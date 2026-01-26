/**
 * TTS Streaming Orchestrator
 * 
 * Coordinates the streaming TTS pipeline:
 * 1. Subscribes to committed transcript segments
 * 2. Queues segments sequentially
 * 3. Routes to appropriate streaming provider (ElevenLabs or Google)
 * 4. Broadcasts chunks to connected WebSocket clients
 */

import { EventEmitter } from 'events';
import { getElevenLabsStreamingProvider } from './elevenlabsStreamingProvider.js';
import { getGoogleStreamingProvider } from './googleStreamingProvider.js';
import {
    broadcastControl,
    broadcastAudioFrame,
    encodeAudioFrame,
    createStartMessage,
    createEndMessage,
    createCancelMessage,
    createErrorMessage,
    recordFirstAudioLatency,
    recordBytesSent
} from './ttsStreamingTransport.js';
import { isStreamingEnabled, TTS_STREAMING_CONFIG } from './ttsStreamingConfig.js';

// Helper to broadcast routing info for debug overlay
const broadcastRoutingInfo = (sessionId, info) => {
    broadcastControl(sessionId, {
        type: 'tts/routing',
        ...info,
        timestamp: Date.now()
    });
};

/**
 * Per-session orchestrator state
 */
class SessionOrchestrator {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.streamId = `${sessionId}:${Date.now()}`;
        this.segmentQueue = [];
        this.isStreaming = false;
        this.currentSegment = null;
        this.currentStreamHandle = null;
        this.segmentCounter = 0;
        this.isShutdown = false;
    }

    /**
     * Enqueue a committed segment for TTS streaming
     * @param {Object} segment - { seqId, text, lang, voiceId, isFinal }
     */
    enqueueSegment(segment) {
        if (this.isShutdown) {
            console.warn(`[TTS-Orch] Session ${this.sessionId} is shutdown, ignoring segment`);
            return;
        }

        if (this.segmentQueue.length >= TTS_STREAMING_CONFIG.maxQueuedSegments) {
            console.warn(`[TTS-Orch] Queue full for session ${this.sessionId}, dropping oldest segment`);
            this.segmentQueue.shift();
        }

        const segmentId = `${this.sessionId}:seg:${++this.segmentCounter}`;

        this.segmentQueue.push({
            ...segment,
            segmentId,
            version: 1,
            enqueuedAt: Date.now()
        });

        console.log(`[TTS-Orch] Enqueued segment ${segmentId} for session ${this.sessionId}: "${segment.text.substring(0, 50)}..."`);

        // Start processing if not already streaming
        this.processQueue();
    }

    /**
     * Process queued segments sequentially
     */
    async processQueue() {
        if (this.isStreaming || this.isShutdown || this.segmentQueue.length === 0) {
            return;
        }

        this.isStreaming = true;

        while (this.segmentQueue.length > 0 && !this.isShutdown) {
            const segment = this.segmentQueue.shift();
            this.currentSegment = segment;

            try {
                await this.streamSegment(segment);
            } catch (err) {
                console.error(`[TTS-Orch] Error streaming segment ${segment.segmentId}:`, err);

                // Broadcast error
                broadcastControl(this.sessionId, createErrorMessage(
                    this.streamId,
                    'STREAMING_ERROR',
                    err.message
                ));
            }

            this.currentSegment = null;
        }

        this.isStreaming = false;
    }

    /**
     * Stream a single segment
     * @param {Object} segment
     */
    async streamSegment(segment) {
        const { segmentId, version, seqId, text, lang, voiceId } = segment;

        console.log(`[TTS-Orch] Streaming segment ${segmentId}: voiceId=${voiceId}, lang=${lang}`);

        // If no voiceId specified, we need to resolve one
        // For MVP, require voiceId to be provided
        if (!voiceId) {
            throw new Error('voiceId is required for streaming TTS');
        }

        // Resolve provider based on voice ID
        const { provider, providerName } = this.resolveProvider(voiceId);
        if (!provider.isConfigured()) {
            throw new Error(`${providerName} streaming provider not configured`);
        }

        console.log(`[TTS-Orch] Using ${providerName} for voice ${voiceId}`);

        // Broadcast audio.start
        // Use 'opus' for Google (WebM remuxing optimization), 'mp3' for others (ElevenLabs/OpenAI)
        const codec = providerName === 'Google' ? 'opus' : 'mp3';
        broadcastControl(this.sessionId, createStartMessage({
            streamId: this.streamId,
            segmentId,
            version,
            seqId,
            lang,
            voiceId,
            textPreview: text,
            codec // Pass codec to frontend
        }));

        // Start streaming with provider-specific parameters
        let streamHandle;
        if (providerName === 'ElevenLabs') {
            streamHandle = provider.streamTts({
                text,
                voiceId: this.resolveVoiceId(voiceId),
                modelId: 'eleven_multilingual_v2',
                outputFormat: TTS_STREAMING_CONFIG.outputFormat
            });
        } else {
            // Google TTS
            const resolved = this.resolveGoogleVoice(voiceId, lang);
            streamHandle = provider.streamTts({
                text,
                voiceName: resolved.voiceName,
                languageCode: resolved.languageCode,
                modelName: resolved.modelName,
                audioEncoding: 'MP3'
            });
        }

        // Measure latency (TTFB approximation)
        const startTime = Date.now();

        this.currentStreamHandle = streamHandle;

        let chunkIndex = 0;
        let firstChunkTime = null;
        let totalBytes = 0;

        try {
            for await (const chunk of streamHandle.chunks) {
                if (this.isShutdown) {
                    streamHandle.cancel();
                    break;
                }

                // Record time to first audio
                if (firstChunkTime === null) {
                    firstChunkTime = Date.now();
                    const latency = firstChunkTime - startTime;
                    console.log(`[TTS-Orch] TTFB: ${latency}ms`);
                    recordFirstAudioLatency(segmentId, latency);

                    // Update overlay with actual latency
                    broadcastRoutingInfo(this.sessionId, {
                        voiceName: voiceId,
                        provider: providerName,
                        tier: providerName === 'Google' ? (voiceId.includes('gemini') ? 'gemini' : 'chirp') : 'elevenlabs',
                        latencyMs: latency
                    });
                }

                console.log(`[TTS-Orch] Broadcasting chunk ${chunkIndex} for segment ${segmentId}: ${chunk.length} bytes`);

                // Encode and broadcast frame
                const isLast = false; // We don't know until stream ends
                const frame = encodeAudioFrame({
                    streamId: this.streamId,
                    segmentId,
                    version,
                    chunkIndex,
                    isLast
                }, chunk);

                broadcastAudioFrame(this.sessionId, frame);
                recordBytesSent(chunk.length);

                totalBytes += chunk.length;
                chunkIndex++;
            }

            // Stream complete - send final empty frame to signal end
            const finalFrame = encodeAudioFrame({
                streamId: this.streamId,
                segmentId,
                version,
                chunkIndex,
                isLast: true
            }, new Uint8Array(0));

            broadcastAudioFrame(this.sessionId, finalFrame);

            console.log(`[TTS-Orch] Segment ${segmentId} complete: ${chunkIndex} chunks, ${totalBytes} bytes`);

        } finally {
            this.currentStreamHandle = null;
        }

        // Broadcast audio.end
        broadcastControl(this.sessionId, createEndMessage(this.streamId, segmentId, version));
    }

    /**
     * Resolve voice ID (strip provider prefix if present) - for ElevenLabs
     * @param {string} voiceId
     * @returns {string}
     */
    resolveVoiceId(voiceId) {
        // Handle complex ID: provider:tier:engine:voiceId
        // e.g. elevenlabs:elevenlabs_v3:-:pNInz6obpgDQGcFmaJgB
        if (voiceId.includes(':')) {
            const parts = voiceId.split(':');
            const lastPart = parts[parts.length - 1];
            // If the last part is a valid ID, use it
            if (/^[a-zA-Z0-9]{20,22}$/.test(lastPart)) {
                return lastPart;
            }
        }

        // Known ElevenLabs ID format (20-22 chars, alphanumeric)
        // or explicitly prefixed with 'elevenlabs-'
        if (voiceId.startsWith('elevenlabs-')) {
            return voiceId.replace('elevenlabs-', '');
        }

        // Check if it looks like an ElevenLabs ID (simple heuristic)
        // valid IDs are usually ~20 chars, e.g. 21m00Tcm4TlvDq8ikWAM
        const isLikelyElevenLabs = /^[a-zA-Z0-9]{20,22}$/.test(voiceId);

        if (isLikelyElevenLabs) {
            return voiceId;
        }

        // Fallback to default ElevenLabs voice
        console.warn(`[TTS-Orch] Voice '${voiceId}' - using default ElevenLabs voice.`);
        return '21m00Tcm4TlvDq8ikWAM';
    }

    /**
     * Resolve which streaming provider to use based on voice ID
     * @param {string} voiceId
     * @returns {{ provider: Object, providerName: string }}
     */
    resolveProvider(voiceId) {
        // ElevenLabs voice patterns:
        // - elevenlabs-{id}
        // - elevenlabs:{tier}:{engine}:{id}
        // - Raw 20-22 char alphanumeric IDs
        const isElevenLabs =
            voiceId.startsWith('elevenlabs') ||
            voiceId.includes('elevenlabs:') ||
            /^[a-zA-Z0-9]{20,22}$/.test(voiceId);

        if (isElevenLabs) {
            return {
                provider: getElevenLabsStreamingProvider(),
                providerName: 'ElevenLabs'
            };
        }

        // Google voice patterns:
        // - google-{voiceName}
        // - {locale}-{type}-{variant} (e.g., en-US-Neural2-A)
        // - Gemini voice names (Kore, Puck, etc.)
        // - chirp3, chirp_3, chirp-3 patterns
        return {
            provider: getGoogleStreamingProvider(),
            providerName: 'Google'
        };
    }

    /**
     * Resolve Google voice configuration from voice ID
     * @param {string} voiceId
     * @param {string} lang - Target language code
     * @returns {{ voiceName: string, languageCode: string, modelName: string|null }}
     */
    resolveGoogleVoice(voiceId, lang) {
        let voiceName = voiceId;
        let languageCode = lang || 'en-US';
        let modelName = null;

        // Strip 'google-' prefix if present
        if (voiceId.startsWith('google-')) {
            voiceName = voiceId.replace('google-', '');
        }

        // Handle complex ID: google:tier:engine:voiceName
        // OR google_cloud_tts:tier:locale:variant (e.g. google_cloud_tts:standard:en-US:A)
        let targetTier = null;

        if (voiceId.includes(':')) {
            const parts = voiceId.split(':');
            // Format: provider:tier:engine:voiceName or provider:tier:locale:variant
            if (parts.length >= 4) {
                targetTier = parts[1]; // e.g. 'chirp3_hd' or 'gemini_tts'
                const potentialName = parts[parts.length - 1];
                const locale = parts[2];

                // FIX: Standard/Neural2 voices often use just the variant letter (A, B) in the URN
                // We must reconstruct the full name (e.g. en-US-Standard-A) for the Google API
                if (potentialName.length <= 2 && (targetTier === 'standard' || targetTier === 'neural2' || targetTier === 'wavenet')) {
                    let tierNameInVoice = 'Standard';
                    if (targetTier === 'neural2') tierNameInVoice = 'Neural2';
                    if (targetTier === 'wavenet') tierNameInVoice = 'Wavenet';

                    if (locale && locale !== '-') {
                        voiceName = `${locale}-${tierNameInVoice}-${potentialName}`;
                    } else {
                        voiceName = potentialName;
                    }
                } else {
                    voiceName = potentialName;
                }

                // Check if tier indicates Gemini
                if (targetTier === 'gemini' || targetTier === 'gemini_tts' || targetTier === 'gemini-tts') {
                    modelName = 'gemini-2.5-flash-tts';
                }
            } else {
                voiceName = parts[parts.length - 1];
            }
        }

        // Extract language code from voice name if present
        // e.g., en-US-Neural2-A -> en-US
        const localeMatch = voiceName.match(/^([a-z]{2}-[A-Z]{2})-/);
        if (localeMatch) {
            languageCode = localeMatch[1];
        } else {
            // Normalize language code to full locale
            languageCode = this.normalizeLanguageCode(lang || 'en');
        }

        // Detect Gemini vs Chirp 3 HD
        // Update: Gemini 2.5 Flash TTS DOES support streaming via the same API

        // Check if voice name corresponds to a Gemini persona
        const geminiPersonas = [
            'Kore', 'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam',
            'Aoede', 'Autonoe', 'Callirrhoe', 'Charon', 'Despina', 'Enceladus',
            'Erinome', 'Fenrir', 'Gacrux', 'Iapetus', 'Kynd', 'Laomedeia',
            'Leda', 'Orus', 'Puck', 'Pulcherrima', 'Rasalgethi', 'Sadachbia',
            'Sadaltager', 'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix',
            'Zephyr', 'Zubenelgenubi'
        ];

        // Determining the model:
        // 1. If we extracted a tier from the URN, rely on that.
        // 2. If valid Chirp3 pattern in name, it's Chirp3.
        // 3. If Gemini persona name, default to Gemini (unless tier said otherwise).

        // Handle case where URN parsing didn't happen (e.g. simple name passed)
        if (targetTier === null && (voiceId.startsWith('google_cloud_tts:') || voiceId.startsWith('gemini:'))) {
            const parts = voiceId.split(':');
            if (parts.length >= 2) {
                targetTier = parts[1];
            }
        }

        const isChirp3Tier = targetTier === 'chirp3_hd';
        const isGeminiTier = targetTier === 'gemini' || targetTier === 'gemini_tts' || targetTier === 'gemini-tts';

        const isGeminiPersona = geminiPersonas.some(p => voiceName.includes(p));
        const isChirp3Name = voiceName.includes('Chirp3') || voiceName.includes('Chirp_3') || voiceName.includes('Chirp-3');

        if (isChirp3Tier || isChirp3Name) {
            modelName = 'chirp-3-hd';
            // Construct API-compatible name for Chirp if it's just a persona name
            if (isGeminiPersona && !voiceName.includes('Chirp3')) {
                // e.g. 'Kore' -> 'es-ES-Chirp3-HD-Kore'
                voiceName = `${languageCode}-Chirp3-HD-${voiceName}`;
            }
        } else if (isGeminiTier || (isGeminiPersona && modelName !== 'chirp-3-hd')) {
            modelName = 'gemini-2.5-flash-tts';
            // Gemini API expects just the persona name
        }

        console.log(`[TTS-Orch] Resolved Google voice: name=${voiceName}, lang=${languageCode}, model=${modelName || 'default'}, tier=${targetTier}`);

        return { voiceName, languageCode, modelName };
    }

    /**
     * Normalize language code to full locale format
     * @param {string} lang
     * @returns {string}
     */
    normalizeLanguageCode(lang) {
        if (lang && lang.includes('-')) {
            return lang;
        }

        const languageMap = {
            'es': 'es-ES',
            'en': 'en-US',
            'fr': 'fr-FR',
            'de': 'de-DE',
            'it': 'it-IT',
            'pt': 'pt-BR',
            'ja': 'ja-JP',
            'ko': 'ko-KR',
            'zh': 'cmn-CN',
            'ar': 'ar-XA',
            'hi': 'hi-IN',
            'ru': 'ru-RU'
        };

        return languageMap[lang] || `${lang}-${lang.toUpperCase()}`;
    }

    /**
     * Cancel current streaming and clear queue
     * @param {string} reason
     */
    cancel(reason = 'user') {
        console.log(`[TTS-Orch] Cancelling session ${this.sessionId}: ${reason}`);

        // Cancel current stream if active
        if (this.currentStreamHandle) {
            this.currentStreamHandle.cancel();
            this.currentStreamHandle = null;
        }

        // Clear queue
        this.segmentQueue = [];

        // Broadcast cancel
        broadcastControl(this.sessionId, createCancelMessage(
            this.streamId,
            reason,
            this.currentSegment?.segmentId
        ));

        // Reset state
        this.currentSegment = null;
        this.isStreaming = false;
    }

    /**
     * Shutdown the orchestrator
     */
    shutdown() {
        this.isShutdown = true;
        this.cancel('session_end');
    }

    /**
     * Generate new stream ID (for stop/restart scenarios)
     */
    resetStream() {
        this.streamId = `${this.sessionId}:${Date.now()}`;
        this.segmentCounter = 0;
    }
}

/**
 * Global registry of session orchestrators
 */
const orchestrators = new Map();

/**
 * Get or create orchestrator for a session
 * @param {string} sessionId
 * @returns {SessionOrchestrator}
 */
export function getOrchestrator(sessionId) {
    if (!orchestrators.has(sessionId)) {
        orchestrators.set(sessionId, new SessionOrchestrator(sessionId));
    }
    return orchestrators.get(sessionId);
}

/**
 * Remove orchestrator for a session
 * @param {string} sessionId
 */
export function removeOrchestrator(sessionId) {
    const orch = orchestrators.get(sessionId);
    if (orch) {
        orch.shutdown();
        orchestrators.delete(sessionId);
    }
}

/**
 * Handle committed segment from transcript pipeline
 * Call this from soloModeHandler/hostModeHandler after sendWithSequence/broadcastWithSequence
 * 
 * @param {string} sessionId - Session ID
 * @param {Object} segment - { seqId, text, lang, voiceId, isFinal }
 */
export function onCommittedSegment(sessionId, segment) {
    if (!isStreamingEnabled()) {
        return;
    }

    // Only stream final/committed segments with actual text
    if (!segment.text || segment.text.trim().length === 0) {
        return;
    }

    const orch = getOrchestrator(sessionId);
    orch.enqueueSegment(segment);
}

/**
 * Cancel streaming for a session
 * @param {string} sessionId
 * @param {string} reason
 */
export function cancelStreaming(sessionId, reason = 'user') {
    const orch = orchestrators.get(sessionId);
    if (orch) {
        orch.cancel(reason);
    }
}

/**
 * Cleanup session on disconnect
 * @param {string} sessionId
 */
export function cleanupSession(sessionId) {
    removeOrchestrator(sessionId);
}
