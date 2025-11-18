# Temporary Stream Debug Fix - Added Detailed Logging

## Problem Identified

User reported that temporary stream audio recovery wasn't working:
- Logs showed `🎵 Starting audio recovery: 33600 bytes (700ms)`
- But NO subsequent logs from the temporary stream creation, initialization, or transcription
- No recovery text appeared in finals

## Root Cause

The async IIFE (Immediately Invoked Function Expression) was **fire-and-forget**:
```javascript
(async () => {
  // ... recovery code ...
})();
```

Issues:
1. **No visibility**: Zero logs showing what step failed
2. **Timing**: Recovery takes ~3 seconds (initialize + transcribe + wait), but buffer timeout is 2 seconds
3. **No synchronization**: Buffer timeout fires and commits text BEFORE recovery completes
4. **Silent failures**: Errors were caught but recovery was too slow

## Solution Applied

### 1. Added Step-by-Step Logging (Lines 1494-1578)

Each step now logs immediately:
```javascript
console.log(`[SoloMode] 🔄 Step 1: Importing GoogleSpeechStream...`);
const { GoogleSpeechStream } = await import('./googleSpeechStream.js');
console.log(`[SoloMode] ✅ Step 1 complete: GoogleSpeechStream imported`);

console.log(`[SoloMode] 🔄 Step 2: Creating temporary stream...`);
const tempStream = new GoogleSpeechStream();
console.log(`[SoloMode] ✅ Step 2 complete: Temporary stream created`);

// ... 8 steps total ...
```

**Steps:**
1. Import GoogleSpeechStream
2. Create temporary stream instance
3. Initialize stream for language
4. Register result handler
5. Send recovery audio
6. End audio stream
7. Wait 1500ms for final
8. Destroy temporary stream

### 2. Stored Recovery Promise (Lines 1494, 1581-1584)

Changed from anonymous IIFE to stored promise:
```javascript
const recoveryPromise = (async () => {
  // ... recovery logic ...
  return recoveredText;
})();

// Store in buffer for timeout to check
if (forcedFinalBuffer) {
  forcedFinalBuffer.recoveryInProgress = true;
  forcedFinalBuffer.recoveryPromise = recoveryPromise;
}
```

### 3. Buffer Timeout Now Waits for Recovery (Lines 1463-1500)

**OLD CODE**:
```javascript
timeout: setTimeout(() => {
  processFinalText(bufferedText, { forceFinal: true });
  forcedFinalBuffer = null;
}, FORCED_FINAL_MAX_WAIT_MS)
```

**NEW CODE**:
```javascript
timeout: setTimeout(async () => {
  console.warn('[SoloMode] ⏰ Forced final buffer timeout - checking for extensions and audio recovery before commit');

  // CRITICAL: If audio recovery is in progress, wait for it to complete
  if (forcedFinalBuffer && forcedFinalBuffer.recoveryInProgress && forcedFinalBuffer.recoveryPromise) {
    console.log('[SoloMode] ⏳ Audio recovery still in progress, waiting for completion...');
    try {
      const recoveredText = await forcedFinalBuffer.recoveryPromise;
      if (recoveredText && recoveredText.length > 0) {
        console.log(`[SoloMode] ✅ Audio recovery completed before timeout, text already updated`);
      } else {
        console.log(`[SoloMode] ⚠️ Audio recovery completed but no text was recovered`);
      }
    } catch (error) {
      console.error('[SoloMode] ❌ Error waiting for audio recovery:', error.message);
    }
  }

  // Use forcedFinalBuffer.text (may have been updated by recovery)
  let finalTextToCommit = forcedFinalBuffer ? forcedFinalBuffer.text : bufferedText;

  // ... partial checking ...

  console.log(`[SoloMode] 📝 Committing forced final: "${finalTextToCommit.substring(0, 80)}..." (${finalTextToCommit.length} chars)`);
  processFinalText(finalTextToCommit, { forceFinal: true });
  forcedFinalBuffer = null;
}, FORCED_FINAL_MAX_WAIT_MS)
```

### Key Changes:
1. **Changed to async**: `setTimeout(async () => { ... })`
2. **Awaits recovery**: `await forcedFinalBuffer.recoveryPromise`
3. **Uses updated text**: `forcedFinalBuffer.text` (may have been updated by recovery)
4. **Explicit logging**: Shows if recovery completed and what happened

## Expected Log Sequence (Success Case)

```
[SoloMode] 📝 Forced final text: "fulfilling our own." (174 chars, ends with punctuation: false)
[SoloMode] 🎵 Captured recovery audio: 33600 bytes (700ms estimated)
[SoloMode] ⏳ Buffering forced final until continuation arrives or timeout elapses
[SoloMode] 🎵 Starting audio recovery: 33600 bytes (700ms)

[SoloMode] 🔄 Step 1: Importing GoogleSpeechStream...
[SoloMode] ✅ Step 1 complete: GoogleSpeechStream imported

[SoloMode] 🔄 Step 2: Creating temporary stream...
[SoloMode] ✅ Step 2 complete: Temporary stream created

[SoloMode] 🔄 Step 3: Initializing temporary stream for en...
[GoogleSpeech] Initializing streaming transcription for en...
[GoogleSpeech] ✅ Using API v1p1beta1 for PhraseSet support
[GoogleSpeech] Starting stream #0...
[SoloMode] ✅ Step 3 complete: Temporary recovery stream initialized

[SoloMode] ✅ Step 4: Result handler registered

[SoloMode] 🔄 Step 5: Sending 33600 bytes to temp stream...
[SoloMode] ✅ Step 5 complete: Audio sent to temp stream

[SoloMode] 🔄 Step 6: Ending audio stream to force final...
[SoloMode] ✅ Step 6 complete: Audio stream ended

[SoloMode] ⏳ Step 7: Waiting 1500ms for final result...
[SoloMode] 📥 Temp stream result: PARTIAL "fulfilling our own self cen..." ← May see partials
[SoloMode] 📥 Temp stream result: FINAL "fulfilling our own self centered desires"
[SoloMode] ✅ Recovery stream FINAL captured: "fulfilling our own self centered desires"
[SoloMode] ✅ Step 7 complete: Wait finished

[SoloMode] 🔄 Step 8: Destroying temporary stream...
[SoloMode] ✅ Step 8 complete: Temporary stream destroyed

[SoloMode] ✅ Recovery transcription complete: "fulfilling our own self centered desires"
[SoloMode] 📊 Audio recovery found more complete text (174 → 200 chars)
[SoloMode] ✅ Updated forced final buffer with recovered text

--- 2 seconds later (buffer timeout) ---

[SoloMode] ⏰ Forced final buffer timeout - checking for extensions and audio recovery before commit
[SoloMode] ⏳ Audio recovery still in progress, waiting for completion...
[SoloMode] ✅ Audio recovery completed before timeout, text already updated
[SoloMode] 📝 Committing forced final: "fulfilling our own self centered desires" (200 chars)
```

## Expected Log Sequence (Failure Cases)

### Case 1: Import Fails
```
[SoloMode] 🎵 Starting audio recovery: 33600 bytes (700ms)
[SoloMode] 🔄 Step 1: Importing GoogleSpeechStream...
[SoloMode] ❌ Audio recovery failed: Cannot find module './googleSpeechStream.js'
[SoloMode] ❌ Stack: [stack trace]
```

### Case 2: Initialization Fails
```
[SoloMode] 🔄 Step 3: Initializing temporary stream for en...
[SoloMode] ❌ Audio recovery failed: Failed to create recognition stream
[SoloMode] ❌ Stack: [stack trace]
```

### Case 3: No Final Result
```
[SoloMode] ⏳ Step 7: Waiting 1500ms for final result...
[SoloMode] ✅ Step 7 complete: Wait finished
[SoloMode] 🔄 Step 8: Destroying temporary stream...
[SoloMode] ✅ Step 8 complete: Temporary stream destroyed
[SoloMode] ⚠️ No recovery transcript received (recoveredText was empty or undefined)

--- At timeout ---
[SoloMode] ⚠️ Audio recovery completed but no text was recovered
```

### Case 4: Text Doesn't Overlap
```
[SoloMode] ✅ Recovery transcription complete: "something completely different"
[SoloMode] ⚠️ Recovery text doesn't overlap with buffered - may be different segment
[SoloMode]   Buffered: "fulfilling our own..."
[SoloMode]   Recovered: "something completely different"
```

## Why This Should Work Now

### Problem Before:
- Recovery took ~3 seconds total (initialize 500ms + send 200ms + wait 1500ms + process ~1000ms)
- Buffer timeout was 2 seconds
- Timeout fired BEFORE recovery completed → committed incomplete text

### Solution Now:
- Buffer timeout **waits** for recovery: `await forcedFinalBuffer.recoveryPromise`
- Even if recovery takes 3-5 seconds, timeout will wait for it
- Recovery updates `forcedFinalBuffer.text` before timeout commits
- Detailed logs show exactly which step fails (if any)

## Testing Instructions

1. **Restart backend** to load new code
2. **Speak test phrase**: "I love this quote: biblical hospitality is the polar opposite of the cultural trends to separate and isolate. It rejects the notion that life is best spent fulfilling our own self-centered desires cordoned off from others."
3. **Look for step-by-step logs** showing each phase of recovery
4. **Verify text appears complete** in frontend

## Files Modified

- `soloModeHandler.js` (lines 1463-1585):
  - Lines 1494-1578: Added step-by-step logging to recovery async function
  - Lines 1581-1584: Store recovery promise in forcedFinalBuffer
  - Lines 1463-1500: Changed timeout to async, await recovery completion

## Next Steps

Once logs confirm recovery is working:
1. Reduce logging verbosity (remove step numbers, keep key events)
2. Add metrics for recovery success/failure rates
3. Consider adjusting FORCED_FINAL_MAX_WAIT_MS if recovery consistently takes longer

---

**Status**: Ready for testing with detailed logging! 🎉
