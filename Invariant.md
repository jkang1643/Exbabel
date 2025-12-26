Invariants: 

0.1 4️⃣ Add this invariant (this one matters)

No segment may be created after audio for that segment has already contributed to another segment.

Or simpler (behavioral test):

expect(finals).not.toContain(["Oh boy.", "Oh boy. I've been to ..."])


0. Add an invariant test:

“Every segment that receives a FINAL or recovery must emit exactly one committed final”

1. Add an invariant test:

“No Grammar final may commit if recoveryPending === true”


2. The invariant you must enforce (non-negotiable)

No final may commit while a recovery promise is unresolved

or more precisely:

A recovery candidate always dominates grammar-only candidates for the same segment

3. 🔐 The invariant you must enforce (write this test)

Invariant:
When segmentId changes, FinalityGate must have zero pending recovery for the new segment.

If this invariant fails, everything you’re seeing happens again.

4. 
The invariant you MUST enforce (write this down)
🔒 Finalization Liveness Invariant

For every segment S:

If S.recoveryResolved === true
AND S.bestCandidate !== null
AND S.finalized === false

Then exactly one call to finalize(S) must occur.

This invariant must be enforced synchronously, not eventually, not implicitly.

5. 
✅ The invariant you MUST enforce (this is the key)
🔒 Segment Boundary Invariant (write this down)

The moment a new segment is detected, the previous segment must be either:

finalized immediately, or

explicitly abandoned (with a logged drop)

It must NEVER remain pending.

Right now, Segment A is left “floating”.

6. Invariant Test: Add an invariant test:

expect(final.text).toContain("gathered together")


But more importantly:

expect(final.source).toBe(CandidateSource.Recovery)

7. Invariant Seven

If FinalityGate transitions a segment to finalized=true, then the same call must synchronously enqueue/emit the FINAL to your outbound stream (host/frontend), using the same segmentId.

No “finalized” state updates that happen without the emit. No emits that happen without the gate transition.


If Grammar ever wins over Recovery → test fails.

8. So the next invariant to enforce is:

If recovery is pending for segment S, nothing may finalize S until recovery resolves.

🔒 Invariant 1 — Partial text is never finalizable

A PARTIAL segment may never be promoted directly to FINAL.

Allowed transitions:

PARTIAL → PARTIAL (overwrite)

PARTIAL → CANDIDATE

PARTIAL → DROPPED

🚫 Forbidden:

PARTIAL → FINAL

PARTIAL → HISTORY

This alone eliminates your “partial fragment keeps finalizing” bug class.

🔒 Invariant 2 — Grammar does not change identity

Grammar checks may modify text, but must not modify segment identity.

Meaning:

Same segment ID

Same temporal bounds

Same partial index

Why?
Because grammar is transformational, not semantic.

🚨 Violation symptom:

Grammar output being treated as a new segment

Grammar-modified partial seen as “new final content”

🔒 Invariant 3 — Extension checks operate on snapshots only

Extension checks must compare immutable snapshots, never live buffers.

That means:

Extension logic receives (previousFinalSnapshot, currentPartialSnapshot)

Never references a mutable currentPartial object

🚨 This is a major likely bug source in your system.

🔒 Invariant 4 — Forced finals are synthetic candidates, not finals

This one is subtle and extremely important:

A forced final is NOT a FINAL segment.
It is a synthetic CANDIDATE.

So:

FORCED FINAL ❌
FORCED CANDIDATE ✅


Why?
Because forced segments:

Still require recovery

Still require merge

Still require dedup

If you mark them FINAL too early, you guarantee:

partial leakage

double-finalization

history pollution

🚨 If your code ever says:

state = FINAL // before recovery+dedup


you’ve found a root cause.

🔒 Invariant 5 — Recovery output replaces, never extends

Audio recovery produces a replacement candidate, not an extension.

Meaning:

Recovered text does NOT append to forced text

It competes with it

Correct mental model:

forcedCandidate ⟂ recoveredCandidate
        ↓
      MERGE


🚫 Bad model:

forcedText += recoveredText


This is another likely fragment-duplication source.

🔒 Invariant 6 — Dedup runs exactly once per candidate

Deduplication is applied once, at the CANDIDATE stage.

Not:

before recovery

during partial extension

after final

Dedup sees:

(previousFinalSnapshot, currentCandidateSnapshot)


🚨 Multiple dedup passes = emergent bugs.

🔒 Invariant 7 — Finalization is index-monotonic

Final segments must have a strictly increasing finalIndex.

Rules:

finalIndex = lastFinalIndex + 1

If violated → reject

This prevents:

re-finalization

fragment re-emission

partials sneaking into history

🔒 Invariant 8 — History is append-only and immutable

History is write-once, append-only.

No:

rewriting

merging

extending history entries

If something needs fixing, it creates a new final segment, never mutates old ones.