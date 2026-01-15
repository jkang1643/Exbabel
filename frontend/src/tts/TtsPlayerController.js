/**
 * TTS Player Controller
 * 
 * Manages TTS playback state and WebSocket communication.
 * 
 * PR1: Skeleton with start/stop WS messaging
 * PR3: Audio playback and queue management
 */

import { TtsPlayerState, TtsMode, TtsTier } from './types.js';

// Global debug buffer for on-screen visual debugging (mobile)
if (typeof window !== 'undefined' && !window.__AUDIO_DEBUG__) {
    window.__AUDIO_DEBUG__ = [];
    window.audioDebug = function (msg, data) {
        const entry = {
            t: new Date().toLocaleTimeString(),
            msg,
            data: data ? JSON.parse(JSON.stringify(data)) : null
        };
        window.__AUDIO_DEBUG__.push(entry);
        console.log(`[AUDIO_DEBUG] ${msg}`, data);
        if (window.__AUDIO_DEBUG__.length > 30) {
            window.__AUDIO_DEBUG__.shift();
        }

        // Ensure overlay exists
        let overlay = document.getElementById('audio-debug-overlay');
        if (!overlay && document.body) {
            overlay = document.createElement('div');
            overlay.id = 'audio-debug-overlay';
            Object.assign(overlay.style, {
                position: 'fixed',
                bottom: '10px',
                left: '10px',
                right: '10px',
                maxHeight: '40vh',
                overflowY: 'auto',
                backgroundColor: 'rgba(0,0,0,0.85)',
                color: '#0f0',
                padding: '10px',
                borderRadius: '8px',
                zIndex: '99999',
                fontSize: '10px',
                fontFamily: 'monospace',
                pointerEvents: 'none',
                border: '1px solid #333'
            });
            document.body.appendChild(overlay);
        }

        if (overlay) {
            overlay.innerHTML = window.__AUDIO_DEBUG__.map(e =>
                `<div style="border-bottom:1px solid #444;padding:2px 0;white-space:pre-wrap;">
                    <span style="color:#aaa">[${e.t}]</span> <b style="color:#fff">${e.msg}</b>: ${JSON.stringify(e.data)}
                </div>`
            ).reverse().join('');
        }
    };
}


export class TtsPlayerController {
    constructor(sendMessage) {
        this.sendMessage = sendMessage;

        // Player state
        this.state = TtsPlayerState.STOPPED;
        this.currentLanguageCode = null;
        this.currentVoiceName = null;
        this.tier = TtsTier.GEMINI;
        this.mode = TtsMode.UNARY;
        this.ssmlOptions = null; // SSML configuration (Chirp 3 HD only)
        this.promptPresetId = null; // Gemini-TTS prompt preset ID
        this.ttsPrompt = null; // Gemini-TTS custom prompt
        this.intensity = null; // Gemini-TTS intensity level (1-5)

        // Resolved routing info (from last synthesis)
        this.lastResolvedRoute = null;

        // Audio queue (PR1: stored but not played)
        this.audioQueue = [];
        this.currentAudio = null;

        // Radio mode queue management (PR3)
        this.queue = []; // Array<{ segmentId, text, status: 'pending'|'requesting'|'ready'|'playing'|'done'|'failed', audioBlob?, timestamp, timeoutId? }>
        this.lastSeenSegmentId = null; // Track "start from now" marker
        this.inFlight = new Map(); // Map<segmentId, abortToken> for cancellation
        this.dedupeSet = new Set(); // Set<contentHash> to prevent duplicate requests (uses content hash, not dynamic IDs)
        this.queueLimit = 25; // Maximum queue size
        this.maxConcurrentRequests = 5; // Limit concurrent TTS requests (increased to 5 for smoother Gemini prefetching)
        this.currentRequestCount = 0; // Track active requests
        this._concurrencyFullSince = null; // Track when concurrency became saturated

        // Callbacks
        this.onStateChange = null;
        this.onError = null;
        this.onRouteResolved = null; // New callback for routing updates

        this.lastRequestId = 0; // Track latest request ID to prevent out-of-order playback

        // Create a hidden audio element for priming if in browser
        if (typeof window !== 'undefined' && typeof Audio !== 'undefined') {
            this.primingAudio = new Audio();
            this.primingAudio.volume = 0;
        }

        // Diagnostic tracking
        this.instanceId = Math.random().toString(16).slice(2);
        console.log(`[TtsPlayerController] init ${this.instanceId}`);

        // Safeties
        this.playedSet = new Set(); // Prevent duplicate playback of the same segment
        this.receivedAudioBySegment = new Map(); // Track received audio to prevent double-processing: Map<segmentId, {msgId, fingerprint}>
        this.requestIdBySegment = new Map(); // Track requestId per segmentId
        this._isProcessingQueue = false; // Serialize queue processing

        // Queue health monitoring (every 5 seconds)
        this.queueHealthInterval = setInterval(() => {
            if (this.state === TtsPlayerState.PLAYING) {
                const pending = this.queue.filter(i => i.status === 'pending').length;
                const requesting = this.queue.filter(i => i.status === 'requesting').length;
                const ready = this.queue.filter(i => i.status === 'ready').length;

                // Actual playing count should be 0 or 1 based on currentAudio
                const playing = this.currentAudio ? 1 : 0;
                const playingInQueue = this.queue.filter(i => i.status === 'playing').length;

                // Invariant checks
                if (playingInQueue > 1) {
                    console.error('[TTS INVARIANT VIOLATION] Multiple items marked playing in queue:', playingInQueue);
                }
                if (this.currentAudio && playingInQueue === 0) {
                    console.warn('[TTS STATE DRIFT] currentAudio exists but no item marked playing in queue');
                }

                console.log('[TTS QUEUE HEALTH]', {
                    total: this.queue.length,
                    pending,
                    requesting,
                    ready,
                    playing,
                    playingSegmentId: this.currentAudio ? this.queue.find(i => i.status === 'playing')?.segmentId : null,
                    currentRequestCount: this.currentRequestCount,
                    maxConcurrent: this.maxConcurrentRequests,
                    utilizationPct: Math.round((this.currentRequestCount / this.maxConcurrentRequests) * 100)
                });

                // Alert if queue is growing too large
                if (this.queue.length > 10) {
                    console.warn('[TTS] Queue is growing large, may indicate lag:', this.queue.length);
                }

                // Alert if all concurrency slots are used for >10s
                if (this.currentRequestCount >= this.maxConcurrentRequests) {
                    if (!this._concurrencyFullSince) {
                        this._concurrencyFullSince = Date.now();
                    } else if (Date.now() - this._concurrencyFullSince > 10000) {
                        console.error('[TTS] Concurrency saturated for >10s, system is lagging behind');
                    }
                } else {
                    this._concurrencyFullSince = null;
                }
            }
        }, 5000);
    }

    /**
     * Compute a cheap hash for audio bytes to detect re-synthesis vs re-play
     * @private
     */
    _cheapAudioFingerprint(uint8) {
        const len = uint8.length;
        const head = Array.from(uint8.slice(0, 16)).join(',');
        const tail = Array.from(uint8.slice(Math.max(0, len - 16))).join(',');
        return `${len}:${head}:${tail}`;
    }

    /**
     * Start TTS playback
     * 
     * @param {Object} config - Playback configuration
     * @param {string} config.languageCode - BCP-47 language code
     * @param {string} config.voiceName - Voice name
     * @param {string} [config.tier='gemini'] - TTS tier
     * @param {string} [config.mode='unary'] - Synthesis mode
     * @param {Object} [config.ssmlOptions] - SSML configuration (Chirp 3 HD only)
     * @param {string} [config.promptPresetId] - Prompt preset ID (Gemini-TTS only)
     * @param {string} [config.ttsPrompt] - Custom prompt (Gemini-TTS only)
     * @param {number} [config.intensity] - Intensity level 1-5 (Gemini-TTS only)
     * @param {number} [config.startFromSegmentId] - Start from this segment ID (radio mode)
     */
    start({ languageCode, voiceName, tier = TtsTier.GEMINI, mode = TtsMode.UNARY, ssmlOptions = null, promptPresetId = null, ttsPrompt = null, intensity = null, startFromSegmentId = null }) {
        console.log('[TtsPlayerController] Starting playback', { languageCode, voiceName, tier, mode, ssmlOptions, startFromSegmentId });

        this.currentLanguageCode = languageCode;
        this.currentVoiceName = voiceName;
        this.tier = tier;
        this.mode = mode;
        this.ssmlOptions = ssmlOptions;
        this.promptPresetId = promptPresetId;
        this.ttsPrompt = ttsPrompt;
        this.intensity = intensity;
        this.state = TtsPlayerState.PLAYING;

        // Radio mode: Clear queue and set start marker
        this.queue = [];
        this.inFlight.clear();
        this.dedupeSet.clear();
        this.playedSet.clear(); // Clear playback history on start
        this.receivedAudioBySegment.clear();
        this.requestIdBySegment.clear();
        this.currentRequestCount = 0;
        this.lastSeenSegmentId = startFromSegmentId;

        // Prime the audio system
        this._prime();

        // Send WebSocket message to backend
        if (this.sendMessage) {
            this.sendMessage({
                type: 'tts/start',
                languageCode,
                voiceName,
                tier,
                mode,
                ssmlOptions,
                promptPresetId,
                ttsPrompt,
                intensity
            });
        }

        // Notify state change
        if (this.onStateChange) {
            this.onStateChange(this.state);
        }
    }

    /**
     * Stop TTS playback
     */
    stop() {
        console.log('[TtsPlayerController] Stopping playback');

        this.state = TtsPlayerState.STOPPED;

        // Stop current audio and clear queue
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }

        this.audioQueue = [];

        // Radio mode: Clear queue and inflight requests
        this.queue = [];
        this.inFlight.clear();
        this.dedupeSet.clear();
        this.playedSet.clear();
        this.receivedAudioBySegment.clear();
        this.requestIdBySegment.clear();
        this.currentRequestCount = 0;
        this.lastSeenSegmentId = null;

        // Send WebSocket message to backend
        if (this.sendMessage) {
            this.sendMessage({
                type: 'tts/stop'
            });
        }

        // Notify state change
        if (this.onStateChange) {
            this.onStateChange(this.state);
        }
    }

    /**
     * Pause TTS playback
     */
    pause() {
        console.log('[TtsPlayerController] Pausing playback');

        if (this.state !== TtsPlayerState.PLAYING) {
            return;
        }

        this.state = TtsPlayerState.PAUSED;

        // Pause current audio
        if (this.currentAudio) {
            this.currentAudio.pause();
        }

        // Send pause message to backend
        if (this.sendMessage) {
            this.sendMessage({
                type: 'tts/pause'
            });
        }

        // Notify state change
        if (this.onStateChange) {
            this.onStateChange(this.state);
        }
    }

    /**
     * Resume TTS playback
     */
    resume() {
        console.log('[TtsPlayerController] Resuming playback');

        if (this.state !== TtsPlayerState.PAUSED) {
            return;
        }

        this.state = TtsPlayerState.PLAYING;

        // Resume current audio if paused
        if (this.currentAudio) {
            this.currentAudio.play().catch(error => {
                console.error('[TtsPlayerController] Failed to resume audio:', error);
            });
        } else {
            // No current audio, try to play next in queue
            this._processQueue();
        }

        // Send resume message to backend
        if (this.sendMessage) {
            this.sendMessage({
                type: 'tts/resume'
            });
        }

        // Notify state change
        if (this.onStateChange) {
            this.onStateChange(this.state);
        }
    }

    /**
     * Switch language mid-playback (radio mode)
     * Stops current audio, clears queue, and restarts with new language
     * 
     * @param {string} newLanguageCode - New language code
     * @param {string} newVoiceName - New voice name
     */
    switchLanguage(newLanguageCode, newVoiceName) {
        console.log('[TtsPlayerController] Switching language', { newLanguageCode, newVoiceName });

        // Stop current audio immediately
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }

        // Clear queue and inflight
        this.queue = [];
        this.audioQueue = [];
        this.inFlight.clear();
        this.dedupeSet.clear();
        this.currentRequestCount = 0;

        // Send stop to backend
        if (this.sendMessage) {
            this.sendMessage({ type: 'tts/stop' });
        }

        // Restart with new language
        this.start({
            languageCode: newLanguageCode,
            voiceName: newVoiceName,
            tier: this.tier,
            mode: this.mode,
            ssmlOptions: this.ssmlOptions,
            promptPresetId: this.promptPresetId,
            ttsPrompt: this.ttsPrompt,
            intensity: this.intensity
        });
    }

    /**
     * Handle finalized segment (for auto-synthesis in radio mode)
     * 
     * @param {Object} segment - Finalized segment
     * @param {string} segment.id - Segment ID
     * @param {string} segment.text - Segment text
     * @param {number} [segment.timestamp] - Segment timestamp
     */
    onFinalSegment(segment) {
        // Only process if PLAYING
        if (this.state !== TtsPlayerState.PLAYING) {
            console.log('[TtsPlayerController] Ignoring segment (not PLAYING)', segment.id);
            return;
        }

        // Check if segment is after "start marker" (skip old history)
        if (this.lastSeenSegmentId && segment.timestamp && segment.timestamp < this.lastSeenSegmentId) {
            console.log('[TtsPlayerController] Skipping old segment', segment.id);
            return;
        }

        // Dedupe check using content hash (not dynamic ID)
        // This prevents duplicates even when segment.id is dynamically generated (e.g., seg_${Date.now()})
        const contentHash = `${segment.text.trim()}_${segment.timestamp || 0}`;
        if (this.dedupeSet.has(contentHash)) {
            console.log('[TtsPlayerController] Skipping duplicate segment (content hash)', contentHash);
            return;
        }

        // Add to queue as pending
        this.queue.push({
            segmentId: segment.id,
            text: segment.text,
            status: 'pending',
            timestamp: segment.timestamp || Date.now()
        });

        this.dedupeSet.add(contentHash);

        // Enforce queue limit (drop oldest pending/done)
        if (this.queue.length > this.queueLimit) {
            const toRemove = this.queue.filter(item =>
                item.status === 'pending' || item.status === 'done'
            )[0];
            if (toRemove) {
                // Remove from queue
                this.queue = this.queue.filter(item => item !== toRemove);

                // Remove content hash from dedupeSet
                const removeHash = `${toRemove.text.trim()}_${toRemove.timestamp || 0}`;
                this.dedupeSet.delete(removeHash);
                console.log('[TtsPlayerController] Dropped oldest item from queue:', toRemove.segmentId);
            }
        }

        console.log(`[TtsPlayerController] Enqueued segment ${segment.id}. Queue length: ${this.queue.length}`);

        // Try to request synthesis for pending items
        this._requestNextPending();
    }

    /**
     * Request synthesis for next pending item (radio mode)
     * @private
     */
    _requestNextPending() {
        // Respect concurrency limit
        if (this.currentRequestCount >= this.maxConcurrentRequests) {
            return;
        }

        // Find earliest pending item
        const nextPending = this.queue.find(item => item.status === 'pending');
        if (!nextPending) {
            return;
        }

        // Mark as requesting
        nextPending.status = 'requesting';
        this.currentRequestCount++;

        console.log(`[TtsPlayerController] Requesting synthesis for ${nextPending.segmentId}`);

        // Set timeout for stuck requests (15 seconds)
        const timeoutId = setTimeout(() => {
            if (nextPending.status === 'requesting') {
                console.warn(`[TtsPlayerController] Request timeout for ${nextPending.segmentId} after 15s`);
                nextPending.status = 'failed';
                nextPending.error = { code: 'TIMEOUT', message: 'Request timed out after 15s' };
                this.currentRequestCount--;
                console.log(`[TtsPlayerController] Decremented request count after timeout. New count: ${this.currentRequestCount}`);

                // Try to request next pending item
                this._requestNextPending();

                // Try to play next ready segment
                this._processQueue();
            }
        }, 15000); // 15 second timeout

        // Store timeout ID for cleanup
        nextPending.timeoutId = timeoutId;

        // Send synthesis request
        if (this.sendMessage) {
            this.sendMessage({
                type: 'tts/synthesize',
                segmentId: nextPending.segmentId,
                text: nextPending.text,
                languageCode: this.currentLanguageCode,
                voiceName: this.currentVoiceName,
                tier: this.tier,
                mode: this.mode,
                ssmlOptions: this.ssmlOptions,
                promptPresetId: this.promptPresetId,
                ttsPrompt: this.ttsPrompt,
                intensity: this.intensity
            });

            // Track request ID
            this.requestIdBySegment.set(nextPending.segmentId, Date.now());
        }
    }

    /**
     * Handle WebSocket message
     * 
     * @param {Object} msg - WebSocket message
     */
    onWsMessage(msg) {
        switch (msg.type) {
            case 'tts/ack':
                console.log('[TtsPlayerController] Received ack:', msg.action);
                break;

            case 'tts/audio': {
                // Unary audio response (streaming-compatible structure)
                const wsMessageId = Math.random().toString(16).slice(2, 6);
                const segmentId = msg.segmentId;
                const requestId = this.requestIdBySegment.get(segmentId) || 'unknown';

                console.log(`[TTS RX] [idx:${this.instanceId}] [msg:${wsMessageId}] segment:${segmentId} requestId:${requestId}`);

                // Deduplication: check if we already received audio for this segment
                if (this.receivedAudioBySegment.has(segmentId)) {
                    const existing = this.receivedAudioBySegment.get(segmentId);
                    console.warn(`[TTS] [idx:${this.instanceId}] Duplicate audio ignored`, {
                        segmentId,
                        newMsgId: wsMessageId,
                        existingMsgId: existing.msgId
                    });
                    return;
                }

                // Check for out-of-order responses (protected against overlap)
                if (msg.segmentId && String(msg.segmentId).includes('_ts')) {
                    const parts = String(msg.segmentId).split('_ts');
                    const msgRequestId = parseInt(parts[parts.length - 1], 10);
                    if (msgRequestId < this.lastRequestId) {
                        console.warn('[TtsPlayerController] Ignoring out-of-order audio response', {
                            receivedId: msgRequestId,
                            currentId: this.lastRequestId,
                            segmentId: msg.segmentId
                        });
                        return;
                    }
                }

                // Store resolved routing information
                if (msg.resolvedRoute) {
                    this.lastResolvedRoute = msg.resolvedRoute;
                    console.log('[TtsPlayerController] Resolved route:', msg.resolvedRoute);

                    // Notify listeners of routing resolution
                    if (this.onRouteResolved) {
                        this.onRouteResolved(msg.resolvedRoute);
                    }
                }

                // Store in queue with "ready" status (streaming-compatible structure)
                const queueItem = {
                    type: 'unary',
                    segmentId: msg.segmentId,
                    mode: msg.mode || 'unary',
                    audioData: {
                        mimeType: msg.audio.mimeType,
                        durationMs: msg.audio.durationMs,
                        sampleRateHz: msg.audio.sampleRateHz,
                        bytesBase64: msg.audio.bytesBase64 // Keep reference for fingerprinting if needed
                    },
                    resolvedRoute: msg.resolvedRoute,
                    ssmlOptions: msg.ssmlOptions || (msg.segmentId && this._pendingRequests?.get(msg.segmentId)) || null,
                    status: 'ready'
                };

                // Cleanup pending request tracking
                if (msg.segmentId) this._pendingRequests?.delete(msg.segmentId);

                // Radio mode: Update queue item status
                const radioQueueItem = this.queue.find(item => item.segmentId === msg.segmentId);
                if (radioQueueItem) {
                    // Clear timeout if it exists
                    if (radioQueueItem.timeoutId) {
                        clearTimeout(radioQueueItem.timeoutId);
                        radioQueueItem.timeoutId = null;
                    }

                    radioQueueItem.status = 'ready';
                    radioQueueItem.audioData = queueItem.audioData;
                    radioQueueItem.resolvedRoute = msg.resolvedRoute;
                    radioQueueItem.ssmlOptions = queueItem.ssmlOptions;
                    this.currentRequestCount--;
                    console.log(`[TtsPlayerController] [idx:${this.instanceId}] Marked segment ${msg.segmentId} as ready. Request count: ${this.currentRequestCount}`);

                    // Request next pending item
                    this._requestNextPending();
                } else {
                    // Decrement even if not in radio queue (manual requests via speakTextNow)
                    // Check if this was a tracked request to prevent double-decrement
                    if (this.requestIdBySegment.has(msg.segmentId)) {
                        this.currentRequestCount--;
                        console.log(`[TtsPlayerController] Decremented request count for non-radio segment: ${msg.segmentId}. New count: ${this.currentRequestCount}`);
                    }
                }

                this.audioQueue.push(queueItem);

                // Diagnostic: Log fingerprint and store in dedupe map
                try {
                    const bytes = Uint8Array.from(atob(msg.audio.bytesBase64), c => c.charCodeAt(0));
                    const fingerprint = this._cheapAudioFingerprint(bytes);
                    this.receivedAudioBySegment.set(segmentId, { msgId: wsMessageId, fingerprint });
                    console.log(`[TTS RX FINGERPRINT] [idx:${this.instanceId}] [msg:${wsMessageId}] segment:${segmentId} fingerprint:${fingerprint}`);
                } catch (e) {
                    console.warn('[TtsPlayerController] Failed to compute fingerprint', e);
                    this.receivedAudioBySegment.set(segmentId, { msgId: wsMessageId });
                }

                console.log(`[TtsPlayerController] Added to queue [idx:${this.instanceId}]. New length: ${this.audioQueue.length}`); // Updated log

                // Attempt to play next in queue
                this._processQueue();
                break;
            }

            case 'tts/audio_chunk':
                // Streaming audio chunk
                console.log('[TtsPlayerController] Received audio chunk:', msg.seq, msg.isLast);

                this.audioQueue.push({
                    type: 'stream_chunk',
                    segmentId: msg.segmentId,
                    seq: msg.seq,
                    mimeType: msg.mimeType,
                    chunkBase64: msg.chunkBase64,
                    isLast: msg.isLast,
                    status: 'ready'
                });

                // PR3: Streaming playback would go here
                break;

            case 'tts/error':
                console.error('[TtsPlayerController] TTS error:', msg.code, msg.message);

                // Radio mode: Mark queue item as failed and continue
                if (msg.segmentId) {
                    const radioQueueItem = this.queue.find(item => item.segmentId === msg.segmentId);
                    if (radioQueueItem && radioQueueItem.status === 'requesting') {
                        // Clear timeout if it exists
                        if (radioQueueItem.timeoutId) {
                            clearTimeout(radioQueueItem.timeoutId);
                            radioQueueItem.timeoutId = null;
                        }

                        radioQueueItem.status = 'failed';
                        radioQueueItem.error = { code: msg.code, message: msg.message };
                        this.currentRequestCount--;
                        console.log(`[TtsPlayerController] Marked segment ${msg.segmentId} as failed. Request count: ${this.currentRequestCount}`);

                        // Request next pending item
                        this._requestNextPending();

                        // Try to play next ready item
                        this._processQueue();
                    }
                }

                if (this.onError) {
                    this.onError(msg);
                }
                break;

            default:
                break;
        }
    }

    /**
     * Request synthesis for specific text (manual trigger)
     * 
     * @param {string} text - Text to synthesize
     * @param {string} segmentId - Segment identifier
     * @param {Object} [options] - Optional overrides
     * @param {string} [options.tier] - Optional tier override
     * @param {Object} [options.ssmlOptions] - Optional SSML configuration override
     * @param {string} [options.promptPresetId] - Optional prompt preset ID (Gemini-TTS)
     * @param {string} [options.ttsPrompt] - Optional custom prompt (Gemini-TTS)
     * @param {number} [options.intensity] - Optional intensity level 1-5 (Gemini-TTS)
     */
    speakTextNow(text, segmentId, options = {}) {
        console.log('[TtsPlayerController] speakTextNow called', { text, segmentId, currentLanguageCode: this.currentLanguageCode });

        // Prime the audio system to allow subsequent playback after synthesis delay
        this._prime();

        if (!this.currentLanguageCode) {
            console.error('[TtsPlayerController] Cannot speak: language not set');
            if (this.onError) {
                this.onError({
                    code: 'INVALID_STATE',
                    message: 'TTS not initialized. Call start() first.'
                });
            }
            return;
        }

        const resolvedTier = options.tier || this.tier;
        const resolvedSsmlOptions = options.ssmlOptions || this.ssmlOptions;
        const resolvedPromptPresetId = options.promptPresetId || this.promptPresetId;
        const resolvedTtsPrompt = options.ttsPrompt || this.ttsPrompt;
        const resolvedIntensity = options.intensity || this.intensity;

        // Increment and track latest request
        this.lastRequestId = Date.now();
        const requestId = this.lastRequestId;
        const trackedSegmentId = `${segmentId}_ts${requestId}`;

        console.log('[TtsPlayerController] Requesting immediate synthesis:', {
            text: text.substring(0, 50) + '...',
            segmentId: trackedSegmentId,
            voiceName: this.currentVoiceName,
            languageCode: this.currentLanguageCode,
            tier: resolvedTier,
            ssmlOptions: resolvedSsmlOptions
        });

        // Send synthesis request
        if (this.sendMessage) {
            const message = {
                type: 'tts/synthesize',
                segmentId: trackedSegmentId,
                text,
                languageCode: this.currentLanguageCode,
                voiceName: this.currentVoiceName,
                tier: resolvedTier,
                mode: this.mode,
                ssmlOptions: resolvedSsmlOptions,
                promptPresetId: resolvedPromptPresetId,
                ttsPrompt: resolvedTtsPrompt,
                intensity: resolvedIntensity
            };

            // Track the rate for this request to apply it in the browser if synthesis-side fails (Gemini)
            if (!this._pendingRequests) this._pendingRequests = new Map();
            this._pendingRequests.set(trackedSegmentId, resolvedSsmlOptions);
            this.requestIdBySegment.set(trackedSegmentId, requestId);

            console.log('[TtsPlayerController] Sending synthesis request:', message);
            this.sendMessage(message);
        } else {
            console.error('[TtsPlayerController] sendMessage is not defined!');
        }
    }

    /**
     * Convert base64 to Blob
     * @private
     */
    _base64ToBlob(base64, mimeType) {
        try {
            const byteCharacters = atob(base64);
            console.log(`[TtsPlayerController] Decoded base64: ${byteCharacters.length} bytes`);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            return new Blob([byteArray], { type: mimeType });
        } catch (error) {
            console.error('[TtsPlayerController] Failed to decode base64:', error);
            return null;
        }
    }

    /**
     * Process the audio queue
     * @private
     */
    /**
     * Process the audio queue with serialization guard
     * @private
     */
    _processQueue() {
        if (this._isProcessingQueue) {
            console.log(`[TtsPlayerController] Skipping _processQueue (already processing) [idx:${this.instanceId}]`);
            return;
        }

        this._isProcessingQueue = true;
        try {
            this._processQueueInternal();
        } finally {
            this._isProcessingQueue = false;
        }
    }

    /**
     * Internal implementation of queue processing
     * @private
     */
    _processQueueInternal() {
        // If already playing something, wait for it to finish
        if (this.currentAudio) {
            console.log('[TtsPlayerController] Queue processing: Audio already playing, waiting...');
            return;
        }

        // If paused or stopped, don't start new audio (unless we want to allow manual triggers)
        if (this.state === TtsPlayerState.PAUSED || this.state === TtsPlayerState.STOPPED) {
            console.log(`[TtsPlayerController] Queue processing: Player is ${this.state}, skipping auto-advance`);
            return;
        }

        let nextItem = null;

        // STRATEGY: Determine what to play based on mode

        // Mode 1: Radio Mode (Strict Sequential)
        // If we have items in the radio queue and a start marker, strict ordering applies.
        if (this.queue.length > 0 && this.lastSeenSegmentId) {
            // Find the *first* undelivered item in the ordered queue
            // Statuses: 'pending' (waiting for network start), 'requesting' (network in flight), 
            // 'ready' (audio received), 'playing' (currently playing), 'done', 'failed'
            const nextOrdered = this.queue.find(item =>
                item.status !== 'done' && item.status !== 'playing'
            );

            if (!nextOrdered) {
                console.log('[TtsPlayerController] Queue processing: No active segments in radio queue');
                return;
            }

            // Found the next expected item. Is it ready?
            if (nextOrdered.status === 'ready') {
                // It is ready! We need to find its audio payload.
                // In onWsMessage, we pushed a corresponding item to audioQueue.
                // Let's find THAT item to get the audio data.
                nextItem = this.audioQueue.find(item => item.segmentId === nextOrdered.segmentId);

                // Fallback: If for some reason it's not in audioQueue but marked ready (shouldn't happen),
                // check if we stored audioData on the radio item itself (we do this in onWsMessage now).
                if (!nextItem && nextOrdered.audioData) {
                    console.log('[TtsPlayerController] Recovering audio from radio queue item:', nextOrdered.segmentId);
                    nextItem = {
                        segmentId: nextOrdered.segmentId,
                        audioData: nextOrdered.audioData,
                        status: 'ready',
                        type: 'unary', // Assume unary for recovered items
                        ssmlOptions: nextOrdered.ssmlOptions,
                        resolvedRoute: nextOrdered.resolvedRoute
                    };
                }
            } else if (nextOrdered.status === 'failed') {
                // If the *next* item failed, we should probably skip it to unblock the queue.
                console.warn('[TtsPlayerController] Next item failed, skipping:', nextOrdered.segmentId);
                nextOrdered.status = 'done'; // Mark done to skip
                setTimeout(() => this._processQueue(), 0); // Recurse to try next one
                return;
            } else {
                // It is 'pending' or 'requesting'.
                // We MUST WAIT. Playing out of order breaks the radio experience.
                console.log(`[TtsPlayerController] Waiting for sequential segment: ${nextOrdered.segmentId} (currently ${nextOrdered.status})`);
                return;
            }
        }
        // Mode 2: Manual/Fallback (Play whatever is ready)
        else {
            // Find the next ready item in arrival order
            nextItem = this.audioQueue.find(item => item.status === 'ready');
        }

        if (!nextItem) {
            console.log('[TtsPlayerController] Queue processing: No ready items found to play');
            return;
        }

        // Mark as playing and execute
        nextItem.status = 'playing';

        // Also update radio queue status if applicable
        const radioItem = this.queue.find(i => i.segmentId === nextItem.segmentId);
        if (radioItem) radioItem.status = 'playing';

        if (nextItem.type === 'unary') {
            // Audio source interface: extract from structured audioData object
            const audioBlob = this._base64ToBlob(nextItem.audioData.bytesBase64, nextItem.audioData.mimeType);
            if (audioBlob) {
                this._playAudio(audioBlob, nextItem);
            } else {
                console.error('[TtsPlayerController] Failed to decode audio for segment:', nextItem.segmentId);
                nextItem.status = 'error';
                if (radioItem) radioItem.status = 'failed';
                setTimeout(() => this._processQueue(), 0); // Try next one
            }
        } else {
            // Placeholder for streaming
            console.warn('[TtsPlayerController] Streaming chunks not yet supported in sequential player');
            nextItem.status = 'error';
            if (radioItem) radioItem.status = 'failed';
            setTimeout(() => this._processQueue(), 0);
        }
    }

    /**
     * Play audio blob
     * @private
     * @param {Blob} audioBlob
     * @param {Object} queueItem
     */
    _playAudio(audioBlob, queueItem) {
        const segmentId = queueItem.segmentId;
        const requestId = this.requestIdBySegment.get(segmentId) || 'unknown';

        if (this.playedSet.has(segmentId)) {
            console.warn(`[TTS] Blocked duplicate play [idx:${this.instanceId}] segment:${segmentId} requestId:${requestId}`);
            queueItem.status = 'done';
            setTimeout(() => this._processQueue(), 0);
            return;
        }

        this.playedSet.add(segmentId);

        try {
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audio.volume = 1.0; // Explicitly ensure volume is up
            console.log(`[TtsPlayerController] Created Audio object for segment: ${segmentId}, volume: ${audio.volume}, blobSize: ${audioBlob.size}`);

            // Apply playback rate reinforcement for ALL voices (solid guarantee)
            if (queueItem.ssmlOptions && queueItem.ssmlOptions.rate) {
                const rate = parseFloat(queueItem.ssmlOptions.rate);
                if (!isNaN(rate) && rate !== 1.0) {
                    console.log(`[TtsPlayerController] Reinforcing playbackRate in browser [${queueItem.resolvedRoute?.tier || 'unknown'}]: ${rate}x`);
                    audio.playbackRate = rate;
                }
            }

            this.currentAudio = audio;

            // Log metadata for debugging, but don't block logic on it
            audio.onloadedmetadata = () => {
                console.log(`[TtsPlayerController] Audio loaded [idx:${this.instanceId}]: duration=${audio.duration}s, segment=${queueItem.segmentId}`);

                // Diagnostic: Too-long-for-text warning
                const radioItem = this.queue.find(item => item.segmentId === queueItem.segmentId);
                const text = radioItem ? radioItem.text : (queueItem.text || '');
                if (text) {
                    const wc = text.trim().split(/\s+/).filter(Boolean).length;
                    if (wc <= 5 && audio.duration > 3.5) {
                        console.warn(`[TTS] [idx:${this.instanceId}] suspicious duration`, { segmentId: queueItem.segmentId, wc, duration: audio.duration, text });
                    }
                }
            };

            // Log if metadata loading fails/times out (optional safety)
            audio.onstalled = () => console.warn('[TtsPlayerController] Audio stalled:', queueItem.segmentId);

            audio.onended = () => {
                console.log('[TtsPlayerController] Audio playback ended for segment:', segmentId);
                if (this.currentAudio === audio) {
                    this.currentAudio = null;
                }
                URL.revokeObjectURL(audioUrl);

                // Drain both queues
                this.audioQueue = this.audioQueue.filter(item => item !== queueItem);

                // Find matching radio item for dedupe cleanup before filtering
                const radioItem = this.queue.find(item => item.segmentId === segmentId);
                if (radioItem) {
                    const contentHash = `${radioItem.text?.trim() || ''}_${radioItem.timestamp || 0}`;
                    this.dedupeSet.delete(contentHash);
                }
                this.queue = this.queue.filter(item => item.segmentId !== segmentId);

                console.log(`[TtsPlayerController] Removed segment ${segmentId} from queue. New length: ${this.queue.length}`);

                // Play next in queue - direct call maintains gesture context on Safari iOS
                this._processQueue();
            };

            audio.onerror = (error) => {
                console.error('[TtsPlayerController] Audio playback error for segment:', segmentId, error);
                if (this.currentAudio === audio) {
                    this.currentAudio = null;
                }
                URL.revokeObjectURL(audioUrl);

                // Drain both queues on error too to prevent getting stuck
                this.audioQueue = this.audioQueue.filter(item => item !== queueItem);
                this.queue = this.queue.filter(item => item.segmentId !== segmentId);

                setTimeout(() => this._processQueue(), 0);

                if (this.onError) {
                    this.onError({
                        code: 'PLAYBACK_ERROR',
                        message: `Failed to play audio for ${queueItem.segmentId}`
                    });
                }
            };

            console.log(`[TtsPlayerController] Starting audio play() [idx:${this.instanceId}] for segment:`, queueItem.segmentId);

            // Add state transition logging for mobile debugging
            audio.onplay = () => {
                console.log(`[TtsPlayerController] Audio 'onplay' event [idx:${this.instanceId}]:`, queueItem.segmentId);
                if (window.audioDebug) window.audioDebug("onplay event", { segment: queueItem.segmentId });
            };
            audio.onplaying = () => {
                console.log(`[TtsPlayerController] Audio 'onplaying' event [idx:${this.instanceId}]:`, queueItem.segmentId);
                if (window.audioDebug) window.audioDebug("onplaying event", { segment: queueItem.segmentId });
            };
            audio.onpause = () => {
                console.log(`[TtsPlayerController] Audio 'onpause' event [idx:${this.instanceId}]:`, queueItem.segmentId);
                if (window.audioDebug) window.audioDebug("onpause event", { segment: queueItem.segmentId });
            };

            if (window.audioDebug) {
                window.audioDebug("play() attempt", {
                    segment: queueItem.segmentId,
                    src: audio.src?.substring(0, 50) + '...',
                    readyState: audio.readyState,
                    paused: audio.paused
                });
            }

            audio.play().then(() => {
                console.log(`[TtsPlayerController] Audio playing [idx:${this.instanceId}]:`, queueItem.segmentId);
                if (window.audioDebug) window.audioDebug("play() success", { segmentID: queueItem.segmentId });
            }).catch(error => {
                if (window.audioDebug) {
                    window.audioDebug("play() REJECTED", {
                        segment: queueItem.segmentId,
                        name: error.name,
                        message: error.message
                    });
                }
                if (error.name === 'AbortError') {
                    console.log('[TtsPlayerController] Playback aborted:', queueItem.segmentId);
                } else if (error.name === 'NotAllowedError') {
                    console.error('[TtsPlayerController] SAFARI PLAY REJECTION: Audio playback was blocked by browser policies (likely missing user gesture context).', {
                        segmentId: queueItem.segmentId,
                        errorName: error.name,
                        errorMessage: error.message
                    });
                } else {
                    console.error('[TtsPlayerController] Failed to start playback:', queueItem.segmentId, {
                        name: error.name,
                        message: error.message,
                        error
                    });

                    if (this.currentAudio === audio) {
                        this.currentAudio = null;
                    }
                    queueItem.status = 'error';
                    if (this.onError) {
                        this.onError({
                            code: 'PLAYBACK_ERROR',
                            message: `Failed to start playback: ${error.message}`
                        });
                    }
                }
                URL.revokeObjectURL(audioUrl);
                // Even on play error, try next in queue - direct call if possible to attempt recovery
                this._processQueue();
            });
        } catch (error) {
            console.error('[TtsPlayerController] Error in _playAudio:', error);
            this.currentAudio = null;
            queueItem.status = 'error';
            if (this.onError) {
                this.onError({
                    code: 'PLAYBACK_ERROR',
                    message: error.message
                });
            }
            setTimeout(() => this._processQueue(), 0);
        }
    }

    /**
     * Stream audio chunk
     * @private
     * PR3: Implement streaming audio playback
     */
    _streamAudioChunk(chunkBlob, isLast) {
        // PR3: Implement using MediaSource API or Web Audio API
    }

    /**
     * Prime the audio system to allow subsequent play() calls
     * Must be called from a user gesture (like click)
     * @private
     */
    _prime() {
        if (!this.primingAudio) return;

        console.log('[TtsPlayerController] Priming audio system...');
        // Playing an empty source or a short silent sound works to "unlock" audio in most browsers
        this.primingAudio.play().catch(err => {
            // We expect an error because there's no source, but the play() call still "primes" the browser gesture tracking
            console.log('[TtsPlayerController] Audio primed (ignored harmless error):', err.message);
        });
    }

    /**
     * Get detailed queue status for UI
     * @returns {Object} Queue status object
     */
    getQueueStatus() {
        // Find currently playing item from audioQueue
        const playingItem = this.audioQueue.find(item => item.status === 'playing');

        // Find corresponding text from radio queue
        const radioItem = playingItem ? this.queue.find(item => item.segmentId === playingItem.segmentId) : null;

        // Count stats from radio queue
        const readyCount = this.queue.filter(item => item.status === 'ready').length;
        const pendingCount = this.queue.filter(item => item.status === 'pending').length;
        const requestingCount = this.queue.filter(item => item.status === 'requesting').length;

        return {
            queueLength: this.queue.length,
            readyCount,
            pendingCount,
            inFlightCount: requestingCount,
            currentSegmentId: playingItem ? playingItem.segmentId : null,
            currentText: radioItem ? radioItem.text : null
        };
    }

    /**
     * Get current state
     */
    getState() {
        return {
            state: this.state,
            languageCode: this.currentLanguageCode,
            voiceName: this.currentVoiceName,
            tier: this.tier,
            mode: this.mode,
            queueLength: this.audioQueue.length,
            lastResolvedRoute: this.lastResolvedRoute
        };
    }

    /**
     * Dispose of resources
     */
    dispose() {
        console.log(`[TtsPlayerController] Disposing controller [idx:${this.instanceId}]`);

        // Clear queue health monitoring interval
        if (this.queueHealthInterval) {
            clearInterval(this.queueHealthInterval);
            this.queueHealthInterval = null;
        }

        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.onended = null;
            this.currentAudio.onerror = null;
            this.currentAudio = null;
        }
        if (this.primingAudio) {
            this.primingAudio.pause();
            this.primingAudio = null;
        }
        this.audioQueue = [];
        this.queue = [];
        this.playedSet.clear();
        this.receivedAudioBySegment.clear();
        this.requestIdBySegment.clear();
        this.inFlight.clear();
        this.dedupeSet.clear();
    }
}
