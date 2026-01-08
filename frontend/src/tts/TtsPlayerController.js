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

        // Audio queue (PR1: stored but not played)
        this.audioQueue = [];
        this.currentAudio = null;

        // Callbacks
        this.onStateChange = null;
        this.onError = null;
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

        // PR3: Stop current audio and clear queue
        this.audioQueue = [];
        this.currentAudio = null;

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
                console.log('[TtsPlayerController] Received audio (not implemented)');

                // PR1: Store in queue but don't play
                this.audioQueue.push({
                    type: 'unary',
                    segmentId: msg.segmentId,
                    format: msg.format,
                    mimeType: msg.mimeType,
                    audioContentBase64: msg.audioContentBase64
                });

                // PR3: Decode and play audio
                // const audioBlob = this._base64ToBlob(msg.audioContentBase64, msg.mimeType);
                // this._playAudio(audioBlob);
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
     * Convert base64 to Blob
     * @private
     * PR3: Implement audio decoding
     */
    _base64ToBlob(base64, mimeType) {
        // PR3: Implement
        // const byteCharacters = atob(base64);
        // const byteNumbers = new Array(byteCharacters.length);
        // for (let i = 0; i < byteCharacters.length; i++) {
        //   byteNumbers[i] = byteCharacters.charCodeAt(i);
        // }
        // const byteArray = new Uint8Array(byteNumbers);
        // return new Blob([byteArray], { type: mimeType });
        return null;
    }

    /**
     * Play audio blob
     * @private
     * PR3: Implement audio playback
     */
    _playAudio(audioBlob) {
        // PR3: Implement
        // const audioUrl = URL.createObjectURL(audioBlob);
        // const audio = new Audio(audioUrl);
        // audio.play();
        // this.currentAudio = audio;
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
            queueLength: this.audioQueue.length
        };
    }
}
