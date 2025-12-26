1. Partial Non-Finality
PARTIAL may never be emitted as FINAL or written to history.

2. Snapshot Isolation
Any time we create a segment/candidate from a partial, it must be an immutable snapshot (no shared/mutable reference).

3. Forced Segments Are Candidates
“Forced finals” are not FINAL. They are CANDIDATE until recovery + dedup are done.

4. Recovery Dominance
If recovery is pending for a segment, grammar-only output cannot be finalized.
If recovery produces a candidate, it must beat grammar-only for that segment.

5. No Floating Segments
When a new segment begins, the previous segment must be finalized or explicitly dropped (no pending recovery/promises left behind).

6. Exactly-One Final Per Segment
A segment that reaches “ready to finalize” must emit exactly one final commit.

7. Finality Gate Atomicity
“Finalized=true” and emitting the FINAL message must happen together (no one without the other).

8. History Is Append-Only
Once a final is emitted, it is not edited. Corrections create a new final segment