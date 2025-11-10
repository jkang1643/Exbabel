# Capacity Analysis: Actual Concurrent Session Support

## Resource Constraints Analysis

### 1. API Rate Limits (OpenAI)

**Limits**:
- Requests Per Minute (RPM): 4,500 (with 10% safety margin)
- Tokens Per Minute (TPM): 1,800,000 (with 10% safety margin)

**Per Session API Usage** (from costAnalysis.js):
- Partial translations: ~12 requests/minute
- Final translations: ~10 requests/minute  
- Grammar partial: ~12 requests/minute
- Grammar final: ~10 requests/minute
- **Total: ~44 API calls/minute per session**

**Theoretical API Capacity**:
- 4,500 RPM ÷ 44 RPM/session = **~102 sessions** (API limit)

**Token Usage Per Session** (actual calculation):
- Translation partial: ~150 chars system + 50 chars text = ~50 tokens input + ~50 tokens output = ~100 tokens/request
- Translation final: ~150 chars system + 100 chars text = ~60 tokens input + ~60 tokens output = ~120 tokens/request
- Grammar partial: ~2000 chars system + 50 chars text = ~500 tokens input + ~50 tokens output = ~550 tokens/request
- Grammar final: ~2000 chars system + 100 chars text = ~525 tokens input + ~100 tokens output = ~625 tokens/request

**Per Minute Token Usage**:
- Translation partial: 12 × 100 = 1,200 tokens
- Translation final: 10 × 120 = 1,200 tokens
- Grammar partial: 12 × 550 = 6,600 tokens
- Grammar final: 10 × 625 = 6,250 tokens
- **Total: ~15,250 tokens/minute per session**

**Theoretical Token Capacity**:
- 1,800,000 TPM ÷ 15,250 tokens/session = **~118 sessions** (token limit)

**API Bottleneck**: ~102 sessions (RPM is the limiting factor)

### 2. Memory Constraints (t3.small: 2GB RAM)

**Per Session Memory Usage**:
- WebSocket connection: ~1-2 MB
- Google Speech stream: ~2-5 MB (buffers, state)
- Translation state/cache: ~1-2 MB
- Event loop buffers: ~1-2 MB
- **Total: ~5-10 MB per session**

**Available Memory**:
- System overhead: ~500 MB
- Node.js runtime: ~100-200 MB
- Available for sessions: ~1,300-1,400 MB

**Memory Capacity**:
- 1,400 MB ÷ 7.5 MB/session = **~186 sessions** (memory limit)

**Memory Bottleneck**: ~186 sessions

### 3. CPU Constraints (t3.small: 2 vCPU)

**Per Session CPU Usage**:
- WebSocket handling: Mostly I/O bound (minimal CPU)
- Google Speech processing: I/O bound (network)
- Translation API calls: I/O bound (network wait)
- JSON parsing/processing: ~1-2% CPU per session
- Event loop processing: ~0.5-1% CPU per session
- **Total: ~2-3% CPU per active session**

**CPU Capacity**:
- 200% CPU (2 cores) ÷ 2.5% per session = **~80 sessions** (CPU limit)

**CPU Bottleneck**: ~80 sessions

### 4. Network Constraints

**Per Session Network Usage**:
- Audio input: ~24kHz PCM = ~48 KB/s = ~2.9 MB/minute
- Google Speech API: ~1-2 KB/s upstream, ~0.5 KB/s downstream
- OpenAI API: ~1-2 KB/s per request (bursty)
- **Total: ~3-4 MB/minute per session**

**Network Capacity** (t3.small: Up to 5 Gbps):
- 5 Gbps = 625 MB/s = 37,500 MB/minute
- 37,500 MB/minute ÷ 3.5 MB/session = **~10,714 sessions** (network limit)

**Network Bottleneck**: Not a constraint (plenty of bandwidth)

### 5. Connection Limits

**Per Session Connections**:
- 1 WebSocket connection (client → backend)
- 1 Google Speech API stream (persistent WebSocket)
- Multiple HTTP connections to OpenAI (reused via connection pooling)
- **Total: ~2-3 persistent connections per session**

**System Connection Limits**:
- Default Linux: ~65,000 connections
- Node.js: Limited by ulimit (typically 1,024-4,096)
- **Practical limit: ~1,000-2,000 sessions** (connection limit)

**Connection Bottleneck**: ~1,000-2,000 sessions

## Actual Capacity Calculation

**Bottleneck Analysis**:
1. API Rate Limits: **102 sessions** (RPM limit)
2. CPU: **80 sessions** (2 vCPU)
3. Memory: **186 sessions** (2GB RAM)
4. Network: **10,714 sessions** (not a constraint)
5. Connections: **1,000-2,000 sessions** (not a constraint)

**ACTUAL CAPACITY: ~80 concurrent sessions** (CPU is the limiting factor)

However, this assumes:
- All sessions are actively speaking/translating
- No other processes consuming CPU
- Optimal event loop performance

**Realistic Capacity**: **50-60 concurrent sessions** with headroom for:
- System processes
- Garbage collection
- Network overhead
- Error handling

## Performance Degradation Analysis

### Current Architecture (Single Process, Single Event Loop)

**With 1 Session**:
- CPU: ~2-3%
- Latency: 200-500ms (optimal)

**With 2 Sessions**:
- CPU: ~5-6%
- Latency: 300-800ms (fair-share helps, but event loop contention)

**With 5 Sessions**:
- CPU: ~12-15%
- Latency: 400-1200ms (increasing contention)

**With 10 Sessions**:
- CPU: ~25-30%
- Latency: 600-2000ms (significant contention)

**With 20 Sessions**:
- CPU: ~50-60%
- Latency: 1000-3000ms (high contention, event loop blocking)

**With 50 Sessions**:
- CPU: ~125-150% (overloaded, context switching overhead)
- Latency: 2000-5000ms+ (severe degradation)

## Root Cause: Event Loop Blocking

The main bottleneck is **CPU-bound processing blocking the event loop**:

1. **JSON Parsing**: Synchronous, blocks event loop
2. **Translation Processing**: CPU-intensive (even though mostly I/O wait)
3. **String Manipulation**: Synchronous operations
4. **Cache Operations**: Map operations can block with many sessions

**Why Latency Increases**:
- Event loop can't process WebSocket messages while doing CPU work
- Translation requests queue up, causing delays
- Google Speech responses get delayed processing

## Optimization Strategy

### Phase 1: Event Loop Optimization (Current - Partial)

✅ Parallel request queue (4 concurrent)
✅ Increased translation concurrency (5/2)
✅ Fair-share rate limiting

**Result**: Better, but still event loop contention

### Phase 2: Worker Threads (REQUIRED for 50+ Sessions)

**Move CPU-intensive work to worker threads**:
- Translation processing (JSON parsing, string manipulation)
- Cache operations
- Heavy computation

**Expected Impact**:
- Event loop stays responsive
- CPU work doesn't block WebSocket handling
- **Capacity: 50-80 sessions with 200-500ms latency**

### Phase 3: Connection Pooling (REQUIRED for Low Latency)

**Pre-warm HTTP connections**:
- Maintain pool of ready connections to OpenAI
- Reuse connections (saves 50-200ms per request)
- HTTP/2 multiplexing

**Expected Impact**:
- 50-200ms faster per translation request
- **Maintains 200-500ms latency even with 20+ sessions**

### Phase 4: Separate Translation Process (OPTIONAL)

**Isolate translation completely**:
- Separate Node.js process for translation
- IPC communication
- Complete event loop isolation

**Expected Impact**:
- WebSocket handling never blocked
- **Capacity: 80+ sessions with 200-500ms latency**

## Recommended Capacity Targets

### Phase 1 (Current - Completed)
- **1 session**: 200-500ms latency ✅
- **2-5 sessions**: 300-800ms latency ⚠️
- **10 sessions**: 600-1200ms latency ⚠️
- **20+ sessions**: 1000ms+ latency ❌

### Phase 1.5 (For 2-4 Sessions - Next Steps)
**Goal**: Achieve 200-500ms latency for 2-4 sessions

**Optimizations**:
- HTTP connection pooling (saves 50-200ms per request)
- Queue optimization (increase to 6 concurrent)
- Minor async improvements

**Expected Results**:
- **2 sessions**: 200-500ms latency ✅
- **3 sessions**: 250-600ms latency ✅
- **4 sessions**: 300-700ms latency ✅

**Feasibility**: ✅ **YES** - With connection pooling, 2-4 sessions can achieve target latency

### Phase 1.5 (Connection Pooling - For 2-4 Sessions)
- **2 sessions**: 200-500ms latency ✅
- **3 sessions**: 250-600ms latency ✅
- **4 sessions**: 300-700ms latency ✅

### With Worker Threads (Phase 2 - For 20+ Sessions)
- **10-20 sessions**: 200-500ms latency ✅
- **30-50 sessions**: 300-700ms latency ✅
- **50-80 sessions**: 400-1000ms latency ⚠️

### With Worker Threads + Connection Pooling (Phase 2 + 3)
- **20-30 sessions**: 200-500ms latency ✅
- **40-60 sessions**: 250-600ms latency ✅
- **60-80 sessions**: 300-800ms latency ✅

### With All Optimizations (Phase 2 + 3 + 4)
- **50-80 sessions**: 200-500ms latency ✅
- **80+ sessions**: 300-700ms latency ✅

## Conclusion

**Actual Capacity**: ~50-60 concurrent sessions on t3.small (realistic)

**To Maintain 200-500ms Latency**:
- **10-20 sessions**: Current architecture (with Phase 1 optimizations)
- **20-50 sessions**: Requires worker threads (Phase 2)
- **50-80 sessions**: Requires worker threads + connection pooling (Phase 2 + 3)

**Key Insight**: The bottleneck isn't API limits or memory - it's **CPU/event loop blocking**. Worker threads are essential for maintaining low latency with 20+ concurrent sessions.

