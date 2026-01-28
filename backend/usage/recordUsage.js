/**
 * Usage Recording Service
 * 
 * Records usage events atomically with idempotency guarantees.
 * Uses Postgres RPC function for atomic event + daily aggregation.
 * 
 * @module usage/recordUsage
 */

import { supabaseAdmin } from "../supabaseAdmin.js";

/**
 * Records a usage event atomically.
 * 
 * - Inserts into usage_events (ignores duplicates via idempotency_key)
 * - Updates usage_daily only if insert succeeded (no double-counting)
 * 
 * @param {object} params
 * @param {string} params.church_id - Church UUID
 * @param {string} params.metric - Metric name (e.g., 'transcription_seconds', 'tts_characters')
 * @param {number} params.quantity - Amount to record
 * @param {string} [params.idempotency_key] - Unique key for deduplication
 * @param {Date} [params.occurred_at] - Event timestamp (defaults to now)
 * @param {object} [params.metadata] - Additional metadata (session_id, etc.)
 * @returns {Promise<{ inserted: boolean, event_id: string | null }>}
 */
export async function recordUsageEvent({
    church_id,
    metric,
    quantity,
    idempotency_key = null,
    occurred_at = new Date(),
    metadata = null
}) {
    if (!church_id || !metric || quantity === undefined) {
        throw new Error('recordUsageEvent requires church_id, metric, and quantity');
    }

    try {
        const { data, error } = await supabaseAdmin.rpc('record_usage_event', {
            p_church_id: church_id,
            p_metric: metric,
            p_quantity: quantity,
            p_occurred_at: occurred_at.toISOString(),
            p_idempotency_key: idempotency_key,
            p_metadata: metadata
        });

        if (error) {
            console.error(`[Usage] ✗ RPC error:`, error.message);
            throw error;
        }

        const result = data?.[0] || { inserted: false, event_id: null };

        if (result.inserted) {
            console.log(`[Usage] ✓ Recorded: ${metric}=${quantity} for church ${church_id}`);
        } else {
            console.log(`[Usage] ↩ Duplicate (idempotency_key exists): ${idempotency_key}`);
        }

        return result;
    } catch (err) {
        console.error(`[Usage] ✗ recordUsageEvent failed:`, err.message);
        throw err;
    }
}

/**
 * Generates an idempotency key for usage events.
 * 
 * Format: ws:{session_id}:{metric}:{window_start_unix}
 * 
 * @param {string} sessionId - WebSocket session ID
 * @param {string} metric - Metric name
 * @param {number} [windowSeconds=30] - Window size in seconds
 * @returns {string} Idempotency key
 */
export function generateIdempotencyKey(sessionId, metric, windowSeconds = 30) {
    const windowStart = Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds;
    return `ws:${sessionId}:${metric}:${windowStart}`;
}
