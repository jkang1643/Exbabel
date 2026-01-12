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
    }

    /**
     * Start TTS playback
     * 
     * @param {Object} config - Playback configuration
     * @param {string} config.languageCode - BCP-47 language code
     * @param {string} config.voiceName - Voice name
     * @param {string} [config.tier='gemini'] - TTS tier
     * @param {string} [config.mode='unary'] - Synthesis mode
     */
    start({ languageCode, voiceName, tier = TtsTier.GEMINI, mode = TtsMode.UNARY }) {
        console.log('[TtsPlayerController] Starting playback', { languageCode, voiceName, tier, mode });

        this.currentLanguageCode = languageCode;
        this.currentVoiceName = voiceName;
        this.tier = tier;
        this.mode = mode;
        this.state = TtsPlayerState.PLAYING;

        // Send WebSocket message to backend
        if (this.sendMessage) {
            this.sendMessage({
                type: 'tts/start',
                languageCode,
                voiceName,
                tier,
                mode
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

                // Store in queue
                this.audioQueue.push({
                    type: 'unary',
                    segmentId: msg.segmentId,
                    format: msg.format,
                    mimeType: msg.mimeType,
                    audioContentBase64: msg.audioContentBase64,
                    resolvedRoute: msg.resolvedRoute // Include routing info in queue item
                });

                // Decode and play audio
                const audioBlob = this._base64ToBlob(msg.audioContentBase64, msg.mimeType);
                if (audioBlob) {
                    this._playAudio(audioBlob);
                } else {
                    console.error('[TtsPlayerController] Failed to decode audio');
                    if (this.onError) {
                        this.onError({
                            code: 'DECODE_ERROR',
                            message: 'Failed to decode audio content'
                        });
                    }
                }
                break;

            case 'tts/audio_chunk':
                // Streaming audio chunk
                console.log('[TtsPlayerController] Received audio chunk:', msg.seq, msg.isLast);

                // PR1: Store in queue but don't play
                this.audioQueue.push({
                    type: 'stream_chunk',
                    segmentId: msg.segmentId,
                    seq: msg.seq,
                    mimeType: msg.mimeType,
                    chunkBase64: msg.chunkBase64,
                    isLast: msg.isLast
                });

                // PR3: Decode and stream audio
                // const chunkBlob = this._base64ToBlob(msg.chunkBase64, msg.mimeType);
                // this._streamAudioChunk(chunkBlob, msg.isLast);
                break;

            case 'tts/error':
                console.error('[TtsPlayerController] TTS error:', msg.code, msg.message);

                if (this.onError) {
                    this.onError(msg);
                }
                break;

            default:
                // Ignore other message types
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
     */
    speakTextNow(text, segmentId, options = {}) {
        console.log('[TtsPlayerController] speakTextNow called', { text, segmentId, currentLanguageCode: this.currentLanguageCode });

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
        // Increment and track latest request
        this.lastRequestId = Date.now();
        const requestId = this.lastRequestId;
        const trackedSegmentId = `${segmentId}_ts${requestId}`;

        console.log('[TtsPlayerController] Requesting immediate synthesis:', {
            text: text.substring(0, 50) + '...',
            segmentId: trackedSegmentId,
            voiceName: this.currentVoiceName,
            languageCode: this.currentLanguageCode,
            tier: resolvedTier
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
                mode: this.mode
            };
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
     * Play audio blob
     * @private
     */
    _playAudio(audioBlob) {
        try {
            // Stop and clean up current audio if playing
            if (this.currentAudio) {
                console.log('[TtsPlayerController] Stopping previous audio to prevent overlap');
                this.currentAudio.pause();
                this.currentAudio.src = ""; // Clear source to stop buffering
                this.currentAudio.load();   // Force cleanup
                this.currentAudio = null;
            }

            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            this.currentAudio = audio;

            audio.onended = () => {
                console.log('[TtsPlayerController] Audio playback ended');
                if (this.currentAudio === audio) {
                    this.currentAudio = null;
                }
                URL.revokeObjectURL(audioUrl);
            };

            audio.onerror = (error) => {
                console.error('[TtsPlayerController] Audio playback error:', error);
                if (this.currentAudio === audio) {
                    this.currentAudio = null;
                }
                URL.revokeObjectURL(audioUrl);

                if (this.onError) {
                    this.onError({
                        code: 'PLAYBACK_ERROR',
                        message: 'Failed to play audio'
                    });
                }
            };

            audio.play().then(() => {
                console.log('[TtsPlayerController] Audio playback started');
            }).catch(error => {
                if (error.name === 'AbortError') {
                    console.log('[TtsPlayerController] Playback aborted (likely stopped by user)');
                } else {
                    console.error('[TtsPlayerController] Failed to start playback:', error);
                    if (this.currentAudio === audio) {
                        this.currentAudio = null;
                    }
                    if (this.onError) {
                        this.onError({
                            code: 'PLAYBACK_ERROR',
                            message: `Failed to start playback: ${error.message}`
                        });
                    }
                }
                URL.revokeObjectURL(audioUrl);
            });
        } catch (error) {
            console.error('[TtsPlayerController] Error in _playAudio:', error);
            if (this.onError) {
                this.onError({
                    code: 'PLAYBACK_ERROR',
                    message: error.message
                });
            }
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
