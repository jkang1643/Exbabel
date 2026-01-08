/**
 * Frontend TTS Type Definitions
 * 
 * Mirrors backend types for TTS system.
 */

/**
 * TTS Player State
 */
export const TtsPlayerState = {
    STOPPED: 'STOPPED',
    PLAYING: 'PLAYING',
    PAUSED: 'PAUSED'
};

/**
 * TTS Model Tier
 */
export const TtsTier = {
    GEMINI: 'gemini',
    CHIRP_HD: 'chirp_hd',
    CUSTOM_VOICE: 'custom_voice'
};

/**
 * TTS Synthesis Mode
 */
export const TtsMode = {
    UNARY: 'unary',
    STREAMING: 'streaming'
};

/**
 * Audio formats for unary synthesis
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
 * IMPORTANT: MP3 is NOT supported for streaming
 */
export const TtsFormatStreaming = {
    PCM: 'PCM',
    OGG_OPUS: 'OGG_OPUS',
    ALAW: 'ALAW',
    MULAW: 'MULAW'
};
