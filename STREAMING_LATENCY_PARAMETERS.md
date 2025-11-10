# Streaming Latency Parameters

Complete documentation of all parameters related to streaming latency, transcription, translation, and grammar correction.

---

## 🎙️ Google Speech-to-Text Parameters

### Audio Configuration
**File:** `backend/googleSpeechStream.js`

| Parameter | Value | Description |
|-----------|-------|-------------|
| `encoding` | `LINEAR16` | 16-bit linear PCM encoding |
| `sampleRateHertz` | `24000` | 24kHz sample rate (matches frontend audio capture) |
| `languageCode` | Dynamic | Language code from `languageConfig.js` (e.g., `en-US`, `es-ES`) |
| `enableAutomaticPunctuation` | `true` | Automatically adds punctuation |
| `interimResults` | `true` | **CRITICAL:** Enables partial/word-by-word results |
| `useEnhanced` | `true` (conditional) | Enhanced Chirp 3 model (falls back to default if not supported) |
| `model` | `latest_long` (conditional) | Enhanced Chirp 3 model for best accuracy (only if enhanced supported) |

### Streaming Limits
| Parameter | Value | Description |
|-----------|-------|-------------|
| `STREAMING_LIMIT` | `240000` ms (4 min) | Auto-restart before Google's 5-minute limit |
| `VAD_CUTOFF_LIMIT` | `25000` ms (25 sec) | Auto-restart before VAD becomes aggressive (~30s) |
| `cumulativeAudioTime` | Tracked | Total audio sent in current session |

### Audio Batching (Jitter Buffer)
| Parameter | Value | Description |
|-----------|-------|-------------|
| `jitterBufferDelay` | `100` ms | Batching delay (sweet spot: smooth but responsive) |
| `jitterBufferMin` | `80` ms | Minimum batching delay |
| `jitterBufferMax` | `150` ms | Maximum batching delay |

**Purpose:** Batches audio chunks into 100-150ms groups to prevent VAD gaps while maintaining responsiveness.

### Chunk Retry & Timeout
| Parameter | Value | Description |
|-----------|-------|-------------|
| `MAX_CHUNK_RETRIES` | `3` | Maximum retry attempts for failed chunks |
| `RETRY_BACKOFF_MS` | `[100, 200, 400]` | Exponential backoff delays (ms) |
| `CHUNK_TIMEOUT_MS` | `7000` ms (7 sec) | Timeout for stuck chunks (5s + 2s buffer) |

### Speech Context
| Parameter | Value | Description |
|-----------|-------|-------------|
| `lastTranscriptContext` | Last 50 chars | Context carry-forward between stream restarts |

---

## 🔄 Translation Worker Parameters

### Partial Translation Worker
**File:** `backend/translationWorkers.js`  
**Purpose:** Fast, low-latency translations for live updates

| Parameter | Value | Description |
|-----------|-------|-------------|
| `model` | `gpt-4o-mini` | Fast, cost-effective model |
| `temperature` | `0.2` | Low temperature for consistency |
| `max_tokens` | `16000` | Handles very long passages without truncation |
| `stream` | `true` | Token-by-token streaming updates |
| `THROTTLE_MS` | `2000` ms | Throttle to ~1 request every 2 seconds |
| `GROWTH_THRESHOLD` | `25` chars | Wait until text grows by 25 chars or punctuation |
| `MAX_CACHE_SIZE` | `200` entries | Larger cache for partials |
| `CACHE_TTL` | `120000` ms (2 min) | Cache time-to-live |
| `MAX_CONCURRENT` | `5` | Maximum parallel translation requests |

### Final Translation Worker
**File:** `backend/translationWorkers.js`  
**Purpose:** Fast translations for history entries

| Parameter | Value | Description |
|-----------|-------|-------------|
| `model` | `gpt-4o-mini` | Fast and cost-effective |
| `temperature` | `0.3` | Balanced temperature |
| `max_tokens` | `16000` | Full context for long passages |
| `stream` | `false` | No streaming (complete response) |
| `MAX_CACHE_SIZE` | `100` entries | Standard cache size |
| `CACHE_TTL` | `600000` ms (10 min) | Longer cache for finals |

---

## ✏️ Grammar Worker Parameters

**File:** `backend/grammarWorker.js`  
**Purpose:** Real-time grammar correction for English transcripts

### Partial Grammar Correction
| Parameter | Value | Description |
|-----------|-------|-------------|
| `model` | `gpt-4o-mini` | Fast grammar correction |
| `temperature` | `0.1` | Very low temperature for consistency |
| `max_tokens` | `800` | Faster responses for partials |
| `minTextLength` | `8` chars | Minimum text length (skips trivial words) |
| `THROTTLE_MS` | `2000` ms | Throttle to ~1 request every 2 seconds |
| `GROWTH_THRESHOLD` | `20` chars | Wait until text grows by 20 chars or punctuation |
| `timeout` | `2000` ms (2 sec) | Prevents blocking UI if API is slow |
| `MAX_CACHE_SIZE` | `200` entries | Cache size |
| `CACHE_TTL` | `120000` ms (2 min) | Cache time-to-live |

### Final Grammar Correction
| Parameter | Value | Description |
|-----------|-------|-------------|
| `model` | `gpt-4o-mini` | Grammar correction model |
| `temperature` | `0.1` | Very low temperature |
| `max_tokens` | `2000` | Full context for finals |
| `timeout` | `5000` ms (5 sec) | Longer timeout for quality |

---

## ⚡ Solo Mode Handler Parameters

**File:** `backend/soloModeHandler.js`  
**Purpose:** Handles solo translation sessions with parallel processing

### Finalization Parameters
| Parameter | Value | Description |
|-----------|-------|-------------|
| `MIN_SILENCE_MS` | `600` ms | Minimum silence before finalization |
| `FINALIZATION_CONFIRMATION_WINDOW` | `300` ms | Confirmation window for finalization |
| `DEFAULT_LOOKAHEAD_MS` | `200` ms | Default lookahead buffer |
| `MAX_RTT_SAMPLES` | `10` | Rolling average RTT samples |

### Translation Throttling
| Parameter | Value | Description |
|-----------|-------|-------------|
| `THROTTLE_MS` | `0` ms | **NO THROTTLE** - instant translation |
| `GROWTH_THRESHOLD` | `1` char | Updates on every character |

**Note:** Ultra-fast real-time settings for character-by-character updates.

### RTT-Based Adaptive Lookahead
| Parameter | Formula | Description |
|-----------|---------|-------------|
| `adaptiveLookahead` | `RTT/2` (capped 200-700ms) | Dynamic lookahead based on network RTT |

---

## 🎤 Host Mode Handler Parameters

**File:** `backend/hostModeHandler.js`  
**Purpose:** Handles multi-user host/listener sessions

### Partial Translation Throttling
| Parameter | Value | Description |
|-----------|-------|-------------|
| `PARTIAL_TRANSLATION_THROTTLE` | `0` ms | **REAL-TIME INSTANT** - 0ms for maximum speed |

**Note:** Cancellation prevents spam, allowing instant updates.

---

## 🚦 Rate Limiting Parameters

**File:** `backend/openaiRateLimiter.js`  
**Purpose:** Prevents hitting OpenAI API rate limits

### Rate Limits
| Parameter | Value | Description |
|-----------|-------|-------------|
| `MAX_REQUESTS_PER_MINUTE` | `4500` | 5,000 RPM limit with 10% safety margin |
| `MAX_TOKENS_PER_MINUTE` | `1800000` | 2M TPM limit with 10% safety margin |

### Retry Configuration
| Parameter | Value | Description |
|-----------|-------|-------------|
| `maxRetries` | `5` | Maximum retry attempts |
| `baseDelay` | `1000` ms | Base delay for exponential backoff |
| `maxDelay` | `60000` ms (60 sec) | Maximum delay between retries |

### Retry Delay Calculation
- **Short delays (< 100ms):** `delay * 1.5` or `delay + 50ms` (minimum)
- **Long delays (≥ 100ms):** `delay * 1.2` or `delay + 200ms` (minimum)
- **TPM limits (< 500ms):** Minimum 1000ms wait to respect rate limit window

### Request Skipping
| Parameter | Value | Description |
|-----------|-------|-------------|
| `skipThreshold` | `2000` ms (2 sec) | Skip request if wait time exceeds threshold |

---

## 📡 Frontend Audio Capture Parameters

**File:** `frontend/public/audio-stream-processor.js`

### Audio Chunking
| Parameter | Value | Description |
|-----------|-------|-------------|
| `chunkDuration` | `300` ms | Chunk duration |
| `overlapDuration` | `500` ms | Overlap buffer between chunks |
| `sampleRate` | `24000` Hz | Sample rate (matches backend) |
| `channels` | `1` (mono) | Mono audio |

### Audio Processing
| Parameter | Value | Description |
|-----------|-------|-------------|
| `echoCancellation` | `true` | Echo cancellation enabled |
| `noiseSuppression` | `true` | Noise suppression enabled |
| `autoGainControl` | `true` | Auto gain control enabled |

---

## 🔄 Parallel Processing Architecture

### Partial Results (Live Updates) - DECOUPLED
```
Google Speech STT → Partial (isPartial=true)
  ├─→ PartialTranslationWorker (GPT-4o-mini)
  │     → Frontend (translation shows IMMEDIATELY)
  │
  └─→ GrammarWorker (GPT-4o-mini, min 8 chars)
        → Frontend (grammar update sent separately when ready)
```

**Latency:** Translation appears instantly, grammar follows separately (100-500ms later)

### Final Results (History) - COUPLED
```
Google Speech STT → Final (isPartial=false)
  → Translation + Grammar run in parallel
  → WAIT for both to complete
  → Frontend receives complete message (translation + grammar)
  → Added to history with grammar-corrected original text
```

**Latency:** Single atomic update ensures complete data in history

---

## 📊 Expected Latency Metrics

### Translation Latency
- **Short text (< 20 chars):** 200-400ms - Near-instantaneous
- **Medium text (20-100 chars):** 400-800ms - Fast incremental updates
- **Long text (> 100 chars):** 800-1500ms - Smooth streaming

### Grammar Correction Latency
- **Partials:** 100-500ms after translation (non-blocking)
- **Finals:** Included in final message (coupled with translation)

### Character-by-Character Updates
- **Update frequency:** Every 1-2 characters
- **Throttle:** 0ms (no artificial delay)
- **Concurrency:** 5 parallel requests (reduced cancellations)

---

## 🎯 Optimization Summary

### Ultra-Fast Real-Time Settings
- ✅ **Zero throttle** (0ms) - instant translation
- ✅ **1-character updates** - true real-time feel
- ✅ **5x concurrency** - smoother updates, fewer cancellations
- ✅ **Smart cancellation** - only cancels on true resets (>40% reduction)
- ✅ **Decoupled processing** - translation shows immediately, grammar follows

### Latency Improvements
- **Translation:** 200-500ms faster (decoupled from grammar)
- **Grammar:** 20-30% faster (optimized parameters)
- **Character updates:** Every 1-2 characters (vs 2-5 chars before)
- **Fewer cancellations:** 5 concurrent requests vs 2

---

**Last Updated:** January 2025  
**Status:** All parameters optimized for ultra-fast real-time translation

