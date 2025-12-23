/**
 * Partial Text Deduplication Test Suite
 * 
 * Comprehensive tests for word deduplication in partial transcripts.
 * Tests cover punctuation handling, case sensitivity, compound words, and edge cases.
 * 
 * Run with: node backend/test-partial-deduplication.js
 */

import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';

console.log('🧪 Partial Text Deduplication Test Suite\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

function test(name, finalText, partialText, expected, description = '') {
  totalTests++;
  const startTime = Date.now();
  
  try {
    // Create a recent timestamp (within time window)
    const recentTime = Date.now() - 1000; // 1 second ago
    
    const result = deduplicatePartialText({
      partialText: partialText,
      lastFinalText: finalText,
      lastFinalTime: recentTime,
      mode: 'TestMode',
      timeWindowMs: 5000,
      maxWordsToCheck: 5 // Increased for better testing
    });
    
    const actual = result.deduplicatedText;
    const passed = actual === expected;
    const duration = Date.now() - startTime;
    
    if (passed) {
      console.log(`✅ ${name}`);
      if (description) console.log(`   ${description}`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration, description });
    } else {
      console.log(`❌ ${name}`);
      if (description) console.log(`   ${description}`);
      console.log(`   Expected: "${expected}"`);
      console.log(`   Actual:   "${actual}"`);
      console.log(`   Words skipped: ${result.wordsSkipped}, Was deduplicated: ${result.wasDeduplicated}`);
      failedTests++;
      testDetails.push({ 
        name, 
        status: 'failed', 
        duration, 
        description,
        expected,
        actual,
        wordsSkipped: result.wordsSkipped,
        wasDeduplicated: result.wasDeduplicated
      });
    }
    
    return passed;
  } catch (error) {
    console.log(`❌ ${name} - ERROR: ${error.message}`);
    console.error(error.stack);
    failedTests++;
    testDetails.push({ name, status: 'error', duration: Date.now() - startTime, error: error.message });
    return false;
  }
}

// ============================================================================
// CATEGORY 1: User-Provided Test Cases
// ============================================================================

console.log('\n📋 Category 1: User-Provided Test Cases\n');

// Test 1: Basic duplicate - "are" at end of final, "are" at start of partial
test(
  'Test 1: Basic duplicate word',
  'where two or three are',
  'are gathered together',
  'gathered together',
  'Basic case: duplicate "are" should be removed'
);

// Test 2: Case variation - "are" vs "Are"
test(
  'Test 2: Case insensitive matching',
  'where two or three are',
  'Are gathered together',
  'gathered together',
  'Case insensitive: "are" vs "Are" should match'
);

// Test 3: Punctuation in final - "are." vs "are"
test(
  'Test 3: Punctuation in final text',
  'where two or three are.',
  'are gathered together',
  'gathered together',
  'Punctuation handling: "are." should match "are"'
);

// Test 4: Punctuation with extra word - "are." vs "our are"
test(
  'Test 4: Punctuation with extra word before duplicate',
  'where two or three are.',
  'our are gathered together',
  'gathered together',
  'Should skip "our are" and keep "gathered together"'
);

// Test 5: Multiple extra words before duplicate
test(
  'Test 5: Multiple words before duplicate',
  'where two or three are.',
  'they indeed are gathered together',
  'gathered together',
  'Should skip "they indeed are" and keep "gathered together"'
);

// Test 6: Compound word matching - "are-gathered" vs "are gathered"
test(
  'Test 6: Compound word matching',
  'where two or three are-gathered',
  'are gathered together',
  'gathered together',
  'Compound word "are-gathered" should match "are" (first part) and deduplicate'
);

// ============================================================================
// CATEGORY 2: Punctuation Handling
// ============================================================================

console.log('\n📋 Category 2: Punctuation Handling\n');

// Various punctuation marks
test(
  'Test 7: Period punctuation',
  'the end of the sentence.',
  'sentence continues here',
  'continues here',
  'Period at end of final should not prevent matching'
);

test(
  'Test 8: Comma punctuation',
  'the end of the sentence,',
  'sentence continues here',
  'continues here',
  'Comma at end of final should not prevent matching'
);

test(
  'Test 9: Question mark punctuation',
  'the end of the sentence?',
  'sentence continues here',
  'continues here',
  'Question mark at end of final should not prevent matching'
);

test(
  'Test 10: Exclamation mark punctuation',
  'the end of the sentence!',
  'sentence continues here',
  'continues here',
  'Exclamation mark at end of final should not prevent matching'
);

test(
  'Test 11: Semicolon punctuation',
  'the end of the sentence;',
  'sentence continues here',
  'continues here',
  'Semicolon at end of final should not prevent matching'
);

test(
  'Test 12: Colon punctuation',
  'the end of the sentence:',
  'sentence continues here',
  'continues here',
  'Colon at end of final should not prevent matching'
);

test(
  'Test 13: Multiple punctuation marks',
  'the end of the sentence...',
  'sentence continues here',
  'continues here',
  'Multiple punctuation marks should not prevent matching'
);

test(
  'Test 14: Punctuation in partial',
  'the end of the sentence',
  '.sentence continues here',
  'continues here',
  'Punctuation at start of partial should be handled'
);

// ============================================================================
// CATEGORY 3: Case Sensitivity
// ============================================================================

console.log('\n📋 Category 3: Case Sensitivity\n');

test(
  'Test 15: All lowercase',
  'the word is here',
  'here we go',
  'we go',
  'Lowercase matching'
);

test(
  'Test 16: All uppercase',
  'THE WORD IS HERE',
  'HERE WE GO',
  'WE GO',
  'Uppercase matching'
);

test(
  'Test 17: Mixed case in final',
  'The Word Is Here',
  'here we go',
  'we go',
  'Mixed case in final, lowercase in partial'
);

test(
  'Test 18: Mixed case in partial',
  'the word is here',
  'Here We Go',
  'We Go',
  'Lowercase in final, mixed case in partial (preserve case)'
);

test(
  'Test 19: Title case',
  'The Word Is Here',
  'Here We Go',
  'We Go',
  'Title case matching'
);

// ============================================================================
// CATEGORY 4: Compound Word Protection
// ============================================================================

console.log('\n📋 Category 4: Compound Word Protection\n');

test(
  'Test 20: Compound word in final - should not deduplicate',
  'this is a self-centered person',
  'centered person is good',
  'centered person is good',
  'Compound word "self-centered" should NOT match "centered"'
);

test(
  'Test 21: Compound word in partial - should not deduplicate',
  'this is a centered person',
  'self-centered person is good',
  'self-centered person is good',
  'Standalone "centered" should NOT match "self-centered"'
);

test(
  'Test 22: Multiple hyphens in compound',
  'this is a well-known fact',
  'known fact is true',
  'known fact is true',
  'Multi-hyphen compound should not deduplicate'
);

test(
  'Test 23: Compound word with punctuation',
  'this is a self-centered.',
  'centered person is good',
  'centered person is good',
  'Compound word with punctuation should not deduplicate'
);

test(
  'Test 24: Short compound word (edge case)',
  'this is a co-op',
  'op is good',
  'op is good',
  'Short compound word should not deduplicate if too short'
);

// ============================================================================
// CATEGORY 5: Multiple Word Overlaps
// ============================================================================

console.log('\n📋 Category 5: Multiple Word Overlaps\n');

test(
  'Test 25: Two word overlap',
  'the end of the sentence',
  'the sentence continues',
  'continues',
  'Two word overlap: "the sentence"'
);

test(
  'Test 26: Three word overlap',
  'at the end of',
  'end of the sentence',
  'the sentence',
  'Three word overlap: "end of"'
);

test(
  'Test 27: Four word overlap',
  'this is the end',
  'is the end of',
  'of',
  'Four word overlap: "is the end"'
);

test(
  'Test 28: Partial overlap with extra words',
  'the end of the sentence',
  'some words the end of the sentence continues',
  'continues',
  'Extra words before overlap should be skipped'
);

test(
  'Test 29: Overlap in middle of partial',
  'the end of',
  'words the end of continues',
  'words continues',
  'Overlap in middle should only remove overlapping words'
);

// ============================================================================
// CATEGORY 6: Edge Cases
// ============================================================================

console.log('\n📋 Category 6: Edge Cases\n');

test(
  'Test 30: Single word final',
  'hello',
  'hello world',
  'world',
  'Single word final with duplicate'
);

test(
  'Test 31: Single word partial',
  'the end hello',
  'hello',
  '',
  'Single word partial that matches (should return empty)'
);

test(
  'Test 32: Empty partial',
  'the end of sentence',
  '',
  '',
  'Empty partial should return empty'
);

test(
  'Test 33: Empty final',
  '',
  'new sentence starts',
  'new sentence starts',
  'Empty final should not deduplicate'
);

test(
  'Test 34: Whitespace variations',
  'the end  of  the  sentence',
  'sentence continues',
  'continues',
  'Multiple spaces should be normalized'
);

test(
  'Test 35: Tab characters',
  'the end\tof\tthe\tsentence',
  'sentence continues',
  'continues',
  'Tab characters should be handled'
);

test(
  'Test 36: Newline characters',
  'the end\nof\nthe\nsentence',
  'sentence continues',
  'continues',
  'Newline characters should be handled'
);

test(
  'Test 37: Very short words (2 chars)',
  'the end of it',
  'it continues',
  'continues',
  'Very short words should be handled (if length > 2 filter allows)'
);

test(
  'Test 38: Special characters',
  'the end of the sentence@#$',
  'sentence continues',
  'continues',
  'Special characters should not prevent matching'
);

test(
  'Test 39: Numbers in text',
  'the end of sentence 123',
  'sentence 456 continues',
  '456 continues',
  'Numbers should be preserved but not matched'
);

test(
  'Test 40: Apostrophes and contractions',
  "the end of don't",
  "don't continue",
  'continue',
  "Apostrophes in contractions should be handled"
);

// ============================================================================
// CATEGORY 7: Real-World Scenarios
// ============================================================================

console.log('\n📋 Category 7: Real-World Scenarios\n');

test(
  'Test 41: Bible verse style',
  'For where two or three are',
  'are gathered together in my name',
  'gathered together in my name',
  'Bible verse style overlap'
);

test(
  'Test 42: Continuous speech',
  'I think that the',
  'the problem is',
  'problem is',
  'Continuous speech with overlap'
);

test(
  'Test 43: Pause and resume',
  'The sermon today is about.',
  'is about faith and hope',
  'faith and hope',
  'Pause with punctuation, resume with overlap'
);

test(
  'Test 44: Correction mid-sentence',
  'The word was incorrect',
  'incorrect actually correct',
  'actually correct',
  'Correction scenario with overlap'
);

test(
  'Test 45: Repetition',
  'I said I said',
  'I said it again',
  'it again',
  'Repetition with overlap'
);

// ============================================================================
// CATEGORY 8: Boundary Cases
// ============================================================================

console.log('\n📋 Category 8: Boundary Cases\n');

test(
  'Test 46: Exact match',
  'the end of sentence',
  'the end of sentence',
  '',
  'Exact match should return empty'
);

test(
  'Test 47: No overlap',
  'the end of sentence',
  'new sentence starts',
  'new sentence starts',
  'No overlap should return original partial'
);

test(
  'Test 48: Overlap at very end',
  'sentence ends with word',
  'word',
  '',
  'Overlap at very end should return empty'
);

test(
  'Test 49: Overlap at very start',
  'word',
  'word starts sentence',
  'starts sentence',
  'Overlap at very start'
);

test(
  'Test 50: All words overlap',
  'one two three',
  'one two three four',
  'four',
  'All words overlap except last'
);

// ============================================================================
// Test Summary
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log('\n📊 Test Summary\n');
console.log(`Total Tests: ${totalTests}`);
console.log(`✅ Passed: ${passedTests}`);
console.log(`❌ Failed: ${failedTests}`);
console.log(`Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%\n`);

if (failedTests > 0) {
  console.log('❌ Failed Tests:\n');
  testDetails
    .filter(t => t.status === 'failed')
    .forEach(t => {
      console.log(`  - ${t.name}`);
      if (t.description) console.log(`    ${t.description}`);
      console.log(`    Expected: "${t.expected}"`);
      console.log(`    Actual:   "${t.actual}"`);
      console.log(`    Words skipped: ${t.wordsSkipped}, Was deduplicated: ${t.wasDeduplicated}\n`);
    });
}

if (failedTests === 0) {
  console.log('🎉 All tests passed!\n');
  process.exit(0);
} else {
  console.log(`\n⚠️  ${failedTests} test(s) failed. Please review the implementation.\n`);
  process.exit(1);
}

