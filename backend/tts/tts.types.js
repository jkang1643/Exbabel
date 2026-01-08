/**
 * TTS Type Definitions and Enums
 * 
 * Defines all types, enums, and interfaces for the TTS system.
 * Supports both unary (batch) and streaming synthesis modes.
 */

/**
 * TTS Model Tier
 * - gemini: Standard Gemini TTS (default, cost-efficient)
 * - chirp_hd: High-definition Chirp 3 voices (premium)
 * - custom_voice: Custom voice cloning (future)
 */
export const TtsTier = {
    GEMINI: 'gemini',
    CHIRP_HD: 'chirp_hd',
    CUSTOM_VOICE: 'custom_voice'
};

/**
 * TTS Synthesis Mode
 * - unary: Batch synthesis, returns one complete audio file
 * - streaming: Real-time synthesis, returns audio chunks
 */
export const TtsMode = {
    UNARY: 'unary',
    STREAMING: 'streaming'
};

/**
 * Audio formats for unary synthesis
 * All formats supported by Google TTS for batch synthesis
 */
export const TtsFormatUnary = {
    MP3: 'MP3',
    OGG_OPUS: 'OGG_OPUS',
    LINEAR16: 'LINEAR16',
    ALAW: 'ALAW',
    MULAW: 'MULAW',
    PCM: 'PCM'
};

/**
 * Audio formats for streaming synthesis
 * IMPORTANT: MP3 is NOT supported for streaming per Google TTS API
 */
export const TtsFormatStreaming = {
    PCM: 'PCM',
    OGG_OPUS: 'OGG_OPUS',
    ALAW: 'ALAW',
    MULAW: 'MULAW'
};

/**
 * TTS Error Codes
 */
export const TtsErrorCode = {
    TTS_TIER_NOT_ALLOWED: 'TTS_TIER_NOT_ALLOWED',
    TTS_VOICE_NOT_ALLOWED: 'TTS_VOICE_NOT_ALLOWED',
    TTS_DISABLED: 'TTS_DISABLED',
    TTS_TIER_NOT_IMPLEMENTED: 'TTS_TIER_NOT_IMPLEMENTED',
    TTS_QUOTA_EXCEEDED: 'TTS_QUOTA_EXCEEDED',
    TTS_STREAMING_NOT_IMPLEMENTED: 'TTS_STREAMING_NOT_IMPLEMENTED',
    NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
    INVALID_REQUEST: 'INVALID_REQUEST',
    SYNTHESIS_FAILED: 'SYNTHESIS_FAILED'
};

/**
 * TTS Request
 * @typedef {Object} TtsRequest
 * @property {string} sessionId - Session identifier
 * @property {string} userId - User identifier
 * @property {string} orgId - Organization identifier
 * @property {string} languageCode - BCP-47 language code (e.g., 'en-US', 'es-ES')
 * @property {string} voiceName - Voice name (e.g., 'Kore', 'Charon')
 * @property {string} tier - TTS tier (gemini | chirp_hd | custom_voice)
 * @property {string} mode - Synthesis mode (unary | streaming)
 * @property {string} text - Text to synthesize
 * @property {string} [segmentId] - Optional segment identifier for tracking
 */

/**
 * TTS Unary Response
 * @typedef {Object} TtsUnaryResponse
 * @property {string} audioContentBase64 - Base64-encoded audio data
 * @property {string} mimeType - MIME type (e.g., 'audio/mpeg', 'audio/ogg')
 * @property {number} [sampleRateHz] - Sample rate in Hz (optional)
 * @property {number} [durationMs] - Audio duration in milliseconds (optional)
 */

/**
 * TTS Stream Chunk
 * @typedef {Object} TtsStreamChunk
 * @property {string} chunkBase64 - Base64-encoded audio chunk
 * @property {string} mimeType - MIME type
 * @property {number} seq - Sequence number (0-indexed)
 * @property {boolean} isLast - True if this is the last chunk
 */

/**
 * TTS Error
 * @typedef {Object} TtsError
 * @property {string} code - Error code from TtsErrorCode
 * @property {string} message - Human-readable error message
 * @property {Object} [details] - Optional additional error details
 */

/**
 * Helper function to validate TTS tier
 * @param {string} tier - Tier to validate
 * @returns {boolean} True if valid
 */
export function isValidTier(tier) {
    return Object.values(TtsTier).includes(tier);
}

/**
 * Helper function to validate TTS mode
 * @param {string} mode - Mode to validate
 * @returns {boolean} True if valid
 */
export function isValidMode(mode) {
    return Object.values(TtsMode).includes(mode);
}

/**
 * Helper function to validate audio format for given mode
 * @param {string} format - Format to validate
 * @param {string} mode - Synthesis mode
 * @returns {boolean} True if valid
 */
export function isValidFormat(format, mode) {
    if (mode === TtsMode.UNARY) {
        return Object.values(TtsFormatUnary).includes(format);
    } else if (mode === TtsMode.STREAMING) {
        return Object.values(TtsFormatStreaming).includes(format);
    }
    return false;
}

/**
 * Get MIME type for audio format
 * @param {string} format - Audio format
 * @returns {string} MIME type
 */
export function getMimeType(format) {
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
