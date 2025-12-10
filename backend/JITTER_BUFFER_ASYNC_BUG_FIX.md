# Transcription Pipeline Crash - Root Cause and Fix

## Problem
The transcription pipeline completely broke:
- Audio chunks were being received but never processed
- Chunks timed out after 7 seconds
- No transcription results were ever emitted from Google Speech
- Stream kept restarting in a loop

## Root Cause - Async/Await Missing

The critical bug was in the **jitter buffer processing** in `googleSpeechStream.js`:

### The Bug (Line 1034)
```javascript
async processJitterBuffer() {
  while (this.jitterBuffer.length > 0) {
    const released = this.jitterBuffer.shift();
    this.releaseChunkFromBuffer(released.chunkId, released.audioData, released.metadata);
    // ^^^ MISSING AWAIT! This is an async function!
  }
}
```

### What Happened
1. Audio chunk arrives → added to jitter buffer
2. `processJitterBuffer()` is called to release it
3. **BUT** `releaseChunkFromBuffer()` is async and wasn't being awaited
4. The function immediately continues to next chunk before previous one is sent to Google
5. Meanwhile, `releaseChunkFromBuffer()` tries to:
   - Add chunk to audioBufferManager
   - Write to Google stream
   - Set chunk timeout

6. Because chunks are being released faster than they can be sent to Google, the stream gets overwhelmed
7. Chunks time out at 7 seconds because they never make it to Google
8. Stream keeps restarting, creating infinite loop

## The Fix

### File: googleSpeechStream.js

**Change 1: Make processJitterBuffer async (line 1018)**
```javascript
// BEFORE: Not async
processJitterBuffer() {

// AFTER: Now async to allow awaiting internal calls
async processJitterBuffer() {
```

**Change 2: Await releaseChunkFromBuffer (line 1035)**
```javascript
// BEFORE: Not awaited
this.releaseChunkFromBuffer(released.chunkId, released.audioData, released.metadata);

// AFTER: Now properly awaited
await this.releaseChunkFromBuffer(released.chunkId, released.audioData, released.metadata);
```

**Change 3: Await processJitterBuffer in processAudio (line 1013)**
```javascript
// BEFORE: Not awaited
this.processJitterBuffer();

// AFTER: Now properly awaited
await this.processJitterBuffer();
```

## Why This Fixes It

Now the flow is:
1. Audio chunk arrives → `processAudio(audioData)`
2. Chunk added to jitter buffer
3. **AWAIT** `processJitterBuffer()` - wait for it to complete
4. `processJitterBuffer()` **AWAITS** each `releaseChunkFromBuffer()` - ensures it finishes before next chunk
5. `releaseChunkFromBuffer()` completes:
   - Chunk added to audioBufferManager ✓
   - Chunk written to Google stream ✓
   - Chunk timeout set ✓
6. Only then does next chunk get released
7. Google receives chunks at proper rate, emits data events with transcription results
8. Pipeline works normally

## Impact
- ✅ Audio chunks now properly reach Google Speech API
- ✅ Transcription results are emitted and received
- ✅ No more chunk timeouts
- ✅ No more infinite stream restarts
- ✅ Full transcription/translation pipeline restored

## Files Modified
- `googleSpeechStream.js`: Lines 1012, 1018, 1034-1035

## Related Notes
- This bug was INTRODUCED when the jitter buffer system was added but proper async flow wasn't implemented
- The bug was masked before because chunks timing out wasn't critical
- But when chunk timeout burst detection was added (6 timeouts in 2.5s), it triggered forced stream restarts
- This created a restart loop that prevented recovery ever happening
