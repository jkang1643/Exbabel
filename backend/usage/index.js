/**
 * Usage Module Index
 * 
 * Exports usage recording, reporting, and span tracking functions.
 */

export { recordUsageEvent, generateIdempotencyKey } from './recordUsage.js';
export { getMonthToDateUsage, getTodayUsage } from './getUsage.js';

// Listener spans (analytics, engagement tracking)
export { startListening, heartbeat, stopListening, stopAllListeningForSession } from './listeningSpans.js';
export { getListeningQuotaStatus, formatQuotaForDisplay } from './getListeningQuota.js';

// Session spans (billing, quota enforcement)
export { startSessionSpan, heartbeatSessionSpan, stopSessionSpan } from './sessionSpans.js';
export { getSessionQuotaStatus, formatQuotaStatus } from './getSessionQuota.js';
