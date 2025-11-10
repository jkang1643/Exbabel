# Phase 2 Optimization Plan: Worker Threads & Connection Pooling

## Overview

Phase 2 optimizations are designed to maintain 200-500ms latency with 20-50+ concurrent sessions on a single t3.small instance. These optimizations address the root cause: **event loop blocking** from CPU-intensive translation processing.

## Target Capacity After Phase 2

- **20-30 sessions**: 200-500ms latency ✅
- **40-60 sessions**: 250-600ms latency ✅
- **60-80 sessions**: 300-800ms latency ✅

## Phase 2 Optimizations

### 1. Worker Threads for Translation Processing (CRITICAL)

**Problem**: CPU-intensive translation processing blocks the main event loop, causing WebSocket handling delays.

**Solution**: Move translation processing to worker threads.

**Implementation**:
- Create `backend/workerPool.js` - Manages pool of worker threads
- Create `workers/translationWorker.js` - Worker thread that processes translations
- Move JSON parsing, string manipulation, cache operations to workers
- Keep WebSocket handling on main thread (stays responsive)

**Files to Create**:
- `backend/workerPool.js` - Worker thread pool manager
- `workers/translationWorker.js` - Translation processing worker
- `workers/sharedState.js` - Shared state between main thread and workers

**Files to Modify**:
- `backend/translationWorkers.js` - Route translation requests to worker pool
- `backend/soloModeHandler.js` - Use worker pool for translations

**Expected Impact**:
- Event loop stays responsive even with 20+ concurrent sessions
- CPU work doesn't block WebSocket handling
- **Capacity: 20-50 sessions with 200-500ms latency**

**Risks**:
- Worker thread overhead (minimal)
- Shared state synchronization (use SharedArrayBuffer or Redis)
- Error handling across threads

### 2. Connection Pooling and Pre-warming (CRITICAL)

**Problem**: Creating new HTTP connections to OpenAI API adds 50-200ms overhead per request.

**Solution**: Maintain pool of pre-warmed HTTP connections.

**Implementation**:
- Create `backend/connectionPool.js` - HTTP connection pool manager
- Create `backend/openaiConnectionPool.js` - OpenAI-specific connection pool
- Pre-warm connections on startup
- Reuse connections via HTTP keep-alive
- Support HTTP/2 multiplexing for better concurrency

**Files to Create**:
- `backend/connectionPool.js` - Generic HTTP connection pool
- `backend/openaiConnectionPool.js` - OpenAI API connection pool

**Files to Modify**:
- `backend/translationWorkers.js` - Use connection pool instead of creating new connections
- `backend/openaiRateLimiter.js` - Integrate with connection pool

**Expected Impact**:
- 50-200ms faster per translation request
- Reduced connection overhead
- Better connection reuse
- **Maintains 200-500ms latency even with 20+ sessions**

**Risks**:
- Connection pool management complexity
- Connection health monitoring
- Pool size tuning

### 3. Separate Translation Process (OPTIONAL)

**Problem**: Even with worker threads, some contention may occur.

**Solution**: Complete isolation via separate Node.js process.

**Implementation**:
- Create `services/translationService.js` - Separate translation process
- Create `services/translationQueue.js` - Message queue for translation requests
- Use IPC (Inter-Process Communication) for fast communication
- Translation process has its own event loop (complete isolation)

**Files to Create**:
- `services/translationService.js` - Translation service process
- `services/translationQueue.js` - Message queue implementation
- `services/ipcClient.js` - IPC client for main process

**Files to Modify**:
- `backend/soloModeHandler.js` - Send translation requests via IPC
- `backend/server.js` - Spawn translation service process

**Expected Impact**:
- Complete event loop isolation
- WebSocket handling never blocked
- **Capacity: 50-80 sessions with 200-500ms latency**

**Risks**:
- Process management complexity
- IPC overhead (minimal, but exists)
- Error handling across processes

### 4. Request Batching and Deduplication (OPTIMIZATION)

**Problem**: Multiple sessions may translate identical text, wasting API calls.

**Solution**: Share translation cache and deduplicate requests.

**Implementation**:
- Enhance translation cache to be shared across all sessions
- Detect duplicate translation requests
- Batch similar requests together
- Prioritize partials over finals for responsiveness

**Files to Modify**:
- `backend/translationWorkers.js` - Add request deduplication logic
- `backend/soloModeHandler.js` - Check cache before making requests

**Expected Impact**:
- 20-30% reduction in API calls
- Faster cache hits
- Reduced API costs

**Risks**:
- Cache synchronization (if using workers/processes)
- Cache invalidation complexity

## Implementation Order

### Step 1: Connection Pooling (Easiest, High Impact)
- Implement HTTP connection pool
- Integrate with existing translation workers
- **Expected**: Immediate 50-200ms improvement per request

### Step 2: Worker Threads (Medium Complexity, High Impact)
- Create worker pool
- Move translation processing to workers
- **Expected**: Maintain 200-500ms with 20-30 sessions

### Step 3: Request Deduplication (Easy, Medium Impact)
- Enhance cache sharing
- Add deduplication logic
- **Expected**: 20-30% reduction in API calls

### Step 4: Separate Process (Complex, Optional)
- Only if needed beyond 50 sessions
- Complete isolation
- **Expected**: 50-80 sessions with 200-500ms latency

## Testing Strategy

### Load Testing
1. Test with 2, 5, 10, 20, 30, 50 concurrent sessions
2. Measure latency for each session (target: <500ms for partials)
3. Monitor CPU usage (should stay <80% with 50 sessions)
4. Monitor memory usage (should stay <1.5GB with 50 sessions)
5. Monitor API rate limits (should not hit limits)

### Success Criteria
- ✅ 20 sessions: All <500ms latency
- ✅ 30 sessions: All <600ms latency
- ✅ 50 sessions: All <800ms latency
- ✅ CPU usage <80% with 50 sessions
- ✅ No API rate limit errors

## Rollback Plan

Each optimization can be rolled back independently:

1. **Connection Pooling**: Remove pool, use direct connections
2. **Worker Threads**: Route back to main thread processing
3. **Separate Process**: Route back to in-process translation
4. **Deduplication**: Disable cache sharing

All changes maintain backward compatibility.

## Timeline Estimate

- **Connection Pooling**: 2-3 days
- **Worker Threads**: 5-7 days
- **Request Deduplication**: 2-3 days
- **Separate Process**: 5-7 days (optional)

**Total**: 2-3 weeks for full Phase 2 implementation

## Dependencies

- Node.js 18+ (worker threads support)
- No external dependencies required (all built-in Node.js features)
- Optional: Redis for shared state (if needed for multi-instance)

## Notes

- Phase 2 optimizations are **not required** for 2-4 sessions
- Phase 1 optimizations should be sufficient for 2-4 sessions
- Phase 2 is needed when scaling to 20+ concurrent sessions
- Can be implemented incrementally (connection pooling first, then worker threads)

