# AI-Based Verse Matching Implementation

## Overview

Replaced keyword fingerprint matching (JSON-based) with AI-based verse matching using GPT-4o-mini. The system now uses a **hybrid approach**:

1. **Fast regex detection** for explicit references (e.g., "Acts 2:38")
2. **AI-based matching** for paraphrased/heavy context references
3. **Chapter-only reference matching** - When speaker says "Acts 2" (no verse), AI matches to specific verse based on context

## Architecture

### Detection Flow

```
Transcript Text
   ↓
Normalize (lowercase, tokenize, parse numbers)
   ↓
Explicit Reference Detection (Regex)
   ├─ Complete Reference (book + chapter + verse) → High Confidence (≥0.85) → Return
   └─ Chapter-Only Reference (book + chapter, no verse) → Confidence 0.75
      ↓
      AI Verse Matching for Chapter (GPT-4o-mini) → Matches to specific verse
      ↓
      Contextual Confidence Boosts (+0.05 if triggers found)
      ↓
      Filter by Threshold (≥0.85 for auto-emit)
   ↓ (if no explicit match)
AI Verse Matching (GPT-4o-mini) → Medium-High Confidence (≥0.75)
   ↓
Contextual Confidence Boosts (+0.05 if triggers found)
   ↓
Filter by Threshold (≥0.85 for auto-emit)
   ↓
SCRIPTURE_DETECTED Event
```

### Key Principle

> **AI matches verses, never generates Scripture.**

The AI model acts as a **verse identifier**, not a Scripture generator. All Bible text must come from canonical sources (fetched separately via API).

## Implementation Details

### Configuration

```javascript
const detector = new BibleReferenceDetector({
  confidenceThreshold: 0.85,        // Minimum confidence to emit
  aiConfidenceThreshold: 0.75,      // Minimum confidence from AI
  enableAIMatching: true,            // Enable AI matching
  llmModel: 'gpt-4o-mini',          // Model to use
  openaiApiKey: process.env.OPENAI_API_KEY
});
```

### AI Prompt System

**System Prompt:**
```
You are a Bible reference matching engine.

Your task is to identify whether the given transcript likely refers to a specific Bible verse or passage.

Rules:
- Do NOT quote Scripture text.
- Do NOT invent verses.
- Only output references you are confident in.
- If uncertain, respond with "UNCERTAIN".
- Prefer well-known verses commonly quoted in sermons.
- Use canonical book names (e.g., "1 Corinthians" not "First Corinthians").
- Output structured JSON only.
```

**User Prompt Template:**
```
Transcript:
"{TRANSCRIPT_WINDOW}"

Instructions:
- Identify the most likely Bible reference(s) that this transcript refers to.
- The speaker may be paraphrasing or quoting from memory.
- Use canonical book names.
- Output confidence score from 0.0–1.0 (be conservative - only high confidence).

Output format (JSON only):
{
  "matches": [
    {
      "book": "Acts",
      "chapter": 2,
      "verse": 38,
      "confidence": 0.91
    }
  ]
}
```

### Guardrails

1. **Confidence Threshold**: Minimum 0.75 from AI (configurable via `aiConfidenceThreshold`)
2. **Sanity Checks**: 
   - Chapter bounds: 1-150
   - Verse bounds: 1-200
   - Book name format validation
   - Chapter-only references validated to match detected chapter
3. **No Rate Limiting**: Bible verse detection is infrequent, so no artificial delays
4. **Validation**: All AI output validated before acceptance
5. **Error Handling**: Fails silently, never blocks transcript delivery

### When AI is Called

AI matching is triggered when:
- Regex detects chapter-only reference (e.g., "Acts 2") → AI matches to specific verse
- Regex detection fails completely → AI attempts full verse matching
- Text is long enough (≥20 characters) to contain meaningful context

## Benefits

### Advantages Over Keyword Matching

1. **No Manual Maintenance**: No need to maintain keyword fingerprints
2. **Better Context Understanding**: AI understands paraphrasing and context
3. **Handles Edge Cases**: Works with heavy paraphrasing, multiple verses, etc.
4. **Scalable**: Works for any verse, not just pre-indexed ones
5. **Theological Accuracy**: AI trained on Bible knowledge

### Cost & Performance

- **Model**: GPT-4o-mini (low cost, fast)
- **Latency**: ~1-2s per call (acceptable for non-blocking async)
- **Cost**: ~$0.0001-0.0003 per detection (very low)
- **No Rate Limiting**: Bible verse detection is infrequent, so calls happen immediately when needed

## Testing

### Test Cases

1. **Explicit References**: Should use regex (fast, no AI call)
   - "Acts 2:38" → Detected via regex
2. **Chapter-Only References**: Regex detects chapter, AI matches verse
   - "In Acts 2, Peter said to repent" → Detected "Acts 2" via regex, AI matches to "Acts 2:38"
3. **Paraphrased References**: Should use AI matching
   - "repent and be baptized" → AI matches to "Acts 2:38"
4. **Heavy Context**: Should use AI matching
   - "God so loved the world" → AI matches to "John 3:16"
5. **No References**: Should return empty (no false positives)

### Running Tests

```bash
# Full test suite (automatically loads API key from backend/.env)
cd backend
node test-bible-full.js

# The test file automatically loads OPENAI_API_KEY from backend/.env
# If no API key, AI tests will be skipped gracefully
```

## Migration Notes

### Removed

- `detectKeywordMatches()` method (deprecated, returns empty array)
- Dependency on `bibleVerseFingerprints.js` (no longer imported)
- Keyword fingerprint JSON file usage (still exists but unused)

### Changed

- `detectReferences()` now uses AI instead of keywords
- Configuration options updated:
  - `enableLLMConfirmation` → `enableAIMatching`
  - `aiFallbackThreshold` → `aiConfidenceThreshold`
- Method name: `aiFallbackDetection()` → `aiVerseMatching()`

### Backward Compatibility

- Old keyword matching code kept (deprecated) for reference
- Tests updated to handle both regex and AI detection
- Graceful fallback if AI is disabled or API key missing

## Example Usage

```javascript
const detector = new BibleReferenceDetector({
  confidenceThreshold: 0.85,
  enableAIMatching: true,
  openaiApiKey: process.env.OPENAI_API_KEY
});

// Explicit reference (uses regex, fast)
const refs1 = await detector.detectReferences('In Acts 2:38, Peter said');
// Returns: [{ book: 'Acts', chapter: 2, verse: 38, method: 'regex', confidence: 0.9 }]

// Paraphrased reference (uses AI)
const refs2 = await detector.detectReferences('Peter said repent and be baptized');
// Returns: [{ book: 'Acts', chapter: 2, verse: 38, method: 'ai', confidence: 0.91 }]

// Chapter-only reference (regex detects chapter, AI matches verse)
const refs3 = await detector.detectReferences('In Acts 2, Peter said to repent and be baptized');
// Returns: [{ book: 'Acts', chapter: 2, verse: 38, method: 'regex+ai', confidence: 0.91 }]
```

## Edge Cases Handled

### Chapter-Only References

When a speaker mentions only a chapter (e.g., "Acts 2" without a verse number), the system:

1. **Regex Detection**: Detects the chapter-only reference with confidence 0.75
2. **AI Verse Matching**: Uses AI to analyze the transcript context and match to the specific verse
3. **Result**: Returns complete reference (e.g., "Acts 2:38") with method `regex+ai`

**Example:**
- Input: "In Acts 2, Peter said to repent and be baptized for the forgiveness of sins"
- Detected: "Acts 2" (chapter-only via regex)
- AI Analysis: Context mentions "repent", "baptized", "forgiveness" → matches to Acts 2:38
- Output: `{ book: 'Acts', chapter: 2, verse: 38, method: 'regex+ai', confidence: 0.91 }`

## Next Steps

1. **Monitor Performance**: Track AI accuracy and costs
2. **Tune Thresholds**: Adjust confidence thresholds based on real-world data
3. **Add Caching**: Cache common AI matches to reduce API calls
4. **Expand Testing**: Test with real sermon transcripts
5. **Add More Edge Cases**: Handle verse ranges, multiple references, etc.

## Files Modified

- `core/services/bibleReferenceDetector.js` - Main detection logic
- `backend/test-bible-full.js` - Updated tests
- `backend/test-ai-detection.js` - New AI-specific tests

## References

- Original plan: `.cursor/plans/bible_reference_detection_in_core_engine_fb578e02.plan.md`
- Status document: `BIBLE_VERSE_RECOGNITION_STATUS.md`

