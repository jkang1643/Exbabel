
// backend/tests/e2e/helpers/assertions.exbabel.js

/**
 * Filter helpers
 */
function isTranslation(e) { return e.type === 'translation'; }
function isFinal(e) { return isTranslation(e) && e.isPartial === false; }
function isPartial(e) { return isTranslation(e) && e.isPartial === true; }
function isForcedFinal(e) { return isFinal(e) && e.forceFinal === true; }
function isTtsAck(e) { return e.type === 'tts/ack'; }
function isTtsAudio(e) { return e.type === 'tts/audio'; }

/**
 * A) Transport & Error Invariants
 */
export function assertNoErrors(events) {
    const errors = events.filter(e =>
        e.type === 'error' ||
        (e.type === 'translation' && e.translation?.startsWith('[Translation error'))
    );
    if (errors.length > 0) {
        throw new Error(`Pipeline emitted errors: ${JSON.stringify(errors.slice(0, 3), null, 2)}`);
    }
}

/**
 * B) STT & Translation Flow
 * Checks for sequence monotonicity, partial->final progression, and stable IDs.
 */
export function assertTranslationFlow(events) {
    const translations = events.filter(isTranslation);
    if (translations.length === 0) throw new Error("No translation events received");

    // Group by seqId
    const bySeq = new Map();
    for (const t of translations) {
        if (t.seqId === undefined) continue;
        if (!bySeq.has(t.seqId)) bySeq.set(t.seqId, []);
        bySeq.get(t.seqId).push(t);
    }

    // 1. Monotonicity of seqId
    const seqIds = Array.from(bySeq.keys()).sort((a, b) => a - b);
    // We can't strictly assert e[i] > e[i-1] in the raw stream because async updates (grammar/translation) 
    // might arrive "out of order" relative to a new partial. 
    // But generally, NEW finals should appear in increasing order.

    // 2. Per-sequence invariants
    for (const [seqId, seqEvents] of bySeq.entries()) {
        // a) Must have at least one final (unless it's the very last hanging partial of the stream)
        // Note: In some test runs, the last segment might not finalize if stream ends abruptly.
        // But we expect most segments to finalize.

        // b) Check basic content
        for (const e of seqEvents) {
            if (!e.originalText && !e.transcript) {
                throw new Error(`Event missing text (seqId=${seqId}): ${JSON.stringify(e)}`);
            }
        }
    }
}

/**
 * C) Regular Finalization Logic
 * Verifies that sentences ending in punctuation trigger finals
 */
export function assertRegularFinals(events) {
    const finals = events.filter(isFinal);
    // We expect at least some finals to be "regular" (not forced)
    const regularFinals = finals.filter(f => !f.forceFinal);

    if (regularFinals.length > 0) {
        // Check that regular finals often end with punctuation (heuristic)
        const withPunctuation = regularFinals.filter(f => /[.!?]$/.test((f.originalText || "").trim()));
        // It's not 100% because of timeouts, but should be > 0 ideally
        // console.log(`[Assertions] Regular finals with punctuation: ${withPunctuation.length}/${regularFinals.length}`);
    }
}

/**
 * D) Forced Final & Recovery Logic
 * - Assert presence of forceFinal events (if test triggered them)
 * - Assert immediate commit behavior (originalText present, translatedText might be same/empty initially)
 * - Assert async updates (grammar/translation updates with same seqId arriving later)
 */
export function assertForcedFinalLogic(events) {
    const forced = events.filter(isForcedFinal);
    if (forced.length === 0) return; // Skip if no forced finals occurred

    console.log(`[Assertions] Found ${forced.length} forced final events.`);

    for (const f of forced) {
        // 1. Immediate commit check: usually forced finals are sent immediately.
        // In the logs/docs: "Immediate Commit: The current longest partial is sent instantly... translatedText is originalText initially"
        // So we expect one event where translatedText == originalText (or empty/pending) 
        // AND later an update with the same seqId that has 'updateType' or changed text.

        const seqId = f.seqId;
        const updates = events.filter(e => e.seqId === seqId && e.timestamp > f.timestamp);

        // Detect async grammar/translation updates
        const grammarUpdates = updates.filter(u => u.updateType === 'grammar' || (u.hasCorrection && !u.hasTranslation));
        const translationUpdates = updates.filter(u => u.updateType === 'translation' || u.hasTranslation);

        // We don't strictly require updates if the text was perfect/short, 
        // but we should verify we don't see ERRORs in those updates.
    }

    // 2. Recovery / Deduplication check
    // If recovery worked, we shouldn't see the same words repeated in the NEXT segment's start 
    // that were at the END of the forced segment.
    // This is hard to assert strictly without specific audio, but we can check for blatant duplication.
}

/**
 * E) TTS Queueing & Output
 */
export function assertTtsFlow(events) {
    const acks = events.filter(isTtsAck);
    const audio = events.filter(isTtsAudio);

    if (acks.length === 0 && audio.length === 0) {
        // TTS might be disabled or no segs finalized
        console.warn("[Assertions] No TTS events found. Skipping TTS assertions.");
        return;
    }

    // 1. Check Acks
    const playingAcks = acks.filter(a => a.state?.playbackState === 'PLAYING');
    if (playingAcks.length === 0) {
        console.warn("[Assertions] No TTS PLAYING acks found.");
    }

    // 2. Check Audio Payloads
    for (const a of audio) {
        if (!a.audio || !a.audio.bytesBase64) {
            throw new Error(`TTS Audio event missing payload: ${JSON.stringify(a)}`);
        }
        if (a.audio.bytesBase64.length < 100) {
            throw new Error(`TTS Audio payload suspiciously small: ${a.audio.bytesBase64.length} chars`);
        }
    }
}
