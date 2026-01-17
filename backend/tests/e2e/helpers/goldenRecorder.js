
import fs from "fs";
import path from "path";
import { diff } from "jest-diff";
import util from "util";

// Simple Levenshtein distance for "tolerant" matching
function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
    for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
}

function similarity(a, b) {
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    return 1.0 - (dist / maxLen);
}

export class GoldenRecorder {
    constructor(testName, options = {}) {
        this.testName = testName;
        // Options can override
        this.textMode = process.env.GOLDEN_TEXT_MODE || options.mode || 'hybrid';
        // Hybrid anchors: explicit list of seqIds to be strict about. 
        // Could be passed in options, or we could default to "some anchors". 
        // For now, empty list unless passed.
        this.anchors = new Set(options.anchors || []);

        this.events = [];
        this.normalizedEventsByLang = {};
        this.partialCounts = {};

        // Invariant tracking
        this.lastSeqIdByLang = {};
        this.lastFinalSourceSeqIdByLang = {};

        this.goldenDir = path.resolve(process.cwd(), "tests/e2e/golden");

        // Ensure golden directory exists
        if (!fs.existsSync(this.goldenDir)) {
            fs.mkdirSync(this.goldenDir, { recursive: true });
        }
    }

    record(rawEvent) {
        this.events.push(rawEvent);
        this.normalize(rawEvent);
    }

    normalize(event) {
        let k = event.type;
        if (event.type === "translation" && event.isPartial) k = "stt.partial";
        else if (event.type === "translation" && !event.isPartial) k = "stt.final";
        else if (event.type === "segment" && event.isPartial) k = "seg.partial";
        else if (event.type === "segment" && !event.isPartial) k = "seg.final";
        else if (event.type === "tts" && event.state === "enqueued") k = "tts.enqueue";
        else if (event.type === "tts" && event.state === "playing") k = "tts.play";
        else if (event.type === "tts" && event.state === "ended") k = "tts.ended";

        if (!k) return;

        const lang = event.targetLang || event.lang || "unknown";
        if (!this.normalizedEventsByLang[lang]) {
            this.normalizedEventsByLang[lang] = [];
            this.partialCounts[lang] = 0;
            this.lastSeqIdByLang[lang] = -1;
            this.lastFinalSourceSeqIdByLang[lang] = -1;
        }

        const normalized = {
            k,
            seq: event.seqId,
            src: event.sourceSeqId,
            t: this.normalizeText(event.text || event.translation),
        };

        // --- Invariant Checks (Hard Fail / Log) ---

        // 1. SeqId Monotonicity (Global per lang)
        if (normalized.seq !== undefined) {
            const lastSeq = this.lastSeqIdByLang[lang];
            if (normalized.seq < lastSeq) {
                console.error(`[GoldenRecorder] INVARIANT VIOLATION: seqId went backwards! prev=${lastSeq}, curr=${normalized.seq}`);
            }
            this.lastSeqIdByLang[lang] = normalized.seq;
        }

        // 2. SourceSeqId Monotonicity (Finals Only)
        // Helps catch reordering even if emitted seqId is new.
        if (k.endsWith(".final") && normalized.src !== undefined) {
            const lastSrc = this.lastFinalSourceSeqIdByLang[lang];
            if (normalized.src < lastSrc) {
                console.error(`[GoldenRecorder] INVARIANT VIOLATION: final sourceSeqId went backwards! prev=${lastSrc}, curr=${normalized.src}`);
            }
            this.lastFinalSourceSeqIdByLang[lang] = normalized.src;
        }

        // --- Sampling ---
        // Basic sampling for partials
        if (k.endsWith(".partial")) {
            this.partialCounts[lang]++;
            const count = this.partialCounts[lang];
            // Allow first 5, then every 5th
            if (count > 5 && count % 5 !== 0) {
                return;
            }
        }

        // Cleanup undefined
        if (normalized.seq === undefined) delete normalized.seq;
        if (normalized.src === undefined) delete normalized.src;
        if (normalized.t === undefined) delete normalized.t;

        this.normalizedEventsByLang[lang].push(normalized);
    }

    normalizeText(text) {
        if (!text) return undefined;
        return text.trim().replace(/\s+/g, " ");
    }

    getGoldenPath() {
        return path.join(this.goldenDir, `${this.testName}.golden.json`);
    }

    async save() {
        const goldenPath = this.getGoldenPath();
        const output = {
            meta: {
                createdAt: new Date().toISOString(),
                textModeUsed: this.textMode
            },
            streams: this.normalizedEventsByLang
        };

        fs.writeFileSync(goldenPath, JSON.stringify(output, null, 2));
        console.log(`[GoldenRecorder] Saved golden file to ${goldenPath}`);
    }

    async verify() {
        const goldenPath = this.getGoldenPath();
        if (!fs.existsSync(goldenPath)) {
            throw new Error(`Golden file not found at ${goldenPath}. Run with GOLDEN_RECORD=1 to generate.`);
        }

        const goldenContent = JSON.parse(fs.readFileSync(goldenPath, "utf-8"));
        const expectedStreams = goldenContent.streams;
        const actualStreams = this.normalizedEventsByLang;

        console.log(`[GoldenRecorder] Verifying in mode: ${this.textMode.toUpperCase()}`);

        const langs = new Set([...Object.keys(expectedStreams), ...Object.keys(actualStreams)]);
        const report = {
            strictFailures: [],
            textFailures: []
        };

        for (const lang of langs) {
            const expected = expectedStreams[lang] || [];
            const actual = actualStreams[lang] || [];

            // --- Level 1: Structure (Strict) ---
            // Count Check for finals
            const expFinals = expected.filter(e => e.k.endsWith(".final"));
            const actFinals = actual.filter(e => e.k.endsWith(".final"));

            if (expFinals.length !== actFinals.length) {
                report.strictFailures.push(`[${lang}] Final count mismatch. Expected ${expFinals.length}, got ${actFinals.length}`);
                // Don't abort yet, check strict structure matching up to common length?
                // Actually count mismatch is usually fatal for alignment.
            }

            // --- Level 2: Sequence & Text ---
            // We iterate through FINALS to align and check text.
            // Partials are sampled, so we do a structural check on them but maybe lenient on text?
            // User focus is on "Final translations".

            // Let's pair up finals by index
            const maxLen = Math.min(expFinals.length, actFinals.length);
            for (let i = 0; i < maxLen; i++) {
                const e = expFinals[i];
                const a = actFinals[i];

                // Check Structure (Invariant: k, seq, src should match mostly? 
                // but seqId might shift if system is non-deterministic.
                // However user said: "Strict assertions for ordering + seq monotonicity"

                // If seqId is expected to be strictly deterministic:
                if (e.seq !== a.seq) {
                    report.strictFailures.push(`[${lang}] SeqId mismatch at final #${i}. Expected ${e.seq}, got ${a.seq}`);
                }
                if (e.src !== a.src) {
                    report.strictFailures.push(`[${lang}] SourceSeqId mismatch at final #${i}. Expected ${e.src}, got ${a.src}`);
                }

                // Check Text
                const expectedText = e.t || "";
                const actualText = a.t || "";

                let isStrictCheck = (this.textMode === 'strict');
                if (this.textMode === 'hybrid') {
                    // Start tolerant, but become strict if this is an anchor
                    // Anchor definition: "pick 10-20 anchor finals (by seqId)"
                    if (this.anchors.has(e.seq)) {
                        isStrictCheck = true;
                    }
                }

                if (isStrictCheck) {
                    if (expectedText !== actualText) {
                        report.textFailures.push({
                            mode: 'strict',
                            lang,
                            seq: e.seq,
                            expected: expectedText,
                            actual: actualText,
                            msg: "Exact match required"
                        });
                    }
                } else {
                    // Tolerant Check
                    const sim = similarity(expectedText, actualText);
                    const threshold = 0.90; // 90% strictness for "tolerant"
                    if (sim < threshold) {
                        report.textFailures.push({
                            mode: 'tolerant',
                            lang,
                            seq: e.seq,
                            expected: expectedText,
                            actual: actualText,
                            score: sim.toFixed(2),
                            msg: `Below threshold ${threshold}`
                        });
                    }
                }
            }
        }

        // --- Reporting ---
        let failed = false;

        if (report.strictFailures.length > 0) {
            console.error("\n❌ STRICT FAILURES (Structure/Ordering):");
            report.strictFailures.forEach(f => console.error(`  - ${f}`));
            failed = true;
        }

        if (report.textFailures.length > 0) {
            console.error("\n❌ TEXT FAILURES:");
            report.textFailures.forEach(f => {
                const context = `[${f.lang}] Seq ${f.seq}`;
                if (f.mode === 'strict') {
                    console.error(`  - ${context} STRICT MISMATCH:\n    Exp: "${f.expected}"\n    Act: "${f.actual}"`);
                } else {
                    console.error(`  - ${context} TOLERANT FAIL (Score: ${f.score}):\n    Exp: "${f.expected}"\n    Act: "${f.actual}"`);
                }
            });
            // Text failures fail the test too?
            // "tolerant failures => show score + context window". 
            // Usually if it fails tolerance, it's a fail.
            failed = true;
        }

        if (failed) {
            throw new Error(`[GoldenRecorder] Verification Failed. See logs for details.`);
        } else {
            console.log(`[GoldenRecorder] ✅ Verification Passed (Mode: ${this.textMode})`);
        }
    }
}
