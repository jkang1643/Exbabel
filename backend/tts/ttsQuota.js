/**
 * TTS Quota Enforcement
 * 
 * Server-authoritative quota checks to prevent abuse.
 * 
 * PR2: In-memory session-based tracking with env var limits
 * PR5: Database-backed quota tracking
 */

import { TtsErrorCode } from './tts.types.js';

// In-memory session quota tracking
// Map: sessionId -> { characters: number, lastReset: timestamp }
const sessionQuotas = new Map();

/**
 * Get quota limit from environment variable
 * @returns {number|null} Character limit per session, or null if unlimited
 */
function getQuotaLimit() {
    const limit = process.env.TTS_MAX_CHARS_PER_SESSION;
    if (!limit) return null;

    const parsed = parseInt(limit, 10);
    return isNaN(parsed) ? null : parsed;
}

/**
 * Check if synthesis is allowed under quota
 * 
 * @param {Object} params - Quota check parameters
 * @param {string} params.orgId - Organization ID
 * @param {string} params.userId - User ID
 * @param {string} params.sessionId - Session ID
 * @param {number} params.characters - Number of characters to synthesize
 * @returns {Object} { allowed: boolean, error?: Object }
 */
export function canSynthesize({ orgId, userId, sessionId, characters }) {
    const limit = getQuotaLimit();

    // No limit configured - allow all
    if (limit === null) {
        return { allowed: true };
    }

    // Get or create session quota entry
    let sessionQuota = sessionQuotas.get(sessionId);
    if (!sessionQuota) {
        sessionQuota = {
            characters: 0,
            lastReset: Date.now()
        };
        sessionQuotas.set(sessionId, sessionQuota);
    }

    // Check if adding these characters would exceed limit
    const newTotal = sessionQuota.characters + characters;
    if (newTotal > limit) {
        return {
            allowed: false,
            error: {
                code: TtsErrorCode.TTS_QUOTA_EXCEEDED,
                message: `Session quota exceeded. Limit: ${limit} characters, current: ${sessionQuota.characters}, requested: ${characters}`,
                details: {
                    sessionId,
                    limit,
                    current: sessionQuota.characters,
                    requested: characters
                }
            }
        };
    }

    // Update quota
    sessionQuota.characters = newTotal;

    return { allowed: true };
}

/**
 * Reset quota for a session
 * @param {string} sessionId - Session ID
 */
export function resetSessionQuota(sessionId) {
    sessionQuotas.delete(sessionId);
}

/**
 * Get current quota usage for a session
 * @param {string} sessionId - Session ID
 * @returns {Object} { characters: number, limit: number|null }
 */
export function getSessionQuota(sessionId) {
    const limit = getQuotaLimit();
    const sessionQuota = sessionQuotas.get(sessionId);

    return {
        characters: sessionQuota?.characters || 0,
        limit
    };
}

/**
 * Clean up old session quotas (call periodically)
 * Removes sessions older than maxAgeMs
 * @param {number} maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 */
export function cleanupOldQuotas(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const toDelete = [];

    for (const [sessionId, quota] of sessionQuotas.entries()) {
        if (now - quota.lastReset > maxAgeMs) {
            toDelete.push(sessionId);
        }
    }

    toDelete.forEach(sessionId => sessionQuotas.delete(sessionId));

    if (toDelete.length > 0) {
        console.log(`[TTS_QUOTA] Cleaned up ${toDelete.length} old session quotas`);
    }
}

// Cleanup old quotas every hour
setInterval(() => cleanupOldQuotas(), 60 * 60 * 1000);
