/**
 * Analytics Endpoint
 * 
 * Provides admin-only analytics data for the dashboard.
 * Aggregates quota status, month-to-date usage, daily breakdown, and session metadata.
 */

import express from "express";
import { requireAuth, requireAdmin } from "../middleware/requireAuthContext.js";
import { getQuotaStatus } from "../usage/quotaEnforcement.js";
import { getMonthToDateUsage } from "../usage/getUsage.js";
import { getEntitlements } from "../entitlements/index.js";
import { supabaseAdmin } from "../supabaseAdmin.js";

export const analyticsRouter = express.Router();

/**
 * GET /api/quota-check
 * 
 * Lightweight pre-connect quota check for Solo/Host pages.
 * Returns current quota status so the frontend can lock the Start button
 * BEFORE the user attempts to connect via WebSocket.
 * 
 * Requires authentication only (not admin).
 */
analyticsRouter.get("/quota-check", requireAuth, async (req, res) => {
    try {
        const churchId = req.auth.profile?.church_id;
        if (!churchId) {
            return res.status(400).json({ error: "No church associated with this user" });
        }

        const status = await getQuotaStatus(churchId);

        if (!status.hasQuota) {
            // No subscription / no quota defined - allow access
            return res.json({
                hasQuota: false,
                solo: { isExceeded: false, isWarning: false, percentUsed: 0, remaining: Infinity },
                host: { isExceeded: false, isWarning: false, percentUsed: 0, remaining: Infinity },
                combined: { isExceeded: false, isWarning: false, percentUsed: 0, remaining: Infinity }
            });
        }

        const WARNING_THRESHOLD = 0.80;

        res.json({
            hasQuota: true,
            solo: {
                isExceeded: status.solo.percentUsed >= 1.0,
                isWarning: status.solo.percentUsed >= WARNING_THRESHOLD && status.solo.percentUsed < 1.0,
                percentUsed: Math.round(status.solo.percentUsed * 100),
                remaining: status.solo.remaining
            },
            host: {
                isExceeded: status.host.percentUsed >= 1.0,
                isWarning: status.host.percentUsed >= WARNING_THRESHOLD && status.host.percentUsed < 1.0,
                percentUsed: Math.round(status.host.percentUsed * 100),
                remaining: status.host.remaining
            },
            combined: {
                isExceeded: status.isExceeded,
                isWarning: status.isWarning,
                percentUsed: Math.round(status.combined.percentUsed * 100),
                remaining: status.combined.remaining
            }
        });
    } catch (err) {
        console.error('[QuotaCheck] Error:', err.message);
        // Fail-open: if quota check fails, don't block the user
        res.json({
            hasQuota: false,
            solo: { isExceeded: false, isWarning: false, percentUsed: 0, remaining: Infinity },
            host: { isExceeded: false, isWarning: false, percentUsed: 0, remaining: Infinity },
            combined: { isExceeded: false, isWarning: false, percentUsed: 0, remaining: Infinity }
        });
    }
});

/**
 * GET /api/analytics
 * 
 * Returns comprehensive analytics data for the admin dashboard.
 * Requires authentication + admin role.
 */
analyticsRouter.get("/analytics", requireAuth, requireAdmin, async (req, res) => {
    try {
        const churchId = req.auth.profile.church_id;

        // Fetch all data in parallel
        const [quotaStatus, mtdUsage, dailyUsage, sessionMeta, memberCount] = await Promise.all([
            // 1. Quota status (solo/host/combined breakdowns)
            getQuotaStatus(churchId).catch(err => {
                console.error('[Analytics] Quota status error:', err.message);
                return null;
            }),

            // 2. Month-to-date usage totals by metric
            getMonthToDateUsage(churchId).catch(err => {
                console.error('[Analytics] MTD usage error:', err.message);
                return [];
            }),

            // 3. Daily usage for last 30 days (for bar chart)
            getDailyUsageBreakdown(churchId).catch(err => {
                console.error('[Analytics] Daily usage error:', err.message);
                return [];
            }),

            // 4. Session metadata (languages, listener counts)
            getSessionMetadata(churchId).catch(err => {
                console.error('[Analytics] Session metadata error:', err.message);
                return { languages: [], listenerCount: 0 };
            }),

            // 5. Member count for this church
            getMemberCount(churchId).catch(err => {
                console.error('[Analytics] Member count error:', err.message);
                return 0;
            })
        ]);

        // Get plan code from entitlements (reliable source)
        let planCode = 'free';
        try {
            const entitlements = await getEntitlements(churchId);
            planCode = entitlements?.subscription?.planCode || 'free';
        } catch (e) {
            console.warn('[Analytics] Could not fetch entitlements:', e.message);
        }

        // Calculate additional statistics
        // 1. Total sessions this month
        const totalSessions = await getSessionCount(churchId);

        // 2. Total usage (combined solo + host seconds)
        const soloUsage = mtdUsage.find(m => m.metric === 'solo_active_seconds')?.total || 0;
        const hostUsage = mtdUsage.find(m => m.metric === 'host_active_seconds')?.total || 0;
        const totalUsageSeconds = soloUsage + hostUsage;

        // 3. Average daily usage (total usage / days elapsed in current month)
        const now = new Date();
        const daysElapsed = now.getDate(); // Current day of month (1-31)
        const avgDailySeconds = daysElapsed > 0 ? totalUsageSeconds / daysElapsed : 0;

        // Convert percentUsed from fraction (0-1) to percentage (0-100) for frontend
        const scalePercent = (quota) => quota ? {
            ...quota,
            percentUsed: Math.round((quota.percentUsed || 0) * 100)
        } : null;

        res.json({
            quota: quotaStatus ? {
                solo: scalePercent(quotaStatus.solo),
                host: scalePercent(quotaStatus.host),
                combined: scalePercent(quotaStatus.combined)
            } : null,
            mtd: mtdUsage,
            dailyUsage,
            languages: sessionMeta.languages,
            listenerCount: sessionMeta.listenerCount,
            memberCount,
            planCode,
            // New statistics
            totalSessions,
            totalUsageSeconds,
            avgDailySeconds
        });

    } catch (error) {
        console.error('[Analytics] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get daily usage breakdown for the last 30 days.
 * Groups by date and separates solo vs host seconds.
 */
async function getDailyUsageBreakdown(churchId) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startDate = thirtyDaysAgo.toISOString().split('T')[0];

    const { data, error } = await supabaseAdmin
        .from('usage_daily')
        .select('date, metric, quantity')
        .eq('church_id', churchId)
        .gte('date', startDate)
        .order('date', { ascending: true });

    if (error) {
        console.error('[Analytics] Daily usage query error:', error.message);
        return [];
    }

    // Group by date, extract solo/host seconds
    const byDate = {};
    for (const row of data || []) {
        if (!byDate[row.date]) {
            byDate[row.date] = { date: row.date, solo_seconds: 0, host_seconds: 0 };
        }
        if (row.metric === 'solo_active_seconds') {
            byDate[row.date].solo_seconds += Number(row.quantity);
        } else if (row.metric === 'host_active_seconds') {
            byDate[row.date].host_seconds += Number(row.quantity);
        }
    }

    return Object.values(byDate);
}

/**
 * Get session metadata for the current month.
 * Returns distinct languages used and total listener count.
 */
async function getSessionMetadata(churchId) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Fetch sessions for this month
    const { data, error } = await supabaseAdmin
        .from('sessions')
        .select('source_lang, metadata')
        .eq('church_id', churchId)
        .gte('created_at', monthStart);

    if (error) {
        console.error('[Analytics] Session metadata query error:', error.message);
        return { languages: [], listenerCount: 0 };
    }

    // Collect unique languages
    const langs = new Set();
    for (const session of data || []) {
        if (session.source_lang) langs.add(session.source_lang);
    }

    // Get DISTINCT listener count from listening_spans (count unique user_ids)
    let listenerCount = 0;
    try {
        const { data: listeningData, error: countError } = await supabaseAdmin
            .from('listening_spans')
            .select('user_id')
            .eq('church_id', churchId)
            .gte('started_at', monthStart);

        console.log('[Analytics] Listening spans query:', {
            churchId,
            monthStart,
            rowCount: listeningData?.length,
            error: countError?.message
        });

        if (!countError && listeningData) {
            // Count distinct user_ids
            const uniqueListeners = new Set(listeningData.map(span => span.user_id));
            listenerCount = uniqueListeners.size;

            console.log('[Analytics] Listener count calculation:', {
                totalRows: listeningData.length,
                uniqueListeners: listenerCount,
                sampleUserIds: Array.from(uniqueListeners).slice(0, 5)
            });
        }
    } catch (e) {
        // listening_spans table may not exist yet
        console.warn('[Analytics] Could not query listening_spans:', e.message);
    }

    return {
        languages: Array.from(langs),
        listenerCount
    };
}

/**
 * Get member count for a church.
 * Returns the number of profiles (members) associated with the church.
 */
async function getMemberCount(churchId) {
    const { count, error } = await supabaseAdmin
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('church_id', churchId);

    if (error) {
        console.error('[Analytics] Member count query error:', error.message);
        return 0;
    }

    return count || 0;
}

/**
 * Get session count for a church this month.
 * Returns the number of sessions created in the current month.
 */
async function getSessionCount(churchId) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const { count, error } = await supabaseAdmin
        .from('sessions')
        .select('*', { count: 'exact', head: true })
        .eq('church_id', churchId)
        .gte('created_at', monthStart);

    if (error) {
        console.error('[Analytics] Session count query error:', error.message);
        return 0;
    }

    return count || 0;
}

