# Custom Forced Finalization & Audio Recovery Engine

This document serves as a technical reference for Exbabel's custom finalization and audio recovery pipeline. Because standard streaming transcription APIs (like Google Speech) have limitations—such as emitting premature finals for incomplete phrases, enforcing hard connection timeouts, and dropping audio during stream restarts (decoder gaps)—we implemented our own custom engines to intercept, buffer, and recover transcription.

## 1. The Adaptive Finalization Engine (Sentence-Aware)

Google Speech frequently emits `FINAL` results for mere phrases rather than complete sentences. If these were passed directly to the frontend, the UI would prematurely commit fragments to the chat history, causing a disjointed reading experience.

### How It Works (`core/engine/finalizationEngine.js`)

1. **Interception**: When Google emits a normal `FINAL`, our backend intercepts it instead of immediately sending it to the frontend via WebSockets. The text enters a `pendingFinalization` buffer.
2. **Punctuation Check**: The engine checks if the text ends with sentence-ending punctuation (`.`, `!`, `?`). 
3. **Adaptive Waiting**: If the sentence is incomplete, the engine calculates a wait time (typically 1.5 to 3 seconds, scaling with length) and waits to see if the speaker continues the sentence.
4. **Continuations**: Incoming partials are checked to see if they extend the pending phrase. If they do, the pending final is merged with the incoming partials, dynamically extending the finalization window.

### The `MAX_FINALIZATION_WAIT_MS` Cutoff (Mid-Sentence Chunking)

If a user speaks a very long, continuous run-on sentence without pausing, the engine cannot wait indefinitely, or the transcript would appear frozen to the listeners.
- A strict `MAX_FINALIZATION_WAIT_MS` timeout (typically ~15 seconds) is enforced.
- When this max wait time is reached, the backend gives up on waiting for the sentence to naturally finish.
- It forces the commit of the completely buffered text, logging: `⚠️ Max wait exceeded - committing incomplete sentence`.
- This is dispatched on the normal translation pipeline, so `forceFinal: undefined` and `pipeline="normal"`.
- **Frontend Effect**: The frontend segmenter (`sentenceSegmenter.js`) receives this `FINAL`. Because it is a normal final, it flushes the history block and moves to a completely new line. **This is what causes a mid-sentence chunk/fragment to appear on a separate line.**

---

## 2. AudioBufferManager & Decoder Gap Recovery (`core/engine/forcedCommitEngine.js`)

Streaming STT providers impose hard connection limits (e.g., Google Speech's 4-to-5 minute streaming limit). When the backend hits this limit, it is forced to abruptly close the stream and open a new one.

### The Problem: The "Decoder Gap"
During a stream restart, there is typically a 200–500ms window where audio is sent but the STT decoder drops it due to the connection tearing down. This results in missing words right at the boundary of a forced final.

### The Solution: Dual-Phase Audio Recovery

To solve this, Exbabel runs a continuous `AudioBufferManager` (`backend/audioBufferManager.js`) that captures every single audio chunk sent by the client, maintaining a continuous 1500ms rolling window.

1. **Stream Restart Trigger**: Google Speech reaches its `STREAMING_LIMIT`. The backend must emit a forced final containing whatever partial it currently has (`meta.forced === true`).
2. **The Buffer Snapshot**: The backend immediately grabs a snapshot of the rolling audio buffer.
   - It captures 1400ms *before* the forced final signal (to cover the decoder gap).
   - It initiates a wait phase to capture 800ms *after* the signal to catch any trailing speech that was en route.
3. **The Recovery Stream Engine**: The captured 2200ms audio buffer is dispatched to a completely separate, single-shot STT stream (the "Recovery Stream").
4. **Merging & Committing**: Once the recovery STT returns text for the missing words, the `forcedCommitEngine.js` merges the recovered text with the original forced final text to create a complete, uninterrupted transcript.
5. **WebSocket Dispatch**: The enriched text is finally sent to the frontend with the explicit flag `forceFinal: true`.

---

## 3. Frontend Reaction & State Preservation

The frontend `SentenceSegmenter` receives finalization signals from both engines above, but reacts differently based on the flags.

### 1. Normal Pipeline Commit (Adaptive Finalization Cutoff)
- `forceFinal: false` / `undefined`
- The segmenter runs strict deduplication against what it has already partially flushed.
- It pushes the new block to history, and clears `liveText`.
- Because this represents a natural pause (or a `MAX_FINALIZATION_WAIT` cutoff), it cold-clears the partial state so new sentences start fresh.

### 2. Stream Restart Commit (Forced Final)
- `forceFinal: true`
- The segmenter knows this is an artificial stream boundary, not a speaker pause. It uses lenient deduplication to account for slight STT punctuation differences during the reconstruction.
- **Warm Start Optimization**: Instead of cold-clearing the `cumulativeText`, it uses a sliding window substring. This allows the very next incoming partial from the new stream to seamlessly append to the existing display history without a 2–5 second blank freeze delay.
- The `isUpdate: true` flag in subsequent async refinement steps prevents the UI from double-committing and wiping this preserved state.
