# Fix Dropped Segments and UI Freeze

## Overview

This plan addresses four critical bugs causing dropped segments and UI freezing:

1. Short partials are permanently dropped instead of being deferred and replayed
2. Normal partials leak into emission during recovery (causing out-of-order commits)
3. UI freezes during recovery because partials are buffered but not shown
4. Chunk timeout restart policy is too aggressive and restarts on normal latency spikes

## Files to Modify

### 1. `backend/host/adapter.js` - Main handler for host mode

- **Lines 1473-1491**: Replace short-partial suppression `return;` statements with defer+replay logic
- **Lines 1581-1623**: Add hard gate preventing normal partials from emitting during recovery
- **Lines 1528-1576**: Add live-only preview mechanism for recovery partials
- **Lines 379-380**: Add deferred short partial state variables

### 2. `backend/googleSpeechStream.js` - Google Speech stream handler

- **Lines 874-949**: Modify chunk timeout handling to not trigger restarts
- **Lines 102-109**: Update timeout constants and add result tracking

### 3. `frontend/src/components/HostPage.jsx` (if needed) - Frontend handler

- May need to handle `uiHint: 'live-only'` to prevent history commits

## Implementation Details

### Fix 1: Defer + Replay for Short Partials

**Location**: `backend/host/adapter.js` around lines 1473-1491**Current behavior**: Short partials (< 5 chars) are suppressed with `return;` and never replayed.**New behavior**:

- Add state variables: `deferredShortPartial` and `deferredShortTimer` (around line 379)
- Replace suppression `return;` statements with `deferShortPartial()` calls
- Implement `deferShortPartial()` function that:
- Stores partial with current `segmentEpoch`
- Sets 250ms timer to replay
- Cancels timer if newer partial arrives or epoch changes
- Only replays if still in same epoch

**Key invariant**: "We may delay short partials, but we never permanently discard a partial with alphanumerics."

### Fix 2: Hard Gate During Recovery

**Location**: `backend/host/adapter.js` around lines 1581-1623**Current behavior**: Non-continuation partials are buffered, but continuation partials can still emit during recovery.**New behavior**:

- Remove any logic that allows normal-pipeline partials to emit during recovery
- If `recoveryInProgress === true` and `pipeline === 'normal'`:
- Buffer the partial (keep latest snapshot)
- Emit as live-only preview (Fix 3)
- Never call `broadcastWithSequence()` with a new seqId

**Key invariant**: "If `forcedFinalBuffer.recoveryInProgress === true`, no normal partial may be emitted as a new seqId."

### Fix 3: Live-Only Preview During Recovery

**Location**: `backend/host/adapter.js` around lines 1528-1576**Current behavior**: During recovery, normal partials are buffered and UI appears frozen.**New behavior**:

- Add `recoveryPreviewSeqId` state variable (around line 379)
- Create `emitRecoveryPreview(text)` function that:
- Creates `recoveryPreviewSeqId` once if not exists
- Reuses same seqId for all preview updates
- Sets `uiHint: 'live-only'` flag
- Calls `broadcastWithSequence()` with `seqIdOverride` parameter (may need to modify function signature)
- During recovery, call `emitRecoveryPreview()` instead of buffering silently
- Frontend should update live text but not commit to history when `uiHint === 'live-only'`

### Fix 4: Fix Chunk Timeout Restart Policy

**Location**: `backend/googleSpeechStream.js` lines 874-949**Current behavior**:

- 7s per-chunk timeout
- Restarts stream if 6+ timeouts in 2.5s window
- This triggers forced finals and recovery windows unnecessarily

**New behavior**:

- Keep chunk timeout for metrics only (don't restart on timeout)
- Add `lastResultAt` tracking (line ~114)
- Restart only when:
- `Date.now() - lastResultAt > 12000ms` (12 seconds)
- AND audio has been sent recently (`lastAudioTime` within 3s)
- Raise `CHUNK_TIMEOUT_MS` to 15000-20000ms or remove restart trigger entirely
- Update `handleChunkTimeoutBurst()` to only log/metric, not restart

## Testing Considerations

- Test with short phrases like "In My name" and "gathered together in my name"
- Verify UI doesn't freeze during recovery windows
- Verify no partial leaks into history during recovery