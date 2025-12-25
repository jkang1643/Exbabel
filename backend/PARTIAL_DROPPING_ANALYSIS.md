# Host Mode Partial Dropping Analysis

## Critical Bugs Identified

### Bug 1: Early Return Prevents Partial Processing (Line 1975)
**Location**: `backend/host/adapter.js:1975`

```javascript
if (!endsWithCompleteSentence && timeSinceFinal < 2000) {
  console.log(`[HostMode] ⏳ Partial text is mid-sentence and new segment detected - waiting longer before committing (${timeSinceFinal}ms < 2000ms)`);
  // Don't commit yet - continue tracking
  return; // ❌ BUG: Exit early, let the partial continue to be tracked
}
```

**Problem**: This `return` statement EXITS the entire function, preventing the partial from being sent! The comment says "let the partial continue to be tracked" but it actually prevents ALL further processing.

**Impact**: Partials are dropped when:
- A pending final is being committed
- The final text is mid-sentence
- Less than 2000ms has passed since the final

**Fix**: Remove the `return` statement. The code should continue processing the partial below.

---

### Bug 2: Partial Tracker Reset Before Processing New Partial (Line 1883)

**Location**: `backend/host/adapter.js:1883-1886`

```javascript
// PHASE 8: Reset partial tracking using tracker
partialTracker.reset();  // ❌ BUG: Resets BEFORE processing the new partial
syncPartialVariables();
processFinalText(textToCommit);
// Continue processing the new partial as a new segment (don't return - let it be processed below)
```

**Problem**: When a pending final is committed, the partial tracker is reset BEFORE the new partial (that triggered the commit) is processed. This means:
1. The new partial ("oh,") hasn't been tracked yet
2. When translation throttling logic runs (line 2020-2031), it compares against `lastPartialTranslation`
3. Very short partials might not meet the growth threshold
4. The partial might not be sent

**Impact**: After committing a pending final, the partial that triggered the commit might not be sent if it's very short or doesn't meet translation thresholds.

**Fix**: Either:
- Track the new partial BEFORE resetting, OR
- Don't reset the partial tracker until AFTER the new partial has been sent, OR
- Ensure the new partial is sent immediately regardless of throttling

---

### Bug 3: Translation Throttling Can Drop Short Partials (Line 2019-2031)

**Location**: `backend/host/adapter.js:2019-2031`

```javascript
const textGrowth = transcriptText.length - lastPartialTranslation.length;
const GROWTH_THRESHOLD = 2; // Update every 2 characters (~per word)
const MIN_TIME_MS = 150; // Minimum 150ms between updates (6-7 updates/sec)

const textGrewSignificantly = textGrowth >= GROWTH_THRESHOLD;
const enoughTimePassed = timeSinceLastTranslation >= MIN_TIME_MS;

// Immediate translation on growth OR time passed
const isFirstTranslation = lastPartialTranslation.length === 0;
const shouldTranslateNow = isFirstTranslation ||
                           (textGrewSignificantly && enoughTimePassed);

if (shouldTranslateNow) {
  // Send partial
} else {
  // ❌ BUG: Partial is delayed or potentially dropped
  // The delayed processing might not capture the partial correctly
}
```

**Problem**: After resetting the partial tracker:
1. `lastPartialTranslation` might still have a value (not reset)
2. A very short partial like "oh," (3 chars) might not meet the 2-char growth threshold
3. If enough time hasn't passed (< 150ms), the partial is delayed
4. The delayed processing (line 2340+) might not correctly handle the partial if the state has changed

**Impact**: Very short partials at segment start might be dropped or significantly delayed.

**Fix**: After committing a pending final and resetting:
- Force `isFirstTranslation = true` for the next partial
- OR send the partial immediately without throttling
- OR ensure `lastPartialTranslation` is reset along with the partial tracker

---

### Bug 4: Nested Condition Structure Can Skip Partial Processing

**Location**: `backend/host/adapter.js:1846-1999`

The nested if-else structure around pending finalization is complex:
1. Line 1846: `else if (!extendsFinal && timeSinceFinal > 600)`
2. Line 1850: `if (!pendingFinalization)` - warns but continues
3. Line 1867: `if (clearlyNewSegment && (!isFalseFinal || shouldCommitFalseFinalEarly))` - commits final
4. Line 1887: `else if (isFalseFinal && clearlyNewSegment)` - waits
5. Line 1894: `else` - more complex logic with early returns

**Problem**: The nested structure makes it easy to miss code paths where partials should be sent but aren't.

**Impact**: Partials might be dropped in edge cases where the conditions don't match exactly.

---

## Scenarios Where Partials Are Dropped

### Scenario 1: "oh my" after "fight matches know, I haven't"
1. Final "fight matches know, I haven't" creates pending finalization
2. Partial "oh," arrives (new segment detected)
3. Pending final is committed (line 1885)
4. Partial tracker is reset (line 1883)
5. Code continues to process "oh," but:
   - Partial tracker was reset, so tracking state is lost
   - Translation throttling might delay/drop very short partial
   - If `lastPartialTranslation` still has old value, growth threshold not met

**Result**: "oh," partial is dropped or significantly delayed

### Scenario 2: Very Short Partials at Segment Start
1. Final is committed
2. Very short partial like "oh" (2 chars) arrives
3. Doesn't meet GROWTH_THRESHOLD (2 chars)
4. If < 150ms since last translation, gets delayed
5. Delayed processing might not execute correctly

**Result**: Very short partials are dropped

### Scenario 3: Mid-Sentence Partial Text Detection
1. Pending final commit uses partial text
2. Partial text is mid-sentence
3. `timeSinceFinal < 2000ms`
4. Line 1975 does `return;` - EXITS function
5. Partial that triggered commit is never processed

**Result**: Partial is completely dropped

---

## Recommended Fixes

### Fix 1: Remove Early Return (Line 1975)
```javascript
// BEFORE (BUGGY):
if (!endsWithCompleteSentence && timeSinceFinal < 2000) {
  return; // ❌ Exits function, drops partial
}

// AFTER (FIXED):
if (!endsWithCompleteSentence && timeSinceFinal < 2000) {
  // Don't commit yet - continue tracking
  // DO NOT return - continue processing the partial below
  // Remove return statement entirely
}
```

### Fix 2: Track Partial Before Resetting (Line 1883)
```javascript
// BEFORE (BUGGY):
partialTracker.reset();
syncPartialVariables();
processFinalText(textToCommit);
// Continue processing the new partial...

// AFTER (FIXED):
// Track the new partial FIRST before resetting
partialTracker.updatePartial(transcriptText);
// Now reset for the final commit
partialTracker.reset();
syncPartialVariables();
processFinalText(textToCommit);
// Continue processing - partial is already tracked
```

### Fix 3: Force Send After Final Commit
```javascript
// After committing pending final (line 1885), ensure new partial is sent immediately:
processFinalText(textToCommit);
// CRITICAL: After committing final, the partial that triggered commit should be sent immediately
// Reset lastPartialTranslation to force isFirstTranslation = true
lastPartialTranslation = '';
// This ensures the next partial meets translation thresholds
```

### Fix 4: Ensure Partial Tracker State is Consistent
```javascript
// When resetting partial tracker, also reset translation state:
partialTracker.reset();
syncPartialVariables();
// Also reset translation state to ensure next partial is treated as first
lastPartialTranslation = '';
lastPartialTranslationTime = 0;
```

---

## Test Cases to Add

1. **Test**: Partial "oh," after pending final commit should be sent immediately
2. **Test**: Very short partial (2 chars) after final commit should be sent
3. **Test**: Multiple very short partials should all be sent
4. **Test**: Partial should be sent even if early return conditions are met
5. **Test**: After resetting partial tracker, next partial should be treated as first translation

---

## Verification

After fixes, verify:
1. All partials are sent after pending final commits
2. Very short partials (< 5 chars) are sent
3. No early returns prevent partial processing
4. Partial tracker reset doesn't cause state inconsistencies
5. Translation throttling doesn't drop short partials

