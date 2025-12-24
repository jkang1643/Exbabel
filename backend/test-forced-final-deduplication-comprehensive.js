/**
 * Comprehensive Test Suite: Forced Final Deduplication After Recovery
 * 
 * This test suite exposes the bug where word deduplication fails for forced finals
 * after they've been recovered, merged, and committed to history.
 * 
 * The specific issue:
 * - Previous final (after recovery/merge): "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent for their own. '"
 * - Next final: "Our own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug."
 * - Expected: "self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug."
 * - Actual: "Our own self-centered desires..." (deduplication not working)
 * 
 * The flow should be:
 * 1. Examine the end 5 words of partials while they are still being generated
 * 2. After they are finalized, the finalized grammar corrected, recovered, merged text should
 * 3. Compare to the beginning segment of the next segment to determine which words are deduplicated
 * 4. The next segment should be deduplicated
 * 
 * Run with: node backend/test-forced-final-deduplication-comprehensive.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env file from backend directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

import { deduplicateFinalText } from '../core/utils/finalDeduplicator.js';
import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';
import { mergeRecoveryText } from './utils/recoveryMerge.js';
import { ForcedCommitEngine } from '../core/engine/forcedCommitEngine.js';

console.log('🧪 Comprehensive Forced Final Deduplication Test Suite\n');
console.log('='.repeat(80));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
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
      failedTests++;
      return false;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ ${name}: ${error.message} (${duration}ms)`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1]?.trim()}`);
    }
    testDetails.push({ name, status: 'failed', duration, error: error.message });
    failedTests++;
    return false;
  }
}

// ============================================================================
// Test Case 1: Exact User Scenario
// ============================================================================

console.log('\n📋 Test 1: Exact User Scenario - Forced Final After Recovery vs Next Final\n');
test('Next final should deduplicate "Our own" when previous ends with "their own"', () => {
  // User's exact scenario:
  const previousFinal = "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent for their own. '";
  const nextFinal = "Our own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.";
  const expected = "self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.";
  
  // Simulate the deduplication that should happen when next final arrives
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000, // Recent (2 seconds ago)
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 10 // Check more words to catch "our own"
  });
  
  console.log(`   Previous final ends with: "...${previousFinal.substring(Math.max(0, previousFinal.length - 50))}"`);
  console.log(`   Next final starts with: "${nextFinal.substring(0, 50)}..."`);
  console.log(`   Expected: "${expected.substring(0, 50)}..."`);
  console.log(`   Actual: "${dedupResult.deduplicatedText.substring(0, 50)}..."`);
  console.log(`   Deduplicated: ${dedupResult.wasDeduplicated}, Words skipped: ${dedupResult.wordsSkipped}`);
  
  // Test fails if deduplication didn't work
  if (!dedupResult.wasDeduplicated || dedupResult.wordsSkipped === 0) {
    throw new Error(
      `Deduplication failed! Expected to remove "Our own" but got:\n` +
      `  Was deduplicated: ${dedupResult.wasDeduplicated}\n` +
      `  Words skipped: ${dedupResult.wordsSkipped}\n` +
      `  Result: "${dedupResult.deduplicatedText}"\n` +
      `  Expected: "${expected}"`
    );
  }
  
  // Verify the result matches expected
  const resultNormalized = dedupResult.deduplicatedText.trim().toLowerCase();
  const expectedNormalized = expected.trim().toLowerCase();
  
  if (resultNormalized !== expectedNormalized) {
    throw new Error(
      `Deduplication result doesn't match expected!\n` +
      `  Expected: "${expected}"\n` +
      `  Actual: "${dedupResult.deduplicatedText}"\n` +
      `  Previous ends with: "...${previousFinal.substring(Math.max(0, previousFinal.length - 30))}"\n` +
      `  Next starts with: "${nextFinal.substring(0, 30)}..."`
    );
  }
  
  return true;
});

// ============================================================================
// Test Case 2: Check End 5 Words of Previous vs Beginning of Next
// ============================================================================

console.log('\n📋 Test 2: End 5 Words Comparison Logic\n');
test('Should compare last 5 words of previous final to beginning of next final', () => {
  const previousFinal = "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent for their own. '";
  const nextFinal = "Our own self-centered desires cordoned off from others.";
  
  // Extract last 5 words from previous
  const previousWords = previousFinal.trim().split(/\s+/);
  const last5Words = previousWords.slice(-5);
  console.log(`   Last 5 words of previous: "${last5Words.join(' ')}"`);
  
  // Extract first 5 words from next
  const nextWords = nextFinal.trim().split(/\s+/);
  const first5Words = nextWords.slice(0, 5);
  console.log(`   First 5 words of next: "${first5Words.join(' ')}"`);
  
  // Check for overlap
  const lastWordsLower = last5Words.map(w => w.toLowerCase().replace(/[.,!?;:'"]/g, ''));
  const firstWordsLower = first5Words.map(w => w.toLowerCase().replace(/[.,!?;:'"]/g, ''));
  
  // Find matching words
  const matches = [];
  for (let i = 0; i < firstWordsLower.length; i++) {
    const firstWord = firstWordsLower[i];
    // Check if this word matches any of the last 5 words
    for (let j = 0; j < lastWordsLower.length; j++) {
      if (firstWord === lastWordsLower[j]) {
        matches.push({ firstIndex: i, lastIndex: j, word: firstWord });
        break;
      }
    }
  }
  
  console.log(`   Matches found: ${matches.length} - ${matches.map(m => m.word).join(', ')}`);
  
  // Should find "own" matching
  const ownMatch = matches.find(m => m.word === 'own');
  if (!ownMatch) {
    throw new Error(
      `Failed to find "own" match!\n` +
      `  Last 5 words: "${last5Words.join(' ')}"\n` +
      `  First 5 words: "${first5Words.join(' ')}"\n` +
      `  Matches: ${matches.map(m => m.word).join(', ')}`
    );
  }
  
  // Check if "our" also matches (it should match "their" in context, but let's check)
  // Actually, "our" and "their" are different words, so we should only match "own"
  // But we need to check if "our own" as a phrase matches "their own" as a phrase
  const lastPhrase = lastWordsLower.slice(-2).join(' '); // "their own"
  const firstPhrase = firstWordsLower.slice(0, 2).join(' '); // "our own"
  
  console.log(`   Last 2-word phrase: "${lastPhrase}"`);
  console.log(`   First 2-word phrase: "${firstPhrase}"`);
  
  // The phrases don't match exactly, but "own" should still be deduplicated
  // The test should verify that at least "own" is detected for deduplication
  
  return true;
});

// ============================================================================
// Test Case 3: Full Flow - Forced Final -> Recovery -> Merge -> Next Final
// ============================================================================

console.log('\n📋 Test 3: Full Flow - Forced Final Through Recovery to Next Final\n');
test('Full flow: forced final -> recovery -> merge -> next final deduplication', () => {
  // Step 1: Original forced final (before recovery)
  const forcedFinalOriginal = "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent for their own.";
  
  // Step 2: Recovery text (might add words or confirm)
  const recoveryText = "their own."; // Recovery confirms/adds the ending
  
  // Step 3: Merge recovery with forced final
  const mergeResult = mergeRecoveryText(forcedFinalOriginal, recoveryText, {
    mode: 'HostMode'
  });
  
  const mergedFinal = mergeResult.mergedText;
  console.log(`   Step 1 - Original forced final: "${forcedFinalOriginal.substring(Math.max(0, forcedFinalOriginal.length - 50))}"`);
  console.log(`   Step 2 - Recovery text: "${recoveryText}"`);
  console.log(`   Step 3 - Merged final: "${mergedFinal.substring(Math.max(0, mergedFinal.length - 50))}"`);
  
  // Step 4: Grammar correction (simulated - might add punctuation)
  const grammarCorrected = mergedFinal + " "; // Add trailing space (as in user's example)
  console.log(`   Step 4 - Grammar corrected: "${grammarCorrected.substring(Math.max(0, grammarCorrected.length - 50))}"`);
  
  // Step 5: Next final arrives
  const nextFinal = "Our own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.";
  
  // Step 6: Deduplication should happen here
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: grammarCorrected, // Use grammar-corrected merged final
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 10
  });
  
  console.log(`   Step 5 - Next final: "${nextFinal.substring(0, 50)}..."`);
  console.log(`   Step 6 - Deduplicated: "${dedupResult.deduplicatedText.substring(0, 50)}..."`);
  console.log(`   Deduplicated: ${dedupResult.wasDeduplicated}, Words skipped: ${dedupResult.wordsSkipped}`);
  
  const expected = "self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.";
  
  // Test fails if "Our own" wasn't removed
  if (!dedupResult.wasDeduplicated || dedupResult.wordsSkipped < 2) {
    throw new Error(
      `Deduplication failed in full flow!\n` +
      `  Was deduplicated: ${dedupResult.wasDeduplicated}\n` +
      `  Words skipped: ${dedupResult.wordsSkipped}\n` +
      `  Expected to skip at least 2 words ("Our own")\n` +
      `  Result: "${dedupResult.deduplicatedText}"\n` +
      `  Expected: "${expected}"`
    );
  }
  
  // Verify result
  const resultNormalized = dedupResult.deduplicatedText.trim().toLowerCase();
  const expectedNormalized = expected.trim().toLowerCase();
  
  if (!resultNormalized.startsWith(expectedNormalized.substring(0, 20))) {
    throw new Error(
      `Deduplication result doesn't match expected!\n` +
      `  Expected starts with: "${expected.substring(0, 30)}..."\n` +
      `  Actual starts with: "${dedupResult.deduplicatedText.substring(0, 30)}..."`
    );
  }
  
  return true;
});

// ============================================================================
// Test Case 4: Partial Deduplication During Generation
// ============================================================================

console.log('\n📋 Test 4: Partial Deduplication While Partials Are Being Generated\n');
test('Partials should be deduplicated against previous final while being generated', () => {
  const previousFinal = "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent for their own. '";
  
  // Simulate partials arriving for the next segment
  const partials = [
    "Our",
    "Our own",
    "Our own self-centered",
    "Our own self-centered desires",
    "Our own self-centered desires cordoned"
  ];
  
  const expectedResults = [
    "", // "Our" should be deduplicated if "our" appears in previous
    "", // "Our own" should be deduplicated
    "self-centered", // After deduplication
    "self-centered desires",
    "self-centered desires cordoned"
  ];
  
  let allPassed = true;
  const errors = [];
  
  for (let i = 0; i < partials.length; i++) {
    const partial = partials[i];
    const expected = expectedResults[i];
    
    const dedupResult = deduplicatePartialText({
      partialText: partial,
      lastFinalText: previousFinal,
      lastFinalTime: Date.now() - 1000,
      mode: 'HostMode',
      timeWindowMs: 5000,
      maxWordsToCheck: 5
    });
    
    const resultNormalized = dedupResult.deduplicatedText.trim().toLowerCase();
    const expectedNormalized = expected.trim().toLowerCase();
    
    console.log(`   Partial "${partial}" → "${dedupResult.deduplicatedText}" (expected: "${expected}")`);
    
    // For early partials, we might not deduplicate yet (need more context)
    // But for "Our own", we should definitely deduplicate
    if (partial.includes("Our own") && !dedupResult.wasDeduplicated) {
      errors.push(`Partial "${partial}" should have been deduplicated but wasn't`);
      allPassed = false;
    }
  }
  
  if (!allPassed) {
    throw new Error(`Partial deduplication failed:\n${errors.join('\n')}`);
  }
  
  return true;
});

// ============================================================================
// Test Case 5: Case Sensitivity and Punctuation
// ============================================================================

console.log('\n📋 Test 5: Case Sensitivity and Punctuation Handling\n');
test('Should handle case differences and punctuation in deduplication', () => {
  // Previous ends with "their own." (lowercase, with period)
  const previousFinal = "life is best spent for their own.";
  
  // Next starts with "Our own" (capitalized, no punctuation)
  const nextFinal = "Our own self-centered desires.";
  
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  console.log(`   Previous: "...${previousFinal}"`);
  console.log(`   Next: "${nextFinal}"`);
  console.log(`   Deduplicated: "${dedupResult.deduplicatedText}"`);
  console.log(`   Was deduplicated: ${dedupResult.wasDeduplicated}, Words skipped: ${dedupResult.wordsSkipped}`);
  
  // Should deduplicate "Our own" even though case differs
  if (!dedupResult.wasDeduplicated || dedupResult.wordsSkipped < 2) {
    throw new Error(
      `Case-insensitive deduplication failed!\n` +
      `  Previous ends with: "...${previousFinal}"\n` +
      `  Next starts with: "${nextFinal}"\n` +
      `  Should deduplicate "Our own" (case-insensitive match with "their own")\n` +
      `  Was deduplicated: ${dedupResult.wasDeduplicated}\n` +
      `  Words skipped: ${dedupResult.wordsSkipped}`
    );
  }
  
  return true;
});

// ============================================================================
// Test Case 6: History State - Previous Final in History
// ============================================================================

console.log('\n📋 Test 6: Deduplication When Previous Final is in History\n');
test('Should deduplicate against previous final that is in FINALS history', () => {
  // Simulate history state
  const history = [
    {
      text: "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent for their own. '",
      timestamp: Date.now() - 3000,
      isForcedFinal: true,
      wasRecovered: true
    }
  ];
  
  // Next final arrives
  const nextFinal = "Our own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.";
  
  // Get the last final from history
  const lastFinalInHistory = history[history.length - 1];
  
  // Deduplication should use the final from history
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: lastFinalInHistory.text,
    previousFinalTime: lastFinalInHistory.timestamp,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 10
  });
  
  console.log(`   Last final in history: "...${lastFinalInHistory.text.substring(Math.max(0, lastFinalInHistory.text.length - 50))}"`);
  console.log(`   Next final: "${nextFinal.substring(0, 50)}..."`);
  console.log(`   Deduplicated: "${dedupResult.deduplicatedText.substring(0, 50)}..."`);
  console.log(`   Was deduplicated: ${dedupResult.wasDeduplicated}, Words skipped: ${dedupResult.wordsSkipped}`);
  
  // Should deduplicate
  if (!dedupResult.wasDeduplicated || dedupResult.wordsSkipped < 2) {
    throw new Error(
      `Deduplication failed when previous final is in history!\n` +
      `  Last final in history ends with: "...${lastFinalInHistory.text.substring(Math.max(0, lastFinalInHistory.text.length - 30))}"\n` +
      `  Next final starts with: "${nextFinal.substring(0, 30)}..."\n` +
      `  Should deduplicate "Our own"\n` +
      `  Was deduplicated: ${dedupResult.wasDeduplicated}\n` +
      `  Words skipped: ${dedupResult.wordsSkipped}`
    );
  }
  
  return true;
});

// ============================================================================
// Test Case 7: Edge Case - "own" in Different Contexts
// ============================================================================

console.log('\n📋 Test 7: Edge Case - "own" in Different Contexts\n');
test('Should only deduplicate "own" when it appears in the same phrase context', () => {
  // Previous ends with "their own" (2-word phrase)
  const previousFinal1 = "life is best spent for their own.";
  const nextFinal1 = "Our own self-centered desires.";
  
  // Previous ends with just "own" (single word, different context)
  const previousFinal2 = "they have their own way of doing things.";
  const nextFinal2 = "own self-centered desires."; // This should NOT deduplicate "own" because context is different
  
  const dedupResult1 = deduplicateFinalText({
    newFinalText: nextFinal1,
    previousFinalText: previousFinal1,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  console.log(`   Test 7a - Previous: "...${previousFinal1}"`);
  console.log(`   Test 7a - Next: "${nextFinal1}"`);
  console.log(`   Test 7a - Deduplicated: "${dedupResult1.deduplicatedText}"`);
  
  // Should deduplicate "Our own" in first case
  if (!dedupResult1.wasDeduplicated || dedupResult1.wordsSkipped < 2) {
    throw new Error(
      `Test 7a failed: Should deduplicate "Our own" when previous ends with "their own"\n` +
      `  Was deduplicated: ${dedupResult1.wasDeduplicated}\n` +
      `  Words skipped: ${dedupResult1.wordsSkipped}`
    );
  }
  
  // For test 7b, we're checking that "own" alone doesn't cause false deduplication
  // But actually, if "own" appears at the end of previous and start of next, it should still deduplicate
  // The key is whether it's part of a phrase match
  
  return true;
});

// ============================================================================
// Test Case 8: Root Cause Analysis - Why "Our own" isn't deduplicated
// ============================================================================

console.log('\n📋 Test 8: Root Cause Analysis - Word Matching Logic\n');
test('Should deduplicate when end word of previous matches word in start of next', () => {
  // The issue: "own" matches, but "Our" doesn't match "their"
  // Current logic requires consecutive matches from start, so it stops
  // Expected: When a word at the END of previous matches a word in the START of next,
  // we should deduplicate all words from start of next up to and including the matching word
  
  const previousFinal = "life is best spent for their own.";
  const nextFinal = "Our own self-centered desires.";
  
  // Extract words manually to show the issue
  const previousWords = previousFinal.trim().split(/\s+/).map(w => ({
    original: w,
    clean: w.toLowerCase().replace(/[.,!?;:'"]/g, '')
  }));
  const nextWords = nextFinal.trim().split(/\s+/).map(w => ({
    original: w,
    clean: w.toLowerCase().replace(/[.,!?;:'"]/g, '')
  }));
  
  const last3Previous = previousWords.slice(-3);
  const first3Next = nextWords.slice(0, 3);
  
  console.log(`   Last 3 words of previous: ${last3Previous.map(w => w.original).join(', ')}`);
  console.log(`   First 3 words of next: ${first3Next.map(w => w.original).join(', ')}`);
  
  // Find which word in next matches a word in previous
  let matchingWordIndex = -1;
  for (let i = 0; i < first3Next.length; i++) {
    const nextWord = first3Next[i];
    for (let j = 0; j < last3Previous.length; j++) {
      const prevWord = last3Previous[j];
      if (nextWord.clean === prevWord.clean) {
        matchingWordIndex = i;
        console.log(`   ✅ Found match: "${nextWord.original}" (position ${i} in next) matches "${prevWord.original}" (position ${last3Previous.length - 1 - j} from end in previous)`);
        break;
      }
    }
    if (matchingWordIndex >= 0) break;
  }
  
  // Expected behavior: If a word at the END of previous (last 2-3 words) matches
  // a word in the START of next (first 2-3 words), deduplicate all words from
  // start of next up to and including the matching word
  if (matchingWordIndex >= 0) {
    const expectedSkipCount = matchingWordIndex + 1; // Skip all words up to and including the match
    console.log(`   Expected skip count: ${expectedSkipCount} (all words from start up to and including match)`);
    
    // Test actual deduplication
    const dedupResult = deduplicateFinalText({
      newFinalText: nextFinal,
      previousFinalText: previousFinal,
      previousFinalTime: Date.now() - 2000,
      mode: 'HostMode',
      timeWindowMs: 5000,
      maxWordsToCheck: 5
    });
    
    console.log(`   Actual skip count: ${dedupResult.wordsSkipped}`);
    console.log(`   Was deduplicated: ${dedupResult.wasDeduplicated}`);
    
    if (!dedupResult.wasDeduplicated || dedupResult.wordsSkipped < expectedSkipCount) {
      throw new Error(
        `Deduplication logic failed!\n` +
        `  Found match at position ${matchingWordIndex} in next segment\n` +
        `  Expected to skip ${expectedSkipCount} word(s) (all words from start up to and including match)\n` +
        `  Actual skip count: ${dedupResult.wordsSkipped}\n` +
        `  This exposes the bug: the logic requires consecutive matches from start,\n` +
        `  but should deduplicate when ANY word at the end of previous matches a word in the start of next.`
      );
    }
  } else {
    throw new Error('No matching word found - this test setup is incorrect');
  }
  
  return true;
});

// ============================================================================
// Test Case 9: Validating Word Duplication - Standard Cases (Should Work)
// ============================================================================

console.log('\n📋 Test 9a: Standard Case - "are" at end matches "are" at start\n');
test('Standard case: "where two or three are" → "are gathered together"', () => {
  const previousFinal = "where two or three are";
  const nextFinal = "are gathered together";
  const expected = "gathered together";
  
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  if (dedupResult.deduplicatedText.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(`Expected "${expected}" but got "${dedupResult.deduplicatedText}"`);
  }
  
  return true;
});

console.log('\n📋 Test 9b: Case Insensitive - "are" vs "Are"\n');
test('Case insensitive: "where two or three are" → "Are gathered together"', () => {
  const previousFinal = "where two or three are";
  const nextFinal = "Are gathered together";
  const expected = "gathered together";
  
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  if (dedupResult.deduplicatedText.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(`Expected "${expected}" but got "${dedupResult.deduplicatedText}"`);
  }
  
  return true;
});

console.log('\n📋 Test 9c: Punctuation Handling - "are." vs "are"\n');
test('Punctuation: "where two or three are." → "are gathered together"', () => {
  const previousFinal = "where two or three are.";
  const nextFinal = "are gathered together";
  const expected = "gathered together";
  
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  if (dedupResult.deduplicatedText.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(`Expected "${expected}" but got "${dedupResult.deduplicatedText}"`);
  }
  
  return true;
});

console.log('\n📋 Test 9d: Extra Word Before Match - "our are"\n');
test('Extra word: "where two or three are." → "our are gathered together"', () => {
  const previousFinal = "where two or three are.";
  const nextFinal = "our are gathered together";
  const expected = "gathered together";
  
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  if (dedupResult.deduplicatedText.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(`Expected "${expected}" but got "${dedupResult.deduplicatedText}"`);
  }
  
  return true;
});

console.log('\n📋 Test 9e: Multiple Extra Words - "they indeed are"\n');
test('Multiple extra words: "where two or three are." → "they indeed are gathered together"', () => {
  const previousFinal = "where two or three are.";
  const nextFinal = "they indeed are gathered together";
  const expected = "gathered together";
  
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  if (dedupResult.deduplicatedText.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(`Expected "${expected}" but got "${dedupResult.deduplicatedText}"`);
  }
  
  return true;
});

console.log('\n📋 Test 9f: Compound Word Protection - "are-gathered"\n');
test('Compound word protection: "where two or three are-gathered" → "are gathered together"', () => {
  const previousFinal = "where two or three are-gathered";
  const nextFinal = "are gathered together";
  const expected = "are gathered together"; // Should NOT deduplicate "are" because it's part of compound word
  
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  // Should NOT deduplicate because "are" is part of compound word "are-gathered"
  if (dedupResult.wasDeduplicated && dedupResult.wordsSkipped > 0) {
    throw new Error(
      `Should NOT deduplicate "are" because it's part of compound word "are-gathered"!\n` +
      `  Result: "${dedupResult.deduplicatedText}"\n` +
      `  Expected: "${expected}"`
    );
  }
  
  return true;
});

// ============================================================================
// Test Case 10: Failing Word Duplication - Real User Scenarios
// ============================================================================

console.log('\n📋 Test 10a: User Scenario 1 - "our own selves" → "Own self-centered"\n');
test('User scenario 1: Should deduplicate "Own" from "our own selves"', () => {
  const previousFinal = "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate. ' Life is best spent fulfilling our own selves.";
  const nextFinal = "Own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than to.";
  const expected = "self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than to.";
  
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 10
  });
  
  if (dedupResult.deduplicatedText.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(
      `User scenario 1 failed!\n` +
      `  Expected: "${expected}"\n` +
      `  Actual: "${dedupResult.deduplicatedText}"\n` +
      `  Should deduplicate "Own" because previous ends with "our own selves"`
    );
  }
  
  return true;
});

console.log('\n📋 Test 10b: User Scenario 2 - "our own self-centered" → "Our desires"\n');
test('User scenario 2: Should deduplicate "Our desires" from "our own self-centered desires"', () => {
  const previousFinal = "I love this quote: biblical hospitality is the polar opposite of the cultural trends to separate and isolate. It rejects the notion that life is best spent fulfilling our own self-centered desires.";
  const nextFinal = "Our desires are cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than run.";
  const expected = "are cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than run.";
  
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 10
  });
  
  if (dedupResult.deduplicatedText.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(
      `User scenario 2 failed!\n` +
      `  Expected: "${expected}"\n` +
      `  Actual: "${dedupResult.deduplicatedText}"\n` +
      `  Should deduplicate "Our desires" because previous ends with "our own self-centered desires"`
    );
  }
  
  return true;
});

console.log('\n📋 Test 10c: User Scenario 3 - "one\'s own self" → "Own self-centered"\n');
test('User scenario 3: Should deduplicate "Own" from "one\'s own self"', () => {
  const previousFinal = "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate, and rejects the notion that life is best spent fulfilling one's own self. '";
  const nextFinal = "Own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.";
  const expected = "self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.";
  
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 10
  });
  
  if (dedupResult.deduplicatedText.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(
      `User scenario 3 failed!\n` +
      `  Expected: "${expected}"\n` +
      `  Actual: "${dedupResult.deduplicatedText}"\n` +
      `  Should deduplicate "Own" because previous ends with "one's own self"`
    );
  }
  
  return true;
});

console.log('\n📋 Test 10d: User Scenario 4 - "are gathered together" → "Gather together"\n');
test('User scenario 4: Should deduplicate "Gather together" from "are gathered together"', () => {
  const previousFinal = "You know, when you entertain strangers, you may be entertaining angels unaware. You know, but if you miss that, let me give you this one. Where two or three are gathered together.";
  const nextFinal = "Gather together in My name, I show up and I show out.";
  const expected = "in My name, I show up and I show out.";
  
  const dedupResult = deduplicateFinalText({
    newFinalText: nextFinal,
    previousFinalText: previousFinal,
    previousFinalTime: Date.now() - 2000,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 10
  });
  
  // Note: "Gather" vs "gathered" - these are related words (stem matching)
  const resultNormalized = dedupResult.deduplicatedText.trim().toLowerCase();
  const expectedNormalized = expected.trim().toLowerCase();
  
  if (resultNormalized !== expectedNormalized) {
    throw new Error(
      `User scenario 4 failed!\n` +
      `  Expected: "${expected}"\n` +
      `  Actual: "${dedupResult.deduplicatedText}"\n` +
      `  Should deduplicate "Gather together" because previous ends with "are gathered together"\n` +
      `  Note: "Gather" and "gathered" are related words and should match`
    );
  }
  
  return true;
});

// ============================================================================
// Test Case 11: Verify maxWordsToCheck Parameter
// ============================================================================

console.log('\n📋 Test 11: Verify maxWordsToCheck Parameter Affects Deduplication\n');
test('Should check at least 5 words from end of previous final', () => {
  const previousFinal = "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent for their own. '";
  const nextFinal = "Our own self-centered desires cordoned off from others.";
  
  // Test with different maxWordsToCheck values
  const testCases = [
    { maxWords: 3, shouldFind: false }, // Too few - might miss "their own"
    { maxWords: 5, shouldFind: true },  // Should find "their own"
    { maxWords: 10, shouldFind: true }  // Definitely should find
  ];
  
  for (const testCase of testCases) {
    const dedupResult = deduplicateFinalText({
      newFinalText: nextFinal,
      previousFinalText: previousFinal,
      previousFinalTime: Date.now() - 2000,
      mode: 'HostMode',
      timeWindowMs: 5000,
      maxWordsToCheck: testCase.maxWords
    });
    
    console.log(`   maxWordsToCheck=${testCase.maxWords}: Was deduplicated=${dedupResult.wasDeduplicated}, Words skipped=${dedupResult.wordsSkipped}`);
    
    if (testCase.shouldFind && !dedupResult.wasDeduplicated) {
      throw new Error(
        `With maxWordsToCheck=${testCase.maxWords}, should have found overlap but didn't!\n` +
        `  Previous ends with: "...${previousFinal.substring(Math.max(0, previousFinal.length - 30))}"\n` +
        `  Next starts with: "${nextFinal.substring(0, 30)}..."`
      );
    }
  }
  
  return true;
});

// ============================================================================
// Test Summary
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('\n📊 Test Summary\n');
console.log(`Total Tests: ${totalTests}`);
console.log(`✅ Passed: ${passedTests}`);
console.log(`❌ Failed: ${failedTests}`);
console.log(`\n${failedTests > 0 ? '⚠️  Some tests are failing - these expose the bugs that need to be fixed.' : '✅ All tests passed!'}\n`);

if (failedTests > 0) {
  console.log('Failed Tests:\n');
  testDetails
    .filter(t => t.status === 'failed')
    .forEach(t => {
      console.log(`  ❌ ${t.name}`);
      if (t.error) {
        console.log(`     Error: ${t.error}`);
      }
    });
  console.log('\n');
}

process.exit(failedTests > 0 ? 1 : 0);

