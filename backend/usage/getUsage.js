/**
 * Usage Reporting Service
 * 
 * Retrieves usage data for reporting and quota enforcement.
 * 
 * @module usage/getUsage
 */

import { supabaseAdmin } from "../supabaseAdmin.js";

/**
 * Gets month-to-date usage for a church.
 * 
 * @param {string} churchId - Church UUID
 * @param {string} [metric] - Optional: filter by specific metric
 * @returns {Promise<{ metric: string, total: number }[]>}
 */
export async function getMonthToDateUsage(churchId, metric = null) {
    if (!churchId) {
        throw new Error('getMonthToDateUsage requires churchId');
    }

    // Get first day of current month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let query = supabaseAdmin
        .from('usage_daily')
        .select('metric, quantity')
        .eq('church_id', churchId)
        .gte('date', monthStart.toISOString().split('T')[0]);

    if (metric) {
        query = query.eq('metric', metric);
    }

    const { data, error } = await query;

    if (error) {
        console.error(`[Usage] ✗ getMonthToDateUsage error:`, error.message);
        throw error;
    }

    // Aggregate by metric
    const totals = {};
    for (const row of data || []) {
        totals[row.metric] = (totals[row.metric] || 0) + Number(row.quantity);
    }

    return Object.entries(totals).map(([metric, total]) => ({ metric, total }));
}

/**
 * Gets today's usage for a church.
 * 
 * @param {string} churchId - Church UUID
 * @returns {Promise<{ metric: string, total: number }[]>}
 */
export async function getTodayUsage(churchId) {
    if (!churchId) {
        throw new Error('getTodayUsage requires churchId');
    }

    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabaseAdmin
        .from('usage_daily')
        .select('metric, quantity')
        .eq('church_id', churchId)
        .eq('date', today);

    if (error) {
        console.error(`[Usage] ✗ getTodayUsage error:`, error.message);
        throw error;
    }

    return (data || []).map(row => ({
        metric: row.metric,
        total: Number(row.quantity)
    }));
}
