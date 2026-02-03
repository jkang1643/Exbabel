/**
 * Session Spans Service
 * 
 * Tracks wall-clock session/host time for metering and quota enforcement.
 * Each span represents a Start→Stop streaming period for a session.
 * 
 * IMPORTANT: This meters HOST/SESSION time, not individual listener time.
 * 10 listeners for 1 hour = 1 hour billed (not 10 hours).
 * 
 * @module usage/sessionSpans
 */

import { supabaseAdmin } from "../supabaseAdmin.js";
import { recordUsageEvent } from "./recordUsage.js";

/**
 * Starts a session span for metering.
 * Idempotent: unique index ensures at most one active span per session.
 * 
 * @param {Object} params
 * @param {string} params.sessionId - Database session UUID
 * @param {string} params.churchId - Church UUID for billing
 * @param {object} [params.metadata] - Optional metadata
 * @returns {Promise<{ success: boolean, spanId: string | null, alreadyActive: boolean }>}
 */
export async function startSessionSpan({ sessionId, churchId, metadata = {} }) {
    if (!sessionId || !churchId) {
        throw new Error('startSessionSpan requires sessionId and churchId');
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('session_spans')
            .insert({
                session_id: sessionId,
                church_id: churchId,
                started_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
                metadata
            })
            .select('id')
            .single();

        if (error) {
            // Check for unique constraint violation (already active span)
            if (error.code === '23505') { // Postgres unique violation
                console.log(`[SessionSpans] ↩ Already active span for session=${sessionId}`);
                return { success: true, spanId: null, alreadyActive: true };
            }
            console.error(`[SessionSpans] ✗ startSessionSpan error:`, error.message);
            throw error;
        }

        console.log(`[SessionSpans] ✓ Started span ${data.id} for session=${sessionId}, church=${churchId}`);
        return { success: true, spanId: data.id, alreadyActive: false };
    } catch (err) {
        console.error(`[SessionSpans] ✗ startSessionSpan failed:`, err.message);
        throw err;
    }
}

/**
 * Updates the heartbeat timestamp for an active session span.
 * Call this every 30 seconds while session is actively streaming.
 * 
 * @param {Object} params
 * @param {string} params.sessionId - Database session UUID
 * @returns {Promise<{ success: boolean, updated: boolean }>}
 */
export async function heartbeatSessionSpan({ sessionId }) {
    if (!sessionId) {
        throw new Error('heartbeatSessionSpan requires sessionId');
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('session_spans')
            .update({ last_seen_at: new Date().toISOString() })
            .eq('session_id', sessionId)
            .is('ended_at', null)
            .select('id');

        if (error) {
            console.error(`[SessionSpans] ✗ heartbeat error:`, error.message);
            throw error;
        }

        const updated = data && data.length > 0;
        if (updated) {
            console.log(`[SessionSpans] ♥ Heartbeat for session=${sessionId}`);
        }
        return { success: true, updated };
    } catch (err) {
        console.error(`[SessionSpans] ✗ heartbeat failed:`, err.message);
        throw err;
    }
}

/**
 * Stops a session span and records the usage event.
 * 
 * @param {Object} params
 * @param {string} params.sessionId - Database session UUID
 * @param {string} params.reason - End reason ('host_disconnect', 'host_clicked_end', 'timeout', etc.)
 * @returns {Promise<{ success: boolean, durationSeconds: number, eventRecorded: boolean }>}
 */
export async function stopSessionSpan({ sessionId, reason = 'unknown' }) {
    if (!sessionId) {
        throw new Error('stopSessionSpan requires sessionId');
    }

    try {
        // Find the active span (include metadata for mode detection)
        const { data: span, error: findError } = await supabaseAdmin
            .from('session_spans')
            .select('id, church_id, started_at, last_seen_at, metadata')
            .eq('session_id', sessionId)
            .is('ended_at', null)
            .single();

        if (findError) {
            if (findError.code === 'PGRST116') { // No rows found
                console.log(`[SessionSpans] ↩ No active span for session=${sessionId}`);
                return { success: true, durationSeconds: 0, eventRecorded: false };
            }
            throw findError;
        }

        // Determine metric based on mode in metadata
        // Mode should be 'solo' or 'host', defaults to 'session_seconds' for backwards compatibility
        const mode = span.metadata?.mode;
        let usageMetric = 'session_seconds'; // backwards compatibility
        if (mode === 'solo') {
            usageMetric = 'solo_seconds';
        } else if (mode === 'host') {
            usageMetric = 'host_seconds';
        }
        console.log(`[SessionSpans] 📊 Mode: ${mode || 'unknown'} → Metric: ${usageMetric}`);

        // Compute ended_at_effective: least(now, last_seen_at + 45s)
        const now = new Date();
        const lastSeen = span.last_seen_at ? new Date(span.last_seen_at) : new Date(span.started_at);
        const maxEndTime = new Date(lastSeen.getTime() + 45000); // 45 second grace
        const endedAtEffective = now < maxEndTime ? now : maxEndTime;

        // Compute duration
        const startedAt = new Date(span.started_at);
        const durationSeconds = Math.max(0, Math.floor((endedAtEffective.getTime() - startedAt.getTime()) / 1000));

        // Update the span as ended
        const { error: updateError } = await supabaseAdmin
            .from('session_spans')
            .update({
                ended_at: endedAtEffective.toISOString(),
                ended_reason: reason
            })
            .eq('id', span.id);

        if (updateError) {
            console.error(`[SessionSpans] ✗ Failed to update span:`, updateError.message);
            throw updateError;
        }

        // Record usage event (if duration > 0)
        let eventRecorded = false;
        if (durationSeconds > 0) {
            const startedAtEpoch = Math.floor(startedAt.getTime() / 1000);
            const idempotencyKey = `session:${sessionId}:${startedAtEpoch}`;

            try {
                const result = await recordUsageEvent({
                    church_id: span.church_id,
                    metric: usageMetric,
                    quantity: durationSeconds,
                    occurred_at: endedAtEffective,
                    idempotency_key: idempotencyKey,
                    metadata: {
                        session_id: sessionId,
                        reason: reason,
                        span_id: span.id,
                        mode: mode || 'unknown'
                    }
                });
                eventRecorded = result.inserted;

                // PROMINENT METERING LOG
                if (eventRecorded) {
                    console.log(`\n========================================`);
                    console.log(`📊 SESSION METERING RECORDED`);
                    console.log(`   Metric: ${usageMetric}`);
                    console.log(`   Duration: ${durationSeconds} seconds`);
                    console.log(`   Church: ${span.church_id}`);
                    console.log(`   Mode: ${mode || 'unknown'}`);
                    console.log(`   Reason: ${reason}`);
                    console.log(`   Key: ${idempotencyKey}`);
                    console.log(`========================================\n`);
                }
            } catch (usageErr) {
                console.error(`[SessionSpans] ⚠ Usage event failed (span still ended):`, usageErr.message);
                // Don't re-throw - span is already ended, usage recording is best-effort
            }
        }

        console.log(`[SessionSpans] ✓ Stopped span ${span.id}: ${durationSeconds}s, reason=${reason}, recorded=${eventRecorded}`);
        return { success: true, durationSeconds, eventRecorded };
    } catch (err) {
        console.error(`[SessionSpans] ✗ stopSessionSpan failed:`, err.message);
        throw err;
    }
}
