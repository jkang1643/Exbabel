---
name: Bible Reference Detection in Core Engine
overview: Implement Bible reference detection as a core engine component shared between solo and host modes. The detection engine uses word/phrase matching, keyword fingerprints, and AI fallback to detect Bible verse references in live transcripts. Outputs only structured verse references (no Scripture text).
todos: []
---

# Bible Reference Detection in Core Engine

## Architecture Decision

**Build in Core Engine** - This ensures:
- ✅ Single source of truth (no duplication between solo/host)
- ✅ Consistent behavior across modes
- ✅ Follows existing core engine pattern (RTT tracker, partial tracker, etc.)
- ✅ Easy to maintain and extend

## 🎯 Objective

Detect when a speaker references a Bible verse during live transcription by:

1. Matching **explicit references**
2. Matching **spoken-number variants**
3. Matching **semantic keyword fingerprints**
4. Using **AI fallback (GPT-4o-mini)** for ambiguous paraphrases

Output **only structured verse references**, never Scripture text.

## 🧱 System Constraints

* Real-time compatible
* False negatives > false positives
* Canonical Scripture must be fetched separately
* Language-aware but English-first MVP
* UI-agnostic output

## 🧩 Architecture Overview

```
Transcript Window
   ↓
Normalization Layer
   ↓
Explicit Reference Detector (Regex)
   ↓
Keyword Fingerprint Matcher
   ↓
Confidence Scoring
   ↓
AI Fallback Matcher (if ambiguous)
   ↓
SCRIPTURE_DETECTED Event
```

## Core Engine Integration

### Phase 1: Core Engine Component

**Files to Create in `core/`:**
- `core/engine/bibleReferenceEngine.js` - Main detection engine (similar to `finalizationEngine.js`)
- `core/services/bibleReferenceDetector.js` - Detection logic (regex, fuzzy matching)
- `core/services/bibleReferenceNormalizer.js` - Reference normalization
- `core/services/bibleVerseFingerprints.js` - Precomputed verse keyword fingerprints
- `core/services/spokenNumberParser.js` - Spoken number parsing
- `core/services/bookNameDetector.js` - Book name detection

**Files to Modify:**
- `core/engine/coreEngine.js` - Add `bibleReferenceEngine` property and methods
- `core/events/eventTypes.js` - Add `SCRIPTURE_DETECTED` event type

**Core Engine Pattern:**
```javascript
// In coreEngine.js
import { BibleReferenceEngine } from './bibleReferenceEngine.js';

constructor(options = {}) {
  // ... existing engines
  this.bibleReferenceEngine = options.bibleReferenceEngine || 
    new BibleReferenceEngine(options.bibleConfig);
}

// Method to detect references in text
async detectReferences(text, options = {}) {
  return this.bibleReferenceEngine.detectReferences(text, options);
}
```

## 🧪 STEP 1 — Transcript Normalization

**Purpose:** Make spoken text matchable

### Tasks

* lowercase text
* strip punctuation
* collapse whitespace
* tokenize words
* lemmatize (basic)
* convert spoken numbers → integers

### Output

```ts
{
  tokens: string[],
  normalizedText: string
}
```

**Implementation:** `core/services/bibleReferenceNormalizer.js`

---

## 🔢 STEP 2 — Spoken Number Parsing

### Supported Inputs

* "two"
* "thirty eight"
* "twenty one"

### Tasks

* map word → integer
* support compound numbers
* preserve position index

### Output

```ts
{
  raw: "thirty eight",
  value: 38,
  indexRange: [12, 14]
}
```

**Implementation:** `core/services/spokenNumberParser.js`

---

## 📖 STEP 3 — Book Name Detection

### Tasks

* Load canonical book alias map
* Detect book names from tokens
* Support ordinals ("first", "second")

### Output

```ts
{
  book: "Acts",
  confidence: 0.4
}
```

**Implementation:** `core/services/bookNameDetector.js`

---

## 🧠 STEP 4 — Explicit Reference Regex Detection (High Confidence)

### Supported Forms

* `Acts 2:38`
* `Acts two thirty eight`
* `Acts chapter two verse thirty eight`
* `In Acts chapter two`

### Tasks

* Regex scan normalized text
* Parse chapter and verse
* Attach confidence

### Output

```ts
{
  book: "Acts",
  chapter: 2,
  verse: 38,
  method: "regex",
  confidence: 0.85
}
```

**Implementation:** `core/services/bibleReferenceDetector.js` (explicit detection method)

---

## 🧬 STEP 5 — Keyword Fingerprint Matching (Core Intelligence)

### Purpose

Match paraphrased or partial verse references using **precomputed verse keywords**

---

### 5.1 Precomputed Verse Fingerprints (Offline Step)

Each verse must have:

```ts
interface VerseFingerprint {
  ref: "Acts 2:38";
  keywords: string[];
  weights: Record<string, number>;
}
```

Example:

```json
{
  "ref": "Acts 2:38",
  "keywords": [
    "repent",
    "baptize",
    "holy spirit",
    "forgiveness",
    "sin"
  ],
  "weights": {
    "repent": 0.9,
    "baptize": 0.8,
    "holy spirit": 1.0
  }
}
```

**Implementation:** `core/services/bibleVerseFingerprints.js`
- Precomputed JSON file: `core/data/verseFingerprints.json`
- MVP scope: Acts, Romans, Psalms, Gospels, Top 500 sermon verses

---

### 5.2 Keyword → Verse Index

```ts
Map<string, string[]> // keyword → verse refs
```

**Implementation:** Build inverted index from fingerprints for fast lookup

---

### 5.3 Live Transcript Keyword Matching

### Tasks

* Slide 8–15 second transcript window
* Match tokens against keyword index
* Count hits per verse
* Apply weights

### Output

```ts
{
  "Acts 2:38": {
    hits: 4,
    weightedScore: 3.4
  }
}
```

**Implementation:** `core/services/bibleReferenceDetector.js` (keyword matching method)

---

## 🎯 STEP 6 — Contextual Confidence Boosts

### Triggers

* "the Bible says"
* "the Scripture says"
* "as it is written"
* "Peter said"

### Tasks

* Detect triggers within ±2 sentences
* Boost candidate confidence

**Implementation:** `core/services/bibleReferenceDetector.js` (context detection)

---

## 📊 STEP 7 — Confidence Scoring Formula

```ts
confidence =
  bookDetected * 0.4 +
  chapterDetected * 0.2 +
  verseDetected * 0.2 +
  keywordMatchScore * 0.15 +
  triggerBoost * 0.05
```

### Thresholds

| Confidence | Action                  |
| ---------- | ----------------------- |
| ≥ 0.85     | Auto-emit verse         |
| 0.70–0.84  | Candidate → AI fallback |
| < 0.70     | Ignore                  |

**Implementation:** `core/engine/bibleReferenceEngine.js` (scoring logic)

---

## 🤖 STEP 8 — AI Fallback (GPT-4o-mini)

### Conditions

* Multiple candidates
* Strong keyword overlap
* No explicit book/chapter

### Input

* Transcript window
* Top 3 candidate verses (refs only)

---

### System Prompt

```
You are a Bible verse matching engine.

Do NOT quote Scripture.
Do NOT invent verses.
Return only confident verse references.
If unsure, respond "UNCERTAIN".
```

---

### User Prompt Template

```
Transcript:
"{TRANSCRIPT}"

Candidate Verses:
- Acts 2:38
- Romans 6:4
- Mark 1:4

Return JSON:
{
  "matches": [
    { "book": "...", "chapter": n, "verse": n, "confidence": 0.x }
  ]
}
```

**Implementation:** `core/services/bibleReferenceDetector.js` (AI fallback method)
- Rate-limited to prevent API abuse
- Only called when confidence is 0.70-0.84

---

## 🛡️ STEP 9 — AI Output Validation

### Tasks

* Validate verse exists
* Validate book/chapter/verse bounds
* Enforce confidence threshold ≥ 0.75
* Reject hallucinations

**Implementation:** `core/services/bibleReferenceDetector.js` (validation layer)

---

## 📤 STEP 10 — Emission Event

### Output Event (UI-Agnostic)

```json
{
  "event": "SCRIPTURE_DETECTED",
  "reference": {
    "book": "Acts",
    "chapter": 2,
    "verse": 38
  },
  "confidence": 0.91,
  "method": "keywords+ai"
}
```

**Implementation:** Emitted by `bibleReferenceEngine.js`, consumed by mode handlers

---

## ⚠️ Hard Rules (Do Not Break)

🚫 Never generate Scripture text
🚫 Never trust AI without validation
🚫 Never overwrite transcript words
🚫 Never emit without confidence ≥ threshold

---

## Phase 2: Mode-Specific Integration

**Files to Modify:**
- `backend/soloModeHandler.js` - Call `coreEngine.detectReferences()` in `processFinalText()`
- `backend/hostModeHandler.js` - Call `coreEngine.detectReferences()` in `processFinalText()`

**Integration Pattern:**
```javascript
// In processFinalText() - both solo and host mode
const processFinalText = async (textToProcess, options = {}) => {
  // ... existing translation logic
  
  // Bible reference detection (non-blocking)
  coreEngine.detectReferences(textToProcess, {
    sourceLang: currentSourceLang,
    targetLang: currentTargetLang,
    seqId: timelineTracker.getCurrentSeqId()
  }).then(references => {
    if (references && references.length > 0) {
      // Mode-specific event emission
      if (isSoloMode) {
        sendWithSequence({
          type: 'scriptureDetected',
          references: references
        });
      } else {
        // Host mode: broadcast to session
        sessionStore.broadcastToSession(sessionId, {
          type: 'scriptureDetected',
          references: references
        });
      }
    }
  }).catch(err => {
    console.error('[BibleReference] Detection error:', err);
    // Fail silently - don't block transcript delivery
  });
  
  // Continue with translation (non-blocking)
  // ...
};
```

## Component Responsibilities

### Core Engine (`bibleReferenceEngine.js`)
- **Detection**: Runs detection strategies (regex, keyword fingerprints, AI fallback)
- **Normalization**: Converts spoken references to canonical format
- **Scoring**: Calculates confidence scores
- **Mode-Agnostic**: No knowledge of WebSockets or sessions

### Mode Handlers (solo/host)
- **Event Emission**: Send `scriptureDetected` events to clients
- **Configuration**: Pass language settings to core engine
- **Error Handling**: Handle detection failures gracefully

## Benefits of Core Engine Approach

1. **Zero Duplication**: Detection logic written once, used by both modes
2. **Consistent Behavior**: Same detection rules apply regardless of mode
3. **Testability**: Can unit test core engine independently
4. **Extensibility**: Easy to add new detection strategies or improve fingerprints
5. **Maintainability**: Single place to fix bugs or improve accuracy

## Configuration Flow

```javascript
// Core engine receives config from mode handler
const bibleConfig = {
  confidenceThreshold: 0.85,
  aiFallbackThreshold: 0.70,
  enableLLMConfirmation: true,
  llmModel: 'gpt-4o-mini',
  transcriptWindowSeconds: 10,
  mvpBooks: ['Acts', 'Romans', 'Psalms', 'Matthew', 'Mark', 'Luke', 'John']
};

// Mode handler passes config when creating core engine
const coreEngine = new CoreEngine({
  bibleConfig: bibleConfig
});
```

## Event Emission Pattern

**Core Engine** emits internal events (for debugging/monitoring):
```javascript
this.emit('referenceDetected', { reference, confidence });
```

**Mode Handlers** emit WebSocket events:
```javascript
// Solo mode
clientWs.send(JSON.stringify({
  type: 'scriptureDetected',
  references: [...]
}));

// Host mode
sessionStore.broadcastToSession(sessionId, {
  type: 'scriptureDetected',
  references: [...]
});
```

## Implementation Order

1. **Create normalization layer** (`bibleReferenceNormalizer.js`, `spokenNumberParser.js`, `bookNameDetector.js`)
2. **Create fingerprint data** (`verseFingerprints.json` for MVP books)
3. **Create detection engine** (`bibleReferenceDetector.js` with all methods)
4. **Create core engine component** (`bibleReferenceEngine.js`)
5. **Add to CoreEngine orchestrator** (wire it up)
6. **Integrate into solo mode** (test with one mode first)
7. **Integrate into host mode** (verify consistency)
8. **Add frontend components** (UI for displaying verses - separate phase)

## MVP Scope Recommendation

Start with:

* Acts
* Romans
* Psalms
* Gospels (Matthew, Mark, Luke, John)
* Top 500 sermon verses

Expand later.

## Key Design Principles

1. **Non-Blocking**: Detection runs async, never delays transcript delivery
2. **Fail-Safe**: Detection errors don't break transcription/translation
3. **Configurable**: Confidence thresholds, AI fallback settings
4. **Extensible**: Easy to add new detection methods or expand fingerprint database
5. **Statistically Aligned**: We're not "detecting Scripture" - we're statistically aligning speech to canonical truth

## 🧠 Final Truth

You are not "detecting Scripture".

You are **statistically aligning speech to canonical truth**.

That's what makes Exbabel different.

