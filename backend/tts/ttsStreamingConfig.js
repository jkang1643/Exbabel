/**
 * TTS Streaming Configuration
 * 
 * Centralized config for WebSocket audio streaming feature.
 * Gated behind TTS_STREAMING_ENABLED environment variable.
 */

export const TTS_STREAMING_CONFIG = {
    // Master enable flag (Default to true if env var is missing/undefined during dev)
    enabled: process.env.TTS_STREAMING_ENABLED !== 'false',

    // Codec configuration (MP3 for ElevenLabs Creator plan compatibility)
    defaultCodec: 'mp3',
    defaultSampleRate: 44100,
    outputFormat: 'mp3_44100_128',

    // Jitter buffer configuration
    jitterBufferMs: 300,

    // Protocol configuration
    wsPath: '/ws/tts',
    binaryFrameMagic: 'EXA1',

    // Segment queue limits
    maxQueuedSegments: 10,

    // Logging/metrics
    logTimeToFirstAudio: true,
    logUnderruns: true
};

/**
 * Check if streaming is enabled for a session
 * @param {Object} sessionConfig - Optional session-level config override
 * @returns {boolean}
 */
export function isStreamingEnabled(sessionConfig = {}) {
    // Session-level override takes precedence
    if (sessionConfig.ttsMode === 'streaming') return true;
    if (sessionConfig.ttsMode === 'unary') return false;

    // Fall back to global config
    return TTS_STREAMING_CONFIG.enabled;
}

/**
 * Get streaming config merged with session overrides
 * @param {Object} sessionConfig - Session-level overrides
 * @returns {Object}
 */
export function getStreamingConfig(sessionConfig = {}) {
    return {
        ...TTS_STREAMING_CONFIG,
        ...sessionConfig.streaming
    };
}
