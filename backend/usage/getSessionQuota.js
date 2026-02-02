/**
 * Session Quota Status Service
 * 
 * Wrapper for get_session_quota_status RPC.
 * Returns instant quota remaining using session-based metering (host time).
 * 
 * @module usage/getSessionQuota
 */

import { supabaseAdmin } from "../supabaseAdmin.js";

/**
 * Get instant quota status for a church.
 * 
 * Returns:
 * - included_seconds_per_month: from plan
 * - used_seconds_mtd: from usage_monthly (session_seconds)
 * - active_seconds_now: from active session_spans
 * - remaining_seconds: included - used - active
 * 
 * @param {string} churchId - Church UUID
 * @returns {Promise<{ included_seconds_per_month: number, used_seconds_mtd: number, active_seconds_now: number, remaining_seconds: number } | null>}
 */
export async function getSessionQuotaStatus(churchId) {
    if (!churchId) {
        throw new Error('getSessionQuotaStatus requires churchId');
    }

    try {
        const { data, error } = await supabaseAdmin.rpc('get_session_quota_status', {
            p_church_id: churchId
        });

        if (error) {
            console.error(`[SessionQuota] ✗ RPC error:`, error.message);
            throw error;
        }

        // RPC returns an array with one row
        const result = data?.[0] || null;

        if (result) {
            console.log(`[SessionQuota] ✓ Church ${churchId}: ${result.remaining_seconds}s remaining (${result.used_seconds_mtd}s used + ${result.active_seconds_now}s active)`);
        }

        return result;
    } catch (err) {
        console.error(`[SessionQuota] ✗ getSessionQuotaStatus failed:`, err.message);
        throw err;
    }
}

/**
 * Format quota status for display.
 * 
 * @param {object} status - Quota status from getSessionQuotaStatus
 * @returns {{ hoursRemaining: string, percentUsed: number, isExhausted: boolean }}
 */
export function formatQuotaStatus(status) {
    if (!status) {
        return { hoursRemaining: 'Unknown', percentUsed: 0, isExhausted: false };
    }

    const hoursRemaining = (status.remaining_seconds / 3600).toFixed(1);
    const percentUsed = status.included_seconds_per_month > 0
        ? Math.round(((status.used_seconds_mtd + status.active_seconds_now) / status.included_seconds_per_month) * 100)
        : 0;
    const isExhausted = status.remaining_seconds <= 0;

    return { hoursRemaining, percentUsed, isExhausted };
}
