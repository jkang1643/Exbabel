// backend/tests/e2e/helpers/assertions.deep.js

function groupBy(arr, keyFn) {
    const m = new Map();
    for (const x of arr) {
        const k = keyFn(x);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(x);
    }
    return m;
}

export function buildAnalysis(events) {
    const translation = events.filter((e) => e.type === "translation");
    const ttsAudio = events.filter((e) => e.type === "tts/audio");
    const ttsAck = events.filter((e) => e.type === "tts/ack");

    const perLang = groupBy(translation, (e) => e.targetLang || "unknown");

    const lifecycle = {};
    for (const [lang, evs] of perLang.entries()) {
        evs.sort((a, b) => (a.serverTimestamp ?? 0) - (b.serverTimestamp ?? 0));

        const perSeq = groupBy(evs, (e) => String(e.seqId));
        lifecycle[lang] = {};

        for (const [seqId, seqEvents] of perSeq.entries()) {
            const partials = seqEvents.filter((e) => e.isPartial === true);
            const finals = seqEvents.filter((e) => e.isPartial === false);

            lifecycle[lang][seqId] = {
                seqId: Number(seqId),
                firstTs: seqEvents[0].serverTimestamp ?? null,
                lastTs: seqEvents[seqEvents.length - 1].serverTimestamp ?? null,
                partialCount: partials.length,
                finalCount: finals.length,
                hasForceFinal: finals.some((f) => f.forceFinal === true),
                lastPartialLen:
                    partials.length
                        ? (partials[partials.length - 1].transcript ?? partials[partials.length - 1].originalText ?? "").length
                        : 0,
                finalText:
                    finals.length
                        ? (finals[0].translatedText ?? finals[0].translation ?? finals[0].transcript ?? "").slice(0, 120)
                        : null,
            };
        }
    }

    return {
        counts: {
            total: events.length,
            translation: translation.length,
            ttsAck: ttsAck.length,
            ttsAudio: ttsAudio.length,
        },
        lifecycle,
    };
}

export function assertCoreEngineDeep(events, opts = {}) {
    const {
        expectedTargetLangs = [],
        maxFinalsPerSeq = 1,
        maxSecondsToFinalize = 10,
        requirePartials = true,
    } = opts;

    const translation = events.filter((e) => e.type === "translation");
    if (!translation.length) throw new Error("No translation events received.");

    // Required languages present
    for (const lang of expectedTargetLangs) {
        if (!translation.some((e) => e.targetLang === lang)) {
            throw new Error(`Expected targetLang=${lang} to appear but did not.`);
        }
    }

    const byLang = groupBy(translation, (e) => e.targetLang || "unknown");

    for (const [lang, evs] of byLang.entries()) {
        if (lang === "unknown") continue;

        // Sort by timestamp for lifecycle checks
        evs.sort((a, b) => (a.serverTimestamp ?? 0) - (b.serverTimestamp ?? 0));

        // 1) seqId monotonic (allow repeats)
        let lastSeq = -Infinity;
        for (const e of evs) {
            if (!Number.isFinite(e.seqId)) throw new Error(`Missing seqId for lang=${lang}`);
            if (e.seqId < lastSeq) throw new Error(`seqId went backwards for lang=${lang}: ${lastSeq} -> ${e.seqId}`);
            lastSeq = e.seqId;
        }

        // 2) per-seq lifecycle
        const perSeq = groupBy(evs, (e) => String(e.seqId));
        const finalizedSeqs = new Set();

        for (const [seqId, seqEvents] of perSeq.entries()) {
            const partials = seqEvents.filter((e) => e.isPartial === true);
            const finals = seqEvents.filter((e) => e.isPartial === false);

            if (requirePartials && partials.length === 0 && !finals.some(f => f.forceFinal)) {
                // Not always guaranteed, but if your system always emits partials, keep it strict.
                throw new Error(`No partials observed for lang=${lang} seqId=${seqId}`);
            }

            if (finals.length > maxFinalsPerSeq) {
                throw new Error(`Duplicate finals for lang=${lang} seqId=${seqId} (finals=${finals.length})`);
            }

            if (finals.length === 1) {
                finalizedSeqs.add(Number(seqId));

                const f = finals[0];
                const text = f.transcript ?? f.originalText;
                if (typeof text !== "string" || !text.trim()) {
                    throw new Error(`Final missing transcript/originalText for lang=${lang} seqId=${seqId}`);
                }
                if (f.hasTranslation) {
                    const t = f.translatedText ?? f.translation;
                    if (typeof t !== "string" || !t.trim()) {
                        throw new Error(`Final hasTranslation=true but no translatedText for lang=${lang} seqId=${seqId}`);
                    }
                }
                if (f.hasCorrection) {
                    if (typeof f.correctedText !== "string" || !f.correctedText.trim()) {
                        throw new Error(`Final hasCorrection=true but correctedText empty for lang=${lang} seqId=${seqId}`);
                    }
                }
            }

            // 3) partials after final = bug
            if (finals.length === 1) {
                const finalTs = finals[0].serverTimestamp ?? 0;
                const afterFinalPartial = partials.find((p) => (p.serverTimestamp ?? 0) > finalTs + 5);
                if (afterFinalPartial) {
                    throw new Error(`Partial emitted after final for lang=${lang} seqId=${seqId}`);
                }
            }

            // 4) stuck partial detection
            if (partials.length > 0 && finals.length === 0) {
                const firstTs = partials[0].serverTimestamp ?? null;
                const lastTs = partials[partials.length - 1].serverTimestamp ?? null;
                if (firstTs && lastTs) {
                    const ageSec = (lastTs - firstTs) / 1000;
                    if (ageSec > maxSecondsToFinalize) {
                        throw new Error(`Seq appears stuck in partial for lang=${lang} seqId=${seqId} ageSec=${ageSec.toFixed(1)}`);
                    }
                }
            }

            // 5) partial progress detector (optional but useful)
            if (partials.length >= 3) {
                const lens = partials.map(
                    (p) => (p.transcript ?? p.originalText ?? "").length
                );
                const maxLen = Math.max(...lens);
                const minLen = Math.min(...lens);
                if (maxLen <= 2 && (partials.length >= 5)) {
                    throw new Error(`Partials not progressing for lang=${lang} seqId=${seqId} lens=${lens.join(",")}`);
                }
                if (maxLen + 10 < minLen) {
                    throw new Error(`Partial text regressed drastically for lang=${lang} seqId=${seqId}`);
                }
            }
        }

        // 6) “older seq never finalized but newer did” (classic freeze regression)
        // [DISABLED] logic assumes seqId is monotonic per utterance, but it's per message
        /*
        const seqNums = [...perSeq.keys()].map(Number).sort((a, b) => a - b);
        for (const s of seqNums) {
            const hasFinal = perSeq.get(String(s)).some((e) => e.isPartial === false);
            if (!hasFinal) {
                const newerFinalExists = seqNums.some((n) => n > s && perSeq.get(String(n)).some((e) => e.isPartial === false));
                if (newerFinalExists) {
                    throw new Error(`Freeze pattern: seqId=${s} never finalized but newer seqIds did (lang=${lang})`);
                }
            }
        }
        */
    }
}

export function assertTtsMapping(events, { requireTts = false } = {}) {
    const finals = events.filter((e) => e.type === "translation" && e.isPartial === false && e.hasTranslation);
    const audios = events.filter((e) => e.type === "tts/audio");
    const acks = events.filter((e) => e.type === "tts/ack");

    if (requireTts && !acks.length) throw new Error("TTS required but no tts/ack received.");
    if (requireTts && !audios.length) throw new Error("TTS required but no tts/audio received.");
    if (!acks.length && !audios.length) return;

    const finalSeqIds = new Set(finals.map((f) => String(f.seqId)));

    for (const a of audios) {
        if (!finalSeqIds.has(String(a.segmentId))) {
            throw new Error(`tts/audio orphan: segmentId=${a.segmentId} has no matching final translation seqId`);
        }
        const b64 = a?.audio?.bytesBase64;
        if (typeof b64 !== "string" || b64.length < 32) throw new Error(`tts/audio missing bytesBase64 for segmentId=${a.segmentId}`);
    }
}
