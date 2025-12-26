# CRITICAL FINDING: Why Partials Break on ANY Change

## The Hidden Fragility Pattern

Looking at the **WORKING** logs (lines 9738-9771), I notice:
- **Same partial text sent 4 times**: "Hello, hello. Can you hear me?..." (seq 7, 9, 10, 11)
- **No duplicate detection blocking them**
- **Translations still completing successfully**

## Root Cause Discovery

### What's Actually Happening

**Line 1141-1151**: Partials are sent **IMMEDIATELY** after:
1. Deduplication against FINAL (line 1098) ✅
2. Very short partial check (line 1134) ✅
3. **NO duplicate check against previous PARTIALS** ❌

### Why This "Works" (Fragile Design)

The code sends the same partial multiple times because:
- Each send creates a **new seqId** (line 1143)
- Each send triggers a new translation attempt
- Even identical text needs multiple sends to update translations as they arrive
- Character-by-character updates require frequent sends even when text hasn't changed

### Why ANY Change Breaks It

**If someone notices duplicates and adds duplicate detection:**

```javascript
// This would BREAK the system:
if (partialTextNormalized === lastSentPartialNormalized && timeSinceLastPartial < 2000) {
  return; // Skip - BREAKS translation updates!
}
```

**Why it breaks:**
1. Same partial needs to be sent multiple times to trigger retries
2. Translation updates arrive asynchronously - need multiple sends to update UI
3. Partial text can be identical but still needs to trigger new translation requests

### The Translation Trigger Logic (Line 1779-1781)

```javascript
const shouldTranslateNow = isFirstTranslation ||
                           textGrewSignificantly ||
                           enoughTimePassed;
```

**Fragility:**
- Uses **OR** logic (allows time-based triggers even if text unchanged)
- If changed to **AND**, translations stop when text is identical
- The "exact match" check at line 2140 only works in delayed path, not immediate path

### The "Exact Match" Skip (Line 2140)

Only exists in **delayed translation path**:
```javascript
const isExactMatch = latestText === lastPartialTranslation;
if (isExactMatch) {
  console.log(`[SoloMode] ⏭️ Skipping exact match translation`);
  return;
}
```

**NOT in immediate path** - this is intentional! Immediate path needs to send even if text is identical.

### Why Multiple Sends of Same Text are REQUIRED

1. **Translation arrives asynchronously** - seq 7 sends partial, seq 8-11 update the same partial with translation
2. **Grammar corrections arrive separately** - seq 13, 15, 17 are grammar updates for same text
3. **Retries needed** - if translation fails, same text needs to trigger retry
4. **UI updates** - frontend needs multiple messages to update in-place

## The Critical Fragile Points

### 1. Translation Trigger Uses OR (Not AND)
- **Line 1779-1781**: `shouldTranslateNow = isFirstTranslation || textGrewSignificantly || enoughTimePassed`
- If changed to `&&`, stops working when text is identical
- **Working because**: Allows time-based triggers even if text unchanged

### 2. No Duplicate Partial Detection (Intentional!)
- **Missing by design** - allows same text to trigger multiple translation attempts
- If added, breaks retry mechanism and UI updates
- **Working because**: System relies on multiple sends for updates

### 3. Exact Match Check Only in Delayed Path
- **Line 2140**: Only checks in delayed translation path
- Immediate path (line 1783) has no such check
- **Working because**: Immediate path needs to trigger even if text is identical

### 4. `lastPartialTranslation` Update Timing
- **Only updated on SUCCESS** (line 1739, 1804, etc.)
- **NOT updated on errors** (line 1764, 1786, 1801)
- **Working because**: Allows retries when translation fails

### 5. Missing Variable Declarations
- `lastSentPartialText` and `lastSentPartialTime` never declared
- Creates implicit globals (works by accident)
- If someone adds `'use strict'` or refactors, breaks immediately

## What Would Break Immediately

### Scenario 1: Add Duplicate Detection
```javascript
// Adding this breaks it:
if (partialTextNormalized === lastSentPartialNormalized) {
  return; // Blocks necessary duplicate sends
}
```
**Impact**: Translations stop updating, retries fail, UI freezes

### Scenario 2: Change OR to AND
```javascript
// Changing this breaks it:
const shouldTranslateNow = isFirstTranslation ||
                           (textGrewSignificantly && enoughTimePassed); // AND breaks it
```
**Impact**: Translations only trigger when BOTH conditions met, stopping updates

### Scenario 3: Add Exact Match Check to Immediate Path
```javascript
// Adding this breaks it:
if (transcriptText === lastPartialTranslation) {
  return; // Blocks necessary retries
}
```
**Impact**: Failed translations never retry, updates stop

### Scenario 4: Update `lastPartialTranslation` on Error
```javascript
// Adding this breaks it:
catch (error) {
  lastPartialTranslation = capturedText; // Breaks retry logic
}
```
**Impact**: Failed translations marked as "translated", no retries

## The Pattern: "Duplicates are Required"

The system is **designed** to send duplicates because:
- Multiple async operations (translation, grammar) need separate messages
- Updates arrive at different times and need separate sends
- Retries require re-sending identical text
- Character-by-character feel requires frequent sends

**Any code that tries to "fix duplicates" breaks the system.**

## Recommendation

**DO NOT ADD:**
- Duplicate partial detection against previous partials
- Exact match checks in immediate translation path
- AND logic in translation triggers

**DO:**
- Keep OR logic for translation triggers
- Allow multiple sends of same text
- Only skip in delayed path when text is truly stale

The fragility is by design - duplicates are required for the system to work.

