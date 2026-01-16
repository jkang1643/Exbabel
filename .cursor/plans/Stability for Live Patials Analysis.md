Exbabel Live Partials Architecture & Process Analysis
This document provides a technical deep dive into the architecture and processes behind streaming live partials in Exbabel.

1. High-Level Architecture
Exbabel uses a distributed pipeline to deliver real-time speech-to-text (STT), grammar correction, and translation. The system is designed for ultra-low latency (<200ms for partials) while maintaining high accuracy through retroactive reconciliation.

Listener (Frontend)
OpenAI (Grammar/Translation)
Google Speech STT
Backend (HostModeHandler)
Host Mic
Listener (Frontend)
OpenAI (Grammar/Translation)
Google Speech STT
Backend (HostModeHandler)
Host Mic
Delayed Final Reconciliation
Audio Data
Stream Audio
Partial Transcript ("God is migh...")
Broadcast Partial (Transcription Mode)
Partial Translation/Grammar Request
Partial Translation ("Dios es pode...")
Broadcast Partial (Translation Mode)
Final Signal ("God is mighty")
Final Translation
Final Translation ("Dios es poderoso")
Broadcast Final
2. Backend Process (Host Mode)
The backend logic resides primarily in 
backend/hostModeHandler.js
, utilizing the CoreEngine for state management.

A. The Partial Pipeline
Ingestion: speechStream.onResult receives transcription from Google Cloud STT.
Tracking: The partialTracker (part of CoreEngine) maintains latestPartialText and longestPartialText.
Throttling & Debouncing:
If current text is a prefix of lastPartialTranslation, it is skipped (exact match).
If GROWTH_THRESHOLD (1 character) and THROTTLE_MS (0ms) are met, it triggers immediate processing.
Parallel Execution:
Transcription: Sent immediately to same-language targets.
Grammar (Async): For English, a grammarWorker corrects the partial asynchronously.
Translation (Async): A partialWorker (Chat or Realtime API) translates to all listener target languages.
Emission: Each update is broadcast via 
broadcastWithSequence
, which attaches a seqId for ordering.
B. Delayed Final Reconciliation
Google STT often finalizes segments before the speaker finishes the sentence (stability-based finalization). Exbabel fixes this using a buffer:

Buffer Delay: Final transcripts are delayed by WAIT_FOR_PARTIALS_MS (1000ms - 3500ms depending on length).
Extension Recovery: During the delay, the system checks if new partials continue the "final" segment.
Merge Logic: If a partial extends the final or overlaps significantly, the final is updated to the longer version before being committed.
Forced Finals: When streaming restarts, "Forced Finals" use a snapshot of the last partial to ensure no words are lost during the transition.
3. Frontend Process (Listener Page)
The frontend logic in 
frontend/src/components/ListenerPage.jsx
 focuses on smooth rendering and state management.

A. Rendering Live Partials
Selective Updates: The listener only processes messages matching their targetLang (ref-guarded).
Out-of-Order (OOO) Prevention: A lastPartialSeqBySourceRef tracks seqId per sourceSeqId. If a message arrives with a lower seqId than the last seen for that segment, it is dropped.
UI Throttling:
Renders are capped at ~15 FPS (THROTTLE_MS = 66ms).
Significant growth (MIN_CHAR_DELTA = 3) or standard intervals trigger a flushSync update.
Dual Display: The UI simultaneously shows currentOriginal (Host's text) and currentTranslation (Listener's lang) to provide context.
B. Segmenter & History
Sentence Segmenter: A SentenceSegmenter utility watches live partials. When it detects a completed sentence (punctuation-based), it "auto-flushes" that sentence to the history.
Final Commitment: When a message.isPartial === false arrives:
The currentTranslation is cleared.
The final text is added to the translations history state.
The segment is enqueued for TTS Playback via TtsPlayerController.
4. Key Mechanisms for Accuracy
Mechanism	Purpose	Implementation Location
Pending Final Buffer	Catches trailing words that arrive after a "Final" signal.	
backend/hostModeHandler.js
Snapshot Sequence	Prevents race conditions during segment transitions.	partialTracker.getSnapshot()
Token Overlap Matching	Fuzzy matching to merge split segments.	
calculateTokenOverlap
Grammar Correction	Fixes ASR errors ("migh-ty" -> "mighty") before translation.	grammarWorker.correctPartial
FlushSync Rendering	Ensures the UI feels "alive" with no visible lag.	
ListenerPage.jsx
Summary of Data Flow
Audio -> ASR -> Partial Trace (Backend).
Partial Trace -> Parallel Grammar/Translation (Backend).
Broadcasting (Backend) -> OOO Drop -> Throttled Render (Frontend).
Sentence Detection (Frontend) -> History Update -> TTS Queue (Frontend).
