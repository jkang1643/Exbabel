/**
 * Integration test simulating the exact user scenario
 * 
 * Sequence:
 * 1. FINAL: "You gotta care about Him." (sent at time T)
 * 2. PARTIAL: "Oh my!" (arrives at T + 300ms) - MISSING
 * 3. FINAL: "You just can't beat people up with doctrine all the time." (arrives later)
 * 
 * Goal: Find why "Oh my!" is not being sent
 */

console.log('🧪 Integration Test: Missing "Oh my!" Scenario\n');

// Simulate the exact filtering logic from adapter.js
function simulatePartialFiltering(params) {
  const {
    partialText,
    lastSentFinalText,
    lastSentFinalTime,
    currentTime,
    hasPendingFinal = false,
    forcedFinalBuffer = null
  } = params;

  console.log(`\n📥 Processing partial: "${partialText}"`);
  console.log(`   Last final: "${lastSentFinalText}"`);
  console.log(`   Time since last final: ${currentTime - lastSentFinalTime}ms`);
  
  // Step 1: Check if partial extends forced final (lines 1043-1107)
  if (forcedFinalBuffer && forcedFinalBuffer.text) {
    const forcedText = forcedFinalBuffer.text.trim();
    const partialTextTrimmed = partialText.trim();
    const extendsForcedFinal = partialTextTrimmed.length > forcedText.length && 
                               (partialTextTrimmed.toLowerCase().startsWith(forcedText.toLowerCase()) || 
                                (forcedText.length > 10 && partialTextTrimmed.toLowerCase().substring(0, forcedText.length) === forcedText.toLowerCase()));
    
    if (extendsForcedFinal) {
      console.log('   ⚠️  Partial extends forced final - would merge and commit (lines 1077-1088)');
      console.log('   ⚠️  Then code CONTINUES to process as partial (line 1088)');
      // Continue processing...
    } else {
      console.log('   ✅ New segment detected - forced final buffer logic continues');
    }
  }
  
  // Step 2: Deduplication check (lines 1115-1187)
  let partialTextToSend = partialText;
  let shouldDeduplicate = true;
  let textToCheckAgainst = lastSentFinalText;
  
  if (forcedFinalBuffer && forcedFinalBuffer.text) {
    textToCheckAgainst = forcedFinalBuffer.text;
    const forcedText = forcedFinalBuffer.text.trim();
    const partialTextTrimmed = partialText.trim();
    
    const forcedEndsWithPunctuation = /[.!?]$/.test(forcedText);
    const partialStartsWithCapital = /^[A-Z]/.test(partialTextTrimmed);
    
    if (forcedEndsWithPunctuation && partialStartsWithCapital) {
      console.log('   ✅ New segment detected - skipping deduplication');
      shouldDeduplicate = false;
    }
  }
  
  if (shouldDeduplicate && textToCheckAgainst) {
    // Simulate deduplication (simplified)
    console.log('   🔍 Would deduplicate against:', textToCheckAgainst.substring(0, 50));
    // For this test, assume no deduplication occurs (as per our earlier tests)
    partialTextToSend = partialText;
  }
  
  // Step 3: Very short partial check (lines 1231-1247)
  // UPDATED: Changed from < 5 to < 4 to ensure "Oh my!" (5-6 chars) always passes
  const isVeryShortPartial = partialTextToSend.trim().length < 4;
  const timeSinceLastFinal = currentTime - lastSentFinalTime;
  const isNewSegmentStart = !hasPendingFinal && 
                            (!forcedFinalBuffer || !forcedFinalBuffer.recoveryInProgress) &&
                            timeSinceLastFinal < 2000;
  
  // Check if partial extends any final (lines 1213-1229)
  let extendsAnyFinal = false;
  // Simplified - assume no extension
  
  console.log(`   📊 Check results:`);
  console.log(`      isVeryShortPartial: ${isVeryShortPartial} (length: ${partialTextToSend.trim().length})`);
  console.log(`      isNewSegmentStart: ${isNewSegmentStart}`);
  console.log(`      timeSinceLastFinal: ${timeSinceLastFinal}ms`);
  console.log(`      extendsAnyFinal: ${extendsAnyFinal}`);
  
  if (isVeryShortPartial && isNewSegmentStart && timeSinceLastFinal < 500 && !extendsAnyFinal) {
    console.log('   ❌ SKIPPED: Very short partial at segment start');
    return { sent: false, reason: 'very_short_at_segment_start' };
  }
  
  console.log('   ✅ PASSED: Partial would be sent');
  return { sent: true };
}

// Test the exact scenario
console.log('='.repeat(60));
console.log('SCENARIO: Missing "Oh my!" after "You gotta care about Him."');
console.log('='.repeat(60));

const baseTime = Date.now();
const finalTime = baseTime;
const partialTime = baseTime + 300; // 300ms after final

// Test Case 1: "Oh my!" after FINAL (no forced final buffer)
console.log('\n📋 Test Case 1: "Oh my!" arrives 300ms after FINAL (no forced final buffer)');
const result1 = simulatePartialFiltering({
  partialText: 'Oh my!',
  lastSentFinalText: 'You gotta care about Him.',
  lastSentFinalTime: finalTime,
  currentTime: partialTime,
  hasPendingFinal: false,
  forcedFinalBuffer: null
});

// Test Case 2: Progressive partials
console.log('\n📋 Test Case 2: Progressive partials');
const progressivePartials = [
  { text: 'O', time: finalTime + 50 },
  { text: 'Oh', time: finalTime + 100 },
  { text: 'Oh m', time: finalTime + 150 },
  { text: 'Oh my', time: finalTime + 200 },
  { text: 'Oh my!', time: finalTime + 250 },
];

progressivePartials.forEach(p => {
  const result = simulatePartialFiltering({
    partialText: p.text,
    lastSentFinalText: 'You gotta care about Him.',
    lastSentFinalTime: finalTime,
    currentTime: p.time,
    hasPendingFinal: false,
    forcedFinalBuffer: null
  });
  if (!result.sent) {
    console.log(`   ⚠️  "${p.text}" was filtered - this is expected for very short partials`);
  }
});

// Test Case 3: "Oh my!" exactly at boundary (5 chars, no punctuation)
console.log('\n📋 Test Case 3: "Oh my" (5 chars, no punctuation) at 300ms');
const result3 = simulatePartialFiltering({
  partialText: 'Oh my',
  lastSentFinalText: 'You gotta care about Him.',
  lastSentFinalTime: finalTime,
  currentTime: partialTime,
  hasPendingFinal: false,
  forcedFinalBuffer: null
});

// Summary
console.log('\n' + '='.repeat(60));
console.log('SUMMARY:');
console.log('='.repeat(60));
console.log(`Test 1 ("Oh my!" 6 chars): ${result1.sent ? '✅ WOULD BE SENT' : `❌ WOULD BE FILTERED (${result1.reason})`}`);
console.log(`Test 3 ("Oh my" 5 chars): ${result3.sent ? '✅ WOULD BE SENT' : `❌ WOULD BE FILTERED (${result3.reason})`}`);

if (!result1.sent) {
  console.log('\n❌ FOUND THE BUG: "Oh my!" is being filtered!');
  console.log(`   Reason: ${result1.reason}`);
} else {
  console.log('\n⚠️  All tests pass - "Oh my!" should NOT be filtered by this logic.');
  console.log('   🔍 The issue must be elsewhere, or there\'s a timing/state issue not captured in this test.');
}

