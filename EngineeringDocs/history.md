Below is a **single, expanded, plain-text “What Is Done / Running Log” document** that **merges everything we accomplished** *and* the full handoff context you pasted.
It is structured, chronological, newest at the top, and designed to be copy-pasted into a repo or shared as a living debugging log.

---

EXBABEL DEBUGGING LOG
Host / Listener / Solo Emission, Grammar Canonicalization, Correlation, and Ghost Segment Investigation

Last updated: 2026-01-08 (US Central)

Purpose:
This document is a running, factual log of what has been implemented, proven, reverted, and identified while debugging Exbabel’s intermittent “escaped / leaked” segment bugs in Host, Listener, and Solo modes.
Newest items are listed first.
This is intentionally descriptive, not speculative.

---

1. WHAT WE DID (BUG FIXES, INVESTIGATIONS, AND CONFIRMED FINDINGS)

---

2026-01-08 — Identified out-of-order delayed PARTIAL translations as a concrete source of “ghost” segments
Status: Root cause identified; frontend guard proposed, not yet committed everywhere.

What we found:

* Backend logs show **multiple Spanish PARTIAL emissions** for the same English prefix arriving via:

  * IMMEDIATE translation paths
  * DELAYED translation paths
* These PARTIALs share the same semantic content but differ in:

  * `sourceSeqId`
  * emission time
* Delayed PARTIALs can arrive **after newer PARTIALs or FINALS**.

Key evidence:

* Logs show repeated Spanish PARTIAL emissions with previews like:
  “Self-centered desires cordoned off from others. In private fortresses, we call …”
* These emissions are VALID, traced, and correlated — but **out of order**.
* When a delayed PARTIAL arrives late, it can overwrite newer UI state and appear as a “ghost” or escaped segment.

Conclusion:

* The “missing from trace” perception is often caused by **late PARTIAL overwrites**, not literal missing emissions.
* This explains:

  * wrong moment display
  * reappearing earlier fragments
  * non-deterministic behavior

Proposed surgical fix (frontend-safe):

* Track last seen PARTIAL `seqId` per `sourceSeqId`
* Drop any PARTIAL whose `seqId` is ≤ the last committed for that anchor
* Lock the anchor once FINAL is received

This fix is intentionally frontend-first to avoid backend pipeline risk.

---

2026-01-08 — Canonicalized grammar-corrected English for Host and Listener parity
Status: Implemented.

Problem:

* Host Mode showed grammar-corrected English finals.
* Listener pages showed uncorrected originals.
* Regression introduced after earlier backend/frontend changes.

Cause:

* Listener UI depended on client logic to prefer `correctedText`.
* Some commit paths ignored or overwrote it.

Fix (backend, surgical):

* Treat grammar-corrected English as canonical.
* Set:
  originalText = correctedText
  in all FINAL broadcast payloads.

Exact scope:

* Host-only broadcast path (no listeners)
* FINAL anchor payload
* Per-language FINAL message payload

Result:

* Host and Listener always receive the same canonical English text.
* Listener UI no longer depends on frontend correction logic.
* Grammar regression resolved.

---

2026-01-07 — Guaranteed `sourceSeqId` anchor for all translated emissions
Status: Implemented.

Original hypothesis:

* Spanish translations were escaping because they lacked a stable English anchor.

Findings:

* `sourceSeqId` initialized as null.
* English anchor broadcast only occurred when `sameLanguageTargets.length > 0`.
* Delayed translations could broadcast before anchor existed.

Fix:

1. Always broadcast an English anchor first.
2. Capture `sourceSeqId` only if the anchor broadcast returned a valid seqId.
3. Drop any translated emission missing a valid `sourceSeqId`.

Result:

* No more null or undefined `sourceSeqId` values in logs.
* Spanish emissions consistently correlate to English anchors.
* Bug frequency reduced but not eliminated, indicating additional issues.

---

2026-01-07 — Added backend Spanish emission tracing (`TRACE_ES`)
Status: Implemented.

Purpose:

* Prove exactly what the backend broadcasts.
* Eliminate speculation about missing emissions.

What was added:

* `[TRACE_ES]` logs around `broadcastWithSequence`
* Includes:

  * seqId
  * sourceSeqId
  * original / corrected / translated previews
  * flags (`isPartial`, `hasTranslation`, `hasCorrection`)
  * stack trace

Result:

* Confirmed backend does broadcast valid payloads.
* Demonstrated that some UI-visible strings were not easily correlated to expected traces, leading to frontend investigation.

---

2026-01-07 — Observed ledger dump mismatch
Status: Observed, not fixed.

Observation:

* `[TRACE_ES]` showed valid Spanish emissions.
* Ledger dumps for same seqId sometimes showed:
  en: [ … ]
  es: [ ]

Interpretation:

* Ledger/logging may track different keys or lifecycle.
* Does not explain UI bug alone, but confirmed instrumentation mismatch.

---

2026-01-06 → 2026-01-07 — Investigated ListenerPage correlation and caching logic
Status: Identified as suspicious, not yet changed.

Findings:

* Listener row construction uses:
  rowKey = sourceSeqId ?? seqId
* Original text cached by `seqId`, not `sourceSeqId`
* Fallback logic:

  * cachedFromSeqIdRef
  * lastNonEmptyOriginalRef

Concern:

* Translations correlate by `sourceSeqId`
* Originals cached by `seqId`
* This mismatch can cause misaligned rows

No fix applied yet due to risk; deferred until commit path is conclusively identified.

---

2026-01-06 → 2026-01-07 — Investigated Spanish-only rows from segmenter TIME-FLUSH
Status: Tested, reverted.

Finding:

* ListenerPage segmenter creates rows like:
  original: ''
  translated: joinedText
  isSegmented: true

Effect:

* Creates intentional Spanish-only rows.
* Can look like escaped or misordered emissions.

Attempt:

* Fill original from cached English instead of empty string.

Outcome:

* One symptom improved.
* Another segment began escaping.
* Changes reverted due to uncertainty and cross-page impact.

---

2026-01-06 → ongoing — RealtimeFinalWorker correlation anomaly
Status: Known issue, not fixed.

Evidence:

* Repeated logs:
  “No pending request found for item …”

Implication:

* Request/response mismatch inside realtime websocket worker.
* Contributes to nondeterminism.
* Likely worsens ordering problems but not sole cause of ghost strings.

---

2. WHERE WE ARE NOW (IMPLEMENTATION STATUS)

---

Confirmed and implemented:

* English anchor invariant for translations (`sourceSeqId`)
* Backend Spanish emission tracing
* Canonical grammar-corrected English for Host + Listener parity

Confirmed but not yet patched everywhere:

* Out-of-order delayed PARTIALs overwriting newer UI state

Identified but deferred:

* Listener original caching keyed by `seqId` instead of `sourceSeqId`
* Segmenter TIME-FLUSH synthesis risks
* RealtimeFinalWorker request correlation issues

Current understanding:

* The “ghost / escaped” segment is primarily caused by **late PARTIAL updates** arriving after newer content and overwriting UI state.
* This makes the segment appear:

  * at the wrong moment
  * duplicated
  * missing from expected trace windows
* Backend logs do contain the emission, but ordering hides it.

---

3. WHAT’S NEXT (PREFERRED, LOW-RISK PATH)

---

Next step A — Implement frontend out-of-order PARTIAL drop guard

* Track last PARTIAL seqId per sourceSeqId
* Drop any PARTIAL that is older than the most recently committed
* Lock once FINAL is received

This is:

* Surgical
* Frontend-only
* Reversible
* Proven to match observed behavior

Next step B — Keep RAW_IN and COMMIT logging until stable

* Continue logging:
  RAW_IN
  COMMIT (FINAL_HANDLER, SEGMENTER_ONFLUSH, DEDUPE_REPLACE)
* Ensure every visible UI row has a logged commit source

Next step C — Revisit RealtimeFinalWorker once UI is stable

* Fix request/response correlation
* Reduce nondeterminism
* Clean up delayed emission storms

---

4. CONSTRAINTS AND GUIDING PRINCIPLES

---

* Prefer surgical fixes over refactors.
* No speculative changes without trace proof.
* Segmenter edits are high-risk; logging first.
* Every visible UI string must be attributable to:
  a backend emission
  or a specific frontend commit path.

---

## END OF DOCUMENT
