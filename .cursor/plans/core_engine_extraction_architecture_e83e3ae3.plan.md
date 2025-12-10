---
name: Core Engine Extraction Architecture
overview: Extract shared business logic from solo and host modes into a reusable core engine, ensuring zero behavioral drift between modes while eliminating code duplication.
todos: []
---

# Core Engine Extraction Architecture

## Current State Analysis

**Problem:** `backend/soloModeHandler.js` (~2374 lines) and `backend/hostModeHandler.js` (~2409 lines) contain massive duplication of complex business logic:

- Finalization state tracking (pendingFinalization, MAX_FINALIZATION_WAIT_MS, etc.)
- Partial tracking (latestPartialText, longestPartialText, timestamps)
- Forced commit logic with audio recovery
- RTT measurement and adaptive lookahead
- Translation throttling and debouncing
- Sequence tracking (seqId, latestSeqId)
- Recently finalized window for backpatching
- Token overlap matching and merging
- Grammar correction integration
- LLM post-processing

**Shared Components (Already Extracted):**

- `GoogleSpeechStream` - STT client
- `AudioBufferManager` - Rolling audio buffer
- `translationManager` - Translation orchestration
- `translationWorkers` - Partial/final translation workers
- `grammarWorker` - Grammar correction

## Target Architecture

```
/core/
  /engine/
    coreEngine.ts              # Main orchestration engine
    finalizationEngine.ts      # Finalization state & timing logic
    partialTracker.ts          # Partial text tracking & merging
    forcedCommitEngine.ts      # Forced commit detection & recovery
    timelineOffsetTracker.ts   # Sequence & offset tracking
    rttTracker.ts             # RTT measurement & adaptive lookahead
    eventEmitter.ts           # Event contract & emission
    
  /audio/
    audioBufferManager.js     # (Already exists - move here)
    
  /transcription/
    googleSpeechStream.js      # (Already exists - move here)
    
  /translation/
    translationManager.js     # (Already exists - move here)
    translationWorkers.js     # (Already exists - move here)
    grammarWorker.js          # (Already exists - move here)
    
  /events/
    eventTypes.ts             # Event type definitions
    eventEmitter.ts           # Event emission interface

/solo/
  adapter.ts                  # Thin wrapper: mic → coreEngine → UI
  client/                     # (Frontend already exists)

/host/
  adapter.ts                  # Thin wrapper: host mic → coreEngine → broadcast
  listenerAdapter.ts          # Listener event forwarding (no core access)

/shared/
  /types/
    events.ts                 # Event type definitions
    config.ts                 # Shared configuration
```

## Core Engine Interface

### Event Contract

```typescript
// /core/events/eventTypes.ts
type ExbabelEvent =
  | { type: "partial"; text: string; offset: number; seqId: number; timestamp: number }
  | { type: "final"; text: string; offset: number; seqId: number; timestamp: number }
  | { type: "commit"; id: string; text: string; isForced: boolean; timestamp: number }
  | { type: "llm"; html: string; seqId: number; timestamp: number }
  | { type: "latencyReport"; value: number; timestamp: number }
  | { type: "grammarUpdate"; originalText: string; correctedText: string; seqId: number }
  | { type: "translation"; originalText: string; translatedText: string; isPartial: boolean; seqId: number }
```

### Core Engine API

```typescript
// /core/engine/coreEngine.ts
class CoreEngine {
  constructor(config: EngineConfig)
  
  // Main processing entry point
  async processAudioChunk(chunk: AudioChunk, metadata: ChunkMetadata): Promise<void>
  
  // Event subscription
  onEvent(callback: (event: ExbabelEvent) => void): void
  
  // Configuration updates
  updateSourceLanguage(lang: string): Promise<void>
  updateTargetLanguage(lang: string): void
  updateTier(tier: 'basic' | 'premium'): void
  
  // Lifecycle
  initialize(): Promise<void>
  destroy(): Promise<void>
  
  // State queries
  getCurrentState(): EngineState
}
```

## Migration Strategy: Incremental Phase-by-Phase

**Approach:** Extract core components incrementally, test each phase, keep solo mode working throughout. This ensures zero disruption and allows validation at each step.

### Phase 1: Setup & Event Contract (Foundation)

**Goal:** Establish the event contract and directory structure without changing any behavior.

1. **Create `/core` directory structure**

   - Set up directory layout
   - Create `/core/events/eventTypes.ts` with event type definitions
   - Create `/core/shared/types/config.ts` for shared configuration
   - No behavior changes yet

2. **Test:** Verify solo mode still works (no changes made)

**Deliverable:** Event contract defined, directory structure ready

---

### Phase 2: Extract RTT Tracker (Lowest Risk)

**Goal:** Extract RTT measurement logic first (isolated, low dependencies).

1. **Create `/core/engine/rttTracker.ts`**

   - Extract RTT measurement from `soloModeHandler.js`
   - Extract adaptive lookahead calculation
   - Keep interface simple: `measureRTT()`, `getAdaptiveLookahead()`

2. **Update `soloModeHandler.js`**

   - Import `RTTTracker` from `/core`
   - Replace inline RTT logic with `rttTracker.measureRTT()`
   - Replace inline lookahead with `rttTracker.getAdaptiveLookahead()`
   - Keep all other logic unchanged

3. **Test:** Verify solo mode behavior identical (RTT measurements match)

**Deliverable:** RTT tracking extracted, solo mode using core RTT tracker

---

### Phase 3: Extract Timeline Offset Tracker

**Goal:** Extract sequence tracking (isolated, clear interface).

1. **Create `/core/engine/timelineOffsetTracker.ts`**

   - Extract sequence tracking: `sequenceCounter`, `latestSeqId`
   - Extract `sendWithSequence()` logic
   - Provide `getNextSeqId()`, `updateLatestSeqId()`, `createSequencedMessage()`

2. **Update `soloModeHandler.js`**

   - Import `TimelineOffsetTracker` from `/core`
   - Replace `sequenceCounter`, `latestSeqId` with tracker instance
   - Replace `sendWithSequence()` calls with tracker methods
   - Keep all other logic unchanged

3. **Test:** Verify solo mode behavior identical (sequence IDs match exactly)

**Deliverable:** Sequence tracking extracted, solo mode using core tracker

---

### Phase 4: Extract Partial Tracker

**Goal:** Extract partial text tracking and merging logic.

1. **Create `/core/engine/partialTracker.ts`**

   - Extract: `latestPartialText`, `longestPartialText`, timestamps
   - Extract token overlap calculation (`calculateTokenOverlap`, `tokenize`)
   - Extract partial merging logic (`mergeTokens`, `mergeWithOverlap`)
   - Extract recently finalized window management

2. **Update `soloModeHandler.js`**

   - Import `PartialTracker` from `/core`
   - Replace inline partial tracking with tracker instance
   - Replace token overlap logic with tracker methods
   - Keep all other logic unchanged

3. **Test:** Verify solo mode behavior identical (partial tracking matches)

**Deliverable:** Partial tracking extracted, solo mode using core tracker

---

### Phase 5: Extract Finalization Engine

**Goal:** Extract finalization state and timing logic.

1. **Create `/core/engine/finalizationEngine.ts`**

   - Extract: `pendingFinalization`, timeout logic
   - Extract constants: `MAX_FINALIZATION_WAIT_MS`, `FINALIZATION_CONFIRMATION_WINDOW`, `MIN_SILENCE_MS`
   - Extract finalization decision logic
   - Extract forced commit detection

2. **Update `soloModeHandler.js`**

   - Import `FinalizationEngine` from `/core`
   - Replace finalization state with engine instance
   - Replace finalization logic with engine methods
   - Keep all other logic unchanged

3. **Test:** Verify solo mode behavior identical (finalization timing matches exactly)

**Deliverable:** Finalization logic extracted, solo mode using core engine

---

### Phase 6: Extract Forced Commit Engine

**Goal:** Extract forced commit detection and audio recovery coordination.

1. **Create `/core/engine/forcedCommitEngine.ts`**

   - Extract forced final buffer logic
   - Extract audio recovery coordination
   - Extract merge-with-overlap logic for forced commits
   - Integrate with `AudioBufferManager`

2. **Update `soloModeHandler.js`**

   - Import `ForcedCommitEngine` from `/core`
   - Replace forced commit logic with engine instance
   - Keep all other logic unchanged

3. **Test:** Verify solo mode behavior identical (forced commits match)

**Deliverable:** Forced commit logic extracted, solo mode using core engine

---

### Phase 7: Create Core Engine Orchestrator

**Goal:** Wire all extracted components into unified core engine.

1. **Create `/core/engine/coreEngine.ts`**

   - Import all extracted engines (RTT, Timeline, Partial, Finalization, ForcedCommit)
   - Wire together components
   - Implement `processAudioChunk()` entry point
   - Implement event emission (emit `ExbabelEvent` types)
   - Coordinate with `GoogleSpeechStream`, `translationManager`, `grammarWorker`
   - Maintain exact same behavior as current solo mode logic

2. **Update `soloModeHandler.js`**

   - Import `CoreEngine` from `/core`
   - Replace internal processing with `coreEngine.processAudioChunk()`
   - Subscribe to core engine events
   - Forward events to WebSocket client
   - Keep WebSocket handling unchanged

3. **Test:** Verify solo mode behavior identical (comprehensive testing)

**Deliverable:** Core engine complete, solo mode fully migrated

---

### Phase 8: Migrate Host Mode

**Goal:** Refactor host mode to use core engine.

1. **Create `/host/adapter.ts`**

   - Import `CoreEngine` from `/core` (same instance as solo uses)
   - Replace internal logic with `coreEngine.processAudioChunk()`
   - Subscribe to core engine events
   - Broadcast events to listeners via `sessionStore`
   - Handle WebSocket messages (init, audio, audio_end)
   - Maintain host-specific: sessionStore integration, multi-language broadcasting

2. **Create `/host/listenerAdapter.ts`**

   - Handle listener connections
   - Forward events from host adapter to listeners
   - No direct core engine access (listeners only receive events)

3. **Update `backend/server.js`**

   - Replace `handleHostConnection` import with `/host/adapter`

4. **Test:** Verify host mode behavior identical to current implementation

**Deliverable:** Host mode migrated, both modes using shared core

---

### Phase 9: Testing & Validation

**Goal:** Comprehensive validation of behavioral equivalence.

1. **Create Deterministic Test Suite**

   - Record PCM audio samples (`test/fixtures/audio_samples/`)
   - Capture expected event sequences from current solo mode
   - Test core engine produces identical events
   - Test host mode produces identical events for host
   - Test listener events match host events

2. **Behavioral Equivalence Tests**

   - Finalization timing matches exactly
   - Partial tracking behavior identical
   - Forced commit behavior identical
   - Translation timing matches
   - Sequence IDs match

3. **Integration Tests**

   - End-to-end solo mode test
   - End-to-end host mode test
   - Multi-listener synchronization test

**Deliverable:** Test suite validates zero behavioral drift

---

## Execution Workflow: One Phase at a Time

**Process:**

1. **I complete one phase** (e.g., Phase 1: Setup & Event Contract)
2. **I stop and notify you** - Phase is ready for testing
3. **You test and review** - Verify solo mode works, check behavior
4. **You approve or request changes** - If issues, we fix before proceeding
5. **We proceed to next phase** - Only after approval

**Benefits:**

- Safe incremental progress
- Catch issues early
- Easy rollback if needed
- Solo mode stays functional throughout
- You control the pace

**What I'll Do Each Phase:**

- Make the code changes for that phase
- Update imports/exports as needed
- Leave clear comments about what changed
- Provide a summary of changes
- Wait for your approval before next phase

**What You'll Do Each Phase:**

- Test solo mode with real audio
- Verify behavior matches previous phase
- Check console logs for expected behavior
- Approve or request fixes
- Give go-ahead for next phase

## Phase-by-Phase Testing Strategy

**After Each Phase:**

1. Run solo mode with real audio input
2. Verify event sequences match previous phase
3. Check console logs for identical behavior
4. Verify no regressions in finalization timing
5. Verify no regressions in partial tracking
6. Verify sequence IDs continue correctly
7. **Run Critical Features Checklist:**

   - [ ] Word Recovery: Forced commits include all words from longest partial
   - [ ] Audio Recovery: Audio recovery produces same recovered text
   - [ ] Adaptive Timing: Finalization timing matches exactly
   - [ ] Grammar Caching: Corrections persist when partials extend

**Rollback Plan:**

- Each phase is isolated
- Can revert to previous phase if issues found
- Solo mode remains functional throughout
- Git commit after each successful phase (recommended)

## Key Design Principles

1. **Single Source of Truth**: All business logic lives in `/core/engine/*`
2. **Event-Driven**: Core emits events, adapters handle transport
3. **Zero Behavioral Drift**: Core logic extracted verbatim, not rewritten
4. **Thin Adapters**: Solo/Host adapters are <200 lines each
5. **Testability**: Core engine can be tested independently with PCM samples

## Files to Create

- `/core/engine/coreEngine.ts` - Main orchestrator
- `/core/engine/finalizationEngine.ts` - Finalization logic
- `/core/engine/partialTracker.ts` - Partial tracking
- `/core/engine/forcedCommitEngine.ts` - Forced commits
- `/core/engine/timelineOffsetTracker.ts` - Sequence tracking
- `/core/engine/rttTracker.ts` - RTT measurement
- `/core/events/eventTypes.ts` - Event definitions
- `/solo/adapter.ts` - Solo mode adapter
- `/host/adapter.ts` - Host mode adapter
- `/host/listenerAdapter.ts` - Listener adapter

## Files to Refactor

- `backend/soloModeHandler.js` → `/solo/adapter.ts` (thin wrapper)
- `backend/hostModeHandler.js` → `/host/adapter.ts` (thin wrapper)
- Move shared components to `/core` directories

## Backward Compatibility Strategy

**Approach: Internal Refactoring Only (Option 2)**

- **Maintain External WebSocket API**: No changes to message formats, event types, or client-server contracts
- **Frontend Compatibility**: Frontend code requires zero changes
- **Internal Structure Only**: Only backend internal structure changes
- **Behavior Preservation**: All existing behavior must remain identical

## Critical Features to Preserve Exactly

**ALL FOUR FEATURES ARE CRITICAL** - Zero behavioral drift required for each:

### 1. Word Recovery (Longest Partial Tracking) ⚠️ CRITICAL

**Mechanism:** The `longestPartialText` mechanism prevents word loss on forced finals by tracking the longest partial seen before finalization.

**Why Critical:** Missing words would break user trust and accuracy. This is the primary defense against word loss.

**Preservation Requirements:**

- `longestPartialText` and `longestPartialTime` tracking must work identically
- Partial comparison logic (`partialText.length > longestPartialText.length`) must match exactly
- Finalization must wait for longest partial confirmation before committing
- No words can be lost during forced commits - longest partial must always be preserved
- `PartialTracker` extraction must maintain exact same longest partial update logic

**Test:** Verify forced commits include all words from longest partial (compare before/after extraction)

**Location in Code:** `soloModeHandler.js` lines ~194-197, ~700-800 (partial tracking logic)

---

### 2. Forced Final Audio Recovery ⚠️ CRITICAL

**Mechanism:** The 3-phase recovery system (snapshot → wait → audio replay) that recovers missing words on stream restarts.

**Why Critical:** Recovers words lost during stream interruptions. Without this, forced commits would lose data permanently.

**Preservation Requirements:**

- Audio buffer snapshot timing must match exactly (when snapshot is taken)
- Wait period before recovery must be identical (`WAIT_FOR_PARTIALS_MS`)
- Audio replay logic must work the same way (which audio is replayed, how it's merged)
- Recovery stream integration must behave identically (Google Speech stream restart)
- Merge logic for recovered text must match exactly (how recovered text merges with forced final)
- `ForcedCommitEngine` must coordinate with `AudioBufferManager` identically

**Test:** Verify audio recovery recovers same words in same order (record forced commit scenario, compare recovered text)

**Location in Code:** `soloModeHandler.js` lines ~2200-2300 (forced final processing, audio recovery)

---

### 3. Adaptive Finalization Timing ⚠️ CRITICAL

**Mechanism:** RTT-based lookahead and sentence-aware waiting that optimizes latency vs completeness tradeoff.

**Why Critical:** Core UX differentiator - balances responsiveness with completeness. Wrong timing = poor UX.

**Preservation Requirements:**

- RTT measurement must be identical (`measureRTT()` function, filtering logic)
- Adaptive lookahead calculation must match exactly (`getAdaptiveLookahead()`, RTT/2 capped 200-700ms)
- Sentence completion detection must work the same (period detection, sentence boundaries)
- Finalization timing decisions must be identical (when to wait, when to commit)
- Constants must match exactly: `MAX_FINALIZATION_WAIT_MS=12000`, `MIN_SILENCE_MS=600`, `DEFAULT_LOOKAHEAD_MS=200`
- `RTTTracker` and `FinalizationEngine` must use exact same timing calculations

**Test:** Verify finalization timing matches exactly (same wait times, same commit decisions, same RTT calculations)

**Location in Code:** `soloModeHandler.js` lines ~53-74 (RTT measurement), ~39-43 (timing constants), ~2150-2265 (finalization logic)

---

### 4. Grammar Correction Caching ⚠️ CRITICAL

**Mechanism:** Cache that remembers corrections and reapplies them to extending partials for consistency.

**Why Critical:** Ensures corrections persist across partial updates. Without this, corrections would flicker or disappear.

**Preservation Requirements:**

- Grammar correction cache must work identically (what's cached, when it's applied)
- Reapplication to extending partials must match exactly (how corrections are merged)
- Correction consistency across partials must be preserved (same correction for same text)
- `correctedText` field behavior must be identical (when it's set, when it's updated)
- Grammar worker integration must maintain cache behavior

**Test:** Verify corrections persist when partials extend (send partial, get correction, extend partial, verify correction persists)

**Location in Code:** `soloModeHandler.js` lines ~470-600 (grammar correction integration, correction caching)

---

## Feature Preservation Testing Checklist

After each phase, verify ALL four features:

- [ ] **Word Recovery**: Forced commits include all words from longest partial
- [ ] **Audio Recovery**: Audio recovery produces same recovered text
- [ ] **Adaptive Timing**: Finalization timing matches exactly (same delays, same decisions)
- [ ] **Grammar Caching**: Corrections persist when partials extend

## Critical Migration Rules

1. **Extract, Don't Rewrite**: Copy logic exactly, don't reinterpret
2. **Preserve Invariants**: Buffer lifecycle, forced commit behavior, offset tracking must match exactly
3. **Preserve Critical Features**: Word recovery, audio recovery, adaptive timing, grammar caching must be identical
4. **Test Continuously**: After each extraction, verify solo mode still works
5. **One Component at a Time**: Extract one engine component, test, then move to next
6. **Freeze Solo Mode First**: Get clean baseline before extracting
7. **Maintain WebSocket API**: No changes to message formats or event structures

## Success Criteria

- Solo mode behavior identical to current implementation
- Host mode behavior identical to current implementation  
- Listeners receive identical events as host (perfect sync)
- Code duplication eliminated
- Core engine testable independently
- Adapters are <200 lines each