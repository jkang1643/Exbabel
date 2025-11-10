<!-- e073f449-1c16-48fe-abcf-fdaaffb0abce e1ad3ade-02dd-4b2a-bf62-f8bcdf69e867 -->
# Optimize Translation Latency - Decouple Grammar & Translation

## Problem

Currently, translation and grammar correction run in parallel using `Promise.allSettled()`, but the backend waits for BOTH to complete before sending results. This adds significant latency, especially for short texts where users expect instant translation.

## Solution Architecture

**Decouple execution and messaging:**

1. Fire translation and grammar in parallel (keep current behavior)
2. Send translation result IMMEDIATELY when ready (don't wait for grammar)
3. Send grammar correction separately when ready
4. Frontend already supports incremental merging via `correctedText` field

## Key Changes

### 1. Backend: Decouple Translation & Grammar Sends

**File:** `backend/soloModeHandler.js`

**Current flow (lines 258-314):**

```javascript
// Run in parallel
const [grammarResult, translationResult] = await Promise.allSettled([...]);
// Wait for BOTH, then send merged result
sendWithSequence({ correctedText, translatedText, ... });
```

**New flow:**

```javascript
// Fire both in parallel, but handle results independently
const grammarPromise = grammarWorker.correctPartial(...);
const translationPromise = partialTranslationWorker.translatePartial(...);

// Send translation IMMEDIATELY when ready
translationPromise.then(translatedText => {
  sendWithSequence({ 
    originalText, 
    translatedText, 
    hasTranslation: true,
    hasCorrection: false // Not ready yet
  });
});

// Send grammar update separately when ready
grammarPromise.then(correctedText => {
  sendWithSequence({
    originalText,
    correctedText,
    hasCorrection: true,
    updateType: 'grammar' // Flag to indicate this is grammar-only update
  });
});
```

**Apply to 3 locations:**

- Partial translation (immediate, lines ~258-320)
- Partial translation (delayed, lines ~353-399)
- Final translation (lines ~452-485)

### 2. Grammar Worker: Optimize Parameters for Speed

**File:** `backend/grammarWorker.js`

**Optimizations:**

- Increase minimum text threshold: `3 chars → 8 chars` (line 84)
  - Short texts like "and", "the", "so" don't need grammar correction
- Reduce `max_tokens` for partials: `2000 → 800` (line 142)
  - Partials are short, don't need large token budget
- Add timeout for partials: `2 seconds` (currently no timeout)
  - Prevents grammar from blocking UI if API is slow
- Keep final parameters unchanged (already has 5s timeout)

### 3. Translation Worker: Document Current Fast Parameters

**File:** `backend/translationWorkers.js`

No changes needed - already optimized:

- Using `gpt-4o-mini` (fastest model)
- `temperature: 0.2` (fast, consistent)
- `max_tokens: 16000` (appropriate)

### 4. Update OPTIMIZATIONS_STATUS.md

Document the decoupled architecture and parameter optimizations.

## Expected Latency Improvements

**Before (coupled):**

- Short text: ~400-800ms (translation + grammar, whichever is slower)
- Medium text: ~800-1500ms
- Long text: ~1500-3000ms

**After (decoupled):**

- Short text: ~200-400ms (translation only, grammar follows)
- Medium text: ~400-800ms (translation shows first)
- Long text: ~800-1500ms (translation shows first)

**Key benefit:** Translation appears immediately, grammar correction updates in-place when ready (lowest perceived latency)

## Implementation Order

1. Optimize grammar worker parameters (quickest win)
2. Refactor backend message sending to decouple translation/grammar
3. Test with short, medium, and long texts
4. Update documentation

### To-dos

- [ ] Optimize grammar worker parameters: increase min text threshold to 8 chars, reduce max_tokens to 800 for partials, add 2s timeout
- [ ] Refactor partial translation (immediate) to send translation and grammar independently in soloModeHandler.js
- [ ] Refactor partial translation (delayed) to send translation and grammar independently in soloModeHandler.js
- [ ] Refactor final translation to send translation and grammar independently in soloModeHandler.js
- [ ] Update OPTIMIZATIONS_STATUS.md to document the decoupled architecture and parameter optimizations