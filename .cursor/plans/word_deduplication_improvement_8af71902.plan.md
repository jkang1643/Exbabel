---
name: Word Deduplication Improvement
overview: Improve word deduplication accuracy in partial text deduplication to handle punctuation, case sensitivity, compound words, and multiple word overlaps. Create comprehensive test suite covering all edge cases, then enhance the deduplication logic to pass all tests.
todos:
  - id: create-test-suite
    content: Create comprehensive test suite file (backend/test-partial-deduplication.js) with all test cases including the 6 provided cases and expanded variations
    status: completed
  - id: analyze-current-logic
    content: Analyze current deduplication logic in partialDeduplicator.js to identify specific issues with punctuation, compound words, and word matching
    status: completed
  - id: improve-word-extraction
    content: Improve word extraction in deduplicatePartialText to properly handle punctuation (strip punctuation for comparison but preserve word boundaries)
    status: completed
    dependencies:
      - analyze-current-logic
  - id: add-compound-word-protection
    content: Add compound word detection and protection to prevent deduplicating words that are part of compound words (e.g., are-gathered vs are gathered)
    status: completed
    dependencies:
      - analyze-current-logic
  - id: enhance-word-matching
    content: Enhance word matching logic to handle all test cases including case sensitivity, punctuation variations, and multiple word overlaps
    status: completed
    dependencies:
      - improve-word-extraction
  - id: run-tests-verify
    content: Run test suite against improved implementation and verify all tests pass, including the 6 provided test cases
    status: completed
    dependencies:
      - create-test-suite
      - improve-word-extraction
      - add-compound-word-protection
      - enhance-word-matching
  - id: integration-testing
    content: Test deduplication in both solo and host modes to ensure changes work correctly in production scenarios
    status: pending
    dependencies:
      - run-tests-verify
---

# Word Dedup

lication Improvement Plan

## Current State Analysis

The word deduplication system has two main components:

1. **Partial Deduplication** (`core/utils/partialDeduplicator.js`): Removes duplicate words from partial transcripts that overlap with previous finals

- Used in both solo and host modes
- Currently filters words with length <= 2
- Uses `wordsAreRelated` for matching
- Only checks up to 3 words by default
- Doesn't properly handle punctuation in word boundaries
- Doesn't handle compound words

2. **Recovery Merge Deduplication** (`backend/utils/recoveryMerge.js`): Removes duplicates when merging recovered text

- Uses `deduplicateTail` function
- Has compound word protection
- Handles phrase-level overlaps

## Issues Identified

Based on the test cases provided:

1. **Punctuation Handling**: "are." vs "are" should match but current logic may not handle this correctly
2. **Case Sensitivity**: "are" vs "Are" should match (currently handled via lowercase normalization)
3. **Compound Word Protection**: "are-gathered" (compound) vs "are gathered" should NOT deduplicate
4. **Multiple Word Overlaps**: Need to handle cases where multiple words overlap
5. **Word Boundary Detection**: Need better detection of where words start/end, especially with punctuation

## Test Suite Design

### Test Categories

#### Category 1: Basic Duplicate Detection

- Single word duplicates
- Case variations
- Punctuation variations

#### Category 2: Punctuation Handling

- Trailing punctuation in final
- Leading punctuation in partial
- Multiple punctuation marks

#### Category 3: Compound Word Protection

- Compound words in final
- Compound words in partial
- Hyphenated words

#### Category 4: Multiple Word Overlaps

- 2-word overlaps
- 3-word overlaps
- Partial overlaps with extra words

#### Category 5: Edge Cases

- Very short words
- Empty strings
- Whitespace variations
- Special characters

## Implementation Plan

### Phase 1: Create Comprehensive Test Suite

**File**: `backend/test-partial-deduplication.js`Test cases will cover:

1. All 6 provided test cases
2. Expanded variations of each
3. Additional edge cases
4. Compound word scenarios
5. Punctuation edge cases

### Phase 2: Improve Deduplication Logic

**File**: `core/utils/partialDeduplicator.js`Improvements needed:

1. **Better Punctuation Handling**: Strip punctuation before word comparison but preserve word boundaries
2. **Compound Word Detection**: Check if words are part of compound words before deduplicating
3. **Improved Word Matching**: Enhance matching logic to handle all test cases
4. **Word Boundary Detection**: Better detection of word boundaries with punctuation
5. **Multiple Word Overlap**: Support for overlapping multiple words correctly

### Phase 3: Integration Testing

1. Run test suite against current implementation
2. Fix issues identified
3. Verify both solo and host modes work correctly
4. Test with real-world scenarios

## Key Functions to Modify

1. `deduplicatePartialText()` in `core/utils/partialDeduplicator.js`

- Improve word extraction (handle punctuation)
- Add compound word checking
- Better overlap detection

2. Potentially enhance `wordsAreRelated()` in `backend/utils/recoveryMerge.js`

- May need compound word awareness
- Better punctuation handling

## Test Case Structure

Each test case will have:

- `finalText`: Previous final text
- `partialText`: New partial text
- `expected`: Expected deduplicated result
- `description`: What the test validates

## Success Criteria

All test cases must pass:

- ✅ Basic duplicates detected
- ✅ Case insensitive matching