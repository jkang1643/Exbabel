# Translation/Transcription Pipeline Parameters

This document lists all tunable parameters that affect the translation and transcription pipeline performance, responsiveness, and behavior.

**Last Updated:** Current as of latest optimization pass

---

## Backend: Solo Mode Handler (`backend/soloModeHandler.js`)

### Translation Throttling & Update Frequency

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `THROTTLE_MS` | **20ms** | Consistent throttle for all text lengths | Lower = more frequent updates, higher CPU/API usage |
| `GROWTH_THRESHOLD` | **2 characters** | Minimum text growth to trigger translation | Lower = more sensitive, updates every ~half word |
| `MIN_TEXT_LENGTH_FOR_TRANSLATION` | **1 character** | Minimum text length to start translation | Lower = faster initial translation start |
| `DELAYED_TRANSLATION_MIN_LENGTH` | **3 characters** | Minimum length for delayed translation path | Prevents translating very short fragments |

### Finalization & Silence Detection

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `MIN_SILENCE_MS` | **600ms** | Minimum silence before finalization | Higher = waits longer, fewer premature finalizations |
| `FINALIZATION_CONFIRMATION_WINDOW` | **300ms** | Confirmation window for finalization | Buffer to prevent race conditions |
| `DEFAULT_LOOKAHEAD_MS` | **200ms** | Default lookahead for adaptive finalization | Used in RTT-based calculations |
| `LONGEST_PARTIAL_RECOVERY_WINDOW` | **5000ms** | Window to recover longest partial on final | Prevents word loss when final arrives early |

### RTT (Round-Trip Time) Measurement

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `MAX_RTT_SAMPLES` | **10** | Number of RTT samples to track | More samples = smoother average, more memory |
| `RTT_MIN_VALID` | **0ms** | Minimum valid RTT (filters negative) | Prevents clock sync issues |
| `RTT_MAX_VALID` | **10000ms** | Maximum valid RTT (filters outliers) | Prevents bad measurements from affecting system |

### Language Switching

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `LANGUAGE_CHANGE_DELAY` | **200ms** | Delay after language change before reinit | Prevents race conditions during stream restart |

---

## Backend: Translation Workers (`backend/translationWorkers.js`)

### Partial Translation Worker

#### Caching

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `MAX_CACHE_SIZE` | **200 entries** | Maximum cache entries for partials | Higher = more memory, better hit rate |
| `CACHE_TTL` | **120000ms (2 minutes)** | Cache time-to-live for partials | Longer = more hits, but may serve stale data |
| `CACHE_KEY_PREFIX_LENGTH_SHORT` | **150 characters** | Prefix length for short text cache keys | Balance between uniqueness and memory |
| `CACHE_KEY_PREFIX_LENGTH_LONG` | **200 characters** | Prefix length for long text cache keys | Prevents false cache hits on extending text |
| `CACHE_KEY_SUFFIX_LENGTH` | **100 characters** | Suffix length for long text cache keys | Catches text extensions beyond prefix |
| `CACHE_VALIDITY_LENGTH_RATIO` | **0.9 (90%)** | Minimum cached text length ratio to be valid | Prevents serving truncated translations |

#### Request Management

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `MAX_CONCURRENT` | **3 requests** | Maximum concurrent translation requests | Higher = smoother updates, more API usage |
| `RESET_DETECTION_LENGTH_RATIO` | **0.6 (60%)** | Text must be 60% shorter to be considered reset | Lower = more aggressive cancellation |
| `RESET_DETECTION_PREFIX_CHECK` | **100 characters** | Prefix length to check for reset detection | Prevents false resets on similar text |

#### API Configuration

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `MODEL` | **gpt-4o-mini** | OpenAI model for partial translations | Faster/cheaper than GPT-4o |
| `TEMPERATURE` | **0.2** | Temperature for partial translations | Lower = more consistent, less creative |
| `MAX_TOKENS` | **16000** | Maximum tokens per translation | Higher = handles longer text, more cost |
| `MIN_TEXT_LENGTH_STREAMING` | **5 characters** | Minimum text length for streaming translation | Prevents translating very short fragments |
| `MIN_TEXT_LENGTH_NON_STREAMING` | **1 character** | Minimum text length for non-streaming | Allows instant translation start |

### Final Translation Worker

#### Caching

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `MAX_CACHE_SIZE` | **100 entries** | Maximum cache entries for finals | Lower than partials since finals are stable |
| `CACHE_TTL` | **600000ms (10 minutes)** | Cache time-to-live for finals | Longer since finals don't change |
| `CACHE_KEY_PREFIX_LENGTH` | **200 characters** | Prefix length for final cache keys | Sufficient for uniqueness |

#### API Configuration

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `MODEL` | **gpt-4o-mini** | OpenAI model for final translations | Fast and cost-effective |
| `TEMPERATURE` | **0.3** | Temperature for final translations | Slightly higher than partials for quality |
| `MAX_TOKENS` | **16000** | Maximum tokens per translation | Handles very long passages |

---

## Backend: Google Speech Stream (`backend/googleSpeechStream.js`)

### Stream Management

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `STREAMING_LIMIT` | **240000ms (4 minutes)** | Auto-restart before Google's 5-minute limit | Prevents stream cutoff |
| `VAD_CUTOFF_LIMIT` | **25000ms (25 seconds)** | Restart before VAD becomes aggressive | Prevents premature finalization |

### Audio Batching (Jitter Buffer)

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `JITTER_BUFFER_DELAY` | **100ms** | Default batching delay | Balance between smooth flow and responsiveness |
| `JITTER_BUFFER_MIN` | **80ms** | Minimum batching delay | Prevents too-frequent sends |
| `JITTER_BUFFER_MAX` | **150ms** | Maximum batching delay | Prevents gaps in audio stream |

### Error Handling & Retries

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `MAX_CHUNK_RETRIES` | **3 attempts** | Maximum retries for failed chunks | Higher = more resilient, more latency on errors |
| `RETRY_BACKOFF_MS` | **[100, 200, 400]ms** | Exponential backoff delays | Prevents overwhelming on errors |
| `CHUNK_TIMEOUT_MS` | **7000ms (7 seconds)** | Timeout for chunk processing | Detects stuck chunks |

### Context Management

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `LAST_TRANSCRIPT_CONTEXT` | **50 characters** | Last transcript chars for context carry-forward | Provides continuity between sessions |

---

## Frontend: Translation Interface (`frontend/src/components/TranslationInterface.jsx`)

### Display Throttling

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `THROTTLE_STREAMING_LONG` | **20ms** | Throttle for streaming updates (text >300 chars) | Lower = smoother, more CPU usage |
| `THROTTLE_STREAMING_SHORT` | **30ms** | Throttle for streaming updates (text ≤300 chars) | Balance for shorter text |
| `THROTTLE_NON_STREAMING_LONG` | **30ms** | Throttle for non-streaming (text >300 chars) | Slightly higher than streaming |
| `THROTTLE_NON_STREAMING_SHORT` | **50ms** | Throttle for non-streaming (text ≤300 chars) | Standard throttle for normal updates |
| `THROTTLE_FALLBACK` | **50ms** | Throttle for fallback translation display | Consistent with non-streaming short |

### Sentence Segmenter

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `MAX_SENTENCES` | **10 sentences** | Maximum sentences in live view | Higher = more text before flush |
| `MAX_CHARS` | **2000 characters** | Maximum characters before flush | Prevents UI overflow |
| `MAX_TIME_MS` | **15000ms (15 seconds)** | Force flush after time limit | Prevents stale text accumulation |

---

## Frontend: Listener Page (`frontend/src/components/ListenerPage.jsx`)

### Display Throttling

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `THROTTLE_STREAMING_LONG` | **20ms** | Throttle for streaming updates (text >300 chars) | Matches TranslationInterface |
| `THROTTLE_STREAMING_SHORT` | **30ms** | Throttle for streaming updates (text ≤300 chars) | Matches TranslationInterface |
| `THROTTLE_NON_STREAMING` | **50ms** | Throttle for non-streaming updates | Standard throttle |

---

## Frontend: Host Page (`frontend/src/components/HostPage.jsx`)

### Display Throttling

| Parameter | Current Value | Description | Impact |
|-----------|--------------|-------------|--------|
| `THROTTLE_MS` | **50ms** | Consistent throttle for all transcript updates | 20 updates per second max |

---

## Performance Characteristics

### Current Performance Profile

- **Initial Translation Start:** ~1-2 characters (near-instant)
- **Update Frequency:** Every 2 characters or 20ms (whichever comes first)
- **Typical Update Rate:** 20-50 updates per second during active speech
- **Translation Latency:** ~200-500ms (depends on API response time)
- **Display Latency:** ~20-50ms (throttled for smooth rendering)

### Bottlenecks & Optimization Opportunities

1. **API Response Time:** Largest contributor to perceived latency
   - Current: ~200-500ms per translation
   - Optimization: Caching, concurrent requests, streaming

2. **Throttle Timing:** Balance between smoothness and CPU usage
   - Current: 20ms (very responsive)
   - Trade-off: Lower = smoother but more CPU/renders

3. **Growth Threshold:** Balance between responsiveness and API calls
   - Current: 2 characters (very sensitive)
   - Trade-off: Lower = more updates but more API calls

---

## Tuning Guidelines

### To Increase Responsiveness (Lower Latency)

1. **Reduce `THROTTLE_MS`** (backend): 20ms → 10ms
   - ⚠️ Increases CPU usage and API calls
   - ✅ More frequent updates

2. **Reduce `GROWTH_THRESHOLD`**: 2 → 1 character
   - ⚠️ More API calls
   - ✅ Updates on every character

3. **Reduce frontend throttles**: 20-50ms → 10-30ms
   - ⚠️ More renders, higher CPU
   - ✅ Smoother visual updates

### To Reduce API Usage & Cost

1. **Increase `THROTTLE_MS`** (backend): 20ms → 50ms
   - ✅ Fewer API calls
   - ⚠️ Less frequent updates

2. **Increase `GROWTH_THRESHOLD`**: 2 → 5 characters
   - ✅ Fewer API calls
   - ⚠️ Less frequent updates

3. **Increase `CACHE_TTL`**: 2min → 5min
   - ✅ More cache hits
   - ⚠️ May serve slightly stale translations

### To Improve Stability

1. **Increase `MIN_SILENCE_MS`**: 600ms → 1000ms
   - ✅ Fewer premature finalizations
   - ⚠️ Longer wait before finalization

2. **Increase `MAX_CONCURRENT`**: 3 → 5
   - ✅ More concurrent translations complete
   - ⚠️ Higher API usage and cost

3. **Increase `CHUNK_TIMEOUT_MS`**: 7s → 10s
   - ✅ More tolerant of slow processing
   - ⚠️ Longer delay before detecting stuck chunks

---

## Notes

- All time values are in milliseconds unless otherwise specified
- Character counts include spaces and punctuation
- API costs scale with `MAX_TOKENS` and request frequency
- Frontend throttles are independent of backend throttles (both apply)
- Cache effectiveness depends on text repetition patterns

---

## Quick Reference: Key Parameters for Fine-Tuning

| Goal | Parameter | Current | Suggested Range |
|------|-----------|---------|-----------------|
| **Instant feel** | `THROTTLE_MS` (backend) | 20ms | 10-30ms |
| **Character-level updates** | `GROWTH_THRESHOLD` | 2 chars | 1-5 chars |
| **Smooth display** | Frontend throttles | 20-50ms | 15-50ms |
| **Fewer API calls** | `THROTTLE_MS` (backend) | 20ms | 50-100ms |
| **Stability** | `MIN_SILENCE_MS` | 600ms | 800-1200ms |
| **Cache effectiveness** | `CACHE_TTL` (partials) | 2min | 2-5min |

