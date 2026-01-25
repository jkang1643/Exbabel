/**
 * TTS Streaming Orchestrator
 * 
 * Coordinates the streaming TTS pipeline:
 * 1. Subscribes to committed transcript segments
 * 2. Queues segments sequentially
 * 3. Streams audio from ElevenLabs provider
 * 4. Broadcasts chunks to connected WebSocket clients
 */

import { EventEmitter } from 'events';
import { getElevenLabsStreamingProvider } from './elevenlabsStreamingProvider.js';
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

        // Get streaming provider
        const provider = getElevenLabsStreamingProvider();
        if (!provider.isConfigured()) {
            throw new Error('ElevenLabs streaming provider not configured');
        }

        // Broadcast audio.start
        broadcastControl(this.sessionId, createStartMessage({
            streamId: this.streamId,
            segmentId,
            version,
            seqId,
            lang,
            voiceId,
            textPreview: text
        }));

        // Start streaming
        const streamHandle = provider.streamTts({
            text,
            voiceId: this.resolveVoiceId(voiceId),
            modelId: 'eleven_multilingual_v2',
            outputFormat: TTS_STREAMING_CONFIG.outputFormat
        });

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
                if (chunkIndex === 0) {
                    firstChunkTime = Date.now();
                    const latency = firstChunkTime - segment.enqueuedAt;
                    recordFirstAudioLatency(segmentId, latency);
                }

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
     * Resolve voice ID (strip provider prefix if present)
     * @param {string} voiceId
     * @returns {string}
     */
    resolveVoiceId(voiceId) {
        // Known ElevenLabs ID format (20-22 chars, alphanumeric)
        // or explicitly prefixed with 'elevenlabs-'

        if (voiceId.startsWith('elevenlabs-')) {
            return voiceId.replace('elevenlabs-', '');
        }

        // Check if it looks like an ElevenLabs ID (simple heuristic)
        // valid IDs are usually ~20 chars, e.g. 21m00Tcm4TlvDq8ikWAM
        // Google IDs are structured like en-US-Neural2-F
        const isLikelyElevenLabs = /^[a-zA-Z0-9]{20,22}$/.test(voiceId);

        if (isLikelyElevenLabs) {
            return voiceId;
        }

        // Fallback for Google/Gemini voices to ensure streaming works
        // Default to 'Rachel' (21m00Tcm4TlvDq8ikWAM)
        console.warn(`[TTS-Orch] Voice '${voiceId}' not compatible with ElevenLabs streaming. Falling back to default.`);
        return '21m00Tcm4TlvDq8ikWAM';
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
