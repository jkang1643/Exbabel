/**
 * TTS Service Abstraction Base Class
 */

import { TtsErrorCode, TtsEncoding, validateTtsProfile } from './tts.types.js';

/**
 * TTS Service Class
 * 
 * Handles text-to-speech synthesis with support for both unary and streaming modes.
 */
export class TtsService {
    constructor(config = {}) {
        this.config = {
            provider: config.provider || process.env.TTS_PROVIDER || 'google',
            playingLeaseSeconds: parseInt(config.playingLeaseSeconds || process.env.TTS_PLAYING_LEASE_SECONDS || '30', 10)
        };
    }

    /**
     * Synthesize speech in unary mode (batch)
     * Returns one complete audio file for the entire text.
     *
     * @param {TtsRequest} request - TTS request
     * @returns {Promise<TtsUnaryResponseWithRoute>}
     * @throws {Error} If synthesis fails or is not implemented
     */
    async synthesizeUnary(request) {
        // Validate request
        this._validateRequest(request);
        validateTtsProfile(request.profile);

        console.log(`[TtsService] Synthesizing unary: ${request.text.length} chars, engine: ${request.profile.engine}, lang: ${request.profile.languageCode}`);

        // This is the base class - should be overridden by subclasses
        throw new Error(JSON.stringify({
            code: TtsErrorCode.NOT_IMPLEMENTED,
            message: 'TTS unary synthesis not implemented in base class',
            details: {
                request: {
                    sessionId: request.sessionId,
                    engine: request.profile.engine,
                    languageCode: request.profile.languageCode,
                    voiceName: request.profile.voiceName,
                    textLength: request.text?.length || 0
                }
            }
        }));
    }

    /**
     * Synthesize speech in streaming mode
     * Calls onChunk callback for each audio chunk as it becomes available.
     * 
     * @param {TtsRequest} request - TTS request
     * @param {Function} onChunk - Callback function(chunk: TtsStreamChunk)
     * @returns {Promise<void>}
     * @throws {Error} If synthesis fails or is not implemented
     */
    async synthesizeStream(request, onChunk) {
        // Validate request
        this._validateRequest(request);
        validateTtsProfile(request.profile);

        // PR1: Stub implementation
        throw new Error(JSON.stringify({
            code: TtsErrorCode.NOT_IMPLEMENTED,
            message: 'TTS streaming synthesis not implemented yet (PR2)',
            details: {
                request: {
                    sessionId: request.sessionId,
                    engine: request.profile.engine,
                    languageCode: request.profile.languageCode,
                    voiceName: request.profile.voiceName,
                    textLength: request.text?.length || 0
                }
            }
        }));
    }

    /**
     * Validate basic request fields
     * @private
     */
    _validateRequest(request) {
        if (!request.text || request.text.length === 0) {
            throw new Error(JSON.stringify({
                code: TtsErrorCode.INVALID_REQUEST,
                message: 'Text is required and must not be empty',
                details: { request }
            }));
        }
    }

    /**
     * Get MIME type for audio format
     * @protected
     */
    _getMimeType(encoding) {
        const mimeTypes = {
            [TtsEncoding.MP3]: 'audio/mpeg',
            [TtsEncoding.OGG_OPUS]: 'audio/ogg',
            [TtsEncoding.LINEAR16]: 'audio/wav',
            [TtsEncoding.ALAW]: 'audio/alaw',
            [TtsEncoding.MULAW]: 'audio/mulaw',
            [TtsEncoding.PCM]: 'audio/pcm'
        };
        return mimeTypes[encoding] || 'application/octet-stream';
    }
}
