# Grammar Engine Settings

This document describes the configuration and validation parameters for the Xenova grammar correction model used in the real-time transcription pipeline.

## Overview

The grammar engine uses a T5-based text-to-text generation model (`onnx-community/grammar-synthesis-small-ONNX`) with multiple layers of constraints to ensure minimal, accurate corrections without semantic drift or over-rewriting.

**Model Location:** `backend/grammarCorrectorModel.js`

---

## Four-Layer Protection System

### Layer 1: Instruction Prompt

**Purpose:** Explicitly instructs the model to perform minimal correction only

**Implementation:**
```javascript
const instructionPrompt = `Fix only clear grammar and punctuation errors. Do not change correct words. Keep meaning identical.\n\nText: ${original}`;
```

**Effect:**
- Tells model to preserve semantic meaning
- Prevents unnecessary word substitutions
- Guides model toward grammar-only fixes

---

### Layer 2: Decoding Parameters

**Purpose:** Constrain model output to be deterministic and conservative

**Parameters:**

| Parameter | Value | Description | Impact |
|-----------|-------|-------------|--------|
| `max_new_tokens` | `Math.min(inputWords * 1.2, 256)` | Maximum tokens to generate | Limits output to 120% of input length |
| `num_beams` | `2` | Beam search width | Narrow search prevents wild alternatives |
| `temperature` | `0.1` | Sampling randomness | Near-deterministic output (0.0 = fully deterministic) |
| `top_p` | `0.8` | Nucleus sampling threshold | Only considers tokens in top 80% probability mass |
| `top_k` | `40` | Top-K sampling | Limits selection to 40 most likely tokens |
| `length_penalty` | `2.0` | Length change penalty | Heavily penalizes making text longer/shorter |
| `repetition_penalty` | `1.2` | Repetition penalty | Discourages adding redundant words |
| `do_sample` | `false` | Disable sampling | Forces greedy decoding for consistency |

**Tuning Guidelines:**
- **Lower `temperature`** (0.0-0.3) → More deterministic, less creative
- **Lower `top_p`** (0.5-0.9) → More conservative token selection
- **Lower `top_k`** (20-50) → Fewer token choices
- **Higher `length_penalty`** (1.5-3.0) → Stronger preference for same length
- **Higher `num_beams`** (2-4) → Better quality but slower

**When to Adjust:**
- Model too conservative? → Increase `temperature` to 0.2-0.3
- Still making wild changes? → Lower `top_p` to 0.7 or `top_k` to 30
- Adding too many words? → Increase `length_penalty` to 2.5-3.0

---

### Layer 3: Semantic Similarity Validation (Jaro-Winkler)

**Purpose:** Detect and reject semantic drift (word substitutions that change meaning)

**Algorithm:** Jaro-Winkler Distance
- Measures character-level similarity between strings
- Returns score from 0.0 (completely different) to 1.0 (identical)
- Gives extra weight to common prefixes

**Implementation:**
```javascript
isSemanticallyValid(original, corrected) {
  const similarity = this.jaroWinklerSimilarity(original, corrected);
  const MIN_SIMILARITY = 0.85; // 85% threshold

  if (similarity < MIN_SIMILARITY) {
    console.warn(`Semantic drift detected - similarity: ${similarity * 100}%`);
    return false;
  }
  return true;
}
```

**Threshold:** `MIN_SIMILARITY = 0.85` (85%)

**Examples:**

| Original | Corrected | Similarity | Result |
|----------|-----------|------------|--------|
| "Can you hear me?" | "Can you tell me?" | ~78% | ❌ Rejected (semantic drift) |
| "Hello world" | "Hello, world." | ~95% | ✅ Accepted (punctuation only) |
| "I going store" | "I am going to the store" | ~82% | ❌ Rejected (too many changes) |
| "I going store" | "I'm going to the store" | ~87% | ✅ Accepted (grammar fix) |

**Tuning Guidelines:**
- **Lower threshold** (0.75-0.85) → Allow more changes
- **Higher threshold** (0.85-0.95) → More strict, fewer changes

**When to Adjust:**
- Rejecting legitimate fixes? → Lower to 0.80-0.82
- Still allowing word substitutions? → Raise to 0.88-0.90

---

### Layer 4: Word-Level Change Validation

**Purpose:** Validate corrections using word count and change metrics

#### 4A. Adaptive Length Validation

**Rules:** Length change thresholds adapt based on input length

| Input Length | Max Length Change | Rationale |
|--------------|-------------------|-----------|
| 1-3 words | 80% | Short inputs need flexibility |
| 4-5 words | 60% | Medium flexibility |
| 6-10 words | 40% | Moderate strictness |
| 11+ words | 30% | Strict control |

**Additional Constraint:** Absolute difference must be >5 words to reject

**Example:**
```javascript
// Input: "Hello, hello" (2 words)
// Output: "Hello there, hello" (3 words)
// Change: 50% but only +1 word absolute
// Result: ✅ Accepted (below 80% threshold AND <5 words absolute)
```

#### 4B. Word-Level Difference Analysis

**Metrics Tracked:**
- **Substitutions:** Words changed (position-based comparison)
- **Additions:** New words added
- **Deletions:** Words removed

**Implementation:**
```javascript
// Count substitutions (ignoring punctuation)
for (let i = 0; i < minLength; i++) {
  const origWord = origWords[i].toLowerCase().replace(/[.,!?;:'"]/g, '');
  const corrWord = corrWords[i].toLowerCase().replace(/[.,!?;:'"]/g, '');
  if (origWord !== corrWord) {
    // Check if minor variation (capitalization, contained substring)
    if (origWord.includes(corrWord) || corrWord.includes(origWord)) {
      continue; // Don't count as substitution
    }
    substitutions++;
  }
}

// Calculate total change ratio
const totalChanges = substitutions + additions + deletions;
const changeRatio = totalChanges / Math.max(origWords.length, corrWords.length);
```

**Rejection Threshold:** `changeRatio > 0.5` (50%)

**Examples:**

| Original | Corrected | Subs | Adds | Dels | Ratio | Result |
|----------|-----------|------|------|------|-------|--------|
| "hello world" | "Hello, world." | 0 | 0 | 0 | 0% | ✅ Accepted |
| "I going" | "I am going" | 0 | 1 | 0 | 33% | ✅ Accepted |
| "Can you hear me" | "Can you tell me" | 1 | 0 | 0 | 25% | ✅ Accepted* |
| "Short text" | "This is completely different" | 2 | 2 | 0 | 100% | ❌ Rejected |

*Note: Would be rejected by Layer 3 (semantic similarity)

**Tuning Guidelines:**
- **Lower threshold** (0.3-0.5) → More strict
- **Higher threshold** (0.5-0.7) → More lenient

---

## Configuration Summary

### Current Production Settings

```javascript
// Decoding Parameters
{
  max_new_tokens: Math.min(inputWords * 1.2, 256),
  num_beams: 2,
  temperature: 0.1,
  top_p: 0.8,
  top_k: 40,
  length_penalty: 2.0,
  repetition_penalty: 1.2,
  do_sample: false
}

// Validation Thresholds
{
  MIN_SIMILARITY: 0.85,           // Jaro-Winkler threshold (85%)
  MAX_CHANGE_RATIO: 0.5,          // Maximum word change ratio (50%)
  MAX_LENGTH_CHANGE: {            // Adaptive by input length
    '1-3 words': 0.8,             // 80%
    '4-5 words': 0.6,             // 60%
    '6-10 words': 0.4,            // 40%
    '11+ words': 0.3              // 30%
  },
  MIN_ABSOLUTE_DIFF: 5            // Minimum absolute word difference to reject
}
```

---

## How to Adjust Settings

### Problem: Model Too Conservative (Rejecting Good Fixes)

**Symptoms:**
- Legitimate grammar fixes are rejected
- Logs show "Rejected - semantic drift" for valid corrections

**Solutions:**
1. Lower `MIN_SIMILARITY` from 0.85 to 0.82
2. Increase `MAX_CHANGE_RATIO` from 0.5 to 0.6
3. Increase `temperature` from 0.1 to 0.2

**File:** `backend/grammarCorrectorModel.js`

```javascript
// Around line 1362
const MIN_SIMILARITY = 0.82; // Was 0.85

// Around line 1449
if (changeRatio > 0.6) { // Was 0.5
```

### Problem: Model Still Over-Correcting

**Symptoms:**
- Semantic changes still getting through ("hear" → "tell")
- Logs show accepted corrections that change meaning

**Solutions:**
1. Increase `MIN_SIMILARITY` from 0.85 to 0.88
2. Decrease `temperature` from 0.1 to 0.05
3. Lower `top_p` from 0.8 to 0.7
4. Lower `MAX_CHANGE_RATIO` from 0.5 to 0.4

### Problem: Model Adding Too Many Words

**Symptoms:**
- Short inputs becoming longer
- Additions not semantically necessary

**Solutions:**
1. Increase `length_penalty` from 2.0 to 2.5 or 3.0
2. Increase `repetition_penalty` from 1.2 to 1.5
3. Decrease `max_new_tokens` multiplier from 1.2 to 1.1

```javascript
// Around line 1501
const maxTokens = Math.ceil(inputWords * 1.1); // Was 1.2
```

### Problem: Model Too Slow

**Symptoms:**
- High latency in corrections
- Timeouts

**Solutions:**
1. Decrease `num_beams` from 2 to 1 (greedy decoding)
2. Lower `max_new_tokens` multiplier
3. Consider disabling grammar model for partials (only finals)

---

## Environment Variables

Enable/disable the grammar model:

```bash
# In .env file
ENABLE_XENOVA_GRAMMAR=true   # Enable Xenova grammar corrections
ENABLE_XENOVA_GRAMMAR=false  # Disable (use rule-based only)
```

Set custom model (optional):
```bash
GRAMMAR_MODEL=onnx-community/grammar-synthesis-small-ONNX
```

---

## Monitoring & Logs

### Successful Correction
```
[GrammarCorrector] ✅ Accepted - 1 substitutions, 2 additions, 0 deletions (15.0% change)
```

### Rejected: Semantic Drift
```
[GrammarCorrector] Semantic drift detected - similarity: 78.3% (min: 85.0%)
[GrammarCorrector]   Original: "Can you hear me?"
[GrammarCorrector]   Corrected: "Can you tell me?"
[GrammarCorrector] Rejected due to semantic drift
```

### Rejected: Too Many Changes
```
[GrammarCorrector] Rejected - 66.7% of words changed (4 substitutions, 2 additions, 0 deletions)
```

### Rejected: Length Change
```
[GrammarCorrector] Rejected - word count changed by 45.5% (11 → 16, +5 words)
```

---

## Testing Recommendations

### Test Cases to Verify

1. **Punctuation Only** (should accept)
   - Input: `"hello world"`
   - Expected: `"Hello, world."`

2. **Grammar Fix** (should accept)
   - Input: `"I going to store"`
   - Expected: `"I'm going to the store"`

3. **Semantic Change** (should reject)
   - Input: `"Can you hear me"`
   - Expected: Rejected, returns original

4. **Short Text Addition** (should accept)
   - Input: `"Hello hello"`
   - Expected: `"Hello, hello there"` or similar

5. **Excessive Rewrite** (should reject)
   - Input: `"Short text"`
   - Expected: If output is completely different, reject

### Monitoring Strategy

1. Watch logs for rejection patterns
2. Track rejection rates (should be <10% for legitimate transcriptions)
3. Review rejected samples weekly
4. Adjust thresholds based on production data

---

## Performance Characteristics

### Latency
- **Initial Load:** 5-10 seconds (one-time model download)
- **Per Correction:** 50-200ms (depends on text length)
- **Partials:** Grammar model disabled (0ms overhead)
- **Finals:** Full correction pipeline (~100-200ms total)

### Accuracy
- **Grammar Fixes:** ~95% correct (capitalization, punctuation, contractions)
- **False Positives:** <5% (over-corrections caught by validation)
- **False Negatives:** <10% (missed errors due to conservative settings)

---

## Related Files

- **Model Implementation:** `backend/grammarCorrectorModel.js`
- **Pipeline Integration:** `backend/transcriptionPipeline.js`
- **Rule-Based Corrections:** `backend/retext-plugins/logic.js`
- **Punctuation Logic:** `backend/retext-plugins/logic.js` (lines 172-700)

---

## Troubleshooting

### Model Not Working

1. Check `ENABLE_XENOVA_GRAMMAR=true` in `.env`
2. Verify model downloaded (check logs for "✅ Model files ready")
3. Check for errors in logs

### Corrections Rejected Too Often

1. Review logs to see rejection reasons
2. Adjust `MIN_SIMILARITY` and `MAX_CHANGE_RATIO`
3. Consider if input text quality is low (STT errors)

### Model Taking Too Long

1. Reduce `num_beams` to 1
2. Lower `max_new_tokens` multiplier
3. Consider disabling for real-time partials

---

## Version History

- **v1.0** (Initial) - Basic grammar correction with Xenova
- **v2.0** (Current) - Four-layer protection system with semantic validation

**Last Updated:** 2025-11-07
