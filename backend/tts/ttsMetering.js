/**
 * TTS Metering (Stub)
 * 
 * Builds metering event objects for TTS usage tracking.
 * No database writes yet - debug logging only.
 * 
 * Feature-flagged by TTS_METERING_DEBUG env var.
 */

/**
 * Record TTS metering event
 * @param {object} params
 * @param {string} params.orgId - Organization ID
 * @param {string} params.userId - User ID
 * @param {string} params.sessionId - Session ID
 * @param {string} params.segmentId - Segment ID
 * @param {string} params.tier - TTS tier used
 * @param {string} params.voiceName - Voice name used
 * @param {string} params.languageCode - Language code
 * @param {string} params.mode - Synthesis mode ('unary' | 'streaming')
 * @param {number} params.durationMs - Audio duration in milliseconds
 * @param {number} params.characters - Character count of synthesized text
 */
export function recordMeteringEvent({
    orgId,
    userId,
    sessionId,
    segmentId,
    tier,
    voiceName,
    languageCode,
    mode,
    durationMs,
    characters
}) {
    // Build metering event object
    const event = {
        timestamp: Date.now(),
        orgId,
        userId,
        sessionId,
        segmentId,
        tier,
        voiceName,
        languageCode,
        mode,
        durationMs: durationMs || null,
        characters
    };

    // Debug logging if enabled
    if (process.env.TTS_METERING_DEBUG === 'true') {
        console.log('[TtsMetering] Event:', JSON.stringify(event, null, 2));
    }

    // Future: Write to database, send to analytics service, etc.
    // For now, this is a no-op besides logging

    return event;
}
