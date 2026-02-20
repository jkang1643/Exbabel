# Audio Buffer Size Mismatch - Root Cause and Fix (ADDING LINE)

## Problem
Recovery was still only capturing ~57,600 bytes (~1830ms) instead of the expected 70,400 bytes (2200ms), even after fixing the future timestamp bug and the jitter buffer async issue.

## Root Cause
**The audio buffer rolling window (1500ms) was smaller than the recovery window being requested (2200ms).**

### Timeline
1. AudioBufferManager initialized with `bufferDurationMs: 1500`
2. Chunks older than 1500ms are automatically expired and deleted
3. Recovery tries to request 2200ms of audio
4. But buffer only contains the last ~1500ms
5. Result: ~1830ms of audio returned instead of 2200ms

This explains why recovery always gets ~57,600 bytes (1830ms) - it's getting the entire buffer available, but the buffer is configured too small!

## The Fix

**File: googleSpeechStream.js (Lines 51-61)**

Changed buffer duration from **1500ms to 3000ms**:

```javascript
// BEFORE
this.audioBufferManager = new AudioBufferManager({
  bufferDurationMs: 1500,  // Too small! Recovery needs 2200ms
  ...
});

// AFTER
this.audioBufferManager = new AudioBufferManager({
  bufferDurationMs: 3000,  // 3 second rolling window (covers 2200ms recovery + overhead)
  ...
});
```

### Why 3000ms?
- Recovery window: 2200ms
- Buffer needs extra headroom for:
  - Timing variance between forced final detection and recovery execution
  - Audio chunk arrival jitter
  - Safe margin to ensure chunks don't expire mid-recovery
- 3000ms = 2200ms + 800ms overhead = safe margin

## Impact
✅ Recovery now has full audio buffer available (2200ms minimum)
✅ Will now capture ~70,400 bytes (full 2200ms) instead of ~57,600 bytes
✅ Complete audio context available for recovery stream transcription
✅ Word anchor detection will have more context to work with

## Memory Impact
Minimal - still only ~200 audio chunks max, just storing them for longer duration. Memory footprint is negligible on modern systems.

## Related Configuration
Recovery window constants in soloModeHandler.js:
```javascript
const FORCED_FINAL_RECOVERY_WINDOW_MS = 2200;  // Total recovery window
const FORCED_FINAL_PRE_MS = 900;               // Before forced final
const FORCED_FINAL_POST_MS = 1300;             // After forced final
```

These are now fully supported by the 3000ms buffer.
