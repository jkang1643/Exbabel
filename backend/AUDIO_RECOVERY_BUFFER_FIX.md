# Audio Recovery Data Type Bug Fix

## Problem Identified

The dual buffer audio recovery system was capturing audio but sending **corrupted data** to the recovery stream, causing garbled transcription that missed critical middle words.

### Example Issue:
- **Expected**: "rejects the notion that LIFE IS best spent fulfilling"
- **Actual**:
  - FINAL 1: "rejects the notion that"
  - Recovery: "checks the notion that" ← GARBLED! ("checks" vs "rejects")
  - **MISSING**: "LIFE IS" (completely lost due to corruption)

### Root Cause:

**Data Type Mismatch** - The recovery stream was receiving **raw Buffer objects** instead of **base64-encoded strings**:

1. `getRecentAudio()` returns a **Buffer** (raw binary audio data)
2. Recovery code splits this into chunks (still **Buffers**)
3. These chunks are passed to `processAudio(chunk, ...)` ← **BUG!**
4. `processAudio()` expects **base64 strings**, not raw Buffers
5. Inside `processAudio()` → `releaseChunkFromBuffer()`, it does:
   ```javascript
   const audioBuffer = Buffer.from(audioData, 'base64'); // Expects base64!
   ```
6. When you pass a raw Buffer to `Buffer.from(rawBuffer, 'base64')`, it treats the binary data AS IF it were base64-encoded text, resulting in **corrupted audio**

**Result:** Google Speech received garbled audio, transcribed nonsense ("checks" instead of "rejects"), and completely missed the middle portion.

## Solution Implemented

### Change Made (`soloModeHandler.js:1569-1570`)

**Before:**
```javascript
const chunk = recoveryAudio.slice(offset, Math.min(offset + CHUNK_SIZE, recoveryAudio.length));

// BUG: Passing raw Buffer - processAudio expects base64 string!
await tempStream.processAudio(chunk, {
  isRecovery: true,
  recoverySource: 'forced_final_buffer',
  chunkIndex: chunksSent
});
```

**After:**
```javascript
const chunk = recoveryAudio.slice(offset, Math.min(offset + CHUNK_SIZE, recoveryAudio.length));

// FIXED: Convert Buffer to base64 string before sending
const chunkBase64 = chunk.toString('base64');

await tempStream.processAudio(chunkBase64, {
  isRecovery: true,
  recoverySource: 'forced_final_buffer',
  chunkIndex: chunksSent
});
```

### Why This Works:

The entire audio pipeline uses **base64-encoded strings** for audio transport:
- Client sends base64 audio to backend
- Backend's `processAudio()` expects base64
- `releaseChunkFromBuffer()` decodes base64 → raw Buffer
- Raw Buffer is sent to Google Speech API

The recovery flow was the **only place** that violated this contract by passing raw Buffers directly to `processAudio()`.

With the fix:
1. We capture raw Buffer from audio buffer manager ✓
2. Split into chunks (still raw Buffers) ✓
3. **Convert each chunk to base64** ← NEW STEP
4. Send base64 string to `processAudio()` ✓
5. Audio is properly decoded and sent to Google ✓
6. Google transcribes clean audio ✓
7. Recovery captures complete text including "LIFE IS" ✓

## Expected Behavior After Fix:

Given the same example:
- Google sends incomplete FINAL: "rejects the notion that"
- We capture 1.5 seconds of recent audio (as Buffer)
- **Convert to base64 chunks before sending to recovery stream**
- Recovery stream receives clean, uncorrupted audio
- Recovery transcribes: "rejects the notion that LIFE IS best spent" ← COMPLETE!
- We detect recovery has MORE text than the final
- We update the final to include "LIFE IS"
- User sees complete text without word loss

## Why We Reverted Buffer Size Changes:

The initial hypothesis was that 1500ms wasn't enough to capture older audio. However:
- The timeline shows "LIFE IS" is **newer** than "rejects the notion that"
- The problem wasn't buffer size, it was **data corruption**
- With corrupted audio, even a 10-second buffer would fail
- With clean audio, 1500ms is sufficient to capture the text extension window

Buffer remains at 1500ms (original size) - adequate for recovery needs.

## Testing Recommendations:

1. Verify recovery transcriptions match the original audio (not garbled)
2. Test with long sentences that span forced finals
3. Confirm "LIFE IS" and similar middle portions are captured
4. Check logs for clean transcriptions in recovery stream:
   - Should see accurate PARTIALs during recovery
   - Should see complete FINAL with all words
   - No more "checks" when user said "rejects"

## Date: 2025-11-18
