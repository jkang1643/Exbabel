# Bible Verse Recognition Feature - Current Status & Plan

## 📊 Overall Progress: ~70% Complete

The Bible verse recognition feature has **detection and event emission fully implemented** in the core engine with backend integration complete. All tests passing (19/19). AI-based matching replaces keyword fingerprints. **Bible API integration and Frontend UI remain missing components.**

---

## 🏗️ **ARCHITECTURAL PLAN** (Future-Proof, UI-Agnostic Design)

### High-Level Architecture

**Goal:** Detect spoken Bible references → resolve them → fetch canonical verse text → expose via a generic event API that *any UI* can consume.

```
Audio → STT → NLP Reference Detector
                  ↓
          Bible Reference Resolver
                  ↓
            Bible API Fetcher
                  ↓
        Verse Event Stream (JSON)
                  ↓
          Frontend UI Renderer
```

**Key Principle:**
> **The backend emits semantic events, not UI decisions**

### Architecture Components

#### 1. Reference Detection (Post-STT) ✅ **COMPLETE** (Final Transcripts Only)
- **A. Explicit Citation Regex** (High Confidence) ✅
- **B. Fuzzy Reference Matching** (Medium Confidence) ✅  
- **C. LLM Confirmation** (Optional, Low Frequency) ✅
- **Current Limitation:** Only runs on final transcripts (waits for complete sentences)
- **Enhancement Needed:** Real-time detection on partial/streaming transcripts ⚠️

#### 2. Reference Normalization Layer ✅ **COMPLETE**
- Input variants → Canonical format
- Spoken numbers → Numeric format
- Book name aliases → Canonical names

#### 3. Bible API Fetcher ❌ **NOT IMPLEMENTED**
- **Status:** Missing
- **Recommended API:** bible-api.com (free, no auth, multiple translations)
- **Alternative:** API.Bible (requires key, strong language support)
- **Needs:** Service to fetch verse text in requested language
- **Needs:** Caching strategy (24-72 hour TTL)

#### 4. Event-Based Backend → Frontend Contract ✅ **PARTIALLY COMPLETE**
- ✅ Emits `SCRIPTURE_DETECTED` events with reference structure
- ❌ Does NOT include verse text (only reference)
- ❌ Frontend must fetch verse text separately (or backend should fetch)

#### 5. Real-Time Detection on Partial Transcripts ❌ **NOT IMPLEMENTED** 🔴 **HIGH PRIORITY**
- **Status:** Not started
- **Goal:** Detect verses immediately as speaker talks, not waiting for final transcripts
- **Current Behavior:** Detection only runs on final transcripts (complete sentences)
- **Target Behavior:** Detection runs on partial/streaming transcripts for immediate results
- **Technical Challenges:**
  - Handle incomplete references (e.g., "Acts 2" before "Acts 2:38" is complete)
  - Deduplicate detections as transcript extends
  - Performance optimization (can't call AI too frequently)
  - Transcript windowing for context
  - Confidence scoring for partial matches
- **Approach:**
  - Use existing transcript windowing system
  - Debounce/throttle AI calls (e.g., every 2-3 seconds or on trigger phrases)
  - Incremental detection (update confidence as more context arrives)
  - Track detected references to prevent duplicates
  - Emit "provisional" detections with lower confidence, then "confirmed" when complete

#### 6. Frontend UI Components ❌ **NOT IMPLEMENTED**
- **Status:** Not started
- **Design:** UI-agnostic, transferable
- **Options:**
  - Inline transcript markers
  - Overlay scripture panel
  - Side panel
  - Floating window
- **Data Store:** Scripture state management needed

---

## 📍 **CURRENT POSITION IN ARCHITECTURE**

### ✅ **COMPLETED** (Steps 1-2, Partial Step 4)

1. ✅ **Reference Detection Engine** - Fully working
   - Explicit regex detection
   - AI-based matching (GPT-4o-mini)
   - Chapter-only reference handling
   - Contextual trigger filtering
   - Confidence scoring

2. ✅ **Reference Normalization** - Fully working
   - Spoken number parsing
   - Book name detection
   - Text normalization

3. ✅ **Event Emission** - Partially working
   - Emits `SCRIPTURE_DETECTED` events
   - Includes reference structure (book, chapter, verse)
   - Includes confidence, method, timestamp
   - **Missing:** Verse text in event

### ❌ **NOT IMPLEMENTED** (Steps 3, 5, 6)

3. ❌ **Bible API Fetcher Service** - Not started
   - No API integration
   - No verse text fetching
   - No caching layer
   - No language-specific translation fetching

4. ❌ **Real-Time Detection on Partial Transcripts** - Not started
   - Currently only runs on final transcripts
   - No detection on partial/streaming transcripts
   - No immediate detection as speaker talks
   - No deduplication logic for extending transcripts
   - No debouncing/throttling for AI calls

5. ❌ **Frontend UI** - Not started
   - No React components
   - No WebSocket message handlers
   - No scripture display
   - No user interaction

---

## 🎯 **IMPLEMENTATION PRIORITY** (Based on New Architecture)

### **Phase 1: Bible API Integration** (HIGH PRIORITY)
**Goal:** Fetch canonical verse text after detection

**Tasks:**
1. Create `core/services/bibleApiFetcher.js`
   - Integrate bible-api.com (or API.Bible)
   - Handle language/translation selection
   - Implement caching (24-72 hour TTL)
   - Error handling and fallbacks

2. Update backend handlers
   - After detection, fetch verse text
   - Include verse text in `SCRIPTURE_DETECTED` event
   - Handle API failures gracefully

3. Update event structure
   ```json
   {
     "type": "scriptureDetected",
     "reference": { "book": "Acts", "chapter": 2, "verse": 38 },
     "displayText": "Acts 2:38",
     "verseText": "Peter said to them, 'Repent...'",
     "language": "en",
     "translation": "WEB",
     "confidence": 0.93,
     "method": "regex"
   }
   ```

**Estimated Time:** 4-6 hours

---

### **Phase 2: Frontend UI** (HIGH PRIORITY)
**Goal:** Display detected verses with canonical text

**Tasks:**
1. Create `ScriptureDisplay.jsx` component
   - Display verse reference + text
   - Label as "Canonical Scripture Text"
   - Show confidence threshold (only if ≥0.85)
   - Hover tooltip / click overlay

2. Integrate into translation interface
   - Add to `TranslationDisplay.jsx` or separate section
   - Handle `scriptureDetected` WebSocket messages
   - Real-time display as detected

3. Create scripture state store
   - Manage multiple verses
   - Easy switching between verses
   - No tight UI coupling

**Estimated Time:** 6-8 hours

---

### **Phase 3: Edge Cases & Enhancements** (MEDIUM PRIORITY)
**Tasks:**
1. Verse range detection (e.g., "Acts 2:38-40")
2. Multiple reference detection in single transcript
3. Book abbreviation handling (e.g., "1 Cor" → "1 Corinthians")
4. Cross-reference detection
5. Parallel translations view
6. Original Greek/Hebrew toggle

**Estimated Time:** 10-15 hours

---

## ✅ **COMPLETED COMPONENTS**

### 1. Core Services (100% Complete)
All detection services are implemented in `core/services/`:

- ✅ **`spokenNumberParser.js`** - Parses spoken numbers ("thirty eight" → 38)
- ✅ **`bookNameDetector.js`** - Detects Bible book names with aliases
- ✅ **`bibleReferenceNormalizer.js`** - Normalizes transcript text
- ✅ **`bibleVerseFingerprints.js`** - Manages verse keyword fingerprints
- ✅ **`bibleReferenceDetector.js`** - Main detection engine (regex + AI-based matching)

### 2. Core Engine Integration (100% Complete)
- ✅ **`core/engine/bibleReferenceEngine.js`** - Main orchestrator (mode-agnostic)
- ✅ **`core/engine/coreEngine.js`** - Integrated Bible reference engine
- ✅ **`core/events/eventTypes.js`** - Added `SCRIPTURE_DETECTED` event type

### 3. Backend Integration (100% Complete)
- ✅ **`backend/soloModeHandler.js`** - Integrated detection with event emission
- ✅ **`backend/hostModeHandler.js`** - Integrated detection with broadcast to listeners
- ✅ Non-blocking architecture (detection runs async, never delays transcripts)
- ✅ Error handling (fails silently, doesn't break transcription/translation)

### 4. Detection Features (100% Complete)
- ✅ **Explicit Reference Detection** (High Confidence ≥0.85)
  - Detects: "Acts 2:38", "Acts chapter two verse thirty eight"
  - Uses regex patterns with spoken number parsing
  
- ✅ **Chapter-Only Reference Detection** (Regex + AI)
  - Detects: "Acts 2" (chapter without verse)
  - Regex detects chapter (confidence 0.75)
  - AI matches to specific verse based on context
  - Example: "In Acts 2, Peter said to repent" → Acts 2:38
  
- ✅ **AI-Based Verse Matching** (Primary Method for Non-Explicit)
  - Uses GPT-4o-mini for paraphrased references
  - Handles heavy context and theological themes
  - Example: "repent and be baptized" → Acts 2:38
  - No rate limiting (Bible detection is infrequent)
  - Validates all AI output
  
- ✅ **Contextual Confidence Boosts**
  - Detects triggers like "the Bible says", "as it is written"
  - Boosts candidate confidence by 0.05

### 5. Testing Infrastructure (100% Complete)
- ✅ **`backend/test-bible-full.js`** - Comprehensive test suite with detailed output
- ✅ **`backend/test-bible-components.js`** - Component tests
- ✅ **`backend/test-ai-detection.js`** - AI-specific tests
- ✅ All tests passing (19/19) - includes AI tests with API key from .env

---

## ⚠️ **INCOMPLETE / MISSING COMPONENTS**

### 1. Bible API Fetcher Service (0% Complete) 🔴 **CRITICAL MISSING**
**Status:** Not started

**Missing:**
- No Bible API integration (bible-api.com or API.Bible)
- No verse text fetching after detection
- No caching layer for verse text
- No language/translation selection
- Verse text not included in events (only reference structure)

**Files to Create:**
- `core/services/bibleApiFetcher.js` - Service to fetch verse text from Bible API
- Update `backend/soloModeHandler.js` - Fetch verse after detection
- Update `backend/hostModeHandler.js` - Fetch verse after detection
- Update event structure to include verse text

**Priority:** HIGH (core feature - canonical text must come from API, not STT)

---

### 2. Real-Time Detection on Partial Transcripts (0% Complete) 🔴 **HIGH PRIORITY**
**Status:** Not started

**Current Limitation:**
- Detection only runs on **final transcripts** (complete sentences)
- Users must wait for sentence completion before verse detection
- No immediate feedback as speaker talks

**Goal:**
- Detect verses **immediately** as speaker talks (on partial/streaming transcripts)
- Provide instant feedback when verse is detected
- Update confidence as more context arrives

**Technical Requirements:**

1. **Partial Transcript Processing**
   - Run detection on `partial` events (not just `final`)
   - Handle incomplete references (e.g., "Acts 2" before verse number)
   - Use transcript windowing for context (already implemented)

2. **Deduplication Logic**
   - Track detected references to prevent duplicates
   - As transcript extends, update existing detections rather than creating new ones
   - Example: "Acts 2" → "Acts 2:38" should update, not duplicate

3. **Performance Optimization**
   - Debounce/throttle AI calls (e.g., every 2-3 seconds or on trigger phrases)
   - Skip AI calls if no new trigger phrases detected
   - Cache recent detections to avoid re-processing

4. **Confidence Scoring for Partial Matches**
   - Lower confidence for incomplete references (e.g., "Acts 2" = 0.60)
   - Increase confidence as more context arrives (e.g., "Acts 2:38" = 0.90)
   - Emit "provisional" detections (confidence 0.60-0.84), then "confirmed" (≥0.85)

5. **Event Emission Strategy**
   - Emit `scriptureDetected` events immediately when detected (even if provisional)
   - Include `isProvisional: true` flag for partial matches
   - Update event when reference becomes complete
   - Frontend can show provisional indicators (e.g., grayed out, "detecting...")

**Files to Modify:**
- `core/services/bibleReferenceDetector.js` - Add partial transcript detection
- `core/engine/bibleReferenceEngine.js` - Handle partial events
- `backend/soloModeHandler.js` - Call detection on partial events
- `backend/hostModeHandler.js` - Call detection on partial events
- Add deduplication tracking system

**Priority:** HIGH (significantly improves UX - immediate feedback vs waiting for final)

---

### 3. Frontend UI Components (0% Complete) 🔴 **CRITICAL MISSING**
**Status:** Not started

**Missing:**
- No React components to display detected scripture references
- No UI to show verse references + canonical text in translation interface
- No visual indicators when scripture is detected
- No way for users to interact with detected references
- No scripture state management

**Files to Create:**
- `frontend/src/components/ScriptureDisplay.jsx` - Component to show detected verses
- Integration into `TranslationDisplay.jsx` or `TranslationInterface.jsx`
- WebSocket message handler for `scriptureDetected` events
- Scripture state store (UI-agnostic)

**Priority:** HIGH (feature is non-functional without UI)

---

### 4. Verse Fingerprint Database (Deprecated)
**Status:** No longer needed - replaced with AI-based matching

**Note:** The fingerprint system is deprecated. AI-based matching works for any verse without requiring pre-indexed keywords. The `verseFingerprints.json` file still exists for backward compatibility but is no longer used in production.

**Benefits of AI Approach:**
- Works for any verse (not just pre-indexed ones)
- No manual maintenance required
- Better context understanding
- Handles edge cases automatically

**Priority:** N/A (replaced by AI matching)

---

### 5. Real-World Testing & Tuning (Unknown)
**Status:** Needs verification

**Missing:**
- Real sermon transcript testing
- Confidence threshold tuning based on real data
- False positive/negative rate analysis
- Performance optimization for large fingerprint database
- Multi-language testing (currently English-first)

**Priority:** MEDIUM (important for production readiness)

---

### 6. AI Matching Verification (✅ Complete)
**Status:** Fully tested and working

**Verified:**
- ✅ OpenAI API integration working correctly
- ✅ AI output validation robust (confidence thresholds, sanity checks)
- ✅ Costs acceptable (~$0.0001-0.0003 per detection)
- ✅ No rate limiting needed (Bible detection is infrequent)
- ✅ All AI tests passing (4/4)

---

## 📋 **IMPLEMENTATION PLAN** (Updated for New Architecture)

### Phase 1: Real-Time Detection on Partial Transcripts (HIGH PRIORITY) 🔴 **NEXT STEP**
**Goal:** Detect verses immediately as speaker talks, not waiting for final transcripts

**Tasks:**
1. **Enable Detection on Partial Events**
   - Modify `backend/soloModeHandler.js` to call `detectReferences()` on `partial` events
   - Modify `backend/hostModeHandler.js` to call `detectReferences()` on `partial` events
   - Ensure non-blocking (doesn't delay transcript delivery)

2. **Implement Deduplication System**
   - Track recently detected references (last 10-15 seconds)
   - Compare new detections against recent ones
   - Update existing detection if reference extends (e.g., "Acts 2" → "Acts 2:38")
   - Prevent duplicate events for same reference

3. **Add Debouncing/Throttling for AI Calls**
   - Throttle AI calls to max once per 2-3 seconds
   - Skip AI call if no new trigger phrases detected since last call
   - Use existing transcript windowing for context

4. **Implement Provisional Detection**
   - Detect incomplete references (e.g., "Acts 2" without verse)
   - Assign lower confidence (0.60-0.75) for partial matches
   - Emit `scriptureDetected` event with `isProvisional: true`
   - Update to confirmed when complete (confidence ≥0.85)

5. **Update Event Structure**
   ```json
   {
     "type": "scriptureDetected",
     "reference": { "book": "Acts", "chapter": 2, "verse": 38 },
     "displayText": "Acts 2:38",
     "confidence": 0.90,
     "isProvisional": false,
     "method": "regex",
     "timestamp": 1234567890
   }
   ```

**Technical Considerations:**
- Use existing `transcriptWindowSeconds` (10 seconds) for context
- Track detection history in `bibleReferenceEngine.js`
- Compare references by canonical format (book+chapter+verse)
- Update confidence incrementally as more context arrives

**Estimated Time:** 6-8 hours

**Why This First:** Significantly improves UX - users get immediate feedback instead of waiting for sentence completion.

---

### Phase 2: Bible API Integration (HIGH PRIORITY)
**Goal:** Fetch canonical verse text after detection (respects immutability of Scripture)

**Tasks:**
1. Create `core/services/bibleApiFetcher.js`
   - Integrate bible-api.com (free, no auth) or API.Bible
   - Handle language/translation selection
   - Implement caching (24-72 hour TTL, key: `book-chapter-verse-lang-translation`)
   - Error handling and fallbacks

2. Update backend handlers (`soloModeHandler.js`, `hostModeHandler.js`)
   - After detection, fetch verse text from API
   - Include verse text in `SCRIPTURE_DETECTED` event
   - Handle API failures gracefully (emit reference without text)

3. Update event structure to include verse text:
   ```json
   {
     "type": "scriptureDetected",
     "reference": { "book": "Acts", "chapter": 2, "verse": 38 },
     "displayText": "Acts 2:38",
     "verseText": "Peter said to them, 'Repent...'",
     "language": "en",
     "translation": "WEB",
     "confidence": 0.93,
     "method": "regex"
   }
   ```

**Estimated Time:** 4-6 hours

**Why This First:** Core theological principle - Scripture text must come from canonical source, not STT/translation.

---

### Phase 3: Frontend UI (HIGH PRIORITY)
**Goal:** Display detected verses with canonical text (UI-agnostic, transferable design)

**Tasks:**
1. Create `ScriptureDisplay.jsx` component
   - Display verse reference + canonical text
   - Label as "Canonical Scripture Text" (theological accuracy)
   - Show only if confidence ≥ 0.85 (UX safeguard)
   - Hover tooltip (desktop) / click overlay (mobile & desktop)
   - Never overwrite transcript text

2. Integrate into translation interface
   - Add to `TranslationDisplay.jsx` or create separate section
   - Handle `scriptureDetected` WebSocket messages
   - Display references in real-time as they're detected
   - Support both solo and host modes

3. Create scripture state store (UI-agnostic)
   ```typescript
   interface ScriptureState {
     verses: Record<string, BibleVerse>;
     activeVerseId?: string;
   }
   ```
   - Manage multiple verses
   - Easy switching between verses
   - No tight UI coupling (can replace with side panel, floating window, etc.)

**Estimated Time:** 6-8 hours

**Design Principles:**
- UI-agnostic (backend emits semantic events, not UI decisions)
- Transferable (can replace overlay with side panel, second monitor, AR overlay)
- Non-intrusive (inline markers, hover/click to expand)

---

### Phase 4: Expand Edge Case Handling (MEDIUM PRIORITY)
**Goal:** Handle more detection edge cases

**Tasks:**
1. ✅ Chapter-only references (e.g., "Acts 2" → AI matches verse) - **COMPLETE**
2. Add verse range detection (e.g., "Acts 2:38-40")
3. Add multiple reference detection in single transcript
4. Add book abbreviation handling (e.g., "1 Cor" → "1 Corinthians")
5. Add cross-reference detection (e.g., "see also Romans 6:23")

**Estimated Time:** 10-15 hours

---

### Phase 5: Testing & Tuning (MEDIUM PRIORITY)
**Goal:** Ensure production-ready quality

**Tasks:**
1. Collect real sermon transcripts
2. Test detection accuracy
3. Tune confidence thresholds
4. Measure false positive/negative rates
5. Optimize performance
6. Test with multiple languages
7. Test Bible API integration and caching

**Estimated Time:** 10-15 hours

---

### Phase 6: Future Enhancements (LOW PRIORITY)
**Goal:** Advanced features for power users

**Tasks:**
1. Verse auto-sync to sermon timeline
2. Parallel translations view
3. Original Greek/Hebrew toggle
4. Offline cached Bibles
5. Highlight when preacher paraphrases vs quotes

**Estimated Time:** 15-20 hours

---

## 🎯 **RECOMMENDED NEXT STEPS** (Based on New Architecture)

1. **IMMEDIATE:** Implement Real-Time Detection on Partial Transcripts (Phase 1)
   - **Critical UX Improvement:** Immediate feedback as speaker talks
   - Detect verses on partial/streaming transcripts (not just finals)
   - Implement deduplication and provisional detection
   - Significantly improves user experience

2. **SHORT TERM:** Implement Bible API Fetcher (Phase 2)
   - **Critical:** Respects theological principle - Scripture must come from canonical source
   - Fetches verse text after detection
   - Includes verse text in events
   - Enables frontend to display canonical text (not STT/translation)

3. **SHORT TERM:** Build Frontend UI (Phase 3)
   - Display detected verses with canonical text
   - Show provisional indicators for partial matches
   - UI-agnostic design (transferable to different layouts)
   - Non-intrusive (inline markers, hover/click to expand)
   - Validates the full pipeline end-to-end

4. **MEDIUM TERM:** Expand Edge Cases (Phase 4)
   - Verse ranges, multiple references, abbreviations
   - Improves detection coverage

5. **LONG TERM:** Testing & Enhancements (Phases 5-6)
   - Real-world testing and tuning
   - Advanced features (parallel translations, Greek/Hebrew, etc.)

---

## 📁 **KEY FILES REFERENCE**

### Core Engine Files
- `core/engine/bibleReferenceEngine.js` - Main orchestrator
- `core/services/bibleReferenceDetector.js` - Detection logic
- `core/services/bibleReferenceNormalizer.js` - Text normalization
- `core/services/bibleVerseFingerprints.js` - Fingerprint management
- `core/services/bookNameDetector.js` - Book name detection
- `core/services/spokenNumberParser.js` - Number parsing
- `core/data/verseFingerprints.json` - Verse data (needs expansion)

### Backend Integration
- `backend/soloModeHandler.js` - Lines 606-633
- `backend/hostModeHandler.js` - Lines 644-673
- `core/engine/coreEngine.js` - Lines 56-58, 321-323

### Frontend (TO BE CREATED)
- `frontend/src/components/ScriptureDisplay.jsx` - **MISSING**
- Integration into `TranslationDisplay.jsx` - **MISSING**

### Testing
- `backend/test-bible-full.js` - Comprehensive tests
- `backend/test-bible-components.js` - Component tests

### Documentation
- `.cursor/plans/bible_reference_detection_in_core_engine_fb578e02.plan.md` - Original plan
- `BIBLE_REFERENCE_TEST_RESULTS.md` - Test results

---

## 💡 **WHY THIS ARCHITECTURE IS POWERFUL FOR EXBABEL**

### Technical Benefits
- ✅ **Zero STT trust for Scripture** - Canonical text always from Bible API
- ✅ **Language-independent truth source** - Works with any translation
- ✅ **Works with imperfect audio** - Detection doesn't require perfect transcription
- ✅ **UI-agnostic design** - Backend emits semantic events, frontend can be replaced
- ✅ **Transferable** - Can adapt to different UI patterns (overlay, side panel, AR, etc.)

### Product Differentiation
- 🎯 **No captioning competitor does this** - Unique feature for Exbabel
- 🎯 **Extremely strong for:**
  - Churches and religious organizations
  - Missionary work (multilingual sermons)
  - Multilingual sermons
  - Deaf/HoH worship (canonical text display)

### Theological Benefits
- ✝️ **Respects immutability of Scripture** - Never re-translates live speech as Scripture
- ✝️ **Canonical truth source** - Always uses authoritative Bible text
- ✝️ **Prevents theological errors** - STT mistakes don't become "Scripture"

---

## 🔍 **TECHNICAL DETAILS**

### Detection Pipeline

#### Current Pipeline (Final Transcripts Only)
```
Final Transcript Text
   ↓
Normalization (lowercase, tokenize, parse numbers)
   ↓
Explicit Reference Detection (regex)
   ├─ Complete Reference (book + chapter + verse) → High Confidence (≥0.85) → Return
   └─ Chapter-Only Reference (book + chapter, no verse) → Confidence 0.75
      ↓
      AI Verse Matching for Chapter (GPT-4o-mini) → Matches to specific verse
      ↓
      Contextual Confidence Boosts (+0.05 if triggers found)
      ↓
      Filter by Threshold (≥0.85 for auto-emit) → Return
   ↓ (if no explicit match)
AI Verse Matching (GPT-4o-mini) → Medium-High Confidence (≥0.75)
   ↓
Contextual Confidence Boosts (+0.05 if triggers found)
   ↓
Filter by Threshold (≥0.85 for auto-emit)
   ↓
SCRIPTURE_DETECTED Event
```

#### Target Pipeline (Real-Time on Partial Transcripts) ⚠️ **TO BE IMPLEMENTED**
```
Partial/Streaming Transcript Text
   ↓
Add to Transcript Window (10 second context)
   ↓
Check for Recent Detections (deduplication)
   ↓
Normalization (lowercase, tokenize, parse numbers)
   ↓
Explicit Reference Detection (regex)
   ├─ Complete Reference → High Confidence (≥0.85) → Emit Confirmed Event
   ├─ Partial Reference (e.g., "Acts 2") → Lower Confidence (0.60-0.75) → Emit Provisional Event
   └─ Chapter-Only Reference → Confidence 0.75 → Check if extends existing detection
      ↓
      AI Verse Matching for Chapter (GPT-4o-mini) [Throttled: max once per 2-3s]
      ↓
      Contextual Confidence Boosts (+0.05 if triggers found)
      ↓
      Update Existing Detection OR Emit New Event
   ↓ (if no explicit match)
AI Verse Matching (GPT-4o-mini) [Throttled: max once per 2-3s]
   ↓
Contextual Confidence Boosts (+0.05 if triggers found)
   ↓
Check if extends existing detection OR emit new event
   ↓
SCRIPTURE_DETECTED Event (with isProvisional flag)
   ↓
[As transcript extends, update confidence and isProvisional status]
```

### Confidence Thresholds
- **≥ 0.85:** Auto-emit verse (high confidence)
- **0.75-0.84:** AI matching results (medium-high confidence)
- **< 0.75:** Ignore (low confidence, filtered out)

### Detection Methods
- **`regex`**: Explicit reference with complete verse (e.g., "Acts 2:38")
- **`regex+ai`**: Chapter-only detected via regex, verse matched via AI (e.g., "Acts 2" → "Acts 2:38")
- **`ai`**: Full AI matching for paraphrased references

### Current Event Structure (Missing Verse Text)
```json
{
  "type": "scriptureDetected",
  "reference": {
    "book": "Acts",
    "chapter": 2,
    "verse": 38
  },
  "displayText": "Acts 2:38",
  "confidence": 0.90,
  "method": "regex",
  "timestamp": 1234567890,
  "seqId": 42
}
```

### Target Event Structure (After Bible API Integration)
```json
{
  "type": "scriptureDetected",
  "reference": {
    "book": "Acts",
    "chapter": 2,
    "verse": 38
  },
  "displayText": "Acts 2:38",
  "verseText": "Peter said to them, 'Repent, and be baptized, every one of you, in the name of Jesus Christ for the forgiveness of your sins, and you will receive the gift of the Holy Spirit.'",
  "language": "en",
  "translation": "WEB",
  "confidence": 0.90,
  "method": "regex",
  "timestamp": 1234567890,
  "seqId": 42
}
```

---

## ✅ **SUMMARY**

**What Works:**
- ✅ Complete backend detection pipeline (final transcripts only)
- ✅ Core engine integration
- ✅ Both solo and host mode support
- ✅ All detection strategies (regex, AI-based matching)
- ✅ Chapter-only reference detection with AI verse matching
- ✅ Contextual trigger filtering (reduces API calls)
- ✅ Non-blocking architecture
- ✅ Comprehensive test suite (19/19 tests passing)
- ✅ AI matching verified and working
- ✅ Event emission with reference structure
- ✅ Transcript windowing system (ready for real-time detection)

**What's Missing:**
- ❌ **Real-Time Detection on Partial Transcripts** - Only runs on final transcripts (critical UX gap)
- ❌ **Bible API Fetcher** - No canonical verse text fetching (critical)
- ❌ **Frontend UI** - No display components (critical)
- ❌ Deduplication logic for extending transcripts
- ❌ Provisional detection system (partial matches)
- ❌ Verse text in events (only reference structure currently)
- ❌ Additional edge cases (verse ranges, multiple references, etc.)

**Next Priority:**
1. **Implement Real-Time Detection on Partial Transcripts** - Detect immediately as speaker talks (significantly improves UX)
2. **Implement Bible API Fetcher** - Fetch canonical verse text after detection (respects theological principle)
3. **Build Frontend UI** - Display detected verses with canonical text (including provisional indicators)

**Why This Order:**
The Bible API integration is foundational - it ensures Scripture text comes from a canonical source (not STT/translation), which is the core theological principle of this feature. The frontend can then display this canonical text, making the feature complete and accurate.

