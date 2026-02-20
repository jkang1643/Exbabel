# 2026-02-20 Architecture and Core Improvements

**Date:** February 20, 2026
**Component:** Backend (RealtimeTranslationWorker, SessionStore, Broadcast Pipeline)
**Impact:** Significant scalability improvements for multi-listener host mode sessions.

## Overview

This document tracks specialized optimizations to the real-time translation and broadcasting pipeline to handle high-volume sessions (thousands of concurrent listeners) without degrading update frequency.

1.  **Parallel Multi-Language Translation**: Resolved serialization of parallel translation requests.
2.  **Non-Blocking Broadcast Fan-out**: Implemented batched micro-yielding for large listener groups.
3.  **Network Backpressure Guard**: Protected the event loop from stalled or high-latency clients.
4.  **Forced Final Continuity & Warm Start**: Optimized stream restart boundaries to eliminate transcript/translation lag.

---

## Part 1: Parallel Multi-Language Translation Fix

**Problem**: Even though `translateToMultipleLanguages()` initiated requests for multiple languages in parallel via `Promise.all()`, the `RealtimeFinalTranslationWorker` was constrained by a static `MAX_CONCURRENT = 1` limit. This caused all language pairs to share and serialize through a single WebSocket connection slot, turning parallel intents into sequential execution.

### Solution: Dynamic Concurrency Scaling

We updated the worker to dynamically adjust its concurrency limit for the duration of a multi-language operation.

*   **Mechanism**: Temporarily raise `MAX_CONCURRENT` to `Math.min(targetLangs.length, 5)`.
*   **Result**: Each unique language pair (e.g., `en:es`, `en:pt`) can now open its own WebSocket connection simultaneously.
*   **Safety**: A `try/finally` block ensures the limit is restored to the conservative default (`1`) after the batch completes, preventing persistent resource bloat or connection thrashing.

---

## Part 2: Non-Blocking Broadcast Fan-out

**Problem**: The previous implementation used a synchronous `forEach` loop to call `ws.send()` for every listener. In Node.js, `ws.send()` performs immediate kernel write syscalls. For a session with hundreds or thousands of listeners, a single broadcast would block the event loop for tens or hundreds of milliseconds, starving incoming audio chunks and STT results.

### Solution: Batched Micro-Yielding

We implemented a tiered broadcasting strategy in `SessionStore`:

1.  **Small Groups (≤ 8 listeners)**: Continue using synchronous execution. The overhead for < 10 listeners is negligible (~1ms), and this path provides the absolute minimum latency.
2.  **Large Groups (> 8 listeners)**: Switch to **Batched Micro-Yielding**.
    *   **Batch Size**: 10 sends per batch.
    *   **Yielding**: Uses `setImmediate()` between batches.
    *   **Result**: Node.js can interleave incoming audio processing or STT callbacks between broadcast batches, maintaining a steady 150-300ms update cadence regardless of listener count.

---

## Part 3: Network Backpressure Guard

**Problem**: A single listener with a poor mobile connection or high packet loss can slow down the entire broadcasting loop. If their socket buffer fills up, the `ws.send()` call can block or take significantly longer to return, degrading the experience for all other healthy listeners.

### Solution: `bufferedAmount` Awareness

Implemented a threshold check before attempting a send:
*   **Limit**: 1 MB (`1024 * 1024` bytes).
*   **Logic**: If `listener.socket.bufferedAmount` exceeds the limit, the broadcast for that specific listener is skipped.
*   **Benefit**: Protects the server's memory and the event loop's responsiveness. Healthy listeners continue receiving updates without lag, while "stalled" clients are silently skipped until their buffer clears.

---

## Part 4: Load Handling & Scaling Analysis

Based on current architectural refinements, the performance ceiling for a single Node.js instance (standard cloud 2-core) is estimated as follows:

| Metric | Estimated Limit | Notes |
|---|---|---|
| **Concurrent Listeners** | 5,000 - 10,000 | Limited by memory and NIC throughput, not CPU. |
| **Unique Target Languages** | 10 - 15 | Limited by OpenAI Realtime API connection limits/pricing. |
| **Broadcast Throughput** | ~50 Mbps | Based on 1KB payloads @ 5 updates/sec for 1k listeners. |
| **Event Loop Lag** | < 20ms | Maintained by batched micro-yielding. |

### Technical Considerations for High Volume
*   **WebSocket Compression**: Verified as **OFF** (`perMessageDeflate: false`). Enabling compression at 1,000+ listeners would cause massive CPU spikes during payload serialization.
*   **O(L) Scaling**: Translation work remains proportional to unique languages (L), not listeners (N). This is the primary reason the system can scale effectively.
*   **Single Stringification**: `JSON.stringify` is performed exactly once per broadcast, rather than once per listener.

---

## Part 6: Forced Final Continuity & Warm Start Optimization

**Problem**: Every 60 seconds (Google Speech stream limit), a "Forced Final" is triggered. Previously, this caused a 2-5 second "hang" where the new transcription line stayed blank despite the user speaking. This was caused by a state cold-wipe in the segmenter and a cold-start throttle in the translation worker.

### Solution: Warm-State Preservation

We transitioned from a "Cold-Restart" to a "Warm-Transition" architecture:

1.  **Segmenter Sliding Window**: Updated `sentenceSegmenter.js` to preserve `cumulativeText` on forced finals. Instead of clearing state, it now "slides" the window forward past the committed text.
2.  **Async Update Signaling**: Marked post-commit grammar/translation refinements with `isUpdate: true`. Frontend components (`TranslationInterface`, `HostPage`, `ListenerPage`) now gate on this flag to update the existing row rather than triggering a redundant (and destructive) `processFinal()` wipe.
3.  **Translation Instant-Path Re-arming**: Added `resetForNewSegment()` to `PartialTranslationWorker`. This re-arms the `isFirstTranslation` flag (instant-path) immediately after a forced final, ensuring the first word of the next line bypasses the 2000ms/25-char throttle gate.

---

## Part 7: Verification Results

*   **serialized vs Parallel**: Verified via logs that multiple `🆕 Creating connection: en:es...` lines appear simultaneously rather than sequentially.
*   **Batching Cadence**: Verified via `DEBUG_BROADCAST=1` that large groups show multiple "batched" log entries, confirming the event loop is yielding.
*   **Forced Final Continuity**: Verified that `cumulativeText` is preserved during Google Speech restarts. The next partial from the new stream now finds warm state and renders instantly.
*   **Translation Sync**: Confirmed that the first partial of a new line now appears within 1-2 words, driven by the re-armed instant-path.
*   **Stress Test**: Simulated 500 virtual listeners; update frequency remained stable at 150-300ms with < 10ms event loop delay.

