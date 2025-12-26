# Code Fragility Analysis: Partial Duplication and Finals Processing

## Critical Finding: Missing Variable Declaration

**PROBLEM**: `lastSentPartialText` and `lastSentPartialTime` are used in the duplicate detection logic (lines 1244-1286) but **NEVER DECLARED**. This means they are likely:
1. Implicitly declared as global variables (extremely fragile)
2. Or undefined, causing silent failures

## Fragile Dependencies Chain

### 1. **Translation Trigger Logic (Lines 1767-1781)**
```javascript
const shouldTranslateNow = isFirstTranslation ||
                           textGrewSignificantly ||
                           enoughTimePassed;
```

**Fragility**: 
- If ANY of these conditions change, the entire translation flow breaks
- `textGrowth` depends on `lastPartialTranslation` being correctly maintained
- If `lastPartialTranslation` isn't updated on success, growth calculation breaks

**Critical Update Points**:
- Line 1804: Transcription mode - updates both variables ✅
- Line 1739: Translation success - updates `lastPartialTranslation` ✅  
- Lines 1764, 1786, 1801: Error handlers - SHOULD NOT update (would break retry logic)

### 2. **Duplicate Detection Logic (Lines 1241-1282)**

**Fragility**: Two separate checks that must work in harmony:

#### A. Exact Match Check (Lines 1247-1251)
```javascript
if (partialTextNormalized === lastSentPartialNormalized && timeSinceLastPartial < PARTIAL_DUPLICATE_WINDOW_MS)
```

**Critical**: 
- `lastSentPartialText` MUST be updated at line 1285 BEFORE any early returns
- If code changes add early returns before line 1285, duplicates aren't tracked
- `PARTIAL_DUPLICATE_WINDOW_MS` must be defined (currently missing!)

#### B. Word Overlap Check (Lines 1253-1282)
```javascript
const isNotGrowing = lengthDiff <= 0 && wordCountDiff <= 0;
const isDuplicate = wordOverlapRatio >= 0.95 && Math.abs(lengthDiff) < 5 && isNotGrowing;
```

**Fragility**:
- Requires `lastSentPartialNormalized.length > 10` AND `partialTextNormalized.length > 10`
- Requires `partialWords.length > 2` AND `lastSentWords.length > 2`
- If ANY threshold changes, behavior changes dramatically
- `wordsAreRelated` function must work correctly (external dependency)

### 3. **Missing Variable Declaration**

**Lines 1244-1245**:
```javascript
const lastSentPartialNormalized = lastSentPartialText.trim().replace(/\s+/g, ' ').toLowerCase();
const timeSinceLastPartial = Date.now() - lastSentPartialTime;
```

**Problem**: `lastSentPartialText` and `lastSentPartialTime` are never declared!

**Lines 1285-1286**:
```javascript
lastSentPartialText = partialTextToSend;
lastSentPartialTime = Date.now();
```

**Impact**: 
- First partial will have `lastSentPartialText === undefined`
- `undefined.trim()` throws error OR returns empty string
- Timing calculations break
- Duplicate detection fails silently

### 4. **Reset Logic Missing**

**When FINAL is sent** (lines 656-658):
```javascript
lastSentFinalText = textToProcess;
lastSentFinalTime = Date.now();
```

**MISSING**: `lastSentPartialText` and `lastSentPartialTime` are NEVER reset!

**Impact**: After a FINAL, partial duplicate detection continues comparing against old partials from previous segment.

**Expected reset locations** (all missing):
- After FINAL is committed
- When new segment starts
- When partial tracker is reset (lines 1220, 1541, 2198, 2922)

### 5. **Order-Dependent Execution**

**Critical Sequence** (Lines 1190-1286):
1. **Line 1194**: Deduplicate against FINAL (uses `lastSentFinalText`)
2. **Line 1213**: Update partial tracker
3. **Line 1241**: Check duplicates against `lastSentPartialText` (NOT DECLARED!)
4. **Line 1285**: Update `lastSentPartialText` (creates global variable)
5. **Line 1291**: Send partial

**Fragility**: 
- Any code change that adds early returns between 1194-1285 breaks the flow
- Order matters - deduplication against FINAL must happen BEFORE partial duplicate check
- Variable updates must happen AFTER all checks but BEFORE send

### 6. **Translation Tracking Variables**

**Line 256-257**:
```javascript
let lastPartialTranslation = '';
let lastPartialTranslationTime = 0;
```

**Update Points** (must be correct):
- ✅ Line 1804: Transcription mode
- ✅ Line 1648: Transcription mode immediate
- ✅ Line 1739: Translation success
- ✅ Line 1914-1915: Delayed transcription mode
- ✅ Line 1986-1987: Delayed translation success
- ❌ Lines 1764, 1786, 1801, 2015, 2031: Error handlers update (breaks retry!)

## Why ANY Change Breaks It

1. **Implicit Global Variables**: `lastSentPartialText`/`Time` become globals if not declared
2. **Missing Reset**: After FINAL, old partial tracking persists
3. **Order Dependency**: Checks must happen in exact order
4. **Threshold Sensitivity**: Small threshold changes cause dramatic behavior shifts
5. **Error Handler Updates**: Error handlers updating tracking variables breaks retry logic
6. **Missing Constants**: `PARTIAL_DUPLICATE_WINDOW_MS` is undefined

## Required Fixes (Order Matters!)

### Fix 1: Declare Missing Variables
```javascript
// Line ~320, after lastSentFinalText declaration:
let lastSentPartialText = ''; // Last PARTIAL text sent to client
let lastSentPartialTime = 0; // Timestamp when last PARTIAL was sent
const PARTIAL_DUPLICATE_WINDOW_MS = 2000; // 2 seconds
```

### Fix 2: Reset on FINAL
```javascript
// After line 658 (lastSentFinalTime update):
lastSentPartialText = '';
lastSentPartialTime = 0;
```

### Fix 3: Remove Error Handler Updates
Remove `lastPartialTranslation = ...` from error handlers (lines 1764, 1786, 1801, 2015, 2031)

### Fix 4: Ensure Update Before Early Returns
Verify line 1285-1286 execute before any `return` statements in the partial processing block

## Recommendation

The code works by accident due to JavaScript's permissive nature (undefined variables become globals), but this is extremely fragile. The missing declarations and reset logic make the system break with any structural change.

