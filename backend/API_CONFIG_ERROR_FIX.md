# Google Speech API Error Fix: Config Required Before Audio

## Error Encountered

```
ApiError: Malordered Data Received. Expected audio_content none was set.
Send exactly one config, followed by audio data.
```

**Location**: Temporary stream audio recovery
**Code**: 3 (INVALID_ARGUMENT)

## Root Cause

We were trying to bypass the jitter buffer by writing audio directly to `recognizeStream`:

```javascript
// WRONG: Sends audio without config
tempStream.recognizeStream.write({ audioContent: chunk });
```

**Problem**: Google Speech API requires the **first message** to be a **config message**, not audio. The stream initialization sends config, but we were writing audio directly without going through the proper method.

## Google Speech API Protocol

**Required sequence**:
1. **First message**: Config (language, model, etc.)
2. **Subsequent messages**: Audio chunks

**What we were doing**:
1. ~~Send audio directly~~ ❌ (skipped config)

**What we should do**:
1. Initialize stream (sends config automatically) ✅
2. Use `processAudio()` to send audio (handles protocol properly) ✅

## Solution Applied

### Step 1: Use processAudio() Method
```javascript
// CORRECT: Use processAudio() which handles protocol
await tempStream.processAudio(chunk, {
  isRecovery: true,
  recoverySource: 'forced_final_buffer',
  chunkIndex: chunksSent
});
```

This method:
- Sends config on first call (handled by GoogleSpeechStream)
- Queues audio in jitter buffer
- Releases chunks after delay
- Handles retries and errors

### Step 2: Wait for Jitter Buffer to Release

**Problem**: Jitter buffer delays each chunk by 80-120ms

**Solution**: Wait for all chunks to be released before closing stream

```javascript
// Calculate wait time based on number of chunks
const estimatedJitterDelay = chunksSent * 100; // 100ms per chunk average
const totalWaitBeforeEnd = Math.max(1500, estimatedJitterDelay + 500);

console.log(`Waiting ${totalWaitBeforeEnd}ms for jitter buffer to release all ${chunksSent} chunks...`);
await new Promise(resolve => setTimeout(resolve, totalWaitBeforeEnd));
```

**For 12 chunks (1200ms audio)**:
- Estimated jitter delay: 12 × 100ms = 1200ms
- Total wait: Math.max(1500, 1200 + 500) = **1700ms**

### Step 3: Then Close Stream

```javascript
// NOW it's safe to close - all audio has been sent to Google
tempStream.recognizeStream.end();
```

### Step 4: Wait for Results

```javascript
// Wait for Google Speech to process and send results
await new Promise(resolve => setTimeout(resolve, 2000));
```

## Complete Timeline

```
T=0ms:      Start sending 57600 bytes (1200ms of audio)
T=0ms:      Chunk 1 queued in jitter buffer (release at T=80ms)
T=50ms:     Chunk 2 queued (release at T=130ms)
T=100ms:    Chunk 3 queued (release at T=180ms)
...
T=550ms:    Chunk 12 queued (release at T=630ms)
T=630ms:    All chunks released to Google Speech ✅
T=1700ms:   Wait complete, call recognizeStream.end()
T=1750ms:   Google Speech receives end signal
T=2000ms:   Google Speech starts finalizing
T=2500ms:   Google Speech sends PARTIAL "gathered"
T=3000ms:   Google Speech sends FINAL "gathered in my name"
T=3700ms:   Our wait (2000ms) completes
T=3700ms:   We have recoveredText = "gathered in my name" ✅
T=3750ms:   Destroy stream (safe, results already received)
```

## Expected Logs

### Success:
```
[SoloMode] 🔄 Step 5: Sending 57600 bytes to temp stream...
[SoloMode] ✅ Step 5 complete: 12 chunks queued in jitter buffer (57600 bytes total)
[SoloMode] ⏳ Step 5.5: Waiting 1700ms for jitter buffer to release all 12 chunks...
[SoloMode] ✅ Step 5.5 complete: Jitter buffer should have released all chunks
[SoloMode] 🔄 Step 6: Ending recognition stream to force final...
[SoloMode] ✅ Step 6 complete: Recognition stream ended (listening for final result)
[SoloMode] ⏳ Step 7: Waiting 2000ms for final result...
[GoogleSpeech] ✅ PARTIAL (1 result(s)): "gathered in"
[SoloMode] 📥 Temp stream result: PARTIAL "gathered in"
[GoogleSpeech] ✅ FINAL (1 result(s)): "gathered in my name"
[SoloMode] 📥 Temp stream result: FINAL "gathered in my name"
[SoloMode] ✅ Recovery stream FINAL captured: "gathered in my name"
[SoloMode] ✅ Step 7 complete: Wait finished
[SoloMode] 📊 Audio recovery found more complete text (157 → 182 chars)
[SoloMode] ✅ Updated forced final buffer with recovered text
```

### No More API Errors:
- ✅ No "Malordered Data" errors
- ✅ No "Expected audio_content none was set" errors
- ✅ Config sent properly on initialization
- ✅ Audio sent through proper protocol

## Code Changes

**File**: `soloModeHandler.js`
**Lines**: 1539-1570

**Key Changes**:
1. Use `processAudio()` instead of direct `recognizeStream.write()`
2. Split recovery audio into 100ms chunks (4800 bytes each)
3. Wait for jitter buffer to release all chunks (1500-2000ms)
4. Then close stream with `recognizeStream.end()`
5. Wait for results (2000ms additional)

## Total Recovery Time

- **Chunk queueing**: ~550ms (12 chunks × 50ms average)
- **Jitter buffer wait**: ~1700ms (ensures all chunks sent)
- **Stream close + processing**: minimal
- **Result wait**: ~2000ms
- **Total**: ~4250ms (4.25 seconds)

This is acceptable since it only happens on forced finals (stream restarts), not on every utterance.

## Testing

1. **Restart backend** with fixed code
2. **Trigger forced final** (speak long sentence that causes stream restart)
3. **Look for**:
   - `✅ Step 5 complete: X chunks queued in jitter buffer`
   - `⏳ Step 5.5: Waiting Xms for jitter buffer...`
   - `📥 Temp stream result: FINAL "..."`  (THIS is the key!)
   - `✅ Updated forced final buffer with recovered text`
4. **Verify frontend** shows complete text

---

**Status**: API protocol error fixed. Recovery should work now! 🚀
