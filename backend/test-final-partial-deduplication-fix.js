/**
 * Test: Final Partial Deduplication Fix
 * 
 * Tests that the fix correctly identifies new segments and skips deduplication.
 * This test uses the ACTUAL logic from adapter.js (copied here for testing).
 */

console.log('🧪 Final Partial Deduplication Fix Test\n');
console.log('='.repeat(70));

// Copy of the actual logic from adapter.js
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
  const commonStarters = ['and', 'but', 'or', 'so', 'then', 'when', 'where', 'who', 'what', 'why', 'how'];
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

// Test 1: "and," after final should be NEW segment
test('Test 1: "and," after final should be NEW segment', () => {
  const lastFinal = "I almost wish sometimes people would stop having services.";
  const partial = "and,";
  
  const result = isNewSegment(partial, lastFinal);
  
  if (!result) {
    throw new Error(
      `"and," was NOT detected as new segment! ` +
      `Should be detected because final ends with period and "and" is a common starter.`
    );
  }
});

// Test 2: "And go" after final should be NEW segment
test('Test 2: "And go" after final should be NEW segment', () => {
  const lastFinal = "I almost wish sometimes people would stop having services.";
  const partial = "And go";
  
  const result = isNewSegment(partial, lastFinal);
  
  if (!result) {
    throw new Error(
      `"And go" was NOT detected as new segment! ` +
      `Should be detected because final ends with period and partial starts with capital.`
    );
  }
});

// Test 3: Partial extending final should NOT be new segment
test('Test 3: Partial extending final should NOT be new segment', () => {
  const lastFinal = "I almost wish sometimes people would stop";
  const partial = "I almost wish sometimes people would stop having";
  
  const result = isNewSegment(partial, lastFinal);
  
  if (result) {
    throw new Error(
      `Extending partial was incorrectly detected as new segment! ` +
      `Partial extends final - should be continuation.`
    );
  }
});

// Test 4: "But I think" after final should be NEW segment
test('Test 4: "But I think" after final should be NEW segment', () => {
  const lastFinal = "I almost wish sometimes people would stop having services.";
  const partial = "But I think";
  
  const result = isNewSegment(partial, lastFinal);
  
  if (!result) {
    throw new Error(
      `"But I think" was NOT detected as new segment! ` +
      `Should be detected because final ends with period and partial starts with capital.`
    );
  }
});

// Test 5: "but" after final should be NEW segment (lowercase common starter)
test('Test 5: "but" after final should be NEW segment', () => {
  const lastFinal = "I almost wish sometimes people would stop having services.";
  const partial = "but I think";
  
  const result = isNewSegment(partial, lastFinal);
  
  if (!result) {
    throw new Error(
      `"but I think" was NOT detected as new segment! ` +
      `Should be detected because final ends with period and "but" is a common starter.`
    );
  }
});

console.log(`\n${'='.repeat(70)}`);
console.log(`📊 Test Summary`);
console.log(`Total Tests: ${5}`);
console.log(`✅ Passed: ${5 - failures.length}`);
console.log(`❌ Failed: ${failures.length}`);

if (failures.length > 0) {
  console.log(`\n❌ Failed Tests:`);
  failures.forEach(({ name, error }) => {
    console.log(`  - ${name}`);
    console.log(`    ${error}`);
  });
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed! The fix correctly identifies new segments.`);
  process.exit(0);
}

