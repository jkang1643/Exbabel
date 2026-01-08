/**
 * TTS Service Abstraction
 * 
 * Provides unified interface for TTS synthesis supporting both unary (batch)
 * and streaming modes. Actual Google TTS integration in PR2.
 * 
 * PR1: Stub implementation with correct signatures
 * PR2: Google TTS API integration
 */

import { TtsErrorCode, TtsMode } from './tts.types.js';

/**
 * TTS Service Class
 * 
 * Handles text-to-speech synthesis with support for both unary and streaming modes.
 */
export class TtsService {
    constructor(config = {}) {
        this.config = {
            provider: config.provider || process.env.TTS_PROVIDER || 'google',
            defaultTier: config.defaultTier || process.env.TTS_MODEL_TIER || 'gemini',
            unaryFormat: config.unaryFormat || process.env.TTS_AUDIO_FORMAT_UNARY || 'MP3',
            streamingFormat: config.streamingFormat || process.env.TTS_AUDIO_FORMAT_STREAMING || 'PCM',
            playingLeaseSeconds: parseInt(config.playingLeaseSeconds || process.env.TTS_PLAYING_LEASE_SECONDS || '30', 10)
        };
    }

    /**
     * Synthesize speech in unary mode (batch)
     * Returns one complete audio file for the entire text.
     * 
     * @param {Object} request - TTS request
     * @param {string} request.sessionId - Session identifier
     * @param {string} request.userId - User identifier
     * @param {string} request.orgId - Organization identifier
     * @param {string} request.languageCode - BCP-47 language code
     * @param {string} request.voiceName - Voice name
     * @param {string} request.tier - TTS tier
     * @param {string} request.text - Text to synthesize
     * @param {string} [request.segmentId] - Optional segment identifier
     * @returns {Promise<Object>} TtsUnaryResponse
     * @throws {Error} NOT_IMPLEMENTED in PR1
     * 
     * TODO PR2: Implement Google TTS unary synthesis
     */
    async synthesizeUnary(request) {
        // Validate text
        if (!request.text || request.text.length === 0) {
            throw new Error(JSON.stringify({
                code: TtsErrorCode.INVALID_REQUEST,
                message: 'Text is required and must not be empty',
                details: { request }
            }));
        }

        console.log(`[TtsService] Synthesizing unary: ${request.text.length} chars, tier: ${request.tier}, lang: ${request.languageCode}`);

        // This is the base class - should be overridden by GoogleTtsService
        throw new Error(JSON.stringify({
            code: TtsErrorCode.NOT_IMPLEMENTED,
            message: 'TTS unary synthesis not implemented in base class',
            details: {
                request: {
                    sessionId: request.sessionId,
                    tier: request.tier,
                    languageCode: request.languageCode,
                    voiceName: request.voiceName,
                    textLength: request.text?.length || 0
                }
            }
        }));
    }

    /**
     * Synthesize speech in streaming mode
     * Calls onChunk callback for each audio chunk as it becomes available.
     * 
     * @param {Object} request - TTS request
     * @param {string} request.sessionId - Session identifier
     * @param {string} request.userId - User identifier
     * @param {string} request.orgId - Organization identifier
     * @param {string} request.languageCode - BCP-47 language code
     * @param {string} request.voiceName - Voice name
     * @param {string} request.tier - TTS tier
     * @param {string} request.text - Text to synthesize
     * @param {string} [request.segmentId] - Optional segment identifier
     * @param {Function} onChunk - Callback function(chunk: TtsStreamChunk)
     * @returns {Promise<void>}
     * @throws {Error} NOT_IMPLEMENTED in PR1
     * 
     * TODO PR2: Implement Google TTS streaming synthesis
     */
    async synthesizeStream(request, onChunk) {
        // PR1: Stub implementation
        throw new Error(JSON.stringify({
            code: TtsErrorCode.NOT_IMPLEMENTED,
            message: 'TTS streaming synthesis not implemented yet (PR2)',
            details: {
                request: {
                    sessionId: request.sessionId,
                    tier: request.tier,
                    languageCode: request.languageCode,
                    voiceName: request.voiceName,
                    textLength: request.text?.length || 0
                }
            }
        }));

        // TODO PR2: Implement actual streaming synthesis
        // const stream = await this._callGoogleTtsStreaming(request);
        // let seq = 0;
        // for await (const chunk of stream) {
        //   onChunk({
        //     chunkBase64: chunk.audioContent.toString('base64'),
        //     mimeType: this._getMimeType(this.config.streamingFormat),
        //     seq: seq++,
        //     isLast: chunk.isLast || false
        //   });
        // }
    }

    /**
     * Get MIME type for audio format
     * @private
     */
    _getMimeType(format) {
        const mimeTypes = {
            MP3: 'audio/mpeg',
            OGG_OPUS: 'audio/ogg',
            LINEAR16: 'audio/wav',
            ALAW: 'audio/alaw',
            MULAW: 'audio/mulaw',
            PCM: 'audio/pcm'
        };
        return mimeTypes[format] || 'application/octet-stream';
    }
}

/**
 * Google TTS Service (extends TtsService)
 * 
 * TODO PR2: Implement Google-specific TTS logic
 */
export class GoogleTtsService extends TtsService {
    constructor(config = {}) {
        super(config);

        // Lazy-load Google TTS client (will be initialized on first use)
        this.client = null;
        this.clientInitialized = false;
    }

    /**
     * Initialize Google TTS client
     * Supports GOOGLE_APPLICATION_CREDENTIALS or ADC
     * @private
     */
    async _initClient() {
        if (this.clientInitialized) return;

        try {
            // Dynamic import to avoid loading if not needed
            const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');

            // Client will automatically use:
            // 1. GOOGLE_APPLICATION_CREDENTIALS env var if set
            // 2. Application Default Credentials (ADC) otherwise
            this.client = new TextToSpeechClient();
            this.clientInitialized = true;

            console.log('[GoogleTtsService] Google TTS client initialized');
        } catch (error) {
            console.error('[GoogleTtsService] Failed to initialize Google TTS client:', error);
            throw new Error(`Failed to initialize Google TTS client: ${error.message}`);
        }
    }

    /**
     * Map TTS tier to Google TTS model
     * @private
     */
    _getTtsModel(tier) {
        const models = {
            'gemini': 'en-US-Studio-MultiSpeaker', // Gemini TTS model
            // Future tiers:
            // 'chirp_hd': 'chirp-3-hd',
            // 'custom_voice': 'custom-voice-model'
        };

        return models[tier] || null;
    }

    /**
     * Get Google audio encoding from format string
     * @private
     */
    _getAudioEncoding(format) {
        const encodings = {
            'MP3': 'MP3',
            'OGG_OPUS': 'OGG_OPUS',
            'LINEAR16': 'LINEAR16',
            'ALAW': 'ALAW',
            'MULAW': 'MULAW',
            'PCM': 'LINEAR16' // PCM maps to LINEAR16 in Google TTS
        };

        return encodings[format] || 'MP3';
    }

    /**
     * Synthesize speech in unary mode using Google TTS
     * @override
     */
    async synthesizeUnary(request) {
        // Initialize client if needed
        await this._initClient();

        // Validate text
        if (!request.text || request.text.length === 0) {
            throw new Error(JSON.stringify({
                code: TtsErrorCode.INVALID_REQUEST,
                message: 'Text is required and must not be empty',
                details: { request }
            }));
        }

        // Check if tier is implemented
        const model = this._getTtsModel(request.tier);
        if (!model) {
            throw new Error(JSON.stringify({
                code: TtsErrorCode.TTS_TIER_NOT_IMPLEMENTED,
                message: `TTS tier '${request.tier}' is not implemented yet`,
                details: {
                    tier: request.tier,
                    implementedTiers: ['gemini']
                }
            }));
        }

        console.log(`[GoogleTtsService] Synthesizing: ${request.text.length} chars, tier: ${request.tier}, voice: ${request.voiceName}, lang: ${request.languageCode}`);

        // Prepare Google TTS request
        const audioEncoding = this._getAudioEncoding(this.config.unaryFormat);
        const googleRequest = {
            input: { text: request.text },
            voice: {
                languageCode: request.languageCode,
                name: request.voiceName || undefined
            },
            audioConfig: {
                audioEncoding: audioEncoding
            }
        };

        // Retry logic
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const [response] = await this.client.synthesizeSpeech(googleRequest);

                // Convert audio content to base64
                const audioContentBase64 = response.audioContent.toString('base64');
                const mimeType = this._getMimeType(this.config.unaryFormat);

                console.log(`[GoogleTtsService] Synthesis successful: ${audioContentBase64.length} bytes (base64)`);

                return {
                    audioContentBase64,
                    mimeType,
                    sampleRateHz: response.sampleRateHz || undefined,
                    // TODO: Calculate duration from audio content
                    durationMs: undefined
                };
            } catch (error) {
                lastError = error;
                console.error(`[GoogleTtsService] Synthesis attempt ${attempt + 1} failed:`, error.message);

                // Check if error is retryable
                const isRetryable = this._isRetryableError(error);
                if (!isRetryable || attempt === 1) {
                    // Don't retry or last attempt
                    break;
                }

                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        // All retries failed
        throw new Error(JSON.stringify({
            code: TtsErrorCode.SYNTHESIS_FAILED,
            message: `Google TTS synthesis failed: ${lastError.message}`,
            details: {
                tier: request.tier,
                languageCode: request.languageCode,
                voiceName: request.voiceName,
                textLength: request.text.length,
                error: lastError.message
            }
        }));
    }

    /**
     * Check if error is retryable
     * @private
     */
    _isRetryableError(error) {
        // Retry on network errors, 5xx errors, rate limits
        if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
            return true;
        }

        if (error.code >= 500 && error.code < 600) {
            return true;
        }

        if (error.code === 429) {
            return true;
        }

        return false;
    }

    // TODO PR2: Override synthesizeStream with Google TTS implementation
}
