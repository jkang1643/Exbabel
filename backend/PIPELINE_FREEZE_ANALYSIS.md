# Pipeline Freeze & Partial Commit Failure Analysis

**Date:** December 24, 2025  
**Log Range:** Lines 9563-10025  
**Status:** Critical systemic bug identified

---

## Executive Summary

Analysis of terminal logs reveals a **systemic bug** that causes the pipeline to freeze and prevent partials from being committed to history:

**ROOT CAUSE: Translation errors occur throughout the pipeline (immediate AND delayed paths), and when ANY translation fails, partials are silently dropped - nothing is sent to the frontend, so partials never appear and never get committed to history.**

The delayed translation errors appear "all over the logs" because:
1. **Immediate translations fail** → logged, nothing sent
2. **Delayed translations are scheduled** → they also fail → logged, nothing sent  
3. **Pattern repeats** → cascade of failures → pipeline appears frozen

This is NOT isolated to one code path - it's a **systemic error handling pattern** that affects both immediate and delayed translation paths.

---

## Root Cause: Systemic Translation Error Handling

### Problem Pattern (Occurs in Multiple Locations)

**Location 1: Immediate Translation Errors**
```1745:1779:backend/soloModeHandler.js
}).catch(error => {
  // Handle translation errors gracefully
  if (error.name !== 'AbortError') {
    // ... error logging ...
    } else if (error.message && error.message.includes('timeout')) {
      console.warn(`[SoloMode] ⚠️ ${workerType} API timeout - translation skipped for this partial`);
      // Don't send error message to frontend - just skip this translation
    } else {
      console.error(`[SoloMode] ❌ Translation error (${workerType} API, ${rawCapturedText.length} chars):`, error.message);
    }
  }
  // Don't send anything on error - keep last partial translation
});
```

**Location 2: Delayed Translation Errors**
```1941:1957:backend/soloModeHandler.js
}).catch(error => {
  // Handle translation errors gracefully
  if (error.name !== 'AbortError') {
    // ... error logging ...
    } else if (error.message && error.message.includes('timeout')) {
      console.warn(`[SoloMode] ⚠️ ${workerType} API timeout - translation skipped for this partial`);
    } else {
      console.error(`[SoloMode] ❌ Delayed translation error (${workerType} API, ${latestText.length} chars):`, error.message);
    }
  }
  // Don't send anything on error
});
```

### The Cascade Effect

1. **Partial arrives** → `currentPartialText` updated (line 1597)
2. **Immediate translation attempted** → fails with "active response" error → logged, nothing sent
3. **`lastPartialTranslation` NOT updated** (line 1778: "keep last partial translation")
4. **Next partial arrives** → doesn't meet `shouldTranslateNow` criteria → **delayed translation scheduled**
5. **Delayed translation timeout fires** → captures latest `currentPartialText` → attempts translation
6. **Delayed translation also fails** → logged, nothing sent
7. **Pattern repeats** → multiple delayed translations queued, all failing
8. **Result**: No messages sent to frontend → pipeline appears frozen → partials never committed

### Evidence from Logs

The errors appear throughout because both paths fail:
```
[0] [SoloMode] ❌ Translation error (REALTIME API, 57 chars): Conversation already has an active response...
[0] [SoloMode] ❌ Translation error (REALTIME API, 64 chars): Conversation already has an active response...
[0] [SoloMode] ❌ Delayed translation error (REALTIME API, 62 chars): Conversation already has an active response...
[0] [SoloMode] ❌ Translation error (REALTIME API, 72 chars): Conversation already has an active response...
[0] [SoloMode] ❌ Translation error (REALTIME API, 81 chars): Conversation already has an active response...
[0] [SoloMode] ⚠️ REALTIME API timeout - translation skipped for this partial
[0] [SoloMode] ❌ Delayed translation error (REALTIME API, 14 chars): Conversation already has an active response...
[0] [SoloMode] ❌ Delayed translation error (REALTIME API, 18 chars): Conversation already has an active response...
```

### Impact
- **CRITICAL**: Partials are lost when ANY translation fails (immediate OR delayed)
- Pipeline appears frozen because no messages are sent
- User sees no updates during translation errors
- **Systemic issue** - affects all translation paths, not just one

### Fix Required
Send partials **even when translation fails** - at minimum, send the original text so it appears in the UI and can be committed to history.

---

## Bug #2: Over-Aggressive Partial Deduplication

### Location
```1127:1131:backend/soloModeHandler.js
// If all words were duplicates, skip sending this partial entirely
if (dedupResult.wasDeduplicated && (!partialTextToSend || partialTextToSend.length < 3)) {
  console.log(`[SoloMode] ⏭️ Skipping partial - all words are duplicates of previous FINAL`);
  return; // Skip this partial entirely
}
```

### Problem
When deduplication removes all words from a partial (or leaves < 3 chars), the partial is **completely skipped**. This happens when:
- Partial starts with words that match the end of the previous FINAL
- Example: FINAL ends with "and drink", partial starts with "and," → entire partial skipped

### Evidence from Logs
```
[0] [SoloMode] ✂️ Trimmed 1 duplicate word(s) from partial: "and,..." → "..."
[0] [SoloMode] ⏭️ All words are duplicates of previous FINAL - text would be empty after deduplication
[0] [SoloMode] ⏭️ Skipping partial - all words are duplicates of previous FINAL
```

### Impact
- **HIGH**: Legitimate partials are dropped when they start with common words
- New segments that begin with connecting words ("and", "but", "so") are lost
- Pipeline appears frozen because partials never arrive

### Fix Required
**Never skip partials entirely** - even if deduplication removes all words, the partial should still be tracked and sent (possibly with a flag indicating it's a continuation).

---

## Bug #3: Delayed Translation Timeout Doesn't Send Partial

### Location
```1847:1957:backend/soloModeHandler.js
console.log(`[SoloMode] ⏱️ Delayed processing partial (${latestText.length} chars): "${latestText.substring(0, 40)}..."`);
// ... translation code ...
.catch(error => {
  // ... error handling ...
  if (error.message && error.message.includes('timeout')) {
    console.warn(`[SoloMode] ⚠️ ${workerType} API timeout - translation skipped for this partial`);
  }
  // Don't send anything on error
});
```

### Problem
When delayed translation times out, the error is logged but **the partial is never sent**. The delayed translation path is used when:
- Partial doesn't meet immediate translation thresholds
- Text is queued for later processing
- Timeout occurs before translation completes

### Evidence from Logs
```
[0] [SoloMode] ⚠️ REALTIME API timeout - translation skipped for this partial
[0] [SoloMode] ⏱️ Delayed processing partial (14 chars): "and, you know,..."
[0] [SoloMode] 🔀 Using REALTIME API for delayed partial translation (14 chars)
```

### Impact
- **MEDIUM-HIGH**: Partials in the delayed queue are lost on timeout
- Creates gaps in the transcription history
- Pipeline appears frozen because queued partials never complete

### Fix Required
**Send partials on timeout** - even without translation, send the original text so it appears in the UI.

---

## Bug #4: REALTIME API Response Conflicts

### Location
Multiple locations in `translationWorkersRealtime.js` - the API allows only one active response per conversation.

### Problem
The REALTIME API throws "Conversation already has an active response in progress" errors when:
- Multiple translation requests are made concurrently
- Previous response hasn't completed
- Response cancellation doesn't complete before new request

### Evidence from Logs
```
[0] [SoloMode] ❌ Translation error (REALTIME API, 72 chars): Conversation already has an active response in progress: resp_CqRCDc21cEZqa0VX6rCXS. Wait until the response is finished before creating a new one.
[0] [SoloMode] ❌ Translation error (REALTIME API, 81 chars): Conversation already has an active response in progress: resp_CqRCDc21cEZqa0VX6rCXS. Wait until the response is finished before creating a new one.
[0] [SoloMode] ❌ Delayed translation error (REALTIME API, 14 chars): Conversation already has an active response in progress: resp_CqRCFvEjIiCAYNPoi0wwY. Wait until the response is finished before creating a new one.
```

### Impact
- **HIGH**: All translation requests fail when response conflicts occur
- Creates a cascade of failures
- Pipeline freezes because no translations succeed

### Fix Required
**Implement proper request queuing** - wait for active responses to complete or cancel properly before starting new requests. Add retry logic with exponential backoff.

---

## Bug #5: Recovery Stream Timeout

### Location
Recovery stream mechanism in `soloModeHandler.js` - timeout after 5000ms.

### Problem
When recovery stream times out:
- Recovery promise may never resolve
- Partials waiting for recovery are stuck
- No fallback mechanism to continue processing

### Evidence from Logs
```
[0] [SoloMode] ⚠️ Recovery stream timeout after 5000ms
```

### Impact
- **MEDIUM**: Recovery failures can block partial processing
- Partials that should extend forced finals are delayed
- Pipeline may appear frozen during recovery attempts

### Fix Required
**Add timeout handling** - resolve recovery promise with empty result on timeout, allowing normal processing to continue.

---

## Bug #6: Invalid RTT Measurements

### Location
RTT tracking code - negative measurements indicate timing issues.

### Problem
Negative RTT measurements suggest:
- Clock synchronization issues
- Timestamp calculation errors
- Race conditions in timing logic

### Evidence from Logs
```
[0] [RTTTracker] ⚠️ Invalid RTT measurement: -556ms (skipping)
[0] [RTTTracker] ⚠️ Invalid RTT measurement: -553ms (skipping)
[0] [RTTTracker] ⚠️ Invalid RTT measurement: -550ms (skipping)
```

### Impact
- **LOW-MEDIUM**: RTT tracking is broken, but doesn't directly cause freezes
- May indicate underlying timing issues that affect other systems
- Could cause issues with timeout calculations

### Fix Required
**Fix timestamp calculations** - ensure timestamps are always monotonically increasing and handle edge cases properly.

---

## Root Cause Analysis

The pipeline freezes because of a **systemic error handling pattern** that silently drops partials:

1. **REALTIME API conflicts occur** → "active response" errors
2. **Immediate translations fail** → logged, nothing sent, `lastPartialTranslation` not updated
3. **Delayed translations scheduled** → they also fail → logged, nothing sent
4. **Pattern repeats** → cascade of failures across both paths
5. **No fallback mechanism** → when translation fails, partial is completely lost

**Result**: No messages are sent to the frontend, so the pipeline appears frozen and partials are never committed to history.

**Key Insight**: The delayed translation errors appear "all over the logs" because:
- Immediate translations fail → delayed translations are scheduled as fallback
- Delayed translations also fail → same error pattern
- Both paths use the same error handling: log error, don't send anything
- This creates a cascade where partials are queued for delayed translation, but all delayed translations fail, so nothing ever gets sent

---

## Recommended Fixes (Priority Order)

### Priority 1: Always Send Partials (Even on Error) - SYSTEMIC FIX
**Location**: `soloModeHandler.js` lines 1745-1779 (immediate), 1941-1957 (delayed)

**Problem**: Both immediate AND delayed translation paths silently drop partials on error.

**Fix**: Send partials with original text when translation fails in BOTH paths:
```javascript
// IMMEDIATE TRANSLATION PATH (line ~1745)
.catch(error => {
  // ... existing error handling ...
  
  // CRITICAL FIX: Always send partial, even on error
  // This ensures partials appear in UI and can be committed to history
  console.warn(`[SoloMode] ⚠️ Translation failed, sending original text: "${capturedText.substring(0, 40)}..."`);
  sendWithSequence({
    type: 'translation',
    originalText: rawCapturedText,
    translatedText: capturedText, // Fallback to original
    timestamp: Date.now(),
    isTranscriptionOnly: false,
    hasTranslation: false, // Flag that translation failed
    hasCorrection: false,
    translationError: true // Flag for frontend
  }, true);
  
  // Update tracking so we don't retry the same text
  lastPartialTranslation = capturedText;
});

// DELAYED TRANSLATION PATH (line ~1941)
.catch(error => {
  // ... existing error handling ...
  
  // CRITICAL FIX: Always send partial, even on error
  console.warn(`[SoloMode] ⚠️ Delayed translation failed, sending original text: "${latestText.substring(0, 40)}..."`);
  sendWithSequence({
    type: 'translation',
    originalText: latestText,
    translatedText: latestText, // Fallback to original
    timestamp: Date.now(),
    isTranscriptionOnly: false,
    hasTranslation: false,
    hasCorrection: false,
    translationError: true
  }, true);
  
  // Update tracking so we don't retry the same text
  lastPartialTranslation = latestText;
  lastPartialTranslationTime = Date.now();
});
```

### Priority 2: Never Skip Partials Entirely
**Location**: `soloModeHandler.js` lines 1127-1131

**Fix**: Always send partials, even if deduplication removes all words:
```javascript
// If all words were duplicates, still send the partial (may be continuation)
if (dedupResult.wasDeduplicated && (!partialTextToSend || partialTextToSend.length < 3)) {
  console.log(`[SoloMode] ⚠️ All words deduplicated, but sending partial as continuation`);
  // Use original text if deduplication removed everything
  partialTextToSend = transcriptText;
  // Continue processing - don't skip
}
```

### Priority 3: Fix REALTIME API Request Queuing
**Location**: `translationWorkersRealtime.js`

**Fix**: Implement proper request queuing and cancellation:
- Wait for active response to complete before starting new request
- Implement request queue with max 1 concurrent request per session
- Add proper cancellation handling with timeout
- Add retry logic with exponential backoff

### Priority 4: Add Timeout Handling for Delayed Translations
**Location**: `soloModeHandler.js` lines 1829-1991

**Fix**: Send partial on timeout:
```javascript
// Add timeout to translation promise
const translationWithTimeout = Promise.race([
  translationPromise,
  new Promise((_, reject) => 
    setTimeout(() => reject(new Error('timeout')), 10000)
  )
]);

translationWithTimeout.catch(error => {
  if (error.message === 'timeout') {
    // Send original text on timeout
    sendWithSequence({
      type: 'translation',
      originalText: latestText,
      translatedText: latestText,
      timestamp: Date.now(),
      isTranscriptionOnly: false,
      hasTranslation: false,
      translationError: true
    }, true);
  }
});
```

### Priority 5: Fix Recovery Stream Timeout
**Location**: Recovery stream timeout handler

**Fix**: Resolve recovery promise on timeout:
```javascript
// In recovery stream timeout handler
if (recoveryPromise && !recoveryResolved) {
  console.warn('[SoloMode] ⚠️ Recovery timeout - resolving with empty result');
  recoveryPromise.resolve('');
  recoveryResolved = true;
}
```

---

## Testing Recommendations

1. **Test translation error scenarios** - Verify partials are sent even when translation fails
2. **Test deduplication edge cases** - Verify partials starting with common words aren't skipped
3. **Test concurrent translation requests** - Verify API conflict handling
4. **Test delayed translation timeouts** - Verify partials are sent on timeout
5. **Test recovery stream timeouts** - Verify pipeline continues after timeout

---

## Conclusion

The pipeline freezes because **partials are silently dropped** when errors occur. The fix is to **always send partials to the frontend**, even when translation fails, so they can be displayed and committed to history. This ensures the pipeline never appears frozen and users always see progress.

