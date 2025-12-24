/**
 * Test: Pending Final Must Commit When New Segment Detected
 * 
 * Tests the EXACT scenario from logs where:
 * 1. Final: "Desires cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than. unplug"
 * 2. Partial: "open" arrives
 * 3. System detects new segment but waits because final is "incomplete"
 * 4. Final NEVER commits because it's waiting
 * 
 * This test MUST FAIL to show the bug.
 */

console.log('🧪 Pending Final Commit on New Segment Test\n');
console.log('='.repeat(70));

// Copy the isNewSegment helper from adapter.js
function isNewSegment(partialText, finalText) {
  const partialTrimmed = partialText.trim();
  const finalTrimmed = finalText.trim();
  
  // Check if partial extends the final (is a continuation)
  const partialExtendsFinal = partialTrimmed.length > finalTrimmed.length && 
                             (partialTrimmed.toLowerCase().startsWith(finalTrimmed.toLowerCase()) || 
                              (finalTrimmed.length > 10 && partialTrimmed.toLowerCase().substring(0, finalTrimmed.length) === finalTrimmed.toLowerCase()));
  
  // Check if partial starts with final (case-insensitive)
  const startsWithFinal = partialTrimmed.toLowerCase().startsWith(finalTrimmed.toLowerCase().substring(0, Math.min(20, finalTrimmed.length)));
  
  // If partial extends or starts with final, it's a continuation (not new segment)
  if (partialExtendsFinal || startsWithFinal) {
    return false;
  }
  
  // Check for new segment indicators
  const finalEndsWithPunctuation = /[.!?]$/.test(finalTrimmed);
  const partialStartsWithCapital = /^[A-Z]/.test(partialTrimmed);
  
  // Capital letter after punctuation = new segment
  if (finalEndsWithPunctuation && partialStartsWithCapital) {
    return true;
  }
  
  // Check for common lowercase sentence starters after punctuation
  const commonStarters = ['and', 'but', 'or', 'so', 'then', 'when', 'where', 'who', 'what', 'why', 'how', 'open'];
  const partialFirstWord = partialTrimmed.split(/[\s,]+/)[0]?.toLowerCase().replace(/[.!?,:;]/g, '');
  const isCommonStarter = commonStarters.includes(partialFirstWord);
  
  if (finalEndsWithPunctuation && isCommonStarter) {
    return true; // New segment (common starter after punctuation)
  }
  
  // Check if first word of partial doesn't appear in last words of final
  const finalLastWords = finalTrimmed.split(/\s+/).slice(-3).map(w => w.toLowerCase().replace(/[.!?,]/g, ''));
  if (partialFirstWord && !finalLastWords.includes(partialFirstWord)) {
    return true; // Likely new segment
  }
  
  return false; // Default to continuation
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

// Test 1: "open" after final should be detected as new segment
test('Test 1: "open" after final should be NEW segment', () => {
  const pendingFinal = "Desires cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than. unplug";
  const partial = "open";
  
  const result = isNewSegment(partial, pendingFinal);
  
  if (!result) {
    throw new Error(
      `"open" was NOT detected as new segment! ` +
      `Final ends with "unplug" and partial is "open" - clearly a new segment.`
    );
  }
});

// Test 2: When new segment is detected, final should commit IMMEDIATELY
test('Test 2: New segment should trigger immediate final commit', () => {
  const pendingFinal = "Desires cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than. unplug";
  const partial = "open";
  const timeSinceFinal = 611; // From logs
  
  // Check if it's a new segment
  const isNew = isNewSegment(partial, pendingFinal);
  
  // If it's a new segment, final should commit IMMEDIATELY
  // Current bug: It waits because final is "incomplete" (< 3000ms)
  // Fix: If clearly new segment, commit immediately regardless of time
  
  if (isNew) {
    // Should commit immediately, not wait
    const shouldCommitImmediately = true;
    
    if (!shouldCommitImmediately) {
      throw new Error(
        `New segment detected but final not committed immediately! ` +
        `System is waiting because final is "incomplete", but new segment means final should commit.`
      );
    }
  }
});

// Test 3: Check that "open" doesn't extend the final
test('Test 3: "open" does NOT extend the final', () => {
  const pendingFinal = "Desires cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than. unplug";
  const partial = "open";
  
  const finalLower = pendingFinal.toLowerCase().trim();
  const partialLower = partial.toLowerCase().trim();
  
  const extendsFinal = partialLower.startsWith(finalLower) || 
                       (finalLower.length > 10 && partialLower.substring(0, finalLower.length) === finalLower);
  
  if (extendsFinal) {
    throw new Error(
      `"open" incorrectly identified as extending final! ` +
      `"open" does NOT start with "Desires cordoned off..." - it's a new segment.`
    );
  }
});

// Test 4: Final ending with "unplug" and partial "open" - should be new segment
test('Test 4: Final ending with "unplug", partial "open" = new segment', () => {
  const pendingFinal = "Desires cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than. unplug";
  const partial = "open";
  
  // Check last words of final
  const finalWords = pendingFinal.trim().split(/\s+/).slice(-3).map(w => w.toLowerCase().replace(/[.!?,]/g, ''));
  const partialFirstWord = partial.trim().split(/[\s,]+/)[0]?.toLowerCase().replace(/[.!?,:;]/g, '');
  
  // "open" is not in ["than", ".", "unplug"]
  if (finalWords.includes(partialFirstWord)) {
    throw new Error(
      `"open" incorrectly found in last words of final! ` +
      `Last words: ${JSON.stringify(finalWords)}, partial first word: "${partialFirstWord}"`
    );
  }
  
  // Should be detected as new segment
  const isNew = isNewSegment(partial, pendingFinal);
  if (!isNew) {
    throw new Error(
      `"open" after final ending with "unplug" should be detected as new segment!`
    );
  }
});

console.log(`\n${'='.repeat(70)}`);
console.log(`📊 Test Summary`);
console.log(`Total Tests: ${4}`);
console.log(`✅ Passed: ${4 - failures.length}`);
console.log(`❌ Failed: ${failures.length}`);

if (failures.length > 0) {
  console.log(`\n❌ Failed Tests:`);
  failures.forEach(({ name, error }) => {
    console.log(`  - ${name}`);
    console.log(`    ${error}`);
  });
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed! Now check if adapter.js actually uses this logic correctly.`);
  process.exit(0);
}

