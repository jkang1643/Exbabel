/**
 * TTS Tier Helper (Stub)
 * 
 * Determines which TTS tiers an organization is allowed to use.
 * Currently returns all tiers - future implementation will check subscription/org settings.
 */

/**
 * Get allowed TTS tiers for an organization
 * @param {string} orgId - Organization ID
 * @returns {Array<string>} Array of allowed tier names
 */
export function getAllowedTiers(orgId) {
    // Stub implementation: all tiers allowed
    // Future: Check org subscription, feature flags, etc.

    // For now, return all available tiers
    const allTiers = ['gemini', 'chirp3_hd', 'neural2', 'standard', 'elevenlabs', 'elevenlabs_v3', 'elevenlabs_turbo', 'elevenlabs_flash'];

    // Could filter based on org config:
    // const orgConfig = await getOrgConfig(orgId);
    // return orgConfig.allowedTtsTiers || allTiers;

    return allTiers;
}

/**
 * Check if an organization is admin (stub)
 * @param {string} orgId - Organization ID
 * @param {string} userId - User ID
 * @returns {boolean} True if user is admin
 */
export function isOrgAdmin(orgId, userId) {
    // Stub implementation: always true for now
    // Future: Check actual admin permissions from database
    return true;
}
