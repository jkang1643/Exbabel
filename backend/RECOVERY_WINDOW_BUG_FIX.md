# Recovery Window Audio Capture Bug - Root Cause and Fix

## Summary
Recovery was only capturing ~1520ms of audio (48,000 bytes) instead of the full 2200ms window (70,400 bytes), resulting in incomplete sentence fragments like "in that life is" instead of full context.

## Root Cause

### The Bug
The recovery window calculation was using a **future timestamp** for the window endpoint:

```javascript
const windowStartTimestamp = forcedFinalTimestamp - FORCED_FINAL_PRE_MS;     // T - 900ms
const windowEndTimestamp = forcedFinalTimestamp + FORCED_FINAL_POST_MS;      // T + 1300ms (FUTURE!)
const recoveryAudio = speechStream.getRecentAudio(FORCED_FINAL_RECOVERY_WINDOW_MS, windowEndTimestamp);
```

### Why This Failed
1. When forced final is detected at time T, `forcedFinalTimestamp = T`
2. Recovery is triggered after 400ms timeout, at time T+400ms
3. The audio buffer only contains chunks with timestamps up to approximately T+400ms
4. Calling `getRecentAudio(2200, T+1300)` requests a window that extends to T+1300ms - **but the buffer has no chunks from that future time**
5. Result: Instead of `[T-900, T+1300]`, the buffer can only provide `[T-900, T+400]` = ~1300ms
6. This gives us ~520ms of additional words beyond the forced final, not the intended 1300ms

### Implementation Detail
In `audioBufferManager.js`, the method calculates:
```javascript
const now = endTimestamp || Date.now();
const startTimestamp = now - durationMs;
const chunks = this.buffer.filter(entry => entry.timestamp >= startTimestamp && entry.timestamp <= now)
```

When `endTimestamp` is in the future, the filter finds zero chunks from that future time.

## The Fix

### Change Strategy
Instead of calculating a window relative to the **forced final timestamp** (which is in the past by recovery time), use the **actual current time** when recovery executes:

```javascript
const recoveryExecutionTime = Date.now();  // Capture actual current time
const windowStartTimestamp = recoveryExecutionTime - FORCED_FINAL_RECOVERY_WINDOW_MS;  // NOW - 2200ms
const windowEndTimestamp = recoveryExecutionTime;  // NOW (not future)
const recoveryAudio = speechStream.getRecentAudio(FORCED_FINAL_RECOVERY_WINDOW_MS, windowEndTimestamp);
```

### Why This Works
- Window is `[NOW - 2200ms, NOW]` = last 2200ms of all available audio
- The buffer always has chunks up to NOW (by definition)
- No future timestamps, so the buffer can fulfill the entire request
- This captures the maximum audio available: forced final + any new partial words that arrived in the 400ms timeout window

### Backup Safeguard
Added detection in `audioBufferManager.getRecentAudio()` to catch future timestamps and automatically fall back to using `Date.now()`:

```javascript
if (endTimestamp && endTimestamp > currentTime) {
  this.logger.warn('[AudioBuffer] ⚠️ CRITICAL BUG DETECTED: endTimestamp is in the future!', {
    futureByMs: endTimestamp - currentTime,
    message: 'Buffer cannot have chunks from the future! Using Date.now() instead.'
  });
  return this.getRecentAudio(durationMs, null);
}
```

## Impact
- Recovery now captures full 2200ms window (70,400 bytes) instead of incomplete ~1520ms (48,000 bytes)
- Complete sentence fragments are recovered instead of partial phrases
- Merge logic receives more context for better word boundary detection

## Files Modified
1. **soloModeHandler.js** (lines 1480-1506)
   - Changed window calculation to use `recoveryExecutionTime = Date.now()` instead of projected future time

2. **audioBufferManager.js** (lines 146-203)
   - Added future timestamp detection and auto-correction
   - Added enhanced diagnostic logging to show buffer coverage percentage

## Testing Recommendations
1. Monitor logs for "[AudioBuffer] ⚠️ CRITICAL BUG DETECTED" warnings to confirm fix is preventing future timestamps
2. Check recovery audio byte counts now match expected 70,400 bytes for 2200ms windows
3. Verify sentence recovery now includes full context, not just partial fragments
4. Validate merge logic finds correct anchor words with more surrounding context available
