/**
 * Test suite to identify why "Oh my!" partial is missing
 * 
 * Scenario from user transcript:
 * - FINAL #4: "You gotta care about Him."
 * - MISSING: "Oh my!" (should appear as partial between #4 and #5)
 * - FINAL #5: "You just can't beat people up with doctrine all the time."
 * 
 * Goal: Use TDD to find which condition is filtering out "Oh my!"
 */

import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';

/**
 * Simulates the partial filtering logic from host/adapter.js
 * This extracts the key conditions that might filter out partials
 */
function shouldSkipPartial(params) {
  const {
    partialText,
    lastSentFinalText,
    lastSentFinalTime,
    hasPendingFinal,
    forcedFinalBuffer,
    currentTime = Date.now()
  } = params;

  // Step 1: Deduplication check (lines 1169-1187)
  let partialTextToSend = partialText;
  let shouldDeduplicate = true;
  
  if (lastSentFinalText) {
    const dedupResult = deduplicatePartialText({
      partialText: partialText,
      lastFinalText: lastSentFinalText,
      lastFinalTime: lastSentFinalTime,
      mode: 'HostMode',
      timeWindowMs: 5000,
      maxWordsToCheck: 3
    });
    
    partialTextToSend = dedupResult.deduplicatedText;
    
    // If all words were duplicates, skip sending this partial entirely
    if (dedupResult.wasDeduplicated && (!partialTextToSend || partialTextToSend.length < 3)) {
      return { skip: true, reason: 'all_words_duplicates', dedupResult };
    }
  }
  
  // Step 2: Check if partial extends a final (lines 1213-1229)
  let extendsAnyFinal = false;
  if (hasPendingFinal) {
    // Simplified - would check pending final text
    extendsAnyFinal = false; // Assume no pending final for this test
  }
  if (!extendsAnyFinal && forcedFinalBuffer && forcedFinalBuffer.text) {
    const forcedText = forcedFinalBuffer.text.trim();
    const partialTextTrimmed = partialTextToSend.trim();
    extendsAnyFinal = partialTextTrimmed.length > forcedText.length && 
                     (partialTextTrimmed.startsWith(forcedText) || 
                      (forcedText.length > 10 && partialTextTrimmed.substring(0, forcedText.length) === forcedText));
  }
  
  // Step 3: Very short partial at segment start check (lines 1231-1247)
  // UPDATED: Changed from < 5 to < 4 to ensure "Oh my!" (5-6 chars) always passes
  const isVeryShortPartial = partialTextToSend.trim().length < 4;
  const timeSinceLastFinal = lastSentFinalTime ? (currentTime - lastSentFinalTime) : Infinity;
  const isNewSegmentStart = !hasPendingFinal && 
                            (!forcedFinalBuffer || !forcedFinalBuffer.recoveryInProgress) &&
                            timeSinceLastFinal < 2000;
  
  if (isVeryShortPartial && isNewSegmentStart && timeSinceLastFinal < 500 && !extendsAnyFinal) {
    return { 
      skip: true, 
      reason: 'very_short_at_segment_start',
      details: {
        isVeryShortPartial,
        isNewSegmentStart,
        timeSinceLastFinal,
        extendsAnyFinal,
        partialLength: partialTextToSend.trim().length
      }
    };
  }
  
  return { skip: false, partialTextToSend, details: { isVeryShortPartial, isNewSegmentStart, timeSinceLastFinal } };
}

// Test cases
console.log('🧪 Testing missing "Oh my!" partial scenario\n');

// Test Case 1: Exact scenario from user
console.log('Test 1: "Oh my!" after "You gotta care about Him." (within 500ms)');
const test1 = shouldSkipPartial({
  partialText: 'Oh my!',
  lastSentFinalText: 'You gotta care about Him.',
  lastSentFinalTime: Date.now() - 300, // 300ms ago
  hasPendingFinal: false,
  forcedFinalBuffer: null,
  currentTime: Date.now()
});
console.log('Result:', test1);
console.log(`Expected: should NOT skip, but got: ${test1.skip ? `SKIPPED (${test1.reason})` : 'PASSED'}`);
console.log(test1.skip ? '❌ FAILED - "Oh my!" is being filtered out!' : '✅ PASSED');
console.log('');

// Test Case 2: "Oh my!" exactly at 5 characters (boundary case)
console.log('Test 2: "Oh my!" is exactly 5 chars - should it be filtered?');
const test2 = shouldSkipPartial({
  partialText: 'Oh my!',
  lastSentFinalText: 'You gotta care about Him.',
  lastSentFinalTime: Date.now() - 300,
  hasPendingFinal: false,
  forcedFinalBuffer: null,
  currentTime: Date.now()
});
console.log(`Partial length: ${test2.partialTextToSend?.trim().length || 'N/A'}`);
console.log('Result:', test2);
console.log('');

// Test Case 3: Very short partial (< 5 chars) at segment start
console.log('Test 3: Very short partial "Hi" (2 chars) at segment start');
const test3 = shouldSkipPartial({
  partialText: 'Hi',
  lastSentFinalText: 'You gotta care about Him.',
  lastSentFinalTime: Date.now() - 300,
  hasPendingFinal: false,
  forcedFinalBuffer: null,
  currentTime: Date.now()
});
console.log('Result:', test3);
console.log(`Expected: should skip (very short), got: ${test3.skip ? 'SKIPPED ✅' : 'PASSED ❌'}`);
console.log('');

// Test Case 4: "Oh my!" after longer delay (should pass)
console.log('Test 4: "Oh my!" after 600ms (should pass)');
const test4 = shouldSkipPartial({
  partialText: 'Oh my!',
  lastSentFinalText: 'You gotta care about Him.',
  lastSentFinalTime: Date.now() - 600,
  hasPendingFinal: false,
  forcedFinalBuffer: null,
  currentTime: Date.now()
});
console.log('Result:', test4);
console.log(`Expected: should NOT skip (delay > 500ms), got: ${test4.skip ? 'SKIPPED ❌' : 'PASSED ✅'}`);
console.log('');

// Test Case 5: Check if deduplication is removing "Oh my!"
console.log('Test 5: Deduplication check for "Oh my!" after "You gotta care about Him."');
const dedupTest = deduplicatePartialText({
  partialText: 'Oh my!',
  lastFinalText: 'You gotta care about Him.',
  lastFinalTime: Date.now() - 300,
  mode: 'HostMode',
  timeWindowMs: 5000,
  maxWordsToCheck: 3
});
console.log('Deduplication result:', dedupTest);
console.log(`Deduplicated text: "${dedupTest.deduplicatedText}"`);
console.log(`Was deduplicated: ${dedupTest.wasDeduplicated}`);
console.log(`Words skipped: ${dedupTest.wordsSkipped}`);
if (dedupTest.wasDeduplicated && (!dedupTest.deduplicatedText || dedupTest.deduplicatedText.length < 3)) {
  console.log('❌ FAILED - Deduplication is removing "Oh my!"');
} else {
  console.log('✅ PASSED - Deduplication is not the issue');
}
console.log('');

// Test Case 6: Check edge case - what if partial comes as "oh my" (lowercase, no punctuation)?
console.log('Test 6: "oh my" (lowercase, no punctuation) - 5 chars');
const test6 = shouldSkipPartial({
  partialText: 'oh my',
  lastSentFinalText: 'You gotta care about Him.',
  lastSentFinalTime: Date.now() - 300,
  hasPendingFinal: false,
  forcedFinalBuffer: null,
  currentTime: Date.now()
});
console.log(`Partial length: ${test6.partialTextToSend?.trim().length || 'N/A'}`);
console.log('Result:', test6);
console.log('');

// Test Case 7: Check if whitespace is affecting length calculation
console.log('Test 7: "Oh my!" with different whitespace');
const variants = [
  'Oh my!',
  'Oh my! ',
  ' Oh my!',
  ' Oh my! ',
];
variants.forEach((variant, idx) => {
  const trimmed = variant.trim();
  console.log(`  Variant ${idx + 1}: "${variant}" (trimmed: "${trimmed}", length: ${trimmed.length})`);
  const isVeryShort = trimmed.length < 5;
  console.log(`    Would be skipped (isVeryShortPartial): ${isVeryShort}`);
});
console.log('');

// Test Case 8: Simulate progressive partials (as Google Speech often does)
console.log('Test 8: Progressive partials simulation');
const progressivePartials = [
  'O',
  'Oh',
  'Oh m',
  'Oh my',
  'Oh my!',
];

// Simulate real scenario: each partial comes 50ms after the previous one
let simulatedTime = Date.now() - 300; // Start 300ms after last final
const sentPartials = [];

progressivePartials.forEach((partial, idx) => {
  simulatedTime += 50; // Each partial arrives 50ms later
  const test = shouldSkipPartial({
    partialText: partial,
    lastSentFinalText: 'You gotta care about Him.',
    lastSentFinalTime: Date.now() - 300,
    hasPendingFinal: false,
    forcedFinalBuffer: null,
    currentTime: simulatedTime
  });
  
  const timeSinceLastFinal = simulatedTime - (Date.now() - 300);
  console.log(`  Partial "${partial}" (${partial.length} chars, +${idx * 50}ms): ${test.skip ? `SKIPPED (${test.reason})` : 'PASSED'}`);
  if (test.details) {
    console.log(`    Details: timeSinceLastFinal=${test.details.timeSinceLastFinal?.toFixed(0)}ms, isVeryShortPartial=${test.details.isVeryShortPartial}`);
  }
  
  if (!test.skip) {
    sentPartials.push({ text: partial, time: simulatedTime });
  }
});

console.log(`\n  ✅ Partials that would be SENT: ${sentPartials.length}`);
sentPartials.forEach(p => console.log(`    - "${p.text}" at +${p.time - (Date.now() - 300)}ms`));

if (sentPartials.length === 0) {
  console.log('  ❌ PROBLEM: NO partials would be sent! "Oh my!" is being completely filtered out.');
} else if (!sentPartials.some(p => p.text.includes('Oh my'))) {
  console.log('  ❌ PROBLEM: "Oh my" partials are NOT being sent!');
} else {
  console.log('  ✅ "Oh my" partials would be sent correctly');
}
console.log('');

// Test Case 9: Edge case - exactly 5 characters (boundary test)
console.log('Test 9: Boundary test - exactly 5 characters');
const exactly5Chars = [
  'Oh my',      // 5 chars (including space)
  'Oh my ',     // 5 chars after trim
  ' Oh my',     // 5 chars after trim
  ' Oh my ',    // 5 chars after trim
];
exactly5Chars.forEach((variant, idx) => {
  const trimmed = variant.trim();
  const test = shouldSkipPartial({
    partialText: variant,
    lastSentFinalText: 'You gotta care about Him.',
    lastSentFinalTime: Date.now() - 300,
    hasPendingFinal: false,
    forcedFinalBuffer: null,
    currentTime: Date.now()
  });
  const isVeryShort = trimmed.length < 5;
  console.log(`  Variant ${idx + 1}: "${variant}" (trimmed: "${trimmed}", length: ${trimmed.length})`);
  console.log(`    isVeryShortPartial: ${isVeryShort} (should be false for 5 chars)`);
  console.log(`    Would skip: ${test.skip ? `YES (${test.reason})` : 'NO'}`);
  if (isVeryShort && trimmed.length === 5) {
    console.log(`    ⚠️  BUG: 5 chars is incorrectly marked as very short!`);
  }
});

// Test Case 10: Check if there's a bug with the < 5 check
console.log('\nTest 10: Testing the actual < 5 comparison');
for (let len = 1; len <= 7; len++) {
  const testStr = 'O'.repeat(len);
  const isVeryShort = testStr.trim().length < 5;
  console.log(`  Length ${len}: "${testStr}" -> isVeryShortPartial = ${isVeryShort}`);
  if (len === 5 && isVeryShort) {
    console.log(`    ❌ BUG: 5 chars should NOT be very short!`);
  }
}

// Test Case 11: Real scenario - "Oh my" vs "Oh my!"
console.log('\nTest 11: Real scenario - "Oh my" (5 chars) vs "Oh my!" (6 chars)');
const realScenario1 = shouldSkipPartial({
  partialText: 'Oh my',  // 5 chars - what Google might send first
  lastSentFinalText: 'You gotta care about Him.',
  lastSentFinalTime: Date.now() - 200,
  hasPendingFinal: false,
  forcedFinalBuffer: null,
  currentTime: Date.now()
});
const realScenario2 = shouldSkipPartial({
  partialText: 'Oh my!',  // 6 chars - with punctuation
  lastSentFinalText: 'You gotta care about Him.',
  lastSentFinalTime: Date.now() - 200,
  hasPendingFinal: false,
  forcedFinalBuffer: null,
  currentTime: Date.now()
});
console.log(`  "Oh my" (5 chars): ${realScenario1.skip ? `SKIPPED (${realScenario1.reason})` : 'PASSED'}`);
console.log(`  "Oh my!" (6 chars): ${realScenario2.skip ? `SKIPPED (${realScenario2.reason})` : 'PASSED'}`);

// Summary
console.log('\n' + '='.repeat(60));
console.log('SUMMARY:');
console.log('='.repeat(60));
console.log('Test 1 (main scenario):', test1.skip ? `❌ FAILED - ${test1.reason}` : '✅ PASSED');
console.log('Test 5 (deduplication):', (dedupTest.wasDeduplicated && (!dedupTest.deduplicatedText || dedupTest.deduplicatedText.length < 3)) ? '❌ FAILED' : '✅ PASSED');
console.log('Test 11 (real scenario):', realScenario1.skip || realScenario2.skip ? `❌ FAILED` : '✅ PASSED');
console.log('');
console.log('🔍 ROOT CAUSE ANALYSIS:');
if (test1.skip || realScenario1.skip || realScenario2.skip) {
  console.log(`  ❌ "Oh my!" is being skipped because: ${test1.skip ? test1.reason : realScenario1.skip ? realScenario1.reason : realScenario2.reason}`);
  if (test1.details || realScenario1.details || realScenario2.details) {
    console.log('  Details:', JSON.stringify(test1.details || realScenario1.details || realScenario2.details, null, 2));
  }
} else {
  console.log('  ⚠️  "Oh my!" should NOT be skipped by this logic.');
  console.log('  🔍 Need to investigate other potential causes:');
  console.log('    - Progressive partials might all be filtered (< 5 chars)');
  console.log('    - Extension check might be incorrectly identifying it as extending a final');
  console.log('    - There might be additional filtering logic not captured in this test');
}

