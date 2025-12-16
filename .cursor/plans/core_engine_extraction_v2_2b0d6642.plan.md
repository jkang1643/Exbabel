---
name: Core Engine Extraction v2
overview: Extract duplicated business logic from solo and host mode handlers into CoreEngine, enabling single-source-of-truth edits that automatically propagate to both modes while maintaining zero behavioral drift.
todos: []
---

# Core Engine Extraction v2

## Goal

Extract duplicated business logic into CoreEngine so that edits made once automatically apply to both solo and host modes. This eliminates the need to maintain identical logic in two places.

## Current State

**Both modes use CoreEngine but only partially:**

- `backend/soloModeHandler.js` (~2400 lines) - uses CoreEngine for tracking engines
- `backend/host/adapter.js` (~2400 lines) - uses CoreEngine for tracking engines
- Both have massive duplication of:
  - Grammar correction caching (~100 lines identical)
  - `processFinalText()` function (~200 lines nearly identical)
  - Translation coordination logic (~150 lines similar)
  - `speechStream.onResult()` handling (~600 lines similar)

**Key Difference:** Host mode broadcasts to multiple languages via `sessionStore`, solo mode sends to single client.

## Architecture Target

```
CoreEngine (orchestrator)
  ├── Grammar Correction Cache (shared)
  ├── processFinalText() (shared logic, mode-agnostic)
  ├── Translation Coordination (shared)
  └── Event Emission (mode-agnostic)

Solo Adapter (thin wrapper)
  ├── WebSocket message handling
  ├── Calls coreEngine.processFinalText()
  └── Forwards events to single client

Host Adapter (thin wrapper)
  ├── WebSocket message handling
  ├── Calls coreEngine.processFinalText()
  └── Broadcasts events to sessionStore (multi-language)
```

## Strategy for Handling Differences

**Key Principle:** Extract shared logic, keep mode-specific logic in adapters.

**Differences Identified:**

1. **Translation API:**
   - Solo: Single language (`translateFinal(sourceLang, targetLang)`)
   - Host: Multiple languages (`translateToMultipleLanguages(sourceLang, targetLanguages[])`)
   - **Solution:** CoreEngine calls appropriate API based on config (`targetLang` vs `targetLanguages`)

2. **Delivery Mechanism:**
   - Solo: `sendWithSequence()` to single WebSocket client
   - Host: `broadcastWithSequence()` to sessionStore (multi-language groups)
   - **Solution:** CoreEngine returns processed data, adapters handle delivery

3. **Transcription-Only Mode:**
   - Solo: Supports when `sourceLang === targetLang`
   - Host: Always translates
   - **Solution:** CoreEngine handles via config flag, adapters pass appropriate config

4. **Post-Processing Hooks:**
   - Solo: `checkForExtendingPartialsAfterFinal()` after sending
   - Host: No equivalent
   - **Solution:** Keep in solo adapter, not in CoreEngine

5. **Error Handling:**
   - Solo: Single translation error handling
   - Host: Multi-language error handling (per language validation)
   - **Solution:** CoreEngine handles shared error patterns, adapters handle mode-specific validation

**Extraction Strategy:**

- **Extract:** Grammar correction, translation worker selection, error handling patterns, translation coordination logic
- **Keep in Adapters:** Delivery mechanism, mode-specific validation, post-processing hooks, logging prefixes

## Migration Strategy: Incremental Extraction

**Principle:** Extract one piece at a time, test after each step, maintain exact behavior.

### Phase 1: Extract Grammar Correction Cache

**Goal:** Move grammar correction cache into CoreEngine so both modes share the same cache instance.

**Changes:**

1. Add grammar correction cache to `core/engine/coreEngine.js`:

   - `grammarCorrectionCache` Map
   - `rememberGrammarCorrection(originalText, correctedText)` method
   - `applyCachedCorrections(text)` method
   - Constants: `MAX_GRAMMAR_CACHE_ENTRIES`, `MIN_GRAMMAR_CACHE_LENGTH`, `MAX_LENGTH_MULTIPLIER`

2. Update `backend/soloModeHandler.js`:

   - Remove local `grammarCorrectionCache` Map
   - Remove local `rememberGrammarCorrection()` and `applyCachedCorrections()` functions
   - Replace calls with `coreEngine.rememberGrammarCorrection()` and `coreEngine.applyCachedCorrections()`

3. Update `backend/host/adapter.js`:

   - Same changes as solo mode

**Test:** Verify grammar corrections persist across partials in both modes (same behavior as before).

**Deliverable:** Grammar correction cache shared via CoreEngine.

---

### Phase 2: Extract processFinalText() Core Logic

**Goal:** Extract the shared final text processing logic into CoreEngine, keeping mode-specific delivery separate.

**Key Differences to Handle:**

1. **Translation API:**
   - Solo: `translateFinal(sourceLang, targetLang)` - single language, returns string
   - Host: `translateToMultipleLanguages(sourceLang, targetLanguages[])` - multiple languages, returns map

2. **Transcription-only mode:**
   - Solo: Supports `isTranscriptionOnly` (when sourceLang === targetLang)
   - Host: Always translates (`isTranscriptionOnly = false`)

3. **Delivery mechanism:**
   - Solo: `sendWithSequence()` to single WebSocket client
   - Host: `broadcastWithSequence()` to sessionStore (multi-language groups)

4. **Post-processing:**
   - Solo: `checkForExtendingPartialsAfterFinal()` after sending
   - Host: No equivalent check

**Solution Strategy:**

Extract shared logic (grammar correction, translation worker selection, error handling) into CoreEngine. Keep mode-specific delivery in adapters.

**Changes:**

1. Add `processFinalText()` method to `core/engine/coreEngine.js`:

   - Accepts: `textToProcess`, `options`, `config` object:
     ```javascript
     {
       sourceLang: string,
       targetLang?: string,           // Solo mode: single target
       targetLanguages?: string[],    // Host mode: multiple targets
       isTranscriptionOnly?: boolean,  // Solo mode only
       usePremiumTier: boolean,
       sessionId: string
     }
     ```
   - Returns: Promise with processed result object:
     ```javascript
     {
       originalText: string,
       correctedText: string,
       // Solo mode result:
       translatedText?: string,       // Single translation
       // Host mode result:
       translations?: { [lang: string]: string },  // Multi-language map
       hasCorrection: boolean,
       hasTranslation: boolean,
       forceFinal: boolean
     }
     ```
   - **Shared logic handled:**
     - Grammar correction (English only) - identical in both
     - Translation worker selection (premium vs basic tier) - identical logic
     - Error handling patterns (timeout, truncation, rate limiting) - identical logic
     - Transcription-only mode detection (solo only, but handled via config)
   - **Mode-specific logic stays in adapters:**
     - Translation API call (single vs multi-language)
     - Message delivery (send vs broadcast)
     - Post-processing hooks

2. Update `backend/soloModeHandler.js`:

   - Replace local `processFinalText()` with call to `coreEngine.processFinalText()`
   - Pass config: `{ sourceLang, targetLang, isTranscriptionOnly, usePremiumTier, sessionId }`
   - CoreEngine calls `translateFinal()` internally (single language)
   - Receive result with `translatedText` (string)
   - Call `sendWithSequence()` with result data
   - Keep mode-specific: `sendWithSequence()`, `checkForExtendingPartialsAfterFinal()`, `lastSentFinalText` tracking

3. Update `backend/host/adapter.js`:

   - Replace local `processFinalText()` with call to `coreEngine.processFinalText()`
   - Pass config: `{ sourceLang, targetLanguages: sessionStore.getSessionLanguages(), usePremiumTier, sessionId }`
   - CoreEngine calls `translateToMultipleLanguages()` internally (multi-language)
   - Receive result with `translations` (map)
   - Broadcast to `sessionStore` for each language
   - Keep mode-specific: `broadcastWithSequence()`, `sessionStore` integration, per-language validation

**Key Design Decision:**

CoreEngine handles the translation API call internally (single vs multi-language) based on config. This keeps the translation coordination logic (worker selection, error handling) shared while allowing different API signatures.

**Alternative Considered:** Return raw data and let adapters call translation API. **Rejected** because translation error handling logic is identical and should be shared.

**Test:** Verify final text processing identical in both modes (grammar correction, translation, error handling). Verify solo mode single-language delivery and host mode multi-language broadcast both work correctly.

**Deliverable:** Final text processing logic shared via CoreEngine, mode-specific delivery remains in adapters.

---

### Phase 3: Extract Translation Coordination

**Goal:** Move translation worker coordination and throttling logic into CoreEngine.

**Differences to Handle:**

1. **Translation API:**
   - Solo: `partialTranslationWorker.translatePartial()` - single language
   - Host: May need multi-language support (if partials are translated)
   - **Note:** Review if host mode translates partials or only finals

2. **Throttling Logic:**
   - Both modes have similar throttling (growth threshold, time-based)
   - **Solution:** Extract shared throttling logic, adapters handle delivery

**Changes:**

1. Add translation coordination to `core/engine/coreEngine.js`:

   - `processPartialTranslation(text, config)` method
     - Accepts: `text`, `config` (sourceLang, targetLang/targetLanguages, usePremiumTier, sessionId)
     - Handles translation throttling logic (growth threshold, time-based) - shared logic
     - Coordinates partial translation workers (single vs multi-language based on config)
     - Returns: `{ translatedText?: string, translations?: { [lang: string]: string }, throttled: boolean }`
   - **Shared logic:**
     - Throttling calculations (growth threshold, time-based)
     - Worker selection (premium vs basic tier)
     - Error handling patterns
   - **Mode-specific stays in adapters:**
     - Delivery (send vs broadcast)
     - Throttle state tracking (if needed per mode)

2. Update `backend/soloModeHandler.js`:

   - Replace inline translation throttling with `coreEngine.processPartialTranslation()`
   - Pass config: `{ sourceLang, targetLang, usePremiumTier, sessionId }`
   - Receive result with `translatedText` (string)
   - Call `sendWithSequence()` with result
   - Keep mode-specific: throttle state tracking, delivery

3. Update `backend/host/adapter.js`:

   - Replace inline translation throttling with `coreEngine.processPartialTranslation()`
   - Pass config: `{ sourceLang, targetLanguages, usePremiumTier, sessionId }` (if partials are translated)
   - Receive result with `translations` (map) or `translatedText` (if single)
   - Broadcast to sessionStore
   - Keep mode-specific: throttle state tracking, delivery

**Test:** Verify partial translation timing matches in both modes. Verify throttling behavior identical.

**Deliverable:** Translation coordination shared via CoreEngine.

---

### Phase 4: Extract Speech Stream Result Handler (Future)

**Goal:** Move `speechStream.onResult()` callback logic into CoreEngine.

**Note:** This is the largest extraction and should be done after Phases 1-3 are stable.

**Changes:**

1. Add `processTranscriptResult()` method to CoreEngine:

   - Accepts: `transcriptText`, `isPartial`, `meta`
   - Coordinates: partial tracking, forced commit checking, translation, grammar
   - Emits events: `partial`, `final`, `commit`

2. Update handlers:

   - Replace `speechStream.onResult()` callback with `coreEngine.processTranscriptResult()`
   - Subscribe to CoreEngine events
   - Forward events to clients (solo) or broadcast (host)

**Test:** Comprehensive testing of entire pipeline in both modes.

**Deliverable:** Full pipeline orchestrated by CoreEngine.

---

## Critical Requirements

1. **Zero Behavioral Drift:** All extracted logic must match original behavior exactly
2. **Mode-Specific Delivery:** CoreEngine returns data, adapters handle delivery (single client vs multi-language)
3. **Backward Compatibility:** Existing WebSocket API unchanged
4. **Incremental Testing:** Test after each phase before proceeding
5. **Difference Preservation:** Mode-specific differences must be preserved exactly (solo single-language, host multi-language)

## Testing Strategy for Differences

**After Each Phase:**

1. **Solo Mode Tests:**
   - Verify single-language translation works
   - Verify transcription-only mode works (sourceLang === targetLang)
   - Verify `checkForExtendingPartialsAfterFinal()` still works
   - Verify messages sent to single WebSocket client

2. **Host Mode Tests:**
   - Verify multi-language translation works
   - Verify broadcasting to sessionStore works
   - Verify per-language validation works
   - Verify host receives corrected source text
   - Verify listeners receive appropriate translations

3. **Shared Logic Tests:**
   - Verify grammar correction identical in both modes
   - Verify translation worker selection identical
   - Verify error handling patterns identical
   - Verify throttling behavior identical

**Key Verification Points:**

- Solo mode: `translatedText` is a string (single language)
- Host mode: `translations` is a map (multi-language) OR single translation if only one listener
- Both modes: Grammar correction cache shared and works identically
- Both modes: Error handling (timeout, truncation, rate limiting) works identically

## Files to Modify

- `core/engine/coreEngine.js` - Add extracted methods
- `backend/soloModeHandler.js` - Replace duplicated logic with CoreEngine calls
- `backend/host/adapter.js` - Replace duplicated logic with CoreEngine calls

## Success Criteria

- Grammar correction cache shared (Phase 1)
- Final text processing shared (Phase 2)
- Translation coordination shared (Phase 3)
- Both modes behave identically to current implementation
- Edits to CoreEngine automatically apply to both modes
- Adapters remain thin wrappers (<300 lines each)