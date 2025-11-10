# Multi-Session Performance Optimization

## Overview

This document describes the optimizations implemented to support multiple concurrent translation sessions without latency degradation. These changes allow the system to handle 2-5+ concurrent solo mode sessions while maintaining real-time performance.

## Problem Statement

When running multiple solo mode sessions simultaneously, the second and subsequent sessions experienced significant latency while the first session maintained optimal speed. Root causes identified:

1. **Global Rate Limiter Bottleneck**: All sessions shared a single rate limiter, causing contention
2. **Sequential Request Queue**: Requests processed one at a time (50ms minimum interval)
3. **Limited Translation Concurrency**: Only 2 concurrent translation requests (1 when rate-limited)
4. **No Session-Level Fairness**: Single session could dominate API capacity

## Architecture Changes

### 1. Parallel Request Queue Processing

**File**: `backend/openaiRequestQueue.js`

**Changes**:
- Changed from sequential to parallel processing (up to 4 concurrent requests)
- Added `activeRequests` counter to track concurrent processing
- Added `maxConcurrent` parameter (set to 4 for conservative trial)
- Preserved `minRequestInterval` (50ms) for single-session stability
- Added per-session request tracking

**Impact**:
- Multiple sessions can now share API capacity without blocking each other
- Backward compatible - single session performance unchanged
- Queue processes 4x faster with multiple sessions

**Configuration**:
```javascript
this.maxConcurrent = 4; // Process up to 4 requests in parallel
this.minRequestInterval = 50; // Preserved for stability
```

### 2. Increased Translation Worker Concurrency

**File**: `backend/translationWorkers.js`

**Changes**:
- Increased `MAX_CONCURRENT` from 2/1 to 5/2 (normal/rate-limited)
- Added sessionId parameter to all translation methods
- Pass sessionId through to rate limiter for fair-share allocation

**Impact**:
- Allows 5 parallel translation requests (up from 2)
- Rate-limited mode allows 2 concurrent (up from 1)
- Multiple sessions can process translations simultaneously

**Configuration**:
```javascript
const MAX_CONCURRENT = this.rateLimitDetected ? 2 : 5; // Increased from 1/2
```

### 3. Per-Session Fair-Share Rate Limiting

**File**: `backend/openaiRateLimiter.js`

**Changes**:
- Added per-session token tracking (`sessionTokenUsage` Map)
- Added per-session request tracking (`sessionRequestCounts` Map)
- Implemented fair-share allocation: divides RPM/TPM limits by active session count
- Added `getActiveSessionCount()` function (sessions active in last 5 minutes)
- Session tracking automatically expires after 1 minute

**Impact**:
- Prevents single session from starving others
- Fair distribution of API capacity across sessions
- Global limits still enforced as safety check

**Fair-Share Calculation**:
```javascript
const activeSessions = getActiveSessionCount();
const fairShareRPM = Math.floor(MAX_REQUESTS_PER_MINUTE / activeSessions);
const fairShareTPM = Math.floor(MAX_TOKENS_PER_MINUTE / activeSessions);
```

**Example**: With 2 active sessions:
- Each session gets ~2,250 RPM (4,500 / 2)
- Each session gets ~900,000 TPM (1,800,000 / 2)

### 4. Session-Level Tracking

**File**: `backend/soloModeHandler.js`

**Changes**:
- Added `sessionId` constant for each solo mode connection
- Pass `sessionId` to all translation worker calls
- Session ID format: `session_${Date.now()}`

**Impact**:
- Enables per-session rate limiting and tracking
- Allows monitoring of per-session performance
- No changes to core translation logic

## Performance Metrics

### Expected Improvements

**Before Optimization**:
- 1 session: ~200-500ms latency (partials), ~1-2s (finals)
- 2 sessions: First session ~200-500ms, Second session ~2-5s+ (degraded)

**After Phase 1 Optimization**:
- 1 session: ~200-500ms latency (preserved) ✅
- 2 sessions: Both sessions ~300-800ms (fair-share allocation) ⚠️
- 3-5 sessions: All sessions ~400-1200ms (scales gracefully) ⚠️

**Target for 2-4 Sessions (Phase 1.5)**:
- 2 sessions: 200-500ms latency ✅ (feasible with connection pooling)
- 3 sessions: 250-600ms latency ✅ (feasible with connection pooling)
- 4 sessions: 300-700ms latency ✅ (feasible with connection pooling)

See `PHASE_1.5_PLAN.md` for implementation details.

### Monitoring

**Queue Status** (`openaiRequestQueue.getStatus()`):
```javascript
{
  queueLength: 2,
  processing: true,
  activeRequests: 3,
  maxConcurrent: 4,
  estimatedTokensUsed: 50000,
  activeSessions: 2,
  sessionStats: {
    "session_123": { requestCount: 10, lastRequestTime: 1234567890 }
  }
}
```

**Rate Limiter Stats** (`getRequestStats()`):
```javascript
{
  requestsLastMinute: 100,
  requestsPerMinuteLimit: 4500,
  tokensLastMinute: 500000,
  tokensPerMinuteLimit: 1800000,
  activeSessions: 2,
  sessionStats: {
    "session_123": {
      requestsLastMinute: 50,
      tokensLastMinute: 250000,
      fairShareRPM: 2250,
      fairShareTPM: 900000
    }
  }
}
```

## Configuration Parameters

### Request Queue
- `maxConcurrent`: 4 (number of parallel requests)
- `minRequestInterval`: 50ms (preserved for stability)

### Translation Workers
- `MAX_CONCURRENT`: 5 normal, 2 rate-limited
- Session tracking: Automatic (no config needed)

### Rate Limiter
- `MAX_REQUESTS_PER_MINUTE`: 4,500 (5,000 with 10% margin)
- `MAX_TOKENS_PER_MINUTE`: 1,800,000 (2M with 10% margin)
- Fair-share: Automatic based on active session count

## Testing Strategy

### Load Testing
1. Start 2 solo mode sessions simultaneously
2. Monitor latency for each session (should be <800ms for partials)
3. Verify fair-share allocation (both sessions get ~50% capacity)
4. Test with 3-5 sessions to verify graceful scaling

### Metrics to Monitor
- Per-session latency (partials and finals)
- Queue length and processing time
- Rate limiter fair-share distribution
- Token usage per session
- Error rates

### Success Criteria
- ✅ Single session performance unchanged (<500ms partials)
- ✅ 2 sessions both maintain <800ms partial latency
- ✅ No session starvation (all sessions get fair share)
- ✅ Graceful degradation with 3-5 sessions

## Troubleshooting

### Issue: Second session still slow
**Possible Causes**:
- Rate limiter not detecting multiple sessions (check `getActiveSessionCount()`)
- SessionId not being passed through translation chain
- Queue maxConcurrent too low

**Solutions**:
- Verify sessionId is passed to `translatePartial`/`translateFinal`
- Check rate limiter stats: `getRequestStats()`
- Increase `maxConcurrent` if needed (trial: 4, production: 5-8)

### Issue: Rate limit errors
**Possible Causes**:
- Too many concurrent sessions
- Fair-share limits too aggressive
- Global limits being hit

**Solutions**:
- Reduce `maxConcurrent` in request queue
- Check if global limits are being hit (safety check should prevent)
- Monitor `getRequestStats()` for per-session usage

### Issue: Single session degraded
**Possible Causes**:
- `minRequestInterval` removed (should be preserved)
- Parallel processing interfering with single session

**Solutions**:
- Verify `minRequestInterval` is still 50ms
- Check that single session gets full capacity (fairShare = full limit)

## Future Optimizations

### Phase 2 (Not Implemented Yet)
- Request batching and deduplication across sessions
- Load balancing for horizontal scaling
- Redis for distributed rate limiting
- Worker threads for CPU-intensive tasks

### Phase 3 (Long-term)
- Separate translation microservice
- Database for session persistence
- Advanced monitoring and alerting

## Rollback Procedure

If issues occur, these changes can be rolled back:

1. **Request Queue**: Set `maxConcurrent = 1` (sequential processing)
2. **Translation Workers**: Set `MAX_CONCURRENT = 2` (original values)
3. **Rate Limiter**: Remove session tracking (fair-share disabled)
4. **Solo Mode**: Remove sessionId parameter (optional, won't break)

All changes are backward compatible - removing sessionId parameters will default to null and disable per-session tracking.

## Code References

- `backend/openaiRequestQueue.js`: Parallel queue processing
- `backend/openaiRateLimiter.js`: Fair-share rate limiting
- `backend/translationWorkers.js`: Increased concurrency
- `backend/soloModeHandler.js`: Session tracking

## Version History

- **v1.0** (Trial): Initial multi-session optimizations
  - Parallel request queue (4 concurrent)
  - Increased translation concurrency (5/2)
  - Per-session fair-share rate limiting
  - Session-level tracking

