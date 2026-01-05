# Fix Chunk Acknowledgment Using resultEndTime: FIX 2 

The current system uses FIFO guesses to clear chunk timeouts:

- Assumes 1 partial result = 1 chunk acknowledged
- Assumes FINAL result = all chunks acknowledged
- This causes `pendingChunks` queue to grow, leading to false timeouts and burst restarts

## Solution

Use Google Speech API's `resultEndTime` field to accurately acknowledge which chunks have been processed, eliminating the guesswork.

## Implementation

### 1. Add Audio Duration Tracking to Pending Chunks

**File**: `backend/googleSpeechStream.js`

- Add `sentAudioMs` property to track monotonic audio stream time (initialize to 0 in constructor)
- Calculate audio duration from buffer size:
- Format: PCM 16-bit, 24kHz = 48000 bytes/sec = 48 bytes/ms
- `durationMs = Math.round(audioBuffer.length / 48)`
- Update `setChunkTimeout()` to store `{ chunkId, sendTimestamp, startMs, endMs }` instead of just `{ chunkId, sendTimestamp }`
- Maintain monotonic clock: `startMs = this.sentAudioMs`, `endMs = startMs + durationMs`, `this.sentAudioMs = endMs`

### 2. Extract resultEndTime from Google Responses

**File**: `backend/googleSpeechStream.js` - `handleStreamingResponse()`

- Add helper function `toMs(endTime)` to convert Google's `{ seconds, nanos }` format to milliseconds
- Extract `resultEndTime` from each result in `data.results[]`
- Handle cases where `resultEndTime` might be missing (fallback behavior)

### 3. Replace FIFO Clearing with resultEndTime-Based Clearing

**File**: `backend/googleSpeechStream.js` - `handleStreamingResponse()`

- Remove the current FIFO clearing logic (lines 683-692)
- Remove the "FINAL clears all" logic (lines 700-706)
- Implement new clearing logic:
- For each result, extract `ackMs` from `resultEndTime`
- Clear all chunks where `chunk.endMs <= ackMs`
- If `resultEndTime` is missing, use conservative fallback (clear only 1 oldest chunk to prevent unbounded growth)

### 4. Update Constructor and Initialization

**File**: `backend/googleSpeechStream.js`

- Initialize `this.sentAudioMs = 0` in constructor
- Reset `this.sentAudioMs = 0` in `startStream()` when starting new session

### 5. Update Restart Logic

**File**: `backend/googleSpeechStream.js` - `restartStream()`

- Reset `this.sentAudioMs = 0` when restarting stream

## Key Changes

1. **Pending chunk structure**: `{ chunkId, sendTimestamp }` → `{ chunkId, sendTimestamp, startMs, endMs }`
2. **Clearing logic**: FIFO guess → `resultEndTime`-based acknowledgment
3. **Removed**: "FINAL clears all pending chunks" behavior (lines 700-706)
4. **Added**: Monotonic audio clock tracking (`sentAudioMs`)

## Fallback Behavior

If `resultEndTime` is missing from a response:

- Log a warning (for debugging)
- Clear only the oldest pending chunk to prevent unbounded queue growth
- This is safer than clearing all chunks or clearing nothing

## Testing Considerations