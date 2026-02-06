/**
 * Abandoned Session Reaper
 * 
 * Periodically cleans up abandoned session spans and sessions for long-running servers.
 * Handles cases where:
 * - User forgets they're recording
 * - User closes laptop while recording
 * - User forgets to end session
 * - Connection drops without proper cleanup
 * 
 * @module usage/abandonedSessionReaper
 */

import { supabaseAdmin } from '../supabaseAdmin.js';
import { stopSessionSpan } from './sessionSpans.js';
import sessionStore from '../sessionStore.js';

// Configuration
const ABANDONED_THRESHOLD_SECONDS = 300; // 5 minutes - 10 missed heartbeats at 30s each
const DEFAULT_REAPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Track the interval ID for cleanup
let reaperIntervalId = null;

/**
 * Reap abandoned session spans.
 * Finds spans where last_seen_at is older than threshold and ends them.
 * 
 * @returns {Promise<{ reapedCount: number, errors: string[] }>}
 */
export async function reapAbandonedSessionSpans() {
    const errors = [];
    let reapedCount = 0;

    try {
        // Find all active spans that haven't had a heartbeat recently
        const cutoffTime = new Date(Date.now() - ABANDONED_THRESHOLD_SECONDS * 1000).toISOString();

        const { data: staleSpans, error: findError } = await supabaseAdmin
            .from('session_spans')
            .select('id, session_id, church_id, started_at, last_seen_at')
            .is('ended_at', null)
            .lt('last_seen_at', cutoffTime);

        if (findError) {
            console.error('[AbandonedReaper] ❌ Failed to query stale spans:', findError.message);
            errors.push(`Query failed: ${findError.message}`);
            return { reapedCount, errors };
        }

        if (!staleSpans || staleSpans.length === 0) {
            console.log('[AbandonedReaper] ✓ No abandoned session spans found');
            return { reapedCount, errors };
        }

        console.log(`[AbandonedReaper] 🧹 Found ${staleSpans.length} abandoned session span(s) to clean up`);

        // Stop each stale span
        for (const span of staleSpans) {
            try {
                const lastSeenAge = Math.floor((Date.now() - new Date(span.last_seen_at).getTime()) / 1000);
                console.log(`[AbandonedReaper] 🔴 Reaping span ${span.id} (session: ${span.session_id}, last seen: ${lastSeenAge}s ago)`);

                const result = await stopSessionSpan({
                    sessionId: span.session_id,
                    reason: 'abandoned_reaper'
                });

                if (result.success) {
                    reapedCount++;
                    console.log(`[AbandonedReaper] ✓ Reaped span ${span.id}: ${result.durationSeconds}s billed`);
                } else {
                    errors.push(`Span ${span.id}: stop returned success=false`);
                }
            } catch (spanErr) {
                console.error(`[AbandonedReaper] ❌ Failed to reap span ${span.id}:`, spanErr.message);
                errors.push(`Span ${span.id}: ${spanErr.message}`);
            }
        }

        console.log(`[AbandonedReaper] ✓ Reaped ${reapedCount}/${staleSpans.length} abandoned spans`);

    } catch (err) {
        console.error('[AbandonedReaper] ❌ Unexpected error:', err.message);
        errors.push(`Unexpected: ${err.message}`);
    }

    return { reapedCount, errors };
}

/**
 * Reap abandoned session records.
 * Finds sessions marked 'active' in DB but with no in-memory presence and no active spans.
 * 
 * @returns {Promise<{ reapedCount: number, errors: string[] }>}
 */
export async function reapAbandonedSessions() {
    const errors = [];
    let reapedCount = 0;

    try {
        // Find active sessions in DB
        const { data: activeSessions, error: findError } = await supabaseAdmin
            .from('sessions')
            .select('id, session_code, church_id, created_at')
            .eq('status', 'active');

        if (findError) {
            console.error('[AbandonedReaper] ❌ Failed to query active sessions:', findError.message);
            errors.push(`Session query failed: ${findError.message}`);
            return { reapedCount, errors };
        }

        if (!activeSessions || activeSessions.length === 0) {
            return { reapedCount, errors };
        }

        // Check each session
        for (const session of activeSessions) {
            // Check if session exists in memory (meaning it's actively being used)
            const inMemorySession = sessionStore.getSession(session.id);
            if (inMemorySession) {
                // Session is active in memory - skip
                continue;
            }

            // Check if session has any active spans
            const { data: activeSpans } = await supabaseAdmin
                .from('session_spans')
                .select('id')
                .eq('session_id', session.id)
                .is('ended_at', null)
                .limit(1);

            if (activeSpans && activeSpans.length > 0) {
                // Session has active spans - will be handled by span reaper
                continue;
            }

            // Check session age - don't reap very recent sessions (may be in setup)
            const sessionAge = Date.now() - new Date(session.created_at).getTime();
            if (sessionAge < ABANDONED_THRESHOLD_SECONDS * 1000) {
                continue;
            }

            // Session is abandoned - mark as ended
            try {
                console.log(`[AbandonedReaper] 🔴 Reaping abandoned session ${session.session_code} (${session.id})`);

                const { error: updateError } = await supabaseAdmin
                    .from('sessions')
                    .update({
                        status: 'ended',
                        ended_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', session.id);

                if (updateError) {
                    errors.push(`Session ${session.id}: ${updateError.message}`);
                } else {
                    reapedCount++;
                    console.log(`[AbandonedReaper] ✓ Reaped session ${session.session_code}`);
                }
            } catch (sessionErr) {
                console.error(`[AbandonedReaper] ❌ Failed to reap session ${session.id}:`, sessionErr.message);
                errors.push(`Session ${session.id}: ${sessionErr.message}`);
            }
        }

        if (reapedCount > 0) {
            console.log(`[AbandonedReaper] ✓ Reaped ${reapedCount} abandoned session(s)`);
        }

    } catch (err) {
        console.error('[AbandonedReaper] ❌ Unexpected error in session reaper:', err.message);
        errors.push(`Unexpected: ${err.message}`);
    }

    return { reapedCount, errors };
}

/**
 * Run a single reaper cycle.
 * Reaps both spans and sessions.
 * 
 * @returns {Promise<{ spans: { reapedCount: number, errors: string[] }, sessions: { reapedCount: number, errors: string[] } }>}
 */
export async function runReaperCycle() {
    console.log('[AbandonedReaper] 🔍 Checking for abandoned sessions...');

    const spanResult = await reapAbandonedSessionSpans();
    const sessionResult = await reapAbandonedSessions();

    return { spans: spanResult, sessions: sessionResult };
}

/**
 * Start the periodic abandoned session reaper.
 * 
 * @param {number} [intervalMs=DEFAULT_REAPER_INTERVAL_MS] - Interval between reaper runs
 * @returns {NodeJS.Timeout} The interval ID (for cleanup)
 */
export function startPeriodicReaper(intervalMs = DEFAULT_REAPER_INTERVAL_MS) {
    // Don't start multiple reapers
    if (reaperIntervalId) {
        console.warn('[AbandonedReaper] ⚠️ Reaper already running');
        return reaperIntervalId;
    }

    console.log(`[AbandonedReaper] 🧹 Starting periodic abandoned session reaper (interval: ${intervalMs}ms, threshold: ${ABANDONED_THRESHOLD_SECONDS}s)`);

    // Run immediately on startup
    runReaperCycle().catch(err => {
        console.error('[AbandonedReaper] ❌ Initial reaper cycle failed:', err.message);
    });

    // Then run periodically
    reaperIntervalId = setInterval(() => {
        runReaperCycle().catch(err => {
            console.error('[AbandonedReaper] ❌ Reaper cycle failed:', err.message);
        });
    }, intervalMs);

    return reaperIntervalId;
}

/**
 * Stop the periodic reaper.
 */
export function stopPeriodicReaper() {
    if (reaperIntervalId) {
        clearInterval(reaperIntervalId);
        reaperIntervalId = null;
        console.log('[AbandonedReaper] 🛑 Stopped periodic reaper');
    }
}

// Export configuration for testing
export const CONFIG = {
    ABANDONED_THRESHOLD_SECONDS,
    DEFAULT_REAPER_INTERVAL_MS
};
