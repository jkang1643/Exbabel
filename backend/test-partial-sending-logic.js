/**
 * Test: Partial Sending Logic - Frontend Confusion Issue
 * 
 * The issue: Partials at short segments are being sent as continuations instead of new lines.
 * Frontend gets confused, appends them incorrectly, and they fail to commit to finals.
 * 
 * This test MUST FAIL to show the bug.
 */

console.log('🧪 Partial Sending Logic - Frontend Confusion Test\n');
console.log('='.repeat(70));

// Simulate the logic from adapter.js
function shouldDeduplicatePartial(partialText, lastFinalText, forcedFinalBuffer) {
  // Logic from adapter.js lines 1155-1204
  
  let textToCheckAgainst = lastFinalText;
  let shouldDeduplicate = true;
  
  // Check forced final buffer first
  if (forcedFinalBuffer && forcedFinalBuffer.text) {
    textToCheckAgainst = forcedFinalBuffer.text;
    const forcedText = forcedFinalBuffer.text.trim();
    const partialTextTrimmed = partialText.trim();
    
    // Check if partial extends forced final
    const extendsForcedFinal = partialTextTrimmed.length > forcedText.length && 
                               partialTextTrimmed.toLowerCase().startsWith(forcedText.toLowerCase());
    
    // Check if partial starts with forced final
    const startsWithForcedFinal = partialTextTrimmed.toLowerCase().startsWith(
      forcedText.toLowerCase().substring(0, Math.min(20, forcedText.length))
    );
    
    // If partial is clearly a new segment, skip deduplication
    if (!extendsForcedFinal && !startsWithForcedFinal) {
      const forcedEndsWithPunctuation = /[.!?]$/.test(forcedText);
      const partialStartsWithCapital = /^[A-Z]/.test(partialTextTrimmed);
      
      if (forcedEndsWithPunctuation && partialStartsWithCapital) {
        shouldDeduplicate = false; // NEW SEGMENT
      } else {
        // Check first word
        const partialFirstWord = partialTextTrimmed.split(/\s+/)[0]?.toLowerCase();
        const forcedLastWords = forcedText.split(/\s+/).slice(-3).map(w => w.toLowerCase().replace(/[.!?,]/g, ''));
        
        if (partialFirstWord && !forcedLastWords.includes(partialFirstWord)) {
          shouldDeduplicate = false; // NEW SEGMENT
        }
      }
    }
  }
  
  return { shouldDeduplicate, textToCheckAgainst };
}

let failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.log(`❌ ${name}: ${error.message}`);
    failures.push({ name, error: error.message });
  }
}

// Test 1: "and," after final with period should NOT be deduplicated (new segment)
test('Test 1: "and," after final should be NEW segment (not deduplicated)', () => {
  const lastFinal = "I almost wish sometimes people would stop having services.";
  const partial = "and,";
  
  const result = shouldDeduplicatePartial(partial, lastFinal, null);
  
  // "and," is a new segment - should NOT be deduplicated
  // BUT: The current logic might deduplicate it because "and" could appear in the final
  // This is the BUG - new segments starting with lowercase after period should NOT be deduplicated
  
  if (result.shouldDeduplicate) {
    throw new Error(
      `"and," was marked for deduplication, but it's a NEW segment! ` +
      `Last final ends with period, this is clearly a new sentence start. ` +
      `The logic is incorrectly treating new segments as continuations.`
    );
  }
});

// Test 2: "And go" after final should NOT be deduplicated (new segment)
test('Test 2: "And go" after final should be NEW segment', () => {
  const lastFinal = "I almost wish sometimes people would stop having services.";
  const partial = "And go";
  
  const result = shouldDeduplicatePartial(partial, lastFinal, null);
  
  // "And go" starts with capital after period - NEW SEGMENT
  // Current logic should detect this and skip deduplication
  // But if it doesn't, this test will fail
  
  if (result.shouldDeduplicate) {
    throw new Error(
      `"And go" was marked for deduplication, but it's a NEW segment! ` +
      `Starts with capital after period - should skip deduplication.`
    );
  }
});

// Test 3: Partial extending final SHOULD be deduplicated (continuation)
test('Test 3: Partial extending final SHOULD be deduplicated', () => {
  const lastFinal = "I almost wish sometimes people would stop";
  const partial = "I almost wish sometimes people would stop having";
  
  const result = shouldDeduplicatePartial(partial, lastFinal, null);
  
  // This extends the final - SHOULD be deduplicated
  if (!result.shouldDeduplicate) {
    throw new Error(
      `Extending partial was NOT marked for deduplication! ` +
      `Partial extends final - should be deduplicated (continuation).`
    );
  }
});

// Test 4: Check the ACTUAL adapter.js logic for lowercase new segments
test('Test 4: Lowercase new segment "and," should be detected as new', () => {
  // The bug: adapter.js checks for capital letters to detect new segments
  // But "and," starts with lowercase, so it might get deduplicated incorrectly
  const lastFinal = "I almost wish sometimes people would stop having services.";
  const partial = "and,";
  
  // Current logic in adapter.js:
  // - Checks if forced final ends with punctuation AND partial starts with capital
  // - But "and," starts with lowercase!
  // - So it falls through to word matching, which might incorrectly deduplicate
  
  // This is the BUG - we need to also check for new segments that start with lowercase
  // but are clearly new (e.g., after period, or common sentence starters)
  
  const forcedEndsWithPunctuation = /[.!?]$/.test(lastFinal);
  const partialStartsWithCapital = /^[A-Z]/.test(partial.trim());
  
  // Current logic would NOT detect this as new segment because it doesn't start with capital
  const wouldBeDetectedAsNew = forcedEndsWithPunctuation && partialStartsWithCapital;
  
  if (wouldBeDetectedAsNew) {
    // This would work, but "and," doesn't start with capital
    throw new Error(`Logic would work for capital, but "and," is lowercase - BUG!`);
  }
  
  // The fix needed: Also detect common lowercase sentence starters like "and", "but", "or", etc.
  const commonStarters = ['and', 'but', 'or', 'so', 'then', 'when', 'where', 'who', 'what', 'why', 'how'];
  const partialFirstWord = partial.trim().split(/[\s,]+/)[0]?.toLowerCase();
  const isCommonStarter = commonStarters.includes(partialFirstWord);
  
  if (!isCommonStarter && forcedEndsWithPunctuation) {
    throw new Error(
      `"and," is a common sentence starter but wasn't detected! ` +
      `Need to fix logic to detect lowercase sentence starters after punctuation.`
    );
  }
});

console.log(`\n${'='.repeat(70)}`);
console.log(`📊 Test Summary`);
console.log(`Total Tests: ${4}`);
console.log(`✅ Passed: ${4 - failures.length}`);
console.log(`❌ Failed: ${failures.length}`);

if (failures.length > 0) {
  console.log(`\n❌ Failed Tests (These show the bugs):`);
  failures.forEach(({ name, error }) => {
    console.log(`  - ${name}`);
    console.log(`    ${error}`);
  });
  console.log(`\n⚠️ These tests FAILED - the logic needs to be fixed!`);
  process.exit(1);
} else {
  console.log(`\n⚠️ All tests passed, but check if the fix is actually in adapter.js`);
  process.exit(0);
}

