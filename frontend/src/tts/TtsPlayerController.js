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
     */
    start({ languageCode, voiceName, tier = TtsTier.GEMINI, mode = TtsMode.UNARY, ssmlOptions = null, promptPresetId = null, ttsPrompt = null, intensity = null }) {
        console.log('[TtsPlayerController] Starting playback', { languageCode, voiceName, tier, mode, ssmlOptions });

        this.currentLanguageCode = languageCode;
        this.currentVoiceName = voiceName;
        this.tier = tier;
        this.mode = mode;
        this.ssmlOptions = ssmlOptions;
        this.promptPresetId = promptPresetId;
        this.ttsPrompt = ttsPrompt;
        this.intensity = intensity;
        this.state = TtsPlayerState.PLAYING;

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
     * PR1: Local state change only
     * PR3: Pause current audio
     */
    pause() {
        console.log('[TtsPlayerController] Pausing playback');

        if (this.state !== TtsPlayerState.PLAYING) {
            return;
        }

        this.state = TtsPlayerState.PAUSED;

        // PR3: Pause current audio
        // if (this.currentAudio) {
        //   this.currentAudio.pause();
        // }

        // Notify state change
        if (this.onStateChange) {
            this.onStateChange(this.state);
        }
    }

    /**
     * Resume TTS playback
     * PR1: Local state change only
     * PR3: Resume current audio
     */
    resume() {
        console.log('[TtsPlayerController] Resuming playback');

        if (this.state !== TtsPlayerState.PAUSED) {
            return;
        }

        this.state = TtsPlayerState.PLAYING;

        // PR3: Resume current audio
        // if (this.currentAudio) {
        //   this.currentAudio.play();
        // }

        // Notify state change
        if (this.onStateChange) {
            this.onStateChange(this.state);
        }
    }

    /**
     * Handle finalized segment (for auto-synthesis)
     * PR1: Placeholder
     * PR3: Request synthesis and queue audio
     * 
     * @param {Object} segment - Finalized segment
     * @param {string} segment.id - Segment ID
     * @param {string} segment.text - Segment text
     */
    onFinalSegment(segment) {
        // PR1: Placeholder - do nothing
        console.log('[TtsPlayerController] Final segment received (not implemented)', segment.id);

        // PR3: Request synthesis if playing
        // if (this.state === TtsPlayerState.PLAYING) {
        //   this.sendMessage({
        //     type: 'tts/synthesize',
        //     segmentId: segment.id,
        //     text: segment.text,
        //     languageCode: this.currentLanguageCode,
        //     voiceName: this.currentVoiceName,
        //     tier: this.tier,
        //     mode: this.mode
        //   });
        // }
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
                // Unary audio response
                console.log('[TtsPlayerController] Received audio for segment:', msg.segmentId);

                // Check for out-of-order responses (protected against overlap)
                if (msg.segmentId && msg.segmentId.includes('_ts')) {
                    const parts = msg.segmentId.split('_ts');
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

                // Store in queue with "ready" status
                const queueItem = {
                    type: 'unary',
                    segmentId: msg.segmentId,
                    format: msg.format,
                    mimeType: msg.mimeType,
                    audioContentBase64: msg.audioContentBase64,
                    resolvedRoute: msg.resolvedRoute,
                    ssmlOptions: msg.ssmlOptions || (msg.segmentId && this._pendingRequests?.get(msg.segmentId)) || null,
                    status: 'ready'
                };

                // Cleanup pending request tracking
                if (msg.segmentId) this._pendingRequests?.delete(msg.segmentId);

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
            const audioBlob = this._base64ToBlob(nextItem.audioContentBase64, nextItem.mimeType);
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
