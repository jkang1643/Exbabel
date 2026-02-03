/**
 * Quota Enforcement Service
 * 
 * Checks usage limits and determines if sessions should be locked or warned.
 * Supports both solo and host modes with separate quotas.
 * 
 * @module usage/quotaEnforcement
 */

import { supabaseAdmin } from "../supabaseAdmin.js";

// Thresholds
const WARNING_THRESHOLD = 0.80;  // 80% - show warning
const EXCEEDED_THRESHOLD = 1.00; // 100% - lock session

/**
 * Get detailed quota status with mode-specific breakdowns.
 * 
 * @param {string} churchId - Church UUID
 * @returns {Promise<QuotaStatus>} Detailed quota status
 */
export async function getQuotaStatus(churchId) {
    if (!churchId) {
        throw new Error('getQuotaStatus requires churchId');
    }

    try {
        const { data, error } = await supabaseAdmin.rpc('get_session_quota_status', {
            p_church_id: churchId
        });

        if (error) {
            console.error(`[QuotaEnforcement] ✗ RPC error:`, error.message);
            throw error;
        }

        // RPC returns an array with one row
        const result = data?.[0] || null;

        if (!result) {
            // No subscription found - return unlimited / no quota
            return {
                hasQuota: false,
                combined: { included: 0, used: 0, remaining: 0, percentUsed: 0 },
                solo: { included: 0, used: 0, remaining: 0, percentUsed: 0 },
                host: { included: 0, used: 0, remaining: 0, percentUsed: 0 },
                activeSeconds: 0,
                isWarning: false,
                isExceeded: false
            };
        }

        // Calculate percentages
        const combinedPercent = result.included_seconds_per_month > 0
            ? (result.used_seconds_mtd + result.active_seconds_now) / result.included_seconds_per_month
            : 0;
        const soloPercent = result.included_solo_seconds > 0
            ? result.used_solo_seconds_mtd / result.included_solo_seconds
            : 0;
        const hostPercent = result.included_host_seconds > 0
            ? result.used_host_seconds_mtd / result.included_host_seconds
            : 0;

        const status = {
            hasQuota: true,
            combined: {
                included: result.included_seconds_per_month,
                used: Number(result.used_seconds_mtd),
                remaining: Number(result.remaining_seconds),
                percentUsed: combinedPercent
            },
            solo: {
                included: result.included_solo_seconds,
                used: Number(result.used_solo_seconds_mtd),
                remaining: Number(result.remaining_solo_seconds),
                percentUsed: soloPercent
            },
            host: {
                included: result.included_host_seconds,
                used: Number(result.used_host_seconds_mtd),
                remaining: Number(result.remaining_host_seconds),
                percentUsed: hostPercent
            },
            activeSeconds: result.active_seconds_now,
            isWarning: combinedPercent >= WARNING_THRESHOLD && combinedPercent < EXCEEDED_THRESHOLD,
            isExceeded: combinedPercent >= EXCEEDED_THRESHOLD
        };

        console.log(`[QuotaEnforcement] ✓ Church ${churchId}: ${Math.round(combinedPercent * 100)}% used (warning=${status.isWarning}, exceeded=${status.isExceeded})`);
        return status;
    } catch (err) {
        console.error(`[QuotaEnforcement] ✗ getQuotaStatus failed:`, err.message);
        throw err;
    }
}

/**
 * Check quota limit for a specific mode.
 * Returns status and action needed.
 * 
 * @param {string} churchId - Church UUID
 * @param {'solo' | 'host'} mode - Session mode
 * @returns {Promise<CheckResult>} Result with action needed
 */
export async function checkQuotaLimit(churchId, mode = 'host') {
    const status = await getQuotaStatus(churchId);

    if (!status.hasQuota) {
        // No subscription = no limits (or handle as desired)
        return {
            status,
            mode,
            action: 'allow',
            message: null
        };
    }

    // Check mode-specific quota
    const modeQuota = mode === 'solo' ? status.solo : status.host;

    if (modeQuota.percentUsed >= EXCEEDED_THRESHOLD) {
        return {
            status,
            mode,
            action: 'lock',
            message: `You've reached your monthly ${mode} mode limit (${formatHours(modeQuota.included)})`
        };
    }

    if (modeQuota.percentUsed >= WARNING_THRESHOLD) {
        const remainingHours = formatHours(modeQuota.remaining);
        return {
            status,
            mode,
            action: 'warn',
            message: `You've used ${Math.round(modeQuota.percentUsed * 100)}% of your ${mode} mode quota. ${remainingHours} remaining.`
        };
    }

    // Also check combined quota
    if (status.isExceeded) {
        return {
            status,
            mode,
            action: 'lock',
            message: `You've reached your monthly usage limit`
        };
    }

    if (status.isWarning) {
        const remainingHours = formatHours(status.combined.remaining);
        return {
            status,
            mode,
            action: 'warn',
            message: `You've used ${Math.round(status.combined.percentUsed * 100)}% of your monthly quota. ${remainingHours} remaining.`
        };
    }

    return {
        status,
        mode,
        action: 'allow',
        message: null
    };
}

/**
 * Create WebSocket quota event payload.
 * 
 * @param {CheckResult} checkResult - Result from checkQuotaLimit
 * @returns {object} WebSocket message payload
 */
export function createQuotaEvent(checkResult) {
    const { status, mode, action, message } = checkResult;

    if (action === 'allow') {
        return null; // No event needed
    }

    const eventType = action === 'lock' ? 'quota_exceeded' : 'quota_warning';

    return {
        type: eventType,
        mode,
        message,
        percentUsed: Math.round((mode === 'solo' ? status.solo.percentUsed : status.host.percentUsed) * 100),
        remainingSeconds: mode === 'solo' ? status.solo.remaining : status.host.remaining,
        combinedPercentUsed: Math.round(status.combined.percentUsed * 100),
        // Action buttons (for frontend)
        actions: [
            { id: 'upgrade', label: 'Upgrade Plan', enabled: false, hint: 'Coming Soon' },
            { id: 'add_hours', label: 'Add Hours', enabled: false, hint: 'Coming Soon' },
            { id: 'dismiss', label: action === 'lock' ? 'OK' : 'Dismiss', enabled: true }
        ]
    };
}

/**
 * Format seconds as human-readable hours.
 * @param {number} seconds 
 * @returns {string}
 */
function formatHours(seconds) {
    const hours = seconds / 3600;
    if (hours >= 1) {
        return `${hours.toFixed(1)} hours`;
    }
    const minutes = seconds / 60;
    return `${Math.round(minutes)} minutes`;
}

// Export types for documentation
/**
 * @typedef {Object} QuotaStatus
 * @property {boolean} hasQuota
 * @property {QuotaBreakdown} combined
 * @property {QuotaBreakdown} solo
 * @property {QuotaBreakdown} host
 * @property {number} activeSeconds
 * @property {boolean} isWarning
 * @property {boolean} isExceeded
 */

/**
 * @typedef {Object} QuotaBreakdown
 * @property {number} included
 * @property {number} used
 * @property {number} remaining
 * @property {number} percentUsed
 */

/**
 * @typedef {Object} CheckResult
 * @property {QuotaStatus} status
 * @property {'solo' | 'host'} mode
 * @property {'allow' | 'warn' | 'lock'} action
 * @property {string | null} message
 */
