# Queue Chunks During Startup/Restart Instead of Dropping

## Overview

Fix the issue where chunks (like "cage" in "I've been to cage...") are dropped during startup/restart windows because `lastAudioTime` is null or `isRestarting` is true. Instead of dropping chunks, queue them for retry during these grace periods.

## Problem

In `releaseChunkFromBuffer()` (lines 765-786), when stream is not ready:
- Current logic checks: `attempts < MAX_CHUNK_RETRIES && !isRestarting && lastAudioTime && (Date.now() - lastAudioTime < 3000)`
- **Issue**: During startup, `lastAudioTime` is often null, and `isRestarting` may be true
- **Result**: Chunks fall into "give up" branch and are **dropped** (lines 780-784)
- **Impact**: First few words like "cage" disappear during startup

## Solution

Replace the retry condition logic to:
1. **Allow queueing when `isRestarting === true`** (exactly when you want to queue!)
2. **Allow queueing when `lastAudioTime` hasn't been established yet** (startup grace period)
3. **Keep hard cap via `MAX_CHUNK_RETRIES`** to prevent unbounded growth
4. **Only truly drop after max retries exceeded**

## Files to Modify

### File: `backend/googleSpeechStream.js`

#### Change 1: Add `streamStartTime` tracking (line ~193)

**Location**: In `startStream()` method, right after `this.startTime = Date.now();`

**Add:**
```javascript
this.streamStartTime = Date.now(); // Track when stream started for startup grace period
```

#### Change 2: Replace retry condition logic (lines 777-784)

**Replace current code:**
```javascript
// Only retry if we haven't exceeded max attempts and stream is just restarting (not inactive)
if (attempts < this.MAX_CHUNK_RETRIES && !this.isRestarting && this.lastAudioTime && (Date.now() - this.lastAudioTime < 3000)) {
  this.queueChunkForRetry(chunkId, audioData, metadata, attempts);
} else {
  // Give up - stream inactive or too many attempts
  console.log(`[GoogleSpeech] ⚠️ Giving up on chunk ${chunkId} - stream not ready and conditions not met for retry`);
  this.chunkRetryMap.delete(chunkId);
  this.clearChunkTimeout(chunkId);
}
```

**With:**
```javascript
// Only retry if we haven't exceeded max attempts and stream is plausibly coming back soon
const now = Date.now();
const recentlyActive = this.lastAudioTime && (now - this.lastAudioTime < 3000);

// NEW: treat brand-new stream as "plausibly coming back soon" too
// (you must set this.streamStartTime when you create/restart the stream)
const inStartupGrace = this.streamStartTime && (now - this.streamStartTime < 5000);

if (attempts < this.MAX_CHUNK_RETRIES && (this.isRestarting || recentlyActive || inStartupGrace)) {
  this.queueChunkForRetry(chunkId, audioData, metadata, attempts);
} else {
  // Still not ready, but instead of dropping the chunk, queue it one last time
  // (this prevents losing early words like "cage" during startup/restart)
  if (attempts < this.MAX_CHUNK_RETRIES) {
    console.log(`[GoogleSpeech] ⏸️ Deferring chunk ${chunkId} - stream not ready (attempt ${attempts + 1}/${this.MAX_CHUNK_RETRIES})`);
    this.queueChunkForRetry(chunkId, audioData, metadata, attempts);
  } else {
    console.log(`[GoogleSpeech] ⚠️ Giving up on chunk ${chunkId} - max retries exceeded while stream not ready`);
    this.chunkRetryMap.delete(chunkId);
    this.clearChunkTimeout(chunkId);
  }
}
```

#### Change 3: Initialize `streamStartTime` in constructor (optional but recommended)

**Location**: In constructor, around line 40-50

**Add:**
```javascript
this.streamStartTime = null; // Will be set when stream starts
```

## Why This Fixes "First Few Words Missing"

**At startup:**
- `lastAudioTime` often isn't set yet → old logic would fail `this.lastAudioTime && ...`
- Stream may be "not ready" briefly → chunks arrive and hit this function
- **Old behavior**: Falls into "give up" and drops the chunk
- **New behavior**: `inStartupGrace` is true → chunk gets queued, then delivered once ready

**During restart:**
- `isRestarting === true` → old logic would skip retry
- **New behavior**: `isRestarting === true` → chunk gets queued explicitly

## Safety Considerations

- ✅ Still caps retries via `MAX_CHUNK_RETRIES`
- ✅ Only "hard drop" after retries exceeded
- ✅ Does not touch transcript/translation pipelines — purely "don't drop audio frames"
- ✅ Startup grace period (5 seconds) prevents unbounded queueing

## CRITICAL: The Real Blocker in `queueChunkForRetry()`

**The real blocker isn't the timer delay. It's this line in `queueChunkForRetry()` (lines 993-997):**

```javascript
if (this.isRestarting || audioStopped) {
  console.log(`[GoogleSpeech] ⚠️ Skipping retry...`);
  this.chunkRetryMap.delete(chunkId);
  return;
}
```

**Problem**: Even if you change `releaseChunkFromBuffer()` to "queue instead of drop", **your retry queue immediately deletes the chunk whenever `isRestarting` is true**. That's exactly the "first few words missing during startup/restart" pattern.

**What's going wrong (in 1 sentence)**: You're trying to "queue during restart", but your retry queue currently says "if restarting, delete and never retry".

### Change #1 (MUST FIX): Allow retry scheduling during restart/startup grace

**Location**: `queueChunkForRetry()` method, lines 990-997

**Replace:**
```javascript
// Don't retry if stream is restarting or if audio has been stopped for a while
// Check if audio stopped more than 2 seconds ago (likely user paused)
const audioStopped = this.lastAudioTime && (Date.now() - this.lastAudioTime > 2000);
if (this.isRestarting || audioStopped) {
  console.log(`[GoogleSpeech] ⚠️ Skipping retry for chunk ${chunkId} - stream restarting or audio stopped`);
  this.chunkRetryMap.delete(chunkId);
  return;
}
```

**With:**
```javascript
const now = Date.now();
const audioStopped = this.lastAudioTime && (now - this.lastAudioTime > 2000);

// NEW: don't treat "restarting" as a reason to abandon — it's exactly when we need retries.
// Only abandon if audio has actually stopped (user paused) and we're past startup grace.
const inStartupGrace = this.streamStartTime && (now - this.streamStartTime < 5000);

if (audioStopped && !inStartupGrace) {
  console.log(`[GoogleSpeech] ⚠️ Skipping retry for chunk ${chunkId} - audio stopped`);
  this.chunkRetryMap.delete(chunkId);
  return;
}
```

**Why**: This single change stops you from deleting chunks during restart. The chunk will be scheduled for retry instead of being immediately deleted.

### Change #2 (HIGH IMPACT): Make retry timer "send as soon as ready", not "only if lastAudioTime exists"

**Location**: `queueChunkForRetry()` method, retry timer callback (lines 1024-1031)

**Current code:**
```javascript
// Only retry if stream is ready and audio is still active
if (this.isStreamReady() && this.lastAudioTime && (Date.now() - this.lastAudioTime < 3000)) {
  await this.releaseChunkFromBuffer(chunkId, audioData, metadata);
} else {
  // Stream not ready or audio stopped - give up
  console.log(`[GoogleSpeech] ⚠️ Abandoning retry for chunk ${chunkId} - stream not ready or audio stopped`);
  this.chunkRetryMap.delete(chunkId);
}
```

**Problem**: This fails at startup because `lastAudioTime` may not be set yet.

**Replace with:**
```javascript
const now2 = Date.now();
const recentlyActive = this.lastAudioTime && (now2 - this.lastAudioTime < 3000);
const inStartupGrace2 = this.streamStartTime && (now2 - this.streamStartTime < 5000);

if (this.isStreamReady() && (recentlyActive || inStartupGrace2)) {
  await this.releaseChunkFromBuffer(chunkId, audioData, metadata);
} else {
  console.log(`[GoogleSpeech] ⚠️ Abandoning retry for chunk ${chunkId} - stream not ready or audio stopped`);
  this.chunkRetryMap.delete(chunkId);
}
```

**Why**: This prevents "first few chunks" from being abandoned simply because `lastAudioTime` hasn't been established.

### Change #3 (OPTIONAL but recommended): Immediate flush when stream becomes ready

**Note**: Only add this **after** Change #1 and #2, because right now you'd flush an empty queue (it gets deleted).

**Location**: Add new helper method after `queueChunkForRetry()` (around line 1037)

**Add helper method:**
```javascript
async flushRetryQueue() {
  if (!this.isStreamReady()) return;

  const now = Date.now();
  const recentlyActive = this.lastAudioTime && (now - this.lastAudioTime < 3000);
  const inStartupGrace = this.streamStartTime && (now - this.streamStartTime < 5000);
  if (!(recentlyActive || inStartupGrace)) return;

  for (const [chunkId, info] of this.chunkRetryMap.entries()) {
    // cancel timer if any (we're flushing now)
    if (info.retryTimer) {
      clearTimeout(info.retryTimer);
      info.retryTimer = null;
    }
    await this.releaseChunkFromBuffer(chunkId, info.chunkData, info.metadata);
  }
}
```

**Call it when stream becomes ready**: In `startStream()` method, after `this.isRestarting = false;` (line 195), add:

```javascript
this.streamStartTime = Date.now(); // you likely already added this
setTimeout(() => this.flushRetryQueue(), 0);
```

**Also call it**: After successful stream initialization, in `init()` method after line 174 ("Streaming initialized and ready"):

```javascript
console.log(`[GoogleSpeech] ✅ Streaming initialized and ready`);
setTimeout(() => this.flushRetryQueue(), 0);
```

**Why**: This immediately processes queued chunks when the stream becomes ready, rather than waiting for timer delays (100ms, 200ms, 400ms).

## Answer: Should I add immediate flush when stream becomes ready?

**Yes — but only after you stop deleting retries during `isRestarting`, and you relax the retry callback gate that requires `lastAudioTime`.** Otherwise flush won't help because the chunks are already gone.

## Why This Targets Your Exact Symptom ("I've been to cage…" missing only at the start)

Those are the chunks most likely to hit:
- stream not ready
- `isRestarting=true` or startup state
- `lastAudioTime` not yet set

Your current logic **drops or abandons** exactly in that window. The changes above convert that window into "buffer until ready".

## Testing Considerations

- Test with chunks arriving during stream startup (first 1-3 seconds)
- Test with chunks arriving during stream restart
- Verify chunks are queued and eventually delivered, not dropped
- Verify max retry cap still works
- Verify no duplicate processing of queued chunks
- Test edge case: stream never becomes ready → should eventually drop after max retries

