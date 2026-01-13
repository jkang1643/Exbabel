/**
 * TTS Type Definitions and Enums
 * 
 * Defines all types, enums, and interfaces for the TTS system.
 * Supports both unary (batch) and streaming synthesis modes.
 */

/**
 * TTS Engine
 * - gemini_tts: Next-gen Gemini-powered TTS
 * - chirp3_hd: High-definition Chirp 3 voices
 */
export const TtsEngine = {
    GEMINI_TTS: 'gemini_tts',
    CHIRP3_HD: 'chirp3_hd'
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
 * TTS Audio Encoding
 */
export const TtsEncoding = {
    PCM: 'PCM',
    OGG_OPUS: 'OGG_OPUS',
    ALAW: 'ALAW',
    MULAW: 'MULAW',
    MP3: 'MP3',
    LINEAR16: 'LINEAR16'
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
    TTS_PERMISSION_DENIED_GEMINI: 'TTS_PERMISSION_DENIED_GEMINI',
    NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
    INVALID_REQUEST: 'INVALID_REQUEST',
    SYNTHESIS_FAILED: 'SYNTHESIS_FAILED'
};

/**
 * TTS Profile
 * Unified configuration for TTS synthesis
 * @typedef {Object} TtsProfile
 * @property {string} engine - TTS engine (gemini_tts | chirp3_hd)
 * @property {string} languageCode - BCP-47 language code (e.g., 'es-ES', 'en-US')
 * @property {string} voiceName - Voice name ('Kore' for Gemini, full name for Chirp3 HD)
 * @property {string} [modelName] - Required for Gemini-TTS (e.g., 'gemini-2.5-flash-tts')
 * @property {string} encoding - Audio encoding (PCM | OGG_OPUS | ALAW | MULAW | MP3 | LINEAR16)
 * @property {boolean} streaming - Whether to use streaming mode
 * @property {string} [prompt] - Optional style control for Gemini-TTS
 * @property {Object} [customVoice] - Future: custom voice handle
 * @property {string} customVoice.voiceId - Custom voice identifier
 */

/**
 * Delivery Style (for SSML preaching delivery)
 */
export const DeliveryStyle = {
    STANDARD_PREACHING: 'standard_preaching',
    PENTECOSTAL: 'pentecostal',
    TEACHING: 'teaching',
    ALTAR_CALL: 'altar_call'
};

/**
 * Emphasis Level (for SSML emphasis tags)
 */
export const EmphasisLevel = {
    NONE: 'none',
    MODERATE: 'moderate',
    STRONG: 'strong'
};

/**
 * SSML Options
 * Configuration for SSML generation (Chirp 3 HD only)
 * @typedef {Object} SsmlOptions
 * @property {boolean} enabled - Whether to use SSML
 * @property {string} [deliveryStyle] - Delivery style preset (standard_preaching | pentecostal | teaching | altar_call)
 * @property {number} [rate] - Speaking rate (0.25 - 2.0, default: 0.92)
 * @property {string} [pitch] - Pitch adjustment (e.g., '+1st', '-2st', default: '+1st')
 * @property {string} [pauseIntensity] - Pause intensity (light | medium | heavy)
 * @property {boolean} [emphasizePowerWords] - Auto-emphasize spiritual keywords (default: true)
 * @property {string[]} [customEmphasisWords] - Additional words to emphasize
 * @property {string} [emphasisLevel] - Emphasis level (moderate | strong)
 */

/**
 * TTS Request
 * @typedef {Object} TtsRequest
 * @property {string} sessionId - Session identifier
 * @property {string} userId - User identifier
 * @property {string} orgId - Organization identifier
 * @property {string} text - Text to synthesize
 * @property {TtsProfile} profile - Unified TTS configuration profile
 * @property {string} [segmentId] - Optional segment identifier for tracking
 * @property {SsmlOptions} [ssmlOptions] - Optional SSML configuration (Chirp 3 HD only)
 * @property {string} [ttsPrompt] - Optional custom prompt for Gemini-TTS
 * @property {string} [promptPresetId] - Optional prompt preset ID for Gemini-TTS
 * @property {number} [intensity] - Optional intensity level 1-5 for Gemini-TTS prompts
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
 * Helper function to validate TTS engine
 * @param {string} engine - Engine to validate
 * @returns {boolean} True if valid
 */
export function isValidEngine(engine) {
    return Object.values(TtsEngine).includes(engine);
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
 * @param {string} encoding - Encoding to validate
 * @param {boolean} streaming - Whether using streaming mode
 * @returns {boolean} True if valid
 */
export function isValidEncoding(encoding, streaming) {
    if (!Object.values(TtsEncoding).includes(encoding)) return false;

    // MP3 is NOT supported for streaming
    if (streaming && encoding === TtsEncoding.MP3) {
        return false;
    }

    return true;
}

/**
 * Validate a TTS profile
 * @param {TtsProfile} profile 
 * @throws {Error} If invalid
 */
export function validateTtsProfile(profile) {
    if (!profile) throw new Error('TTS profile is required');
    if (!isValidEngine(profile.engine)) throw new Error(`Invalid TTS engine: ${profile.engine}`);
    if (!profile.languageCode) throw new Error('Language code is required');
    if (!profile.voiceName) throw new Error('Voice name is required');

    if (profile.engine === TtsEngine.GEMINI_TTS && !profile.modelName) {
        throw new Error('modelName is required for gemini_tts engine');
    }

    if (!isValidEncoding(profile.encoding, profile.streaming)) {
        throw new Error(`Invalid encoding ${profile.encoding} for ${profile.streaming ? 'streaming' : 'unary'} mode`);
    }
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
