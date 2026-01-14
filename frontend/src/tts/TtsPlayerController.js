/**
 * TTS Player Controller
 * 
 * Manages TTS playback state and WebSocket communication.
 * 
 * PR1: Skeleton with start/stop WS messaging
 * PR3: Audio playback and queue management
 */

import { TtsPlayerState, TtsMode, TtsTier } from './types.js';

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
        this.queue = []; // Array<{ segmentId, text, status: 'pending'|'requesting'|'ready'|'playing'|'done'|'failed', audioBlob?, timestamp }>
        this.lastSeenSegmentId = null; // Track "start from now" marker
        this.inFlight = new Map(); // Map<segmentId, abortToken> for cancellation
        this.dedupeSet = new Set(); // Set<segmentId> to prevent duplicate requests
        this.queueLimit = 25; // Maximum queue size
        this.maxConcurrentRequests = 3; // Limit concurrent TTS requests (increased for prefetching)
        this.currentRequestCount = 0; // Track active requests

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

        // Dedupe check
        if (this.dedupeSet.has(segment.id)) {
            console.log('[TtsPlayerController] Skipping duplicate segment', segment.id);
            return;
        }

        // Add to queue as pending
        this.queue.push({
            segmentId: segment.id,
            text: segment.text,
            status: 'pending',
            timestamp: segment.timestamp || Date.now()
        });

        this.dedupeSet.add(segment.id);

        // Enforce queue limit (drop oldest pending/done)
        if (this.queue.length > this.queueLimit) {
            const toRemove = this.queue.filter(item =>
                item.status === 'pending' || item.status === 'done'
            )[0];
            if (toRemove) {
                this.queue = this.queue.filter(item => item !== toRemove);
                this.dedupeSet.delete(toRemove.segmentId);
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

            case 'tts/audio':
                // Unary audio response (streaming-compatible structure)
                console.log('[TtsPlayerController] Received audio for segment:', msg.segmentId);

                // Check for out-of-order responses (protected against overlap)
                // Check for out-of-order responses (protected against overlap)
                if (msg.segmentId && String(msg.segmentId).includes('_ts')) {
                    const parts = String(msg.segmentId).split('_ts');
                    const requestId = parseInt(parts[parts.length - 1], 10);
                    if (requestId < this.lastRequestId) {
                        console.warn('[TtsPlayerController] Ignoring out-of-order audio response', {
                            receivedId: requestId,
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
                        bytesBase64: msg.audio.bytesBase64,
                        mimeType: msg.audio.mimeType,
                        durationMs: msg.audio.durationMs,
                        sampleRateHz: msg.audio.sampleRateHz
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
                    radioQueueItem.status = 'ready';
                    radioQueueItem.audioData = queueItem.audioData;
                    radioQueueItem.resolvedRoute = msg.resolvedRoute;
                    radioQueueItem.ssmlOptions = queueItem.ssmlOptions;
                    this.currentRequestCount--;
                    console.log(`[TtsPlayerController] Marked segment ${msg.segmentId} as ready. Request count: ${this.currentRequestCount}`);

                    // Request next pending item
                    this._requestNextPending();
                }

                this.audioQueue.push(queueItem);
                console.log(`[TtsPlayerController] Added to queue. New length: ${this.audioQueue.length}`);

                // Attempt to play next in queue
                this._processQueue();
                break;

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
    _processQueue() {
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

        // Find the next ready item
        const nextItem = this.audioQueue.find(item => item.status === 'ready');
        if (!nextItem) {
            console.log('[TtsPlayerController] Queue processing: No ready items found');
            return;
        }

        // Mark as playing and execute
        nextItem.status = 'playing';

        if (nextItem.type === 'unary') {
            // Audio source interface: extract from structured audioData object
            // V1: Create object URL from base64 blob
            // Future: This is where we'll add SourceBuffer support for streaming
            const audioBlob = this._base64ToBlob(nextItem.audioData.bytesBase64, nextItem.audioData.mimeType);
            if (audioBlob) {
                this._playAudio(audioBlob, nextItem);
            } else {
                console.error('[TtsPlayerController] Failed to decode audio for segment:', nextItem.segmentId);
                nextItem.status = 'error';
                this._processQueue(); // Try next one
            }
        } else {
            // Placeholder for streaming
            console.warn('[TtsPlayerController] Streaming chunks not yet supported in sequential player');
            nextItem.status = 'error';
            this._processQueue();
        }
    }

    /**
     * Play audio blob
     * @private
     * @param {Blob} audioBlob
     * @param {Object} queueItem
     */
    _playAudio(audioBlob, queueItem) {
        try {
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);

            // Apply playback rate reinforcement for Gemini-TTS (solid guarantee)
            // Note: Chirp 3 HD and Neural2/Standard voices handle speed via backend synthesis parameters
            if (queueItem.resolvedRoute?.tier === TtsTier.GEMINI || queueItem.resolvedRoute?.engine === 'gemini_tts' || queueItem.resolvedRoute?.voiceName === 'Kore') {
                if (queueItem.ssmlOptions && queueItem.ssmlOptions.rate) {
                    const rate = parseFloat(queueItem.ssmlOptions.rate);
                    if (!isNaN(rate) && rate !== 1.0) {
                        console.log(`[TtsPlayerController] Reinforcing playbackRate in browser for Gemini: ${rate}x`);
                        audio.playbackRate = rate;
                    }
                }
            }

            this.currentAudio = audio;

            audio.onended = () => {
                console.log('[TtsPlayerController] Audio playback ended for segment:', queueItem.segmentId);
                if (this.currentAudio === audio) {
                    this.currentAudio = null;
                }
                queueItem.status = 'done';
                URL.revokeObjectURL(audioUrl);

                // Remove item from queue to keep it clean (optional, could mark instead)
                this.audioQueue = this.audioQueue.filter(item => item !== queueItem);

                // Play next in queue
                this._processQueue();
            };

            audio.onerror = (error) => {
                console.error('[TtsPlayerController] Audio playback error for segment:', queueItem.segmentId, error);
                if (this.currentAudio === audio) {
                    this.currentAudio = null;
                }
                queueItem.status = 'error';
                URL.revokeObjectURL(audioUrl);

                this._processQueue();

                if (this.onError) {
                    this.onError({
                        code: 'PLAYBACK_ERROR',
                        message: `Failed to play audio for ${queueItem.segmentId}`
                    });
                }
            };

            console.log('[TtsPlayerController] Starting audio play() for segment:', queueItem.segmentId);
            audio.play().then(() => {
                console.log('[TtsPlayerController] Audio playing:', queueItem.segmentId);
            }).catch(error => {
                if (error.name === 'AbortError') {
                    console.log('[TtsPlayerController] Playback aborted:', queueItem.segmentId);
                } else {
                    console.error('[TtsPlayerController] Failed to start playback:', queueItem.segmentId, error);
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
                // Even on play error, try next in queue
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
            this._processQueue();
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
}
