/**
 * TTS Policy Enforcement
 * 
 * Handles tier and voice eligibility checks, organization-level feature flags,
 * and subscription-based access control.
 * 
 * PR1: Basic validation with structured errors
 * PR4: Full tier/subscription enforcement
 */

import { TtsTier, TtsErrorCode } from './tts.types.js';

/**
 * Resolve allowed TTS tiers for a user based on org config and subscription
 * 
 * @param {Object} orgTierConfig - Organization tier configuration
 * @param {Object} userSubscription - User subscription details
 * @returns {string[]} Array of allowed tier names
 * 
 * TODO PR4: Implement full subscription-based tier resolution
 */
export function resolveTierForUser(orgTierConfig = {}, userSubscription = {}) {
    // PR1: Stub implementation - allow all tiers
    // PR4: Check subscription level and return appropriate tiers
    return [TtsTier.GEMINI, TtsTier.CHIRP_HD, TtsTier.CUSTOM_VOICE];
}

/**
 * Check if a voice is allowed for the given tier and language
 * 
 * @param {string} tier - TTS tier
 * @param {string} languageCode - BCP-47 language code
 * @param {string} voiceName - Voice name
 * @returns {boolean} True if voice is allowed
 * 
 * TODO PR4: Implement voice-language-tier matrix validation
 */
export function isVoiceAllowed(tier, languageCode, voiceName) {
    // PR1: Stub implementation - allow all voices
    // PR4: Check against voice availability matrix

    // Basic validation: ensure parameters are provided
    if (!tier || !languageCode || !voiceName) {
        return false;
    }

    return true;
}

/**
 * Check if TTS is enabled for an organization
 * 
 * @param {string} orgId - Organization identifier
 * @returns {Promise<boolean>} True if TTS is enabled
 * 
 * TODO PR4: Query database for org-level TTS feature flag
 */
export async function checkOrgEnabled(orgId) {
    // PR1: Stub implementation - use environment variable default
    // PR4: Query database for org-specific settings

    const defaultEnabled = process.env.TTS_ENABLED_DEFAULT === 'true';
    return defaultEnabled;
}

/**
 * Validate TTS request and return error if not allowed
 * 
 * @param {Object} request - TTS request object
 * @param {string} request.orgId - Organization ID
 * @param {string} request.userId - User ID
 * @param {string} request.tier - Requested tier
 * @param {string} request.languageCode - Language code
 * @param {string} request.voiceName - Voice name
 * @returns {Promise<Object|null>} Error object if validation fails, null if valid
 */
export async function validateTtsRequest(request) {
    const { orgId, userId, tier, languageCode, voiceName } = request;

    // Check if TTS is enabled for organization
    const orgEnabled = await checkOrgEnabled(orgId);
    if (!orgEnabled) {
        return {
            code: TtsErrorCode.TTS_DISABLED,
            message: 'TTS is not enabled for this organization',
            details: { orgId }
        };
    }

    // Check if tier is allowed for user
    const allowedTiers = resolveTierForUser({}, {}); // TODO PR4: Pass actual config
    if (!allowedTiers.includes(tier)) {
        return {
            code: TtsErrorCode.TTS_TIER_NOT_ALLOWED,
            message: `TTS tier '${tier}' is not allowed for this user`,
            details: { tier, allowedTiers }
        };
    }

    // Check if voice is allowed for tier and language
    if (!isVoiceAllowed(tier, languageCode, voiceName)) {
        return {
            code: TtsErrorCode.TTS_VOICE_NOT_ALLOWED,
            message: `Voice '${voiceName}' is not allowed for tier '${tier}' and language '${languageCode}'`,
            details: { tier, languageCode, voiceName }
        };
    }

    // All checks passed
    return null;
}
