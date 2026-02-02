/**
 * Listening Quota Service
 * 
 * Retrieves instant quota remaining including active listening spans.
 * Wraps the get_listening_quota_status RPC function.
 * 
 * @module usage/getListeningQuota
 */

import { supabaseAdmin } from "../supabaseAdmin.js";

/**
 * Gets the current listening quota status for a church.
 * Includes month-to-date usage AND active listening time (in-flight spans).
 * 
 * @param {string} churchId - Church UUID
 * @returns {Promise<{
 *   included_seconds_per_month: number,
 *   used_seconds_mtd: number,
 *   active_seconds_now: number,
 *   remaining_seconds: number
 * }>}
 */
export async function getListeningQuotaStatus(churchId) {
    if (!churchId) {
        throw new Error('getListeningQuotaStatus requires churchId');
    }

    try {
        const { data, error } = await supabaseAdmin.rpc('get_listening_quota_status', {
            p_church_id: churchId
        });

        if (error) {
            console.error(`[ListeningQuota] ✗ RPC error:`, error.message);
            throw error;
        }

        const result = data?.[0] || {
            included_seconds_per_month: 0,
            used_seconds_mtd: 0,
            active_seconds_now: 0,
            remaining_seconds: 0
        };

        console.log(`[ListeningQuota] ✓ Church ${churchId}: ${result.remaining_seconds}s remaining (${result.used_seconds_mtd}s used + ${result.active_seconds_now}s active)`);
        return result;
    } catch (err) {
        console.error(`[ListeningQuota] ✗ getListeningQuotaStatus failed:`, err.message);
        throw err;
    }
}

/**
 * Formats quota status for display.
 * 
 * @param {Object} quotaStatus - Result from getListeningQuotaStatus
 * @returns {{ usedHours: string, remainingHours: string, percentUsed: number }}
 */
export function formatQuotaForDisplay(quotaStatus) {
    const usedSeconds = quotaStatus.used_seconds_mtd + quotaStatus.active_seconds_now;
    const usedHours = (usedSeconds / 3600).toFixed(1);
    const remainingHours = (quotaStatus.remaining_seconds / 3600).toFixed(1);
    const includedHours = quotaStatus.included_seconds_per_month / 3600;
    const percentUsed = includedHours > 0 ? Math.round((usedSeconds / quotaStatus.included_seconds_per_month) * 100) : 0;

    return {
        usedHours: `${usedHours}h`,
        remainingHours: `${remainingHours}h`,
        percentUsed
    };
}
