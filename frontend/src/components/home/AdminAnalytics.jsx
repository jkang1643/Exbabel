/**
 * AdminAnalytics — Usage analytics panel for the admin dashboard
 * 
 * Shows: usage gauges (solo/host), stats cards, daily bar chart, plan badge.
 * Data is fetched fresh on every mount via useAnalytics hook.
 */

import React from 'react';
import { useAnalytics } from '../../hooks/useAnalytics';
import './AdminAnalytics.css';

// Format seconds to human-readable hours string
function formatHours(seconds) {
    if (!seconds || seconds <= 0) return '0h';
    const hrs = seconds / 3600;
    if (hrs < 0.1) {
        const mins = Math.round(seconds / 60);
        return `${mins}m`;
    }
    if (hrs >= 10) return `${Math.round(hrs)}h`;
    return `${hrs.toFixed(1)}h`;
}

// Get color class based on usage percentage
function getColorClass(percent) {
    if (percent >= 90) return 'red';
    if (percent >= 70) return 'amber';
    return 'green';
}

// Format plan code nicely
function formatPlan(code) {
    if (!code) return 'Free';
    return code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');
}

export default function AdminAnalytics() {
    const { data, loading, error, refresh } = useAnalytics();

    if (loading) {
        return (
            <div className="analytics-section">
                <div className="analytics-loading">
                    <div className="spinner" />
                    <div>Loading analytics...</div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="analytics-section">
                <div className="analytics-error">
                    ⚠️ Could not load analytics: {error}
                    <br />
                    <button className="refresh-btn" onClick={refresh} style={{ marginTop: '0.5rem', display: 'inline-flex' }}>
                        Try Again
                    </button>
                </div>
            </div>
        );
    }

    if (!data || !data.quota) {
        return (
            <div className="analytics-section">
                <div className="analytics-empty">
                    📊 No usage data yet. Start a session to see analytics!
                </div>
            </div>
        );
    }

    const { quota, dailyUsage, languages, listenerCount, planCode } = data;
    const soloQuota = quota.solo || { included: 0, used: 0, remaining: 0, percentUsed: 0 };
    const hostQuota = quota.host || { included: 0, used: 0, remaining: 0, percentUsed: 0 };

    // Prepare chart data (last 14 days)
    const chartData = prepareChartData(dailyUsage || []);
    const maxValue = Math.max(
        1,
        ...chartData.map(d => Math.max(d.solo_seconds, d.host_seconds))
    );

    return (
        <div className="analytics-section">
            {/* Header */}
            <div className="analytics-header">
                <div className="analytics-title">
                    📊 Usage Analytics
                    <span className="plan-badge">{formatPlan(planCode)}</span>
                </div>
                <button
                    className={`refresh-btn ${loading ? 'loading' : ''}`}
                    onClick={refresh}
                    disabled={loading}
                >
                    <span className="refresh-icon">⟳</span>
                    Refresh
                </button>
            </div>

            {/* Usage Gauges */}
            <div className="usage-gauges">
                <GaugeCard
                    label="Solo Mode"
                    icon="🎤"
                    used={soloQuota.used}
                    included={soloQuota.included}
                    percentUsed={soloQuota.percentUsed}
                />
                <GaugeCard
                    label="Host Mode"
                    icon="📡"
                    used={hostQuota.used}
                    included={hostQuota.included}
                    percentUsed={hostQuota.percentUsed}
                />
            </div>

            {/* Stats Cards */}
            <div className="stats-grid">
                <div className="stat-card">
                    <div className="stat-value">{formatHours(soloQuota.remaining)}</div>
                    <div className="stat-label">Solo Left</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{formatHours(hostQuota.remaining)}</div>
                    <div className="stat-label">Host Left</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{languages?.length || 0}</div>
                    <div className="stat-label">Languages</div>
                </div>
                <div className="stat-card">
                    <div className="stat-value">{listenerCount || 0}</div>
                    <div className="stat-label">Listeners</div>
                </div>
            </div>

            {/* Daily Bar Chart */}
            {chartData.length > 0 && (
                <div className="chart-section">
                    <div className="chart-title">📈 Daily Usage (Last 14 Days)</div>
                    <div className="chart-container">
                        {chartData.map((day, i) => (
                            <div className="chart-bar-group" key={day.date}>
                                <div className="chart-tooltip">
                                    {formatDateShort(day.date)}: Solo {formatHours(day.solo_seconds)}, Host {formatHours(day.host_seconds)}
                                </div>
                                <div className="chart-bars">
                                    <div
                                        className="chart-bar solo"
                                        style={{ height: `${(day.solo_seconds / maxValue) * 100}%` }}
                                    />
                                    <div
                                        className="chart-bar host"
                                        style={{ height: `${(day.host_seconds / maxValue) * 100}%` }}
                                    />
                                </div>
                                {/* Show date label for every 3rd bar and the last bar */}
                                {(i % 3 === 0 || i === chartData.length - 1) && (
                                    <span className="chart-date-label">
                                        {formatDateTiny(day.date)}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                    <div className="chart-legend">
                        <span><span className="legend-dot solo" /> Solo</span>
                        <span><span className="legend-dot host" /> Host</span>
                    </div>
                </div>
            )}
        </div>
    );
}

/** Gauge Card Component */
function GaugeCard({ label, icon, used, included, percentUsed }) {
    const pct = Math.min(100, Math.round(percentUsed || 0));
    const color = getColorClass(pct);

    return (
        <div className="gauge-card">
            <div className="gauge-label">
                <span className="gauge-mode">{icon} {label}</span>
                <span className={`gauge-percent ${color}`}>{pct}%</span>
            </div>
            <div className="gauge-bar-bg">
                <div
                    className={`gauge-bar-fill ${color}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <div className="gauge-details">
                <span className="gauge-used">{formatHours(used)} used</span>
                <span>{formatHours(included)} included</span>
            </div>
        </div>
    );
}

/** Prepare chart data: fill in missing days, take last 14 */
function prepareChartData(dailyData) {
    if (!dailyData || dailyData.length === 0) return [];

    // Build a map of existing data
    const dataMap = {};
    for (const d of dailyData) {
        dataMap[d.date] = d;
    }

    // Generate last 14 days
    const days = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        days.push(dataMap[dateStr] || { date: dateStr, solo_seconds: 0, host_seconds: 0 });
    }

    return days;
}

/** Format date for tooltip: "Feb 10" */
function formatDateShort(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Format date for axis label: "2/10" */
function formatDateTiny(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return `${d.getMonth() + 1}/${d.getDate()}`;
}
