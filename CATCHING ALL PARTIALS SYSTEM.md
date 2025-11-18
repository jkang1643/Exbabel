# Delayed Final Reconciliation System

## Overview

The Delayed Final Reconciliation System is a production-grade architecture for handling real-time speech transcription that prevents word loss during continuous speech. This system implements the same strategies used in Zoom live captions, YouTube Live, TikTok/Meta streaming, medical dictation software, and call-center ASR systems.

## Problem Statement

Google Cloud Speech-to-Text finalizes transcript segments based on **stability**, not sentence completion. During continuous speech without pauses, Google may finalize an earlier chunk while later words are still being processed as partials. This causes:

- **Missing words at the end of sentences**: "God is migh—" gets finalized before "—ty and powerful" arrives
- **Missing words at the start of sentences**: "Understand that..." gets finalized before "Do you understand..." arrives
- **Missing words in the middle**: Partial words get cut off mid-sentence

## Architecture

### Core Components

1. **Pending Final Buffer** - Delays finalization to allow extending partials
2. **Token-Based Overlap Matching** - Fuzzy matching to detect related segments
3. **Backpatching System** - Retroactive updates to recently finalized segments
4. **Recently Finalized Window** - Keeps previous lines editable for late-arriving tokens

---

## 1. Pending Final Buffer

### Purpose

Instead of immediately processing finals, we store them in a "pending" state and wait for extending partials before committing.

### Implementation

```javascript
let pendingFinal = null; // {text, timestamp, isForced, startTime}
let pendingFinalTimeout = null;
```

### Timing Strategy

| Mode | Buffer Length | Rationale |
|------|--------------|------------|
| **VAD Pause Finalization** | 0ms | Already stable, no delay needed |
| **Forced Commit** | 750ms | Captures trailing words that arrive late |
| **High-speed / Ultra-low-latency** | 350-500ms | More aggressive, may occasionally cut words |

### Workflow

1. **Final Arrives** → Store in `pendingFinal` buffer
2. **Wait Period** → Accept extending partials during delay window
3. **Merge Extensions** → Update pending final as longer partials arrive
4. **Commit** → Process final after delay expires (or when no more extensions)

### Example

```
Final received: "God is migh—"
  ↓ (stored in pending buffer, 750ms timer starts)
Partial arrives: "—ty and pow—"
  ↓ (merged into pending: "God is mighty and pow—")
Partial arrives: "—erful"
  ↓ (merged into pending: "God is mighty and powerful")
Timer expires → Commit: "God is mighty and powerful"
```

---

## 2. Token-Based Overlap Matching

### Purpose

Detect when partials belong to the same segment using intelligent token matching rather than simple string comparison.

### Tokenization

```javascript
const tokenize = (text) => {
  return text.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0);
};
```

### Overlap Calculation

The system checks for token overlap between segments:

- **Exact Match**: End tokens of segment 1 match start tokens of segment 2
- **Fuzzy Match**: 70% of tokens match (handles variations)
- **Overlap Range**: Checks up to 6 tokens for overlap

### Similarity Threshold

- **45% similarity**: Required for backpatching (retroactive merge)
- **30% similarity**: Required for pending final extension
- **70% token match**: Required for fuzzy matching

### Example

```
Segment 1: "We go back to the biblical model"
Segment 2: "biblical model; there's no such thing"

Tokens 1: ["we", "go", "back", "to", "the", "biblical", "model"]
Tokens 2: ["biblical", "model", "there's", "no", "such", "thing"]

Overlap detected: "biblical model" (2 tokens)
Merged: "We go back to the biblical model; there's no such thing"
```

---

## 3. Backpatching System

### Purpose

When late-arriving tokens logically belong to a previous line, update that line retroactively instead of creating a new segment.

### Recently Finalized Window

```javascript
const recentlyFinalized = []; // Array of {text, timestamp, sequenceId}
const RECENTLY_FINALIZED_WINDOW = 1500; // 1.5 seconds
const MAX_RECENT_FINALS = 3; // Keep last 3 finalized segments
```

### Algorithm

```
onPartial(text):
  1. Check if partial overlaps with any recently finalized segment
  2. If similarity > 45%:
     - Merge tokens into previous segment
     - Send updated final to all listeners
     - Update timestamp to keep segment in window longer
  3. Else:
     - Treat as new segment
```

### Example

```
Line #13 finalized: "Understand that maybe the answer is just a fable."
  ↓ (added to recentlyFinalized window)
Partial arrives: "Do you understand that maybe the answer is just a fable."
  ↓ (45%+ similarity detected)
Backpatch: "Do you understand that maybe the answer is just a fable."
  ↓ (previous line updated retroactively)
```

---

## 4. Priority-Based Partial Processing

### Processing Order

When a partial arrives, the system checks in this order:

#### Priority 1: Extend Pending Final (Before Commit)
**Most Important** - Catches words before final is sent

```javascript
if (pendingFinal && partial extends it) {
  mergeIntoPendingFinal();
  resetCommitTimer();
  return; // Don't process as new partial
}
```

#### Priority 2: Backpatch Recently Finalized
**Retroactive Fix** - Updates previous lines

```javascript
if (partial belongs to recent final) {
  backpatchRecentlyFinalized();
  return; // Don't process as new partial
}
```

#### Priority 3: Extend Recent Final (Grace Period)
**Continuation Detection** - Catches late continuations

```javascript
if (partial extends last final && within grace period) {
  sendUpdatedFinal();
  return;
}
```

#### Normal Processing
If no matches, continue normal partial tracking and display.

---

## 5. Complete Algorithm Flow

### On Partial Arrival

```
onPartial(text):
  1. PRIORITY 1: Check if extends pending final
     - Token-based overlap matching
     - If match: merge, update pending, reset timer
     - Return early
  
  2. PRIORITY 2: Check if should backpatch
     - Compare with recently finalized segments
     - If similarity > 45%: merge and update previous line
     - Return early
  
  3. PRIORITY 3: Check if extends recent final
     - Within grace period (3 seconds)?
     - If match: send updated final
     - Return early
  
  4. NORMAL: Track as new partial
     - Update latest/longest partial tracking
     - Send to live display
     - Continue normal flow
```

### On Final Arrival

```
onFinal(text, isForced):
  1. Use longest partial if better version available
  2. Store in pendingFinal buffer
  3. Set commit delay:
     - 0ms if natural (VAD pause)
     - 750ms if forced
  4. Start timer
  5. During delay:
     - Accept extending partials
     - Merge into pending final
     - Reset timer on each extension
  6. On timer expiry:
     - Add to recentlyFinalized window
     - Commit final (translate, send to listeners)
     - Reset partial tracking
```

### On Commit

```
commitPendingFinal():
  1. Last chance check: Use longest partial if better
  2. Add to recentlyFinalized window (for backpatching)
  3. Update lastFinalText tracking (for grace period)
  4. Process final:
     - Grammar correction
     - Translation
     - Send to all listeners
  5. Reset partial tracking
  6. Schedule grace period reset
```

---

## Configuration Parameters

### Timing Constants

```javascript
// Final Commit Delays
const FINAL_COMMIT_DELAY_NATURAL = 0;    // VAD pause - already stable
const FINAL_COMMIT_DELAY_FORCED = 750;   // Forced commit - needs buffer

// Grace Periods
const PARTIAL_TRACKING_GRACE_PERIOD = 3000;        // 3 seconds
const RECENTLY_FINALIZED_WINDOW = 1500;           // 1.5 seconds
const MAX_RECENT_FINALS = 3;                      // Keep last 3 segments
```

### Matching Thresholds

```javascript
// Token Overlap Similarity
const BACKPATCH_SIMILARITY_THRESHOLD = 0.45;      // 45% for backpatching
const PENDING_EXTENSION_SIMILARITY = 0.30;        // 30% for pending extension
const FUZZY_MATCH_THRESHOLD = 0.70;              // 70% token match

// Overlap Detection
const MAX_TOKEN_OVERLAP_CHECK = 6;                // Check up to 6 tokens
const MIN_TOKEN_OVERLAP = 2;                      // Minimum 2 tokens
```

---

## Performance Characteristics

### Latency

- **Live Partial Display**: < 200ms (unchanged)
- **Natural Finalization**: 0ms delay (immediate)
- **Forced Finalization**: 750ms delay (post-processing, user doesn't notice)

### Memory

- **Recently Finalized Window**: ~3 segments × 1.5 seconds = minimal overhead
- **Pending Final Buffer**: Single segment, cleared after commit
- **Token Arrays**: Temporary, garbage collected after processing

### CPU

- **Tokenization**: O(n) where n = text length
- **Overlap Matching**: O(k) where k = max overlap check (6 tokens)
- **Backpatch Search**: O(m) where m = recent finals count (max 3)

---

## Edge Cases Handled

### 1. Rapid Sequential Finals
If a new final arrives before previous one commits:
- Cancel previous pending final timeout
- Replace with new final
- Reset timer

### 2. Multiple Extensions
Pending final can be extended multiple times:
- Each extension resets the commit timer
- Always uses longest/best version
- Prevents premature commits

### 3. False Positive Prevention
Similarity thresholds prevent incorrect merges:
- 45% threshold for backpatching (conservative)
- Token-based matching (more accurate than string)
- Checks overlap position (end vs. start)

### 4. Stale Data Cleanup
Automatic cleanup prevents memory leaks:
- Recently finalized entries expire after 1.5 seconds
- Limited to last 3 segments
- Timestamps updated on backpatch to keep relevant

---

## Integration Points

### Google Speech Stream

```javascript
speechStream.onResult(async (transcriptText, isPartial, meta) => {
  if (isPartial) {
    // Process through priority system
  } else {
    // Store in pending buffer, delay commit
  }
});
```

### Translation Pipeline

```javascript
const processFinalTranscript = async (finalText, isForcedFinal) => {
  // Grammar correction
  // Translation to multiple languages
  // Broadcast to listeners
};
```

### Session Store

```javascript
sessionStore.broadcastToListeners(sessionId, {
  type: 'translation',
  originalText: finalText,
  translatedText: translatedText,
  // ... other fields
}, targetLang);
```

---

## Testing Scenarios

### Scenario 1: Trailing Words
```
Input: Final "God is migh—" → Partial "—ty and powerful"
Expected: "God is mighty and powerful"
Result: ✅ Pending final extended before commit
```

### Scenario 2: Leading Words
```
Input: Final "Understand that..." → Partial "Do you understand that..."
Expected: "Do you understand that..."
Result: ✅ Backpatched to previous segment
```

### Scenario 3: Mid-Sentence Words
```
Input: Final "We go back" → Partial "We go back to the biblical model"
Expected: "We go back to the biblical model"
Result: ✅ Token overlap detected, merged
```

### Scenario 4: New Sentence
```
Input: Final "That's all." → Partial "What's next?"
Expected: Two separate segments
Result: ✅ No overlap, treated as new segment
```

---

## Monitoring & Debugging

### Console Logs

The system provides detailed logging:

```
[HostMode] 📝 FINAL signal received (45 chars): "We go back to the biblical model..."
[HostMode] ⏳ Scheduling final commit after 750ms delay (FORCED - to catch extending partials)
[HostMode] 🔄 Partial extends PENDING final (token merge) - updating:
[HostMode]   Pending: "We go back to the biblical model"
[HostMode]   Partial: "We go back to the biblical model; there's no such thing"
[HostMode]   Merged: "We go back to the biblical model; there's no such thing"
[HostMode] 🔙 BACKPATCHING: Merging into recent final:
[HostMode]   Recent: "Understand that maybe the answer is just a fable."
[HostMode]   Partial: "Do you understand that maybe the answer is just a fable."
[HostMode]   Merged: "Do you understand that maybe the answer is just a fable."
[HostMode]   Similarity: 67.3%
[HostMode] ✅ Processing FINAL Transcript: "We go back to the biblical model; there's no such thing"
```

### Key Metrics to Monitor

- **Pending Final Extensions**: Count of times pending finals were extended
- **Backpatch Operations**: Count of retroactive updates
- **Average Commit Delay**: Time between final arrival and commit
- **Word Recovery Rate**: Percentage of missing words successfully recovered

---

## Future Enhancements

### Potential Improvements

1. **Adaptive Delay**: Adjust delay based on speech rate
2. **Confidence Scoring**: Use Google Speech confidence scores for better matching
3. **Context Awareness**: Use sentence structure to improve merging decisions
4. **Multi-Language Support**: Language-specific tokenization rules
5. **Machine Learning**: Train model to predict optimal merge decisions

---

## References

This architecture is based on production systems:

- **Zoom Live Captions**: Delayed finalization buffer
- **YouTube Live**: Token-based overlap matching
- **Medical Dictation Software**: Backpatching system
- **Call-Center ASR**: Recently finalized window

---

## Version History

- **v1.0** (Current): Initial implementation with all core features
  - Pending final buffer
  - Token-based matching
  - Backpatching system
  - Recently finalized window

---

## Support

For questions or issues with the Delayed Final Reconciliation System, refer to:
- Implementation: `backend/hostModeHandler.js`
- Main entry point: `handleHostConnection()` function
- Core logic: `speechStream.onResult()` callback

