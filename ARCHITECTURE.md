# Architecture Documentation

Complete architecture documentation for the real-time translation application with parallel transcription, translation, and grammar correction.

---

## 🏗️ System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ Audio Capture│  │ WebSocket    │  │ Translation  │         │
│  │ (24kHz PCM) │→ │ Connection   │→ │ Display      │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└──────────────────────────────┬──────────────────────────────────┘
                               │ WebSocket
                               │ (JSON messages)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Backend (Node.js + Express)                   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Google Speech-to-Text Stream                 │  │
│  │  • 24kHz LINEAR16 PCM                                     │  │
│  │  • Partial results (word-by-word)                       │  │
│  │  • Auto-restart every 4 minutes                         │  │
│  │  • VAD cutoff prevention (25s restart)                 │  │
│  └──────────────────────┬───────────────────────────────────┘  │
│                         │                                       │
│                         ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Parallel Processing Pipeline                 │  │
│  │                                                           │  │
│  │  ┌──────────────────┐      ┌──────────────────┐         │  │
│  │  │ Translation       │      │ Grammar          │         │  │
│  │  │ Worker            │      │ Worker           │         │  │
│  │  │ (GPT-4o-mini)     │      │ (GPT-4o-mini)    │         │  │
│  │  │                   │      │                  │         │  │
│  │  │ • Partial: Fast   │      │ • Partial: Fast  │         │  │
│  │  │ • Final: Complete │      │ • Final: Quality│         │  │
│  │  │ • Streaming: Yes  │      │ • Streaming: No │         │  │
│  │  └─────────┬─────────┘      └─────────┬────────┘         │  │
│  │            │                           │                   │  │
│  │            └───────────┬───────────────┘                   │  │
│  │                        │                                   │  │
│  │                        ▼                                   │  │
│  │              ┌──────────────────┐                          │  │
│  │              │ Message Queue    │                          │  │
│  │              │ (Sequence IDs)   │                          │  │
│  │              └─────────┬─────────┘                          │  │
│  └────────────────────────┼───────────────────────────────────┘  │
│                           │                                       │
│                           ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Rate Limiter                                 │  │
│  │  • 4,500 RPM limit                                        │  │
│  │  • 1.8M TPM limit                                         │  │
│  │  • Exponential backoff                                    │  │
│  └──────────────────────┬───────────────────────────────────┘  │
│                         │                                       │
│                         ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              OpenAI API                                   │  │
│  │  • Chat Completions (Translation)                      │  │
│  │  • Chat Completions (Grammar)                            │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Processing Flow

### 1. Audio Capture (Frontend)

**File:** `frontend/public/audio-stream-processor.js`

```
Microphone → AudioWorklet (separate thread)
  → 300ms chunks with 500ms overlap
  → Int16 PCM conversion (24kHz, mono)
  → Base64 encoding
  → WebSocket message with metadata:
     {
       type: 'audio',
       audioData: 'base64...',
       chunkIndex: 123,
       startMs: 1000,
       endMs: 1300,
       clientTimestamp: 1234567890
     }
```

**Key Parameters:**
- **Chunk size:** 300ms
- **Overlap:** 500ms (prevents word loss at boundaries)
- **Sample rate:** 24kHz
- **Format:** LINEAR16 PCM

---

### 2. Transcription (Google Speech-to-Text)

**File:** `backend/googleSpeechStream.js`

```
Audio chunks → Google Speech Streaming API
  → Partial results (isPartial=true) - word-by-word
  → Final results (isPartial=false) - complete sentences
  → Callback: onResult(transcriptText, isPartial)
```

**Key Features:**
- **Partial results:** Enabled (`interimResults: true`)
- **Enhanced model:** `latest_long` (Chirp 3) when supported
- **Auto-restart:** Every 4 minutes (before 5-min limit)
- **VAD prevention:** Restart at 25 seconds (before aggressive VAD)
- **Jitter buffer:** 100ms batching for smooth flow

**Stream Configuration:**
```javascript
{
  encoding: 'LINEAR16',
  sampleRateHertz: 24000,
  languageCode: 'en-US', // Dynamic based on sourceLang
  enableAutomaticPunctuation: true,
  useEnhanced: true, // Conditional
  model: 'latest_long', // Conditional
  interimResults: true // CRITICAL for partials
}
```

---

### 3. Parallel Processing Pipeline

**Files:**
- `backend/soloModeHandler.js` (solo mode)
- `backend/host/adapter.js` and `core/engine/coreEngine.js` (host/listener mode)

#### 3a. Partial Results (DECOUPLED - For Speed)

```
Google Speech → Partial (isPartial=true)
  │
  ├─→ PartialTranslationWorker.translatePartial()
  │     • Model: gpt-4o-mini
  │     • Temperature: 0.2
  │     • Max tokens: 16000
  │     • Streaming: true (token-by-token)
  │     • Timeout: None (cancellable)
  │     → Frontend receives IMMEDIATELY
  │
  └─→ GrammarWorker.correctPartial()
        • Model: gpt-4o-mini
        • Temperature: 0.1
        • Max tokens: 800
        • Min length: 8 chars
        • Timeout: 2000ms
        → Frontend receives separately when ready
```

**Message Flow:**
1. Translation sent immediately with `seqId`, `isPartial: true`
2. Grammar sent separately with `updateType: 'grammar'`, `hasCorrection: true`
3. Frontend merges updates incrementally via `correctedText` field

**Benefits:**
- ✅ Translation appears instantly (200-500ms faster)
- ✅ Grammar corrections update in-place when ready
- ✅ Non-blocking: Slow grammar doesn't delay translation

#### 3b. Final Results (COUPLED - For Data Integrity)

```
Google Speech → Final (isPartial=false)
  │
  └─→ Promise.allSettled([
        FinalTranslationWorker.translateFinal(),
        GrammarWorker.correctFinal()
      ])
        • Both run in parallel
        • WAIT for both to complete
        • Single message with both results
        → Frontend receives complete message
        → Added to history with grammar-corrected original
```

**Message Format:**
```json
{
  "type": "translation",
  "seqId": 123,
  "serverTimestamp": 1234567890,
  "isPartial": false,
  "originalText": "Hello world",
  "correctedText": "Hello, world.",
  "translatedText": "Hola, mundo.",
  "hasTranslation": true,
  "hasCorrection": true
}
```

**Benefits:**
- ✅ History entries always have complete, corrected data
- ✅ Single atomic update prevents incomplete history
- ✅ Grammar-corrected original text preserved

---

### 4. Translation Workers

**Files:** `backend/translationWorkers.js`, `backend/translationWorkersRealtime.js`

#### RealtimePartialTranslationWorker (Host Mode)

**Purpose:** Ultra low-latency translations using OpenAI's Realtime API.

**Configuration:**
- **Model:** `gpt-realtime-mini`
- **Connection Strategy:** WebSocket pool. Connections are specifically closed after *each* partial response to prevent conversational context accumulation, maintaining consistent ~150-300ms latency.
- **Concurrency:** `5` parallel workers, handling up to `30` pending requests.

#### PartialTranslationWorker (Legacy/Solo)

**Purpose:** Fast, low-latency translations for live updates

**Configuration:**
- **Model:** `gpt-4o-mini` (fast, cost-effective)
- **Temperature:** `0.2` (consistent)
- **Max tokens:** `16000` (handles long passages)
- **Streaming:** `true` (token-by-token updates)
- **Concurrency:** `5` parallel requests
- **Throttle:** `2000ms` (1 request per 2 seconds)
- **Growth threshold:** `25` chars or punctuation
- **Cache:** `200` entries, `2` minute TTL

**Features:**
- ✅ Request cancellation (smart cancellation on resets)
- ✅ Larger cache for partials (frequent repeats)
- ✅ Handles incomplete sentences gracefully
- ✅ Smart reset detection (only cancels if text shrunk >40%)

#### FinalTranslationWorker

**Purpose:** Fast translations for history entries

**Configuration:**
- **Model:** `gpt-4o-mini` (fast and cost-effective)
- **Temperature:** `0.3` (balanced)
- **Max tokens:** `16000` (full context)
- **Streaming:** `false` (complete response)
- **Cache:** `100` entries, `10` minute TTL

**Features:**
- ✅ No cancellation (always completes)
- ✅ Standard cache for finals
- ✅ Complete sentence context

---

### 5. Grammar Worker

**File:** `backend/grammarWorker.js`

**Purpose:** Real-time grammar correction for English transcripts

#### Partial Grammar Correction

**Configuration:**
- **Model:** `gpt-4o-mini`
- **Temperature:** `0.1` (very consistent)
- **Max tokens:** `800` (faster responses)
- **Min length:** `8` chars (skips trivial words)
- **Throttle:** `2000ms` (1 request per 2 seconds)
- **Growth threshold:** `20` chars or punctuation
- **Timeout:** `2000ms` (prevents blocking UI)
- **Cache:** `200` entries, `2` minute TTL

**Features:**
- ✅ Handles homophones and STT mishears
- ✅ Respects biblical/church language
- ✅ Preserves meaning (no paraphrasing)
- ✅ Fast timeout prevents UI blocking

#### Final Grammar Correction

**Configuration:**
- **Model:** `gpt-4o-mini`
- **Temperature:** `0.1`
- **Max tokens:** `2000` (full context)
- **Timeout:** `5000ms` (longer for quality)

**Features:**
- ✅ Complete context for quality
- ✅ Longer timeout for accuracy

---

### 6. Rate Limiting

**File:** `backend/openaiRateLimiter.js`

**Purpose:** Prevents hitting OpenAI API rate limits

**Configuration:**
- **RPM limit:** `4,500` requests/minute (10% safety margin)
- **TPM limit:** `1,800,000` tokens/minute (10% safety margin)
- **Max retries:** `5` attempts
- **Base delay:** `1000ms` exponential backoff
- **Max delay:** `60000ms` (60 seconds)

**Features:**
- ✅ Automatic retry with exponential backoff
- ✅ Request skipping if wait > 2 seconds
- ✅ TPM/RPM limit detection and handling
- ✅ Per-minute window tracking

---

### 7. Message Sequencing

**Files:**
- `backend/soloModeHandler.js` (backend)
- `frontend/src/components/TranslationInterface.jsx` (frontend)

**Backend:**
```javascript
const sendWithSequence = (messageData, isPartial = true) => {
  const seqId = sequenceCounter++;
  latestSeqId = Math.max(latestSeqId, seqId);
  
  const message = {
    ...messageData,
    seqId,
    serverTimestamp: Date.now(),
    isPartial
  };
  
  clientWs.send(JSON.stringify(message));
};
```

**Frontend:**
```javascript
if (message.seqId <= latestSeqIdRef.current) {
  console.log(`[TranslationInterface] Dropping stale message (seq: ${message.seqId} <= ${latestSeqIdRef.current})`);
  return; // Drop stale message
}

latestSeqIdRef.current = message.seqId;
// Process message...
```

**Benefits:**
- ✅ Prevents race conditions from network reordering
- ✅ Enables accurate latency measurement
- ✅ Improves reliability under poor network conditions

---

## 🎯 Mode-Specific Architecture

### Solo Mode

**File:** `backend/soloModeHandler.js`

**Flow:**
1. Single WebSocket connection
2. Google Speech stream initialized on `init` message
3. Audio chunks processed → transcription → parallel translation/grammar
4. Results sent back to same client

**Features:**
- ✅ Ultra-fast real-time settings (0ms throttle, 1-char updates)
- ✅ RTT measurement and adaptive lookahead
- ✅ Decoupled partials, coupled finals

### Host/Listener Mode

**Files:** `backend/host/adapter.js`, `core/engine/coreEngine.js`

**Flow:**
1. Host connects → `host/adapter.js` delegates session management to `CoreEngine`.
2. Audio stream → transcription → `CoreEngine` sequences messages via `TimelineOffsetTracker`.
3. `RTTTracker` measures network latency to adjust finalization timing via `FinalizationEngine`.
4. Translated segments are broadcast directly via `SessionStore` WebSockets.

**Features:**
- ✅ Stateful orchestration separated from transport via `CoreEngine`.
- ✅ Adaptive lookahead based on Round-Trip Time (RTT).
- ✅ Real-time translations using OpenAI's Realtime API (`gpt-realtime-mini`).
- ✅ Strict segment sequencing (`seqId`) guarantees correct display order.

---

### 8. Text-to-Speech (TTS) Pipeline

**Files:** 
- `backend/tts/TtsStreamingOrchestrator.js`
- `frontend/src/tts/TtsPlayerController.js`

**Flow:**
1. Backend `TtsStreamingOrchestrator` queues finalized segments.
2. Segments are routed to providers (e.g., ElevenLabs, Google).
3. Audio chunks are streamed to frontend WebSockets.
4. Frontend `TtsPlayerController` receives chunks and queues them.

**Queue Processing & Latency:**
- **Mode 1 (Radio Mode):** Enforces *strict sequential playback*. If segment `seqId=5` is requested but delayed, segment `seqId=6` *will not play* even if ready. This prevents out-of-order audio but can artificially inflate perceived latency if a single synthesis request stalls.
- **Deduplication:** The controller actively discards duplicate segments based on text hashing to stabilize playback.

---

## 📊 Performance Characteristics

### Latency Breakdown

1. **Audio capture:** ~50-100ms (300ms chunks)
2. **Network transmission:** ~50-200ms (WebSocket)
3. **Google Speech processing:** ~200-500ms (partial results)
4. **Translation (partial):** ~200-800ms (GPT-4o-mini, streaming)
5. **Grammar (partial):** ~100-500ms (GPT-4o-mini, non-blocking)
6. **Total (partial):** ~600-2000ms end-to-end

### Throughput

- **Audio chunks:** ~3.3 chunks/second (300ms chunks)
- **Translation requests:** ~0.5 requests/second (2s throttle)
- **Grammar requests:** ~0.5 requests/second (2s throttle)
- **Concurrent translations:** Up to 5 parallel requests

### Resource Usage

- **Memory:** ~50-100MB per active session
- **CPU:** Low impact (browser handles audio encoding)
- **Network:** ~8-12 KB per 300ms audio chunk
- **API calls:** ~1-2 calls/second per session (translation + grammar)

---

## 🔐 Security Considerations

1. **API Keys:** Never exposed to frontend, stored server-side only
2. **WebSocket:** Validated connections, session-based authentication
3. **Rate Limiting:** Prevents API abuse and quota exhaustion
4. **Error Handling:** Graceful degradation on API failures
5. **Input Validation:** Language codes validated against `languageConfig.js`

---

## 🚀 Scalability

### Horizontal Scaling
- **Stateless backend:** Can run multiple instances
- **Session store:** Can be moved to Redis for multi-instance support
- **Load balancing:** WebSocket connections can be load-balanced

### Vertical Scaling
- **Concurrent sessions:** Limited by server resources and API quotas
- **Rate limits:** 4,500 RPM / 1.8M TPM per instance
- **Memory:** ~50-100MB per active session

---

**Last Updated:** January 2025  
**Status:** Production-ready architecture with parallel processing optimization

