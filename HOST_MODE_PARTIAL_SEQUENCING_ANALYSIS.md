# Host Mode Partial Sequencing & No-Miss Analysis

## Summary

Solo mode has robust implementations for:
1. **Ensuring partials are always sequenced correctly** - never out of order for finals even when segments are mixed up
2. **Ensuring no partial is ever missed** - catching partials that arrive after finals are sent

Host mode currently has issues with both edge cases. This document analyzes solo mode's solutions and suggests how to apply them to host mode.

---

## Solo Mode's Key Solutions

### 1. `checkForExtendingPartialsAfterFinal` Function

**Location**: `backend/soloModeHandler.js:408-471`

**Purpose**: After every FINAL is sent, this function checks if any partials arrived that extend the just-sent FINAL. This ensures no partials are missed.

**Key Logic**:
- Checks both `longestPartialText` and `latestPartialText`
- Verifies partials are recent (< 5000ms)
- Checks if partial extends the final (starts with it or has overlap)
- Logs warnings when extensions are found

**Usage**: Called after EVERY final is sent (lines 661, 786, 823, 911, 935)

### 2. Snapshot and Reset Logic

**Location**: `backend/soloModeHandler.js:1949-2058`

**Purpose**: Prevents race conditions where new partials from the next segment arrive between snapshot and reset, which could mix segments.

**Key Logic**:
- **Before processing final**: Takes snapshot using `partialTracker.getSnapshot()` or `snapshotAndReset()`
- **Uses snapshot (not live values)**: When processing finals, uses the snapshot to ensure correct sequencing
- **Resets only after processing**: Resets partial tracking only after the final is fully processed

**Critical Pattern**:
```javascript
// 1. Take snapshot BEFORE reset
const snapshot = partialTracker.getSnapshot();
const longestPartialSnapshot = snapshot.longest;
const longestPartialTimeSnapshot = snapshot.longestTime;

// 2. Use snapshot (not live values) when processing
if (longestPartialSnapshot && longestPartialSnapshot.length > transcriptText.length) {
  // Use snapshot, not longestPartialText
  transcriptText = longestPartialSnapshot;
}

// 3. Reset ONLY after processing is complete
partialTracker.reset();
syncPartialVariables();
```

### 3. Premature Reset Prevention

**Issue**: Resetting partial tracking before the FINAL handler can use it causes data loss.

**Solution**: Only reset partial tracking in the FINAL handler AFTER snapshot has been taken and used.

**Documentation**: See `backend/PREMATURE_RESET_FIX.md` for details on the four locations that were causing issues.

---

## Host Mode's Current Issues

### Issue 1: Missing `checkForExtendingPartialsAfterFinal`

**Location**: `backend/hostModeHandler.js:493`

**Problem**: Host mode removed this function with the comment:
```javascript
// PHASE 8: Removed deprecated checkForExtendingPartialsAfterFinal and cleanupRecentlyFinalized functions
// These were part of the old backpatching system, now replaced by dual buffer recovery
```

**Impact**: Partials that arrive after a FINAL is sent are not checked, causing missed partials.

**Evidence**: The function is never called in host mode, but it's called 5+ times in solo mode after every final.

### Issue 2: Inconsistent Snapshot Usage

**Location**: `backend/hostModeHandler.js:1945-1963`

**Problem**: Host mode does use snapshots for forced finals, but:
- Doesn't use snapshots consistently for regular finals
- May not be taking snapshots at the right time
- May be resetting before snapshots are fully used

**Current Code** (forced final only):
```javascript
const snapshot = partialTracker.getSnapshot();
const longestPartialSnapshot = snapshot.longestPartialText;
// ... uses snapshot ...
```

**Missing**: Similar snapshot logic for regular finals (non-forced).

### Issue 3: Reset Timing Issues

**Location**: Multiple locations in `backend/hostModeHandler.js`

**Problem**: Similar to solo mode's premature reset issue, host mode may be resetting partial tracking at the wrong times, causing:
- Cross-segment contamination
- Lost partials
- Incorrect sequencing

---

## Recommended Solutions for Host Mode

### Solution 1: Re-implement `checkForExtendingPartialsAfterFinal`

**Action**: Add the function back to host mode and call it after every final is sent.

**Implementation**:
1. Copy the function from solo mode (lines 408-471)
2. Adapt it for host mode's broadcasting context
3. Call it after every final is sent in `processFinalText` (similar to solo mode lines 661, 786, 823, 911, 935)

**Key Adaptation**: Since host mode broadcasts to multiple listeners, the function should check for extending partials but may not need to send updates immediately (the partial tracking will handle that).

### Solution 2: Consistent Snapshot Usage for All Finals

**Action**: Use snapshot pattern for ALL finals (not just forced finals).

**Implementation**:
1. Before processing any final, take a snapshot
2. Use the snapshot (not live values) when checking for extending partials
3. Reset only after the final is fully processed

**Pattern**:
```javascript
// In processFinalText, before processing:
const snapshot = partialTracker.getSnapshot();
const longestPartialSnapshot = snapshot.longest;
const latestPartialSnapshot = snapshot.latest;

// Use snapshot when checking for extensions
if (longestPartialSnapshot && longestPartialSnapshot.length > textToProcess.length) {
  // Verify it extends and is recent
  const timeSinceLongest = snapshot.longestTime ? (Date.now() - snapshot.longestTime) : Infinity;
  if (timeSinceLongest < 5000) {
    const longestTrimmed = longestPartialSnapshot.trim();
    const textTrimmed = textToProcess.trim();
    if (longestTrimmed.startsWith(textTrimmed) || 
        (textTrimmed.length > 10 && longestTrimmed.substring(0, textTrimmed.length) === textTrimmed)) {
      textToProcess = longestPartialSnapshot; // Use snapshot
    }
  }
}

// After processing is complete, reset
partialTracker.reset();
syncPartialVariables();
```

### Solution 3: Fix Reset Timing

**Action**: Ensure partial tracking is only reset in the FINAL handler, after snapshot is taken and used.

**Implementation**:
1. Review all locations where `partialTracker.reset()` is called
2. Ensure resets only happen in the FINAL handler after processing
3. Remove any premature resets (similar to solo mode's fix in `PREMATURE_RESET_FIX.md`)

**Locations to Check**:
- Line 1970: After forced final commit (OK - after processing)
- Line 1993: After forced final timeout (OK - after processing)
- Any other locations where reset is called

### Solution 4: Add Snapshot to Regular Final Processing

**Action**: Apply the snapshot pattern to regular (non-forced) finals.

**Current**: Only forced finals use snapshots (line 1945).

**Needed**: Regular finals should also:
1. Take snapshot before processing
2. Check if snapshot extends the final
3. Use snapshot if it extends
4. Reset after processing

**Location**: In the final processing section (around line 2087-2187), before the delay logic.

---

## Implementation Priority

1. **HIGH**: Re-implement `checkForExtendingPartialsAfterFinal` - This directly addresses missed partials
2. **HIGH**: Fix snapshot usage for regular finals - This ensures correct sequencing
3. **MEDIUM**: Review and fix reset timing - This prevents cross-segment contamination
4. **MEDIUM**: Add snapshot to regular final processing - This ensures consistency

---

## Testing Recommendations

After implementing these fixes, test:

1. **Missed Partials**: Speak continuously, verify no partials are missed when finals arrive
2. **Out-of-Order**: Mix segments quickly, verify finals are always in correct order
3. **Cross-Segment Contamination**: Verify partials from one segment don't contaminate the next
4. **Forced Finals**: Test forced final scenarios to ensure snapshots work correctly

---

## Code References

### Solo Mode (Reference Implementation)
- `checkForExtendingPartialsAfterFinal`: `backend/soloModeHandler.js:408-471`
- Snapshot usage: `backend/soloModeHandler.js:1949-2058`
- Function calls: Lines 661, 786, 823, 911, 935

### Host Mode (Needs Updates)
- Missing function: `backend/hostModeHandler.js:493` (removed)
- Snapshot usage (forced only): `backend/hostModeHandler.js:1945-1963`
- Final processing: `backend/hostModeHandler.js:612-963`
- Regular final handling: `backend/hostModeHandler.js:2087-2187`

