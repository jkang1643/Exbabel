---
name: Fix message correlation with sourceSeqId
overview: Thread stable correlation key (sourceSeqId) and freeze original text at English partial broadcast, then use frozen original in translation promise handlers. Minimal surgical fix that doesn't touch gating/dedupe/recovery logic.
todos:
  - id: capture-source-seqid-immediate
    content: Capture sourceSeqId and sourceOriginalText after English partial broadcast, before creating translationPromise (immediate path ~line 2628-2728)
    status: completed
  - id: fix-immediate-translation-path
    content: Update immediate translationPromise.then() to use frozen original + sourceSeqId + invariant check (~line 2731-2767)
    status: completed
    dependencies:
      - capture-source-seqid-immediate
  - id: capture-source-seqid-recovery
    content: Capture sourceSeqId and sourceOriginalText after English partial broadcast in recovery gate path (~line 1946-1963)
    status: completed
  - id: fix-recovery-translation-path
    content: Update recovery gate translationPromise.then() to use frozen original + sourceSeqId + invariant check (~line 1982-2018)
    status: completed
    dependencies:
      - capture-source-seqid-recovery
  - id: optional-correlation-logging
    content: Add optional correlation logging in broadcastWithSequence to track sourceSeqId (~line 829)
    status: completed
---

# Fix Message Correlation Bug with sourceSeqId (Minimal Surgical Fix)

## Problem

No stable join key between English "pending translation" partials and Spanish partials/finals. This causes:

- Host UI showing English partials that never get "completed" correctly
- Listener receiving Spanish translations with missing/incorrect `originalText`, producing `Original: ""` + `Translation: "Y grito."` orphan rows

## Solution

**Thread a stable correlation key** + **freeze the original text at the moment you emit the English partial**, then use that frozen original inside the `.then()` handlers. This is a minimal change that doesn't touch gating/dedupe/recovery logic.

## Implementation

### A) Capture sourceSeqId and sourceOriginalText when emitting English partial

**File:** `backend/host/adapter.js`**Location 1:** Immediate translation path (around line 2628-2728)Right after broadcasting English partial to same-language targets, capture the seqId and freeze the original text **before** creating the translationPromise:

```2628:2642:backend/host/adapter.js
for (const targetLang of sameLanguageTargets) {
  const seqId = broadcastWithSequence({
    type: 'translation',
    originalText: rawCapturedText,
    translatedText: capturedText,
    sourceLang: currentSourceLang,
    targetLang: targetLang,
    // ... existing fields ...
  }, true, targetLang);
}

// ✅ Capture sourceSeqId and freeze original text BEFORE creating translationPromise
const sourceSeqId = seqId; // Use the last seqId from same-language broadcast (or capture first one)
const sourceOriginalText = rawCapturedText; // Freeze the exact English you emitted

// Now create translationPromise - sourceSeqId and sourceOriginalText are in scope
const translationPromise = partialWorker.translateToMultipleLanguages(...);
```

**Location 2:** Recovery gate ephemeral path (around line 1946-1963)Apply the same pattern in the recovery gate path where English partial is broadcasted:

```1946:1963:backend/host/adapter.js
for (const targetLang of sameLanguageTargets.length > 0 ? sameLanguageTargets : [currentSourceLang]) {
  const seqId = broadcastWithSequence({
    type: 'translation',
    originalText: partialTextToSend,
    // ... existing fields ...
  }, true, targetLang);
}

// ✅ Capture sourceSeqId and freeze original text
const sourceSeqId = seqId;
const sourceOriginalText = partialTextToSend; // Freeze the exact English you emitted
```



### B) Use frozen original + sourceSeqId in translationPromise.then()

**File:** `backend/host/adapter.js`**Location 1:** Immediate translation path (around line 2731-2767)Replace the Spanish broadcast block with the pattern that enforces the invariant:

```2731:2767:backend/host/adapter.js
translationPromise.then(translations => {
  if (!translations || Object.keys(translations).length === 0) {
    console.warn(`[HostMode] ⚠️ Translation returned empty for ${capturedText.length} char text`);
    return;
  }

  lastPartialTranslation = capturedText;

  console.log(`[HostMode] ✅ TRANSLATION (IMMEDIATE): Translated to ${Object.keys(translations).length} language(s)`);

  for (const targetLang of translationTargets) {
    const translatedText = translations[targetLang];

    const isSameAsOriginal =
      translatedText === translationReadyText ||
      translatedText.trim() === translationReadyText.trim() ||
      translatedText.toLowerCase() === translationReadyText.toLowerCase();

    if (isSameAsOriginal) {
      console.warn(`[HostMode] ⚠️ Translation matches original (English leak detected) for ${targetLang}: "${translatedText.substring(0, 60)}..."`);
      continue;
    }

    // ✅ HARD INVARIANT: never send translation with blank original
    const safeOriginal =
      (rawCapturedText && rawCapturedText.trim()) ||
      (sourceOriginalText && sourceOriginalText.trim()) ||
      (translationReadyText && translationReadyText.trim()) ||
      '';

    if (!safeOriginal) {
      console.warn(`[HostMode] 🚫 Dropping translation partial (blank originalText)`, {
        sourceSeqId,
        targetLang,
        translatedPreview: (translatedText || '').slice(0, 80),
      });
      continue;
    }

    broadcastWithSequence({
      type: 'translation',
      sourceSeqId,              // ✅ correlation key
      originalText: safeOriginal,
      translatedText,
      sourceLang: currentSourceLang,
      targetLang,
      timestamp: Date.now(),
      isTranscriptionOnly: false,
      hasTranslation: true,
      hasCorrection: false,
      isPartial: true
    }, true, targetLang);
  }
}).catch(err => {
  console.error('[HostMode] ❌ Partial translation promise error:', err?.message || err);
});
```

**Location 2:** Recovery gate ephemeral path (around line 1982-2018)Apply the exact same pattern in the recovery gate translation broadcast:

```1982:2018:backend/host/adapter.js
partialWorker.translateToMultipleLanguages(...)
  .then(translations => {
    if (!translations || Object.keys(translations).length === 0) {
      console.warn(`[RecoveryGate] ⚠️ Translation returned empty for ephemeral partial`);
      return;
    }
    
    console.log(`[RecoveryGate] ✅ TRANSLATION (EPHEMERAL): Translated to ${Object.keys(translations).length} language(s)`);
    
    for (const targetLang of translationTargets) {
      const translatedText = translations[targetLang];
      const isSameAsOriginal = translatedText === translationSeedText || 
                               translatedText.trim() === translationSeedText.trim() ||
                               translatedText.toLowerCase() === translationSeedText.toLowerCase();
      
      if (isSameAsOriginal) {
        console.warn(`[RecoveryGate] ⚠️ Translation matches original (English leak) for ${targetLang}`);
        continue;
      }
      
      // ✅ HARD INVARIANT: never send translation with blank original
      const safeOriginal =
        (partialTextToSend && partialTextToSend.trim()) ||
        (sourceOriginalText && sourceOriginalText.trim()) ||
        (translationSeedText && translationSeedText.trim()) ||
        '';
      
      if (!safeOriginal) {
        console.warn(`[RecoveryGate] 🚫 Dropping translation partial (blank originalText)`, {
          sourceSeqId,
          targetLang,
          translatedPreview: (translatedText || '').slice(0, 80),
        });
        continue;
      }
      
      broadcastWithSequence({
        type: 'translation',
        sourceSeqId,              // ✅ correlation key
        originalText: safeOriginal,
        translatedText: translatedText,
        sourceLang: currentSourceLang,
        targetLang: targetLang,
        timestamp: Date.now(),
        isTranscriptionOnly: false,
        hasTranslation: true,
        hasCorrection: false,
        isPartial: true,
        ephemeral: true,
        suppressHistory: true,
        recoveryEpoch: currentRecoveryEpoch,
        pipeline: 'normal',
        recoveryInProgress: true
      }, true, targetLang);
    }
  }).catch(error => {
    if (error.name !== 'AbortError') {
      console.error(`[RecoveryGate] ❌ Translation error for ephemeral partial:`, error.message);
    }
  });
```



### C) Optional correlation logging

**File:** `backend/host/adapter.js`**Location:** `broadcastWithSequence` function (around line 829)Add optional logging to track correlation:

```829:backend/host/adapter.js
console.log(`[HostMode] 📤 Sent to host (${isPartial ? 'PARTIAL' : 'FINAL'}, seqId: ${seqId}, targetLang: ${messageData.targetLang || 'N/A'})`);

// Optional correlation logging
if (messageData?.sourceSeqId !== undefined) {
  console.log(`[HostMode] 🔗 Correlate: seqId=${seqId} sourceSeqId=${messageData.sourceSeqId} target=${messageData.targetLang}`);
}
```



## Key Points

1. **Capture BEFORE promise:** Store `sourceSeqId` and `sourceOriginalText` right after English broadcast, before creating `translationPromise` - ensures they're in scope for `.then()`
2. **Frozen original:** Use `sourceOriginalText` as the "ground truth" - the exact English text that was emitted
3. **Invariant enforcement:** Never emit translations with blank `originalText` - drop with warning instead
4. **Both paths:** Apply same pattern to immediate path AND recovery gate ephemeral path
5. **No gating changes:** This fix doesn't touch recovery gates, deduplication, forced-final buffers, quarantine, or any other complex logic

## Why This Fixes the Bug

- **Before:** Spanish partials could arrive with blank/incorrect `originalText` because variables like `rawCapturedText` could be stale or overwritten