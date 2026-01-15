/**
 * TTS Module Entry Point
 * 
 * Exports all TTS types, services, and utilities.
 */

// Export types and enums
export {
    TtsTier,
    TtsMode,
    TtsFormatUnary,
    TtsFormatStreaming,
    TtsErrorCode,
    isValidTier,
    isValidMode,
    isValidFormat,
    getMimeType
} from './tts.types.js';

// Export policy functions
export {
    resolveTierForUser,
    isVoiceAllowed,
    checkOrgEnabled,
    validateTtsRequest
} from './ttsPolicy.js';

// Export service classes
export {
    TtsService,
    GoogleTtsService
} from './ttsService.js';

// Export usage tracking
export {
    recordUsage,
    getUsageSummary
} from './ttsUsage.js';

/**
 * Factory function to get TTS service instance
 * 
 * @param {Object} config - Service configuration
 * @param {string} [config.provider='google'] - TTS provider
 * @param {string} [config.defaultTier] - Default tier
 * @param {string} [config.unaryFormat] - Default unary audio format
 * @param {string} [config.streamingFormat] - Default streaming audio format
 * @param {number} [config.playingLeaseSeconds] - Playing lease timeout
 * @returns {Promise<TtsService>} TTS service instance
 */
export async function getTtsService(config = {}) {
    const provider = config.provider || process.env.TTS_PROVIDER || 'google';

    if (provider === 'google') {
        const { GoogleTtsService } = await import('./ttsService.js');
        return new GoogleTtsService(config);
    }

    // Fallback to base service (will throw NOT_IMPLEMENTED)
    const { TtsService } = await import('./ttsService.js');
    return new TtsService(config);
}
