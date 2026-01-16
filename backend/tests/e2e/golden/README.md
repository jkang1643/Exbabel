# Golden Run E2E Testing

The "Golden Run" is a battle-tested E2E pipeline for the real-time translation engine. It captures a deterministic baseline of WebSocket events to ensure that future changes do not cause regressions in behavior, ordering, or translation quality.

## Overview

A Golden Run captures the **whole system behavior** by recording a normalized timeline of events during a known-good execution. Future runs compare their output against this "Golden" baseline.

### What is Captured (Deterministic Signals)
- **Event Timeline**: Normalized WS frames (STT partials, finals, translations, TTS events).
- **Sequencing**: `seqId` and `sourceSeqId` monotonicity.
- **Segment Boundaries**: Finalized sentences produced by the engine.
- **Translation Text**: Normalized and cleaned text for each language stream.
- **TTS Health**: Enqueue/Play/Ended state transitions.

### What is NOT Captured (Flaky Signals)
- **Exact Timestamps**: Normalized into relative ordering.
- **Audio Blob Durations**: Varies by network/codec.
- **Raw Partials**: Sampled (every 5th) to prevent explosion and minor timing noise.

---

## The 2-Phase Workflow

### Phase A: Record Mode (Intentional Updates)
When you introduce a change that intentionally alters the output (e.g., changing a prompt or model), you must update the golden file.
```bash
GOLDEN_RECORD=1 npm test -- tests/e2e/e2e.golden.test.js
```
This saves a normalized JSON to `backend/tests/e2e/golden/<testname>.golden.json`.

### Phase B: Verify Mode (Default / CI)
This is the default mode used in CI to ensure no regressions occurred.
```bash
npm test -- tests/e2e/e2e.golden.test.js
```
It compares actual output against the golden JSON using the configured **Text Mode**.

---

## Verification Modes (`GOLDEN_TEXT_MODE`)

You can control how strictly text differences are treated using the `GOLDEN_TEXT_MODE` environment variable:

| Mode | Behavior | Use Case |
| :--- | :--- | :--- |
| `strict` | Requires byte-for-byte equality of final translations. | Low-level refactors where output must remain identical. |
| `tolerant` | Uses Levenshtein similarity (Threshold: 0.90) to allow minor wording shifts. | General pipeline checks where slight model drift is expected. |
| `hybrid` | **(Default)** Strict on specified "Anchor" segments, tolerant on everything else. | Production-grade regression testing. |

### Anchors (Hybrid Mode)
In `e2e.golden.test.js`, we define "Anchors" (by `seqId`) that must always match exactly, even in hybrid mode. This ensures critical segments (e.g., the opening of a sermon) remain perfect while allowing minor drift elsewhere.

---

## Invariants (Hard Failures)

Regardless of the text mode, the system enforces several "Invariants" that cause immediate failure if violated:

1. **Sequence Monotonicity**: `seqId` must never go backwards within a language stream.
2. **Source Sequence Monotonicity**: `sourceSeqId` for final segments must be strictly increasing. This catches reordering issues that `seqId` alone might mask.
3. **Event Count**: The number of final segments must match the golden file exactly.
4. **Structure**: The sequence of event types (`stt.final`, `tts.play`, etc.) must remain stable.

---

## Failure Reporting

When a verification fails, the `GoldenRecorder` provides a detailed report:
- **Strict Failures**: Direct listing of structure or invariant violations.
- **Text Failures**: Shows the Expected vs Actual text, the similarity score, and the context window (Language + SeqId).

Example Report:
```
❌ TEXT FAILURES:
  - [es] Seq 21 TOLERANT FAIL (Score: 0.76):
    Exp: "Iglesia en el pueblo. He estado."
    Act: "Iglesia en la ciudad. He estado."
```

## How to add a new Golden Test
1. Create a new test case in `tests/e2e/e2e.golden.test.js` (or a new file).
2. Instantiate `GoldenRecorder(testName)`.
3. Hook `recorder.record(msg)` into your WebSocket message handler.
4. Call `recorder.save()` or `recorder.verify()` at the end based on `process.env.GOLDEN_RECORD`.
