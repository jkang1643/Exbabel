/**
 * Recovery Merge Prefix Overlap Test
 * 
 * Tests the recovery merge logic when words are missing at the START of a phrase.
 * This is the issue where "Where two or three" is missing from "Where two or three are gathered together in My name".
 * 
 * Run with: node backend/test-recovery-merge-prefix-overlap.js
 */

import { mergeRecoveryText } from './utils/recoveryMerge.js';

console.log('🧪 Recovery Merge Prefix Overlap Test Suite\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
const testDetails = [];

function test(name, fn) {
  totalTests++;
  const startTime = Date.now();
  try {
    const result = fn();
    const duration = Date.now() - startTime;
    if (result === true || (result && result !== false)) {
      console.log(`✅ ${name} (${duration}ms)`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration, error: null });
      return true;
    } else {
      console.log(`❌ ${name} (${duration}ms)`);
      testDetails.push({ name, status: 'failed', duration, error: 'Test returned false' });
      return false;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ ${name}: ${error.message} (${duration}ms)`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1]?.trim()}`);
    }
    testDetails.push({ name, status: 'failed', duration, error: error.message });
    return false;
  }
}

// ============================================================================
// Test Cases for Prefix Overlap (Missing Words at Start)
// ============================================================================

// Test 1: Missing words at start - "Where two or three" missing
test('Prefix overlap: "Where two or three" missing from start', () => {
  const bufferedText = 'are gathered together in My name';
  const recoveredText = 'Where two or three are gathered together in My name';
  
  const result = mergeRecoveryText(bufferedText, recoveredText, { mode: 'Test' });
  
  // Expected: "Where two or three are gathered together in My name"
  // The merge should detect that buffered text is a suffix of recovered text
  // and prepend the missing prefix words
  const expected = 'Where two or three are gathered together in My name';
  const actual = result.mergedText;
  
  console.log(`   Buffered: "${bufferedText}"`);
  console.log(`   Recovered: "${recoveredText}"`);
  console.log(`   Expected: "${expected}"`);
  console.log(`   Actual: "${actual}"`);
  console.log(`   Merged: ${result.merged}`);
  console.log(`   Reason: ${result.reason}`);
  
  return result.merged && actual === expected;
});

// Test 2: Missing words at start - "Life is best" missing
test('Prefix overlap: "Life is best" missing from start', () => {
  const bufferedText = 'spent fulfilling our own self-centered desires';
  const recoveredText = 'Life is best spent fulfilling our own self-centered desires';
  
  const result = mergeRecoveryText(bufferedText, recoveredText, { mode: 'Test' });
  
  const expected = 'Life is best spent fulfilling our own self-centered desires';
  const actual = result.mergedText;
  
  console.log(`   Buffered: "${bufferedText}"`);
  console.log(`   Recovered: "${recoveredText}"`);
  console.log(`   Expected: "${expected}"`);
  console.log(`   Actual: "${actual}"`);
  console.log(`   Merged: ${result.merged}`);
  console.log(`   Reason: ${result.reason}`);
  
  return result.merged && actual === expected;
});

// Test 3: Single word missing at start
test('Prefix overlap: Single word missing from start', () => {
  const bufferedText = 'gathered together in My name';
  const recoveredText = 'are gathered together in My name';
  
  const result = mergeRecoveryText(bufferedText, recoveredText, { mode: 'Test' });
  
  const expected = 'are gathered together in My name';
  const actual = result.mergedText;
  
  console.log(`   Buffered: "${bufferedText}"`);
  console.log(`   Recovered: "${recoveredText}"`);
  console.log(`   Expected: "${expected}"`);
  console.log(`   Actual: "${actual}"`);
  console.log(`   Merged: ${result.merged}`);
  console.log(`   Reason: ${result.reason}`);
  
  return result.merged && actual === expected;
});

// Test 4: Multiple words missing at start with punctuation
test('Prefix overlap: Multiple words missing with punctuation', () => {
  const bufferedText = 'gathered together in My name.';
  const recoveredText = 'Where two or three are gathered together in My name.';
  
  const result = mergeRecoveryText(bufferedText, recoveredText, { mode: 'Test' });
  
  const expected = 'Where two or three are gathered together in My name';
  const actual = result.mergedText;
  
  console.log(`   Buffered: "${bufferedText}"`);
  console.log(`   Recovered: "${recoveredText}"`);
  console.log(`   Expected: "${expected}"`);
  console.log(`   Actual: "${actual}"`);
  console.log(`   Merged: ${result.merged}`);
  console.log(`   Reason: ${result.reason}`);
  
  // Check that "Where two or three" is at the start
  return result.merged && actual.startsWith('Where two or three');
});

// Test 5: Ensure existing suffix overlap still works (regression test)
test('Regression: Suffix overlap still works (words missing at end)', () => {
  const bufferedText = 'Life is best spent';
  const recoveredText = 'Life is best spent fulfilling our desires';
  
  const result = mergeRecoveryText(bufferedText, recoveredText, { mode: 'Test' });
  
  const expected = 'Life is best spent fulfilling our desires';
  const actual = result.mergedText;
  
  console.log(`   Buffered: "${bufferedText}"`);
  console.log(`   Recovered: "${recoveredText}"`);
  console.log(`   Expected: "${expected}"`);
  console.log(`   Actual: "${actual}"`);
  console.log(`   Merged: ${result.merged}`);
  console.log(`   Reason: ${result.reason}`);
  
  return result.merged && actual === expected;
});

// Test 6: Word overlap case (should append only new words after overlap)
test('Word overlap: Should append only new words after overlap', () => {
  const bufferedText = 'This is sentence one';
  const recoveredText = 'This is sentence two';
  
  const result = mergeRecoveryText(bufferedText, recoveredText, { mode: 'Test' });
  
  // Should append only "two" since "sentence" overlaps (not entire recovery)
  const expected = 'This is sentence one two';
  const actual = result.mergedText;
  
  console.log(`   Buffered: "${bufferedText}"`);
  console.log(`   Recovered: "${recoveredText}"`);
  console.log(`   Expected: "${expected}"`);
  console.log(`   Actual: "${actual}"`);
  console.log(`   Merged: ${result.merged}`);
  console.log(`   Reason: ${result.reason}`);
  
  return result.merged && actual === expected;
});

// Test 7: Exact match (should return buffered text)
test('Exact match: Should return buffered text', () => {
  const bufferedText = 'are gathered together in My name';
  const recoveredText = 'are gathered together in My name';
  
  const result = mergeRecoveryText(bufferedText, recoveredText, { mode: 'Test' });
  
  const expected = 'are gathered together in My name';
  const actual = result.mergedText;
  
  console.log(`   Buffered: "${bufferedText}"`);
  console.log(`   Recovered: "${recoveredText}"`);
  console.log(`   Expected: "${expected}"`);
  console.log(`   Actual: "${actual}"`);
  console.log(`   Merged: ${result.merged}`);
  console.log(`   Reason: ${result.reason}`);
  
  return result.merged && actual === expected;
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log(`\n📊 Test Summary:`);
console.log(`   Total: ${totalTests}`);
console.log(`   Passed: ${passedTests}`);
console.log(`   Failed: ${totalTests - passedTests}`);
console.log(`   Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%\n`);

if (passedTests === totalTests) {
  console.log('✅ All tests passed!\n');
  process.exit(0);
} else {
  console.log('❌ Some tests failed. See details above.\n');
  process.exit(1);
}

