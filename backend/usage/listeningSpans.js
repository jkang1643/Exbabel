/**
 * Listening Spans Service
 * 
 * Tracks wall-clock listening time for metering and quota enforcement.
 * Each span represents a Start→Stop listening period for a user in a session.
 * 
 * @module usage/listeningSpans
 */

import { supabaseAdmin } from "../supabaseAdmin.js";
import { recordUsageEvent } from "./recordUsage.js";

/**
 * Starts a listening span for a user in a session.
 * Idempotent: unique index ensures at most one active span per (session_id, user_id).
 * 
 * @param {Object} params
 * @param {string} params.sessionId - Database session UUID
 * @param {string} params.userId - User UUID
 * @param {string} params.churchId - Church UUID (denormalized for fast filtering)
 * @returns {Promise<{ success: boolean, spanId: string | null, alreadyActive: boolean }>}
 */
export async function startListening({ sessionId, userId, churchId }) {
    if (!sessionId || !userId || !churchId) {
        throw new Error('startListening requires sessionId, userId, and churchId');
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('listening_spans')
            .insert({
                session_id: sessionId,
                user_id: userId,
                church_id: churchId,
                started_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString()
            })
            .select('id')
            .single();

        if (error) {
            // Check for unique constraint violation (already active span)
            if (error.code === '23505') { // Postgres unique violation
                console.log(`[ListeningSpans] ↩ Already active span for session=${sessionId}, user=${userId}`);
                return { success: true, spanId: null, alreadyActive: true };
            }
            console.error(`[ListeningSpans] ✗ startListening error:`, error.message);
            throw error;
        }

        console.log(`[ListeningSpans] ✓ Started span ${data.id} for session=${sessionId}, user=${userId}`);
        return { success: true, spanId: data.id, alreadyActive: false };
    } catch (err) {
        console.error(`[ListeningSpans] ✗ startListening failed:`, err.message);
        throw err;
    }
}

/**
 * Updates the heartbeat timestamp for an active listening span.
 * Call this every 30 seconds while user is actively listening.
 * 
 * @param {Object} params
 * @param {string} params.sessionId - Database session UUID
 * @param {string} params.userId - User UUID
 * @returns {Promise<{ success: boolean, updated: boolean }>}
 */
export async function heartbeat({ sessionId, userId }) {
    if (!sessionId || !userId) {
        throw new Error('heartbeat requires sessionId and userId');
    }

    try {
        const { data, error } = await supabaseAdmin
            .from('listening_spans')
            .update({ last_seen_at: new Date().toISOString() })
            .eq('session_id', sessionId)
            .eq('user_id', userId)
            .is('ended_at', null)
            .select('id');

        if (error) {
            console.error(`[ListeningSpans] ✗ heartbeat error:`, error.message);
            throw error;
        }

        const updated = data && data.length > 0;
        if (updated) {
            console.log(`[ListeningSpans] ♥ Heartbeat for session=${sessionId}, user=${userId}`);
        }
        return { success: true, updated };
    } catch (err) {
        console.error(`[ListeningSpans] ✗ heartbeat failed:`, err.message);
        throw err;
    }
}

/**
 * Stops a listening span and records the usage event.
 * 
 * @param {Object} params
 * @param {string} params.sessionId - Database session UUID
 * @param {string} params.userId - User UUID
 * @param {string} params.reason - End reason ('stop_button', 'ws_disconnect', 'timeout', etc.)
 * @returns {Promise<{ success: boolean, durationSeconds: number, eventRecorded: boolean }>}
 */
export async function stopListening({ sessionId, userId, reason = 'unknown' }) {
    if (!sessionId || !userId) {
        throw new Error('stopListening requires sessionId and userId');
    }

    try {
        // Find the active span
        const { data: span, error: findError } = await supabaseAdmin
            .from('listening_spans')
            .select('id, church_id, started_at, last_seen_at')
            .eq('session_id', sessionId)
            .eq('user_id', userId)
            .is('ended_at', null)
            .single();

        if (findError) {
            if (findError.code === 'PGRST116') { // No rows found
                console.log(`[ListeningSpans] ↩ No active span for session=${sessionId}, user=${userId}`);
                return { success: true, durationSeconds: 0, eventRecorded: false };
            }
            throw findError;
        }

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
            .from('listening_spans')
            .update({
                ended_at: endedAtEffective.toISOString(),
                ended_reason: reason
            })
            .eq('id', span.id);

        if (updateError) {
            console.error(`[ListeningSpans] ✗ Failed to update span:`, updateError.message);
            throw updateError;
        }

        // Record usage event (if duration > 0)
        let eventRecorded = false;
        if (durationSeconds > 0) {
            const idempotencyKey = `listen:${sessionId}:${userId}:${Math.floor(startedAt.getTime() / 1000)}`;

            try {
                const result = await recordUsageEvent({
                    church_id: span.church_id,
                    metric: 'listening_seconds',
                    quantity: durationSeconds,
                    occurred_at: endedAtEffective,
                    idempotency_key: idempotencyKey,
                    metadata: {
                        session_id: sessionId,
                        user_id: userId,
                        reason: reason,
                        span_id: span.id
                    }
                });
                eventRecorded = result.inserted;
            } catch (usageErr) {
                console.error(`[ListeningSpans] ⚠ Usage event failed (span still ended):`, usageErr.message);
                // Don't re-throw - span is already ended, usage recording is best-effort
            }
        }

        console.log(`[ListeningSpans] ✓ Stopped span ${span.id}: ${durationSeconds}s, reason=${reason}, recorded=${eventRecorded}`);
        return { success: true, durationSeconds, eventRecorded };
    } catch (err) {
        console.error(`[ListeningSpans] ✗ stopListening failed:`, err.message);
        throw err;
    }
}

/**
 * Force-stops all active spans for a session (for when session ends).
 * 
 * @param {string} sessionId - Database session UUID
 * @param {string} reason - End reason
 * @returns {Promise<{ stoppedCount: number }>}
 */
export async function stopAllListeningForSession(sessionId, reason = 'session_ended') {
    if (!sessionId) {
        throw new Error('stopAllListeningForSession requires sessionId');
    }

    try {
        // Find all active spans for this session
        const { data: spans, error: findError } = await supabaseAdmin
            .from('listening_spans')
            .select('id, user_id, church_id, started_at, last_seen_at')
            .eq('session_id', sessionId)
            .is('ended_at', null);

        if (findError) {
            throw findError;
        }

        if (!spans || spans.length === 0) {
            console.log(`[ListeningSpans] No active spans to stop for session=${sessionId}`);
            return { stoppedCount: 0 };
        }

        // Stop each span
        let stoppedCount = 0;
        for (const span of spans) {
            try {
                await stopListening({
                    sessionId,
                    userId: span.user_id,
                    reason
                });
                stoppedCount++;
            } catch (err) {
                console.error(`[ListeningSpans] ⚠ Failed to stop span for user=${span.user_id}:`, err.message);
            }
        }

        console.log(`[ListeningSpans] ✓ Stopped ${stoppedCount} spans for session=${sessionId}`);
        return { stoppedCount };
    } catch (err) {
        console.error(`[ListeningSpans] ✗ stopAllListeningForSession failed:`, err.message);
        throw err;
    }
}
