/**
 * TTS Policy Enforcement
 * 
 * Handles tier and voice eligibility checks, organization-level feature flags,
 * and subscription-based access control.
 * 
 * PR1: Basic validation with structured errors
 * PR4: Full tier/subscription enforcement
 */

import { TtsEngine, TtsErrorCode } from './tts.types.js';

/**
 * Resolve allowed TTS engines for a user based on org config and subscription
 * 
 * @param {Object} orgConfig - Organization configuration
 * @param {Object} userSubscription - User subscription details
 * @returns {string[]} Array of allowed engine names
 */
export function resolveEnginesForUser(orgConfig = {}, userSubscription = {}) {
    // PR1: Stub implementation - allow all engines
    // Note: null is allowed for non-Google providers (e.g., ElevenLabs)
    return [TtsEngine.GEMINI_TTS, TtsEngine.CHIRP3_HD, null];
}

/**
 * Check if a voice is allowed for the given engine and language
 * 
 * @param {string|null} engine - TTS engine (can be null for non-Google providers)
 * @param {string} languageCode - BCP-47 language code
 * @param {string} voiceName - Voice name
 * @returns {boolean} True if voice is allowed
 */
export function isVoiceAllowed(engine, languageCode, voiceName) {
    // PR1: Stub implementation - allow all voices

    // Basic validation: ensure parameters are provided
    // Note: engine can be null for non-Google providers (e.g., ElevenLabs)
    if (!languageCode || !voiceName) {
        return false;
    }

    return true;
}

/**
 * Check if TTS is enabled for an organization
 * 
 * @param {string} orgId - Organization identifier
 * @returns {Promise<boolean>} True if TTS is enabled
 */
export async function checkOrgEnabled(orgId) {
    const defaultEnabled = process.env.TTS_ENABLED_DEFAULT === 'true';
    return defaultEnabled;
}

/**
 * Validate TTS request and return error if not allowed
 * 
 * @param {TtsRequest} request - TTS request object
 * @returns {Promise<Object|null>} Error object if validation fails, null if valid
 */
export async function validateTtsRequest(request) {
    const { orgId, profile } = request;
    const { engine, languageCode, voiceName } = profile;

    // Check if TTS is enabled for organization
    const orgEnabled = await checkOrgEnabled(orgId);
    if (!orgEnabled) {
        return {
            code: TtsErrorCode.TTS_DISABLED,
            message: 'TTS is not enabled for this organization',
            details: { orgId }
        };
    }

    // Check if engine is allowed for user
    const allowedEngines = resolveEnginesForUser({}, {});
    if (!allowedEngines.includes(engine)) {
        return {
            code: TtsErrorCode.TTS_TIER_NOT_ALLOWED,
            message: `TTS engine '${engine}' is not allowed for this user`,
            details: { engine, allowedEngines }
        };
    }

    // Check if voice is allowed for engine and language
    if (!isVoiceAllowed(engine, languageCode, voiceName)) {
        return {
            code: TtsErrorCode.TTS_VOICE_NOT_ALLOWED,
            message: `Voice '${voiceName}' is not allowed for engine '${engine}' and language '${languageCode}'`,
            details: { engine, languageCode, voiceName }
        };
    }

    // All checks passed
    return null;
}
