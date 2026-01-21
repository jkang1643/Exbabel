# 2026-01-20 Engine Word Loss Improvements

**Date:** January 20, 2026
**Component:** Backend (HostModeHandler, CoreEngine)
**Impact:** Critical fix for dropped words during split-second segment transitions.

## Overview

We identified and resolved three distinct race conditions that caused word loss when users spoke in rapid-fire bursts or when Google Speech split segments unpredictably. These issues were "invisible" to standard logic because they occurred in the milliseconds between segment finalization and new segment detection.

## 1. Partial Tracker Grace Period (The "First Word" Fix)

### Problem
When a segment was finalized, `partialTracker` was reset immediately.
If the user continued speaking without pause, the *first partial* of the *new* segment often arrived **before** the reset completed or was processed in the wrong order relative to the reset, causing the tracker to lose the first word of the new segment context.

### Root Cause
Race condition between `processFinalText` (which calls `reset`) and the incoming stream of new partials.

### Solution
Implemented a **500ms Grace Period** before resetting the partial tracker.
*   **Mechanism**: `setTimeout` wrapping the `partialTracker.reset()`.
*   **Effect**: The tracker remains active for 500ms after a final, allowing it to "catch" the initial partials of the next segment and seamlessly transition without losing context.

```javascript
// hostModeHandler.js
partialTrackerResetTimeout = setTimeout(() => {
    partialTracker.reset();
    syncPartialVariables();
    console.log(`[HostMode] 🧹 Reset partial tracking after 500ms grace period...`);
}, 500); // 500ms grace period
```

---

## 2. Stale Pending Final Recovery (The "Tail End" Fix)

### Problem
**Scenario**: User says "nurse picked him up".
1. System hears partial: "...his nurse"
2. `pendingFinalization` (safe buffer) holds: "...mountain" (from previous context)
3. **New Segment** ("Him...") starts abruptly.
4. System detects new segment -> forces commit of `pendingFinalization`.
5. **Result**: It committed "...mountain", discarding "...his nurse". "nurse picked" is lost.

### Root Cause
The `pendingFinalization` variable lags behind the raw `partialTracker` updates (waiting for stability). When a forced commit happened, we used the "stale" stable value instead of the "fresh" raw value.

### Solution
Before force-committing due to a new segment, we now **check the Partial Tracker**.
If the tracker has a longer/newer version of the text than the pending final, we commit the tracker's version instead.

```javascript
// hostModeHandler.js (New Segment Detection)
const trackerSnapshot = partialTracker.getSnapshot();
const bestTrackerText = trackerSnapshot.longestPartialText || trackerSnapshot.latestPartialText;

// If tracker text is better than pending final, use it
if (bestTrackerText.length > textToCommit.length && ...) {
    console.log(`[HostMode] ⚠️ Recovering uncommitted tail from tracker...`);
    textToCommit = bestTrackerText;
}
```

---

## 3. Ignored Short Partial Flushing (The "Rapid-Fire" Fix)

### Problem
**Scenario**: User says "One. Two. Three." (Rapidly)
1. "One" arrives as a partial. It is **< 15 chars**, so `hostModeHandler` ignores it (to avoid noise).
2. "Two" arrives as a **New Segment**.
3. System switches to "Two".
4. "One" is discarded because it was never finalized and never "grew" long enough to be sent.

### Root Cause
The logic correctly ignores short partials *assuming they will grow*. But if a new segment starts immediately, they never grow—they are replaced.

### Solution
When a **New Segment** is detected, we check for **"Leftover" Ignored Partials**.
If the tracker holds a valid partial (like "One") that differs from the new segment ("Two"), we **force commit** the leftover immediately before processing the new segment.

```javascript
// hostModeHandler.js (New Segment Start)
if (isNewSegmentStart) {
    const leftoverPartial = partialTracker.getSnapshot().latestPartialText;
    
    // If we have a leftover that isn't the new text
    if (leftoverPartial && !transcriptText.startsWith(leftoverPartial)) {
        console.log(`[HostMode] ⚠️ Recovering ignored short partial: "${leftoverPartial}"`);
        processFinalText(leftoverPartial); // Force commit "One"
        partialTracker.reset(); // Clear it
    }
}
```

## Summary of Results

These three fixes combined ensure that:
1.  **Segment Starts** are protected (Grace Period).
2.  **Segment Ends** are rescued (Stale Final Recovery).
3.  **Short Rapid Segments** are preserved (Ignored Partial Flushing).

The system now handles high-speed, interruptive speech patterns without dropping words at the boundaries.
