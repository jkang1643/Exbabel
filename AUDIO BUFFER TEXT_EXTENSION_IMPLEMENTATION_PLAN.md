# Complete Text Extension Window Implementation Plan

## Executive Summary

This document outlines the complete plan to implement a production-grade **Text Extension Window** system with **Audio Buffer Recovery** for your real-time speech translation application. The system prevents word loss during forced commits by maintaining a rolling 1500ms audio buffer and implementing intelligent text merge algorithms.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Current Status](#current-status)
3. [Architecture Overview](#architecture-overview)
4. [Implementation Phases](#implementation-phases)
5. [Detailed Task Breakdown](#detailed-task-breakdown)
6. [Testing Strategy](#testing-strategy)
7. [Success Criteria](#success-criteria)
8. [Timeline Estimate](#timeline-estimate)
9. [Risk Assessment](#risk-assessment)
10. [Deliverables Checklist](#deliverables-checklist)

---

## Project Overview

### Problem Statement

During continuous speech without pauses, Google Cloud Speech-to-Text may finalize transcript segments before all words are captured, resulting in:
- Missing words at the end of sentences: *"somebody's going to be eating."* → missing *"a taco and drinking a soda"*
- Missing words at the beginning of sentences
- Mid-word cutoffs during forced commits

### Solution

Implement a **dual-layer recovery system**:
1. **Audio Buffer Layer** - Maintains rolling 1500ms of raw PCM audio for resubmission
2. **Text Extension Layer** - Intelligent merge algorithms to recover missing tokens from partials

### Industry Standard

This architecture is used by:
- Zoom Live Captions
- YouTube Live
- TikTok/Meta streaming
- Medical dictation software
- Call-center ASR systems

---

## Current Status

### ✅ Completed (Phase 0)

| Component | Status | Location |
|-----------|--------|----------|
| **AudioBufferManager** | ✅ Complete | `backend/audioBufferManager.js` |
| **GoogleSpeechStream Integration** | ✅ Complete | `backend/googleSpeechStream.js` (lines 23, 47-64, 727-734) |
| **Integration Documentation** | ✅ Complete | `AUDIO_BUFFER_INTEGRATION_GUIDE.md` |
| **Test Logging** | ✅ Complete | `backend/soloModeHandler.js` (lines 172-200, 641-662) |
| **Test Instructions** | ✅ Complete | `AUDIO_BUFFER_TEST_INSTRUCTIONS.md` |

**Key Achievement**: Audio buffer is now capturing **EVERY** audio chunk that flows through the pipeline.

### ❌ Remaining Work

| Phase | Component | Status |
|-------|-----------|--------|
| **Phase 1** | Simple Audio Recovery Hook | 🔶 Pending |
| **Phase 1** | Frontend Validation | 🔶 Pending |
| **Phase 2** | TextExtensionManager | 🔶 Pending |
| **Phase 2** | CommitManager | 🔶 Pending |
| **Phase 2** | Logging & Metrics | 🔶 Pending |
| **Phase 3** | Jest Test Suite | 🔶 Pending |
| **Phase 3** | Simulation Harness | 🔶 Pending |
| **Phase 4** | Production Polish | 🔶 Pending |

---

## Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     CLIENT (Frontend)                       │
│                 Microphone Audio Capture                    │
└────────────────────────┬────────────────────────────────────┘
                         │ PCM Audio Stream (WebSocket)
                         ↓
┌─────────────────────────────────────────────────────────────┐
│                  BACKEND (Node.js ESM)                      │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         GoogleSpeechStream (STT Client)              │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │      AudioBufferManager (1500ms rolling)       │  │  │
│  │  │  • Captures EVERY chunk before STT             │  │  │
│  │  │  • Circular ring buffer                        │  │  │
│  │  │  • Automatic cleanup                           │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  │                     ↓                                 │  │
│  │           Google Speech-to-Text API                   │  │
│  │                     ↓                                 │  │
│  │         Partials & Finals (transcripts)               │  │
│  └──────────────────────────────────────────────────────┘  │
│                         ↓                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         TextExtensionManager (Phase 2)               │  │
│  │  • Extension window (250ms)                          │  │
│  │  • Merge algorithm (Levenshtein, fuzzy match)        │  │
│  │  • Token recovery                                    │  │
│  └──────────────────────────────────────────────────────┘  │
│                         ↓                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │            CommitManager (Phase 2)                   │  │
│  │  • Finalized segment history                         │  │
│  │  • Backpatch support (1.5s window)                   │  │
│  │  • Deduplication                                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                         ↓                                   │
│              Translation Pipeline (Existing)                │
│                         ↓                                   │
└────────────────────────┬────────────────────────────────────┘
                         │ Translated Text (WebSocket)
                         ↓
┌─────────────────────────────────────────────────────────────┐
│                     CLIENT (Frontend)                       │
│                   Live Display with Recovery                │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

**Normal Flow (No Recovery Needed):**
```
Audio → Buffer → Google STT → Partial → Text Extension (no change) → Commit → Translate → UI
```

**Recovery Flow (Missing Words Detected):**
```
Audio → Buffer → Google STT → Final (incomplete) → Text Extension Window Opens
                                                         ↓
                                            Wait 250ms for extending partial
                                                         ↓
                                            Partial arrives with missing words
                                                         ↓
                                            Merge using Levenshtein algorithm
                                                         ↓
                                            Extended Final → Commit → Translate → UI
```

**Recovery Flow (Text Failed, Use Audio):**
```
Audio → Buffer → Google STT → Final (incomplete) → No extending partial arrives
                                                         ↓
                                            Retrieve last 750ms from AudioBuffer
                                                         ↓
                                            Resubmit to Google STT
                                                         ↓
                                            Get missing tokens → Merge → Commit → UI
```

---

## Implementation Phases

### Phase 0: Foundation ✅ COMPLETE

**Status**: ✅ Complete
**Duration**: Completed

**Deliverables**:
- ✅ AudioBufferManager implementation
- ✅ GoogleSpeechStream integration
- ✅ Test logging
- ✅ Documentation

### Phase 1: Proof of Concept (Simple Recovery)

**Status**: 🔶 Pending
**Duration**: 2-3 hours
**Goal**: Validate audio buffer works end-to-end with visible results in frontend

**Tasks**:
1. **Phase 1A**: Build simple recovery hook in `soloModeHandler.js`
   - Detect forced commits
   - Retrieve audio from buffer (750ms)
   - Resubmit to Google Speech (temporary stream)
   - Compare results and extract missing tokens
   - Merge and send updated final to frontend

2. **Phase 1B**: Frontend validation
   - Start application
   - Speak test phrases with forced commits
   - Verify recovered words appear in UI
   - Log recovery events for analysis

**Success Criteria**:
- ✅ Forced commits trigger recovery
- ✅ Audio retrieved from buffer
- ✅ Missing words recovered
- ✅ Updated text visible in frontend
- ✅ No errors or crashes

**Deliverables**:
- Simple recovery hook in `soloModeHandler.js`
- Recovery event logging
- Test results documentation

### Phase 2: Production System (Full Implementation)

**Status**: 🔶 Pending
**Duration**: 6-8 hours
**Goal**: Build production-grade TextExtensionManager with complete merge algorithms

**Tasks**:

#### 2A: TextExtensionManager
**File**: `backend/textExtensionManager.js`

**Features**:
- Extension window (250ms default, tunable 150-400ms)
- Advanced merge algorithms:
  - Exact prefix extension
  - Suffix/prefix fuzzy overlap (Levenshtein DP)
  - Mid-word completion
  - Rewrite detection
  - Confidence-aware merging
- Per-segment state management
- Event emitter architecture
- Safety limits (max 8 tokens recovered)

**API**:
```javascript
class TextExtensionManager {
  constructor({ extendMs, maxRecoveredTokens, logger, metrics })
  onFinal({ id, text, tokens, timestamp, isForced })
  onPartial({ id, text, tokens, timestamp })
  flushPending()
  // Events: extensionOpened, extensionClosed, recoveredTokens, committed
}
```

#### 2B: CommitManager
**File**: `backend/commitManager.js`

**Features**:
- Segment history with sequence IDs
- Backpatch support (1.5s editability window)
- Deduplication of recovered tokens
- Integration with translation pipeline
- Audit trail for debugging

**API**:
```javascript
class CommitManager {
  constructor({ backpatchWindowMs, maxHistory, logger })
  commit(segmentId, text, metadata)
  backpatch(segmentId, updatedText, reason)
  getHistory(limit)
  canBackpatch(segmentId)
}
```

#### 2C: Integration Layer
**File**: `backend/soloModeHandler.js` (modifications)

**Changes**:
- Replace simple recovery hook with TextExtensionManager
- Wire up CommitManager
- Connect audio buffer with text extension
- Add event listeners for monitoring
- Update partial/final handlers

#### 2D: Configuration
**File**: `backend/config/textExtension.config.js`

**Settings**:
```javascript
{
  extendMs: 250,              // Extension window duration
  extendMsMin: 150,           // Adaptive minimum
  extendMsMax: 400,           // Adaptive maximum
  maxRecoveredTokens: 8,      // Safety limit
  maxLevenshteinDistance: 3,  // Fuzzy matching threshold
  maxLevenshteinPercent: 0.30,
  editableBackpatchLifetime: 1500,
  audioBufferMs: 1500,
  audioFlushMs: 600,
}
```

#### 2E: Structured Logging
**File**: `backend/logger.js`

**Features**:
- JSON structured logs
- Log levels (DEBUG, INFO, WARN, ERROR)
- Log filtering and rotation
- Integration with existing console logs

**Format**:
```json
{"level":"INFO","event":"extension_opened","segmentId":"s1","text":"...","ts":...}
{"level":"INFO","event":"recovered_tokens","segmentId":"s1","tokens":["a","taco"],"ts":...}
{"level":"INFO","event":"extension_closed","segmentId":"s1","durationMs":245,"ts":...}
```

#### 2F: Metrics System
**File**: `backend/metrics.js`

**Tracked Metrics**:
- Backpatch rate per session
- Average extension duration
- % of finals extended
- Tokens recovered per extension
- Extension window timeout rate
- False positive merge rate (if detectable)

**Success Criteria**:
- ✅ TextExtensionManager handles all 6 test scenarios
- ✅ CommitManager tracks history and backpatching
- ✅ Integration layer connects all components
- ✅ Structured logging operational
- ✅ Metrics being collected
- ✅ Configuration tunable without code changes

**Deliverables**:
- `backend/textExtensionManager.js`
- `backend/commitManager.js`
- `backend/config/textExtension.config.js`
- `backend/logger.js`
- `backend/metrics.js`
- Updated `backend/soloModeHandler.js`
- Integration documentation

### Phase 3: Testing & Validation

**Status**: 🔶 Pending
**Duration**: 4-5 hours
**Goal**: Comprehensive test coverage with automated and simulation testing

**Tasks**:

#### 3A: Jest Test Suite
**File**: `backend/__tests__/textExtensionManager.test.js`

**6 Core Scenarios**:

1. **Simple Tail Recovery**
   ```
   Final: "somebody's going to be eating."
   Partial: "and drinking a soda"
   Expected: "somebody's going to be eating and drinking a soda."
   ```

2. **Missing Middle Token**
   ```
   Final: "somebody's going to be eating."
   Partial: "a taco and drinking a soda"
   Expected: "somebody's going to be eating a taco and drinking a soda."
   ```

3. **Mid-Word Completion**
   ```
   Final: "...be eati"
   Partial: "ng a taco and..."
   Expected: "...be eating a taco and..."
   ```

4. **Rewrite Partial (Prefer Longer)**
   ```
   Final: "we go back to the biblical"
   Partial: "we go back to the biblical model and..." (rewrites)
   Expected: "we go back to the biblical model and..."
   ```

5. **No Extension Arrives (Timeout)**
   ```
   Final: "I will pray."
   [250ms passes, no partial]
   Expected: "I will pray." (original committed)
   ```

6. **Duplicated Partials (Idempotency)**
   ```
   Final: "God is mighty"
   Partial: "and powerful" (arrives twice)
   Expected: "God is mighty and powerful" (merged once)
   ```

**Additional Tests**:
- Token overlap calculation
- Levenshtein distance calculation
- Mid-word detection
- Confidence scoring
- Extension window timing
- Concurrent segment handling

#### 3B: Simulation Harness
**File**: `backend/__tests__/simulationHarness.js`

**Features**:
- Event timeline replay
- Timestamp-based event sequencing
- Before/after comparisons
- Visual output for validation
- Metrics collection during simulation

**Example Timeline**:
```javascript
[
  { time: 0, event: 'audio_start' },
  { time: 1200, event: 'forced_commit', text: "somebody's going to be eating." },
  { time: 1220, event: 'extension_window_open', duration: 250 },
  { time: 1250, event: 'partial', text: "a taco and drinking a soda" },
  { time: 1255, event: 'tokens_recovered', tokens: ["a", "taco"] },
  { time: 1470, event: 'extension_window_close', finalText: "..." },
  { time: 1475, event: 'commit', text: "somebody's going to be eating a taco and drinking a soda." }
]
```

#### 3C: Integration Tests
**File**: `backend/__tests__/integration.test.js`

**Test Scenarios**:
- End-to-end recovery flow
- Audio buffer → TextExtension → Commit → Translation
- Multiple concurrent sessions
- Stream restart during recovery
- Error handling and fallback
- Performance under load

**Success Criteria**:
- ✅ All 6 core scenarios pass
- ✅ Test coverage > 80%
- ✅ Simulation harness validates timeline accuracy
- ✅ Integration tests pass
- ✅ No memory leaks detected
- ✅ Performance benchmarks met

**Deliverables**:
- `backend/__tests__/textExtensionManager.test.js`
- `backend/__tests__/simulationHarness.js`
- `backend/__tests__/integration.test.js`
- Test results report
- Performance benchmarks

### Phase 4: Production Polish

**Status**: 🔶 Pending
**Duration**: 2-3 hours
**Goal**: Documentation, deployment readiness, and production hardening

**Tasks**:

#### 4A: Documentation
- **README**: Complete system overview
- **API Reference**: All public methods and events
- **Configuration Guide**: Tuning parameters
- **Migration Guide**: Moving from existing system
- **Troubleshooting Guide**: Common issues and solutions
- **Performance Guide**: Optimization tips

#### 4B: Production Hardening
- Error handling and recovery
- Graceful degradation (fallback to existing system)
- Memory leak prevention
- Resource cleanup on crash
- Rate limiting and throttling
- Monitoring hooks

#### 4C: Feature Flags
```javascript
const FEATURES = {
  AUDIO_BUFFER_ENABLED: true,
  TEXT_EXTENSION_ENABLED: true,
  AUDIO_RECOVERY_ENABLED: true,
  METRICS_ENABLED: true,
  DEBUG_LOGGING_ENABLED: false
};
```

#### 4D: Deployment Checklist
- [ ] All tests passing
- [ ] Documentation complete
- [ ] Configuration validated
- [ ] Feature flags in place
- [ ] Monitoring configured
- [ ] Rollback plan documented
- [ ] Performance benchmarks met
- [ ] Security review completed

**Success Criteria**:
- ✅ Complete documentation
- ✅ Production hardening complete
- ✅ Feature flags operational
- ✅ Deployment checklist verified
- ✅ Rollback plan tested

**Deliverables**:
- `TEXT_EXTENSION_README.md`
- `TEXT_EXTENSION_API_REFERENCE.md`
- `TEXT_EXTENSION_CONFIGURATION_GUIDE.md`
- `TEXT_EXTENSION_MIGRATION_GUIDE.md`
- `TEXT_EXTENSION_TROUBLESHOOTING.md`
- Production deployment guide
- Rollback procedures

---

## Detailed Task Breakdown

### Phase 1A: Simple Recovery Hook (2 hours)

**Location**: `backend/soloModeHandler.js`

**Implementation Steps**:

1. **Add Recovery Detection** (30 min)
   ```javascript
   if (!isPartial && meta.isForced) {
     // Forced commit detected
     await attemptAudioRecovery(transcriptText, meta);
   }
   ```

2. **Implement Audio Retrieval** (30 min)
   ```javascript
   async function attemptAudioRecovery(originalText, meta) {
     const recentAudio = speechStream.getRecentAudio(750);
     if (recentAudio.length === 0) return null;
     // Continue...
   }
   ```

3. **Resubmit Audio to STT** (45 min)
   ```javascript
   // Create temporary recognition stream
   const tempStream = await createTemporaryRecognitionStream();
   tempStream.write(recentAudio);
   const recoveredTranscript = await waitForFinalResult(tempStream);
   ```

4. **Token Comparison & Merge** (15 min)
   ```javascript
   const originalTokens = tokenize(originalText);
   const recoveredTokens = tokenize(recoveredTranscript);
   const missingTokens = findMissingTokens(originalTokens, recoveredTokens);
   const mergedText = appendTokens(originalText, missingTokens);
   ```

**Testing**: Manual testing with live audio

### Phase 1B: Frontend Validation (1 hour)

**Test Cases**:
1. Start session and speak continuously
2. Force a commit (e.g., by triggering stream restart)
3. Observe backend logs for recovery
4. Verify updated text appears in frontend
5. Test with various speech patterns

**Expected Results**:
- Recovery logs show missing words detected
- Audio retrieval successful
- Merged text sent to frontend
- UI displays complete sentences

### Phase 2A: TextExtensionManager (3 hours)

**File**: `backend/textExtensionManager.js`

**Implementation Steps**:

1. **Class Structure** (30 min)
   - Constructor with configuration
   - Event emitter setup
   - State management (per-segment tracking)

2. **Extension Window Logic** (45 min)
   - `onFinal()` - Opens extension window
   - Timer management (250ms default)
   - Window close conditions

3. **Merge Algorithm** (90 min)
   - Exact prefix extension
   - Levenshtein distance calculation
   - Token overlap detection
   - Mid-word completion
   - Confidence scoring

4. **Event Emission** (15 min)
   - `extensionOpened`
   - `recoveredTokens`
   - `extensionClosed`
   - `committed`

**Testing**: Unit tests for each merge scenario

### Phase 2B: CommitManager (2 hours)

**File**: `backend/commitManager.js`

**Implementation Steps**:

1. **History Management** (45 min)
   - Circular buffer for recent commits
   - Sequence ID tracking
   - Timestamp management

2. **Backpatch Logic** (45 min)
   - Editability window (1.5s)
   - Backpatch validation
   - Update propagation

3. **Integration Hooks** (30 min)
   - Translation pipeline connection
   - Event emission for updates
   - Deduplication logic

**Testing**: Unit tests for history and backpatching

### Phase 2C: Integration Layer (1.5 hours)

**File**: `backend/soloModeHandler.js` (modifications)

**Implementation Steps**:

1. **Initialize Components** (20 min)
   ```javascript
   const textExtManager = new TextExtensionManager({ extendMs: 250 });
   const commitManager = new CommitManager({ backpatchWindowMs: 1500 });
   ```

2. **Wire Event Handlers** (30 min)
   ```javascript
   speechStream.onResult(async (text, isPartial, meta) => {
     if (isPartial) {
       textExtManager.onPartial({ id: currentSegmentId, text, ... });
     } else {
       textExtManager.onFinal({ id: currentSegmentId, text, isForced: meta.isForced });
     }
   });

   textExtManager.on('extensionClosed', ({ segmentId, finalText }) => {
     commitManager.commit(segmentId, finalText);
     // Send to translation...
   });
   ```

3. **Replace Simple Hook** (20 min)
   - Remove Phase 1 simple recovery code
   - Ensure all flows use TextExtensionManager

4. **Testing** (20 min)
   - Manual testing with live audio
   - Verify events flowing correctly

### Phase 2D-F: Config, Logging, Metrics (1.5 hours)

**Implementation**: See Phase 2 task details above

### Phase 3: Testing (4-5 hours)

**Implementation**: See Phase 3 task details above

### Phase 4: Polish (2-3 hours)

**Implementation**: See Phase 4 task details above

---

## Testing Strategy

### Unit Testing (Jest)

**Coverage Targets**:
- TextExtensionManager: > 90%
- CommitManager: > 85%
- AudioBufferManager: > 80%
- Merge algorithms: 100%

**Test Categories**:
- Happy path scenarios
- Edge cases (empty text, single token, etc.)
- Error handling
- Timing edge cases
- Concurrent operations

### Integration Testing

**Scenarios**:
- End-to-end recovery flow
- Multiple sessions
- Stream restarts
- Network issues
- Resource exhaustion

### Manual Testing

**Test Plan**:
1. Continuous speech (30+ seconds)
2. Rapid speech with pauses
3. Mid-sentence pauses
4. Stream restarts during speech
5. Multiple concurrent sessions
6. Different languages

### Performance Testing

**Benchmarks**:
- Extension window overhead: < 5ms
- Merge algorithm: < 10ms per operation
- Memory usage: < 50KB per session
- CPU impact: < 1% additional

### Stress Testing

**Scenarios**:
- 10 concurrent sessions
- 1-hour continuous session
- Rapid commit/recovery cycles
- Memory leak detection

---

## Success Criteria

### Functional Requirements

- [ ] ✅ Zero dropped words in 95% of forced commits
- [ ] ✅ Latency < 300ms from forced commit to visible correction
- [ ] ✅ No false positive merges in test suite (100% accuracy)
- [ ] ✅ All 6 core test scenarios pass
- [ ] ✅ Integration tests pass
- [ ] ✅ Manual testing validates recovery in frontend

### Non-Functional Requirements

- [ ] ✅ Memory stable over 1-hour session (no leaks)
- [ ] ✅ Performance overhead < 5% CPU/memory vs baseline
- [ ] ✅ Extension window timing accurate (±10ms)
- [ ] ✅ Audio buffer maintains 1500ms ±50ms
- [ ] ✅ Graceful degradation if components fail

### Quality Requirements

- [ ] ✅ Code coverage > 80%
- [ ] ✅ All tests passing
- [ ] ✅ No ESLint errors
- [ ] ✅ Documentation complete
- [ ] ✅ API well-documented
- [ ] ✅ Configuration externalized

### Production Readiness

- [ ] ✅ Feature flags implemented
- [ ] ✅ Monitoring hooks in place
- [ ] ✅ Error handling comprehensive
- [ ] ✅ Rollback plan documented
- [ ] ✅ Performance benchmarks met
- [ ] ✅ Security review passed

---

## Timeline Estimate

### Detailed Breakdown

| Phase | Task | Duration | Dependencies |
|-------|------|----------|--------------|
| **Phase 0** | AudioBufferManager | ✅ Complete | None |
| **Phase 0** | Integration & Test Logging | ✅ Complete | AudioBufferManager |
| **Phase 1A** | Simple Recovery Hook | 2 hours | Phase 0 |
| **Phase 1B** | Frontend Validation | 1 hour | Phase 1A |
| **Phase 2A** | TextExtensionManager | 3 hours | Phase 1 |
| **Phase 2B** | CommitManager | 2 hours | Phase 1 |
| **Phase 2C** | Integration Layer | 1.5 hours | Phase 2A, 2B |
| **Phase 2D** | Configuration | 0.5 hours | Phase 2A, 2B |
| **Phase 2E** | Logging | 1 hour | Phase 2A, 2B |
| **Phase 2F** | Metrics | 1 hour | Phase 2A, 2B |
| **Phase 3A** | Jest Tests | 2 hours | Phase 2 |
| **Phase 3B** | Simulation Harness | 1.5 hours | Phase 2 |
| **Phase 3C** | Integration Tests | 1 hour | Phase 2, 3A |
| **Phase 4A** | Documentation | 1.5 hours | Phase 3 |
| **Phase 4B** | Production Hardening | 1 hour | Phase 3 |
| **Phase 4C** | Feature Flags | 0.5 hours | Phase 3 |
| **Phase 4D** | Deployment Prep | 0.5 hours | Phase 4A, 4B |

**Total Estimated Duration**: 19-21 hours

### Parallelization Opportunities

Tasks that can run in parallel:
- Phase 2A + 2B (TextExtensionManager + CommitManager)
- Phase 2E + 2F (Logging + Metrics)
- Phase 3A + 3B (Jest Tests + Simulation)

**With parallelization**: 15-17 hours

### Recommended Sprint Schedule

**Sprint 1** (Week 1):
- Phase 1: Proof of Concept (3 hours)
- Phase 2A-B: Core Managers (5 hours)
- **Total**: 8 hours

**Sprint 2** (Week 2):
- Phase 2C-F: Integration & Infrastructure (4 hours)
- Phase 3: Testing (4.5 hours)
- **Total**: 8.5 hours

**Sprint 3** (Week 3):
- Phase 4: Polish & Deployment (3.5 hours)
- Buffer for bug fixes (2 hours)
- **Total**: 5.5 hours

**Grand Total**: ~22 hours (including buffer)

---

## Risk Assessment

### High Risk

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Audio resubmission creates latency** | High | Medium | Use text-based recovery as primary, audio as fallback |
| **False positive merges corrupt text** | High | Low | Conservative similarity thresholds, extensive testing |
| **Memory leaks from event listeners** | High | Low | Proper cleanup, automated leak detection tests |

### Medium Risk

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Extension window too short** | Medium | Medium | Make tunable (150-400ms), adaptive based on RTT |
| **Token deduplication fails** | Medium | Low | Robust dedup logic, test coverage |
| **Integration breaks existing features** | Medium | Medium | Feature flags, gradual rollout, rollback plan |

### Low Risk

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Configuration complexity** | Low | Medium | Good defaults, clear documentation |
| **Performance degradation** | Low | Low | Efficient algorithms, performance testing |
| **Cross-language issues** | Low | Low | Language-agnostic tokenization |

### Risk Mitigation Strategy

1. **Incremental Implementation**: Build Phase 1 proof-of-concept first
2. **Feature Flags**: Allow disabling new components if issues arise
3. **Extensive Testing**: 80%+ code coverage, integration tests
4. **Monitoring**: Comprehensive logging and metrics
5. **Rollback Plan**: Document revert procedures

---

## Deliverables Checklist

### Code Deliverables

#### Phase 0 ✅
- [x] `backend/audioBufferManager.js`
- [x] `backend/googleSpeechStream.js` (modified)
- [x] `backend/soloModeHandler.js` (test logging added)

#### Phase 1 🔶
- [ ] `backend/soloModeHandler.js` (simple recovery hook)
- [ ] Test results documentation

#### Phase 2 🔶
- [ ] `backend/textExtensionManager.js`
- [ ] `backend/commitManager.js`
- [ ] `backend/config/textExtension.config.js`
- [ ] `backend/logger.js`
- [ ] `backend/metrics.js`
- [ ] `backend/soloModeHandler.js` (full integration)

#### Phase 3 🔶
- [ ] `backend/__tests__/textExtensionManager.test.js`
- [ ] `backend/__tests__/audioBufferManager.test.js`
- [ ] `backend/__tests__/commitManager.test.js`
- [ ] `backend/__tests__/simulationHarness.js`
- [ ] `backend/__tests__/integration.test.js`

### Documentation Deliverables

#### Phase 0 ✅
- [x] `AUDIO_BUFFER_INTEGRATION_GUIDE.md`
- [x] `AUDIO_BUFFER_TEST_INSTRUCTIONS.md`

#### Phase 1 🔶
- [ ] Phase 1 test results report

#### Phase 2 🔶
- [ ] API reference for TextExtensionManager
- [ ] API reference for CommitManager
- [ ] Integration guide

#### Phase 4 🔶
- [ ] `TEXT_EXTENSION_README.md`
- [ ] `TEXT_EXTENSION_API_REFERENCE.md`
- [ ] `TEXT_EXTENSION_CONFIGURATION_GUIDE.md`
- [ ] `TEXT_EXTENSION_MIGRATION_GUIDE.md`
- [ ] `TEXT_EXTENSION_TROUBLESHOOTING.md`
- [ ] `TEXT_EXTENSION_DEPLOYMENT_GUIDE.md`

### Artifacts

- [ ] Test coverage report
- [ ] Performance benchmark results
- [ ] Memory leak analysis report
- [ ] Integration test results
- [ ] Simulation replay videos/logs
- [ ] Production deployment checklist
- [ ] Rollback procedures

---

## Appendix

### A. Configuration Reference

**Default Configuration** (`backend/config/textExtension.config.js`):
```javascript
export const TEXT_EXTENSION_CONFIG = {
  // Extension Window
  extendMs: 250,                    // Default extension window
  extendMsMin: 150,                 // Min adaptive
  extendMsMax: 400,                 // Max adaptive
  maxRecoveredTokens: 8,            // Safety limit

  // Merge Thresholds
  maxLevenshteinDistance: 3,        // Fuzzy matching
  maxLevenshteinPercent: 0.30,      // 30% threshold
  minPrefixOverlap: 2,              // Min tokens for prefix match
  minConfidenceScore: 0.5,          // Min token confidence

  // Backpatching
  editableBackpatchLifetime: 1500,  // 1.5s window
  maxBackpatchAttempts: 2,          // Max attempts per segment

  // Audio Buffer
  audioBufferMs: 1500,              // Rolling window
  audioFlushMs: 600,                // Flush on natural final

  // Performance
  maxConcurrentExtensions: 5,       // Concurrent segments
  extensionQueueSize: 10,           // Queue depth

  // Features
  enableAudioRecovery: true,        // Use audio buffer
  enableTextExtension: true,        // Use text merge
  enableBackpatching: true,         // Allow retroactive updates
  enableMetrics: true,              // Collect metrics
  enableDebugLogs: false,           // Debug logging
};
```

### B. Merge Algorithm Pseudocode

```
function mergePartialIntoFinal(final, partial):
  finalTokens = tokenize(final)
  partialTokens = tokenize(partial)

  // Step 1: Check exact prefix extension
  if partial.startsWith(final):
    extension = partial[len(final):]
    return final + " " + extension

  // Step 2: Check suffix/prefix overlap
  overlap = findSuffixPrefixOverlap(finalTokens, partialTokens)
  if overlap.similarity > 0.30:
    uniqueTokens = partialTokens[overlap.length:]
    return final + " " + join(uniqueTokens)

  // Step 3: Check mid-word completion
  if finalTokens[-1] is incomplete word:
    if partialTokens[0] completes it:
      return completeMidWord(final, partial)

  // Step 4: Check rewrite (prefer longer)
  if levenshteinDistance(final, partial) <= 3:
    if len(partial) > len(final):
      return partial  // Use longer version

  // Step 5: No merge - treat as new segment
  return null
```

### C. Event Flow Diagram

```
Audio Chunk Arrives
    ↓
AudioBufferManager.addChunk()
    ↓
Forward to Google Speech
    ↓
[Partial Result] ───────→ TextExtensionManager.onPartial()
    ↓                              ↓
    └─→ Check if extends      [Extension Window Open?]
        pending final                ↓
                                 [YES] Merge tokens
                                     ↓
                                 Reset timer

[Final Result] ────────→ TextExtensionManager.onFinal()
    ↓                              ↓
    └─→ Open extension         Start 250ms timer
        window                       ↓
                              [Wait for extending partial]
                                     ↓
                           [Timer expires or confirmed]
                                     ↓
                              Emit 'extensionClosed'
                                     ↓
                              CommitManager.commit()
                                     ↓
                              Send to Translation
                                     ↓
                              Frontend Display
```

### D. Key Algorithms

**Levenshtein Distance** (for fuzzy matching):
```javascript
function levenshtein(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i-1] === str2[j-1]) {
        dp[i][j] = dp[i-1][j-1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i-1][j],    // deletion
          dp[i][j-1],    // insertion
          dp[i-1][j-1]   // substitution
        );
      }
    }
  }

  return dp[m][n];
}
```

**Token Overlap Detection**:
```javascript
function findSuffixPrefixOverlap(tokens1, tokens2) {
  const maxCheck = 6;
  let bestOverlap = 0;

  for (let i = 1; i <= Math.min(tokens1.length, tokens2.length, maxCheck); i++) {
    const suffix = tokens1.slice(-i);
    const prefix = tokens2.slice(0, i);

    if (arraysEqual(suffix, prefix)) {
      bestOverlap = i;
    }
  }

  return {
    length: bestOverlap,
    similarity: bestOverlap / Math.max(tokens1.length, tokens2.length)
  };
}
```

### E. Monitoring Queries

**Key Metrics to Track**:
```javascript
// Recovery success rate
const recoveryRate = (recoveredFinals / totalForcedCommits) * 100;

// Average tokens recovered
const avgTokens = totalTokensRecovered / totalRecoveryAttempts;

// Extension window efficiency
const windowEfficiency = (successfulExtensions / windowsOpened) * 100;

// False positive rate (manual validation)
const falsePositiveRate = (incorrectMerges / totalMerges) * 100;

// Performance impact
const overheadMs = avgLatencyWithExtension - avgLatencyWithout;
```

### F. Troubleshooting Decision Tree

```
Problem: Words still being dropped
  ↓
Check: Is audio buffer capturing?
  [NO] → Fix AudioBufferManager integration
  [YES] ↓
Check: Is extension window opening?
  [NO] → Check TextExtensionManager initialization
  [YES] ↓
Check: Are partials arriving during window?
  [NO] → Increase extendMs (250 → 400ms)
  [YES] ↓
Check: Is merge algorithm detecting overlap?
  [NO] → Lower similarity threshold (0.30 → 0.20)
  [YES] ↓
Check: Are merged tokens being committed?
  [NO] → Check CommitManager integration
  [YES] ↓
Problem: False positives (incorrect merges)
  ↓
Check: Lower similarity threshold
Check: Add contradiction detection
Check: Increase confidence requirements
```

---

## Conclusion

This comprehensive plan outlines a production-grade Text Extension Window system with Audio Buffer Recovery. The phased approach allows for incremental validation and reduces risk.

**Current Status**: Phase 0 complete, audio buffer operational and tested.

**Next Step**: Implement Phase 1 (Simple Recovery Hook) to validate end-to-end functionality.

**Total Effort**: 19-22 hours over 3 sprints.

---

**Document Version**: 1.0
**Last Updated**: 2025-11-18
**Status**: Phase 0 Complete, Ready for Phase 1
