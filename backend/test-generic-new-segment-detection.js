/**
 * Test: Verify isNewSegment works generically for ANY words, not just hardcoded list
 */

console.log('🧪 Generic New Segment Detection Test\n');
console.log('='.repeat(70));

// Copy the updated isNewSegment logic from adapter.js
function isNewSegment(partialText, finalText) {
  const partialTrimmed = partialText.trim();
  const finalTrimmed = finalText.trim();
  
  if (!partialTrimmed || !finalTrimmed) {
    return false; // Can't determine without both texts
  }
  
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
  
  // Extract words for comparison
  const partialWords = partialTrimmed.toLowerCase().split(/\s+/).filter(w => w.length > 0).map(w => w.replace(/[.!?,:;]/g, ''));
  const finalWords = finalTrimmed.toLowerCase().split(/\s+/).filter(w => w.length > 0).map(w => w.replace(/[.!?,]/g, ''));
  
  if (partialWords.length === 0 || finalWords.length === 0) {
    return false; // Can't determine without words
  }
  
  const partialFirstWord = partialWords[0];
  const finalLastWords = finalWords.slice(-5); // Check last 5 words of final
  
  // Check if first word of partial appears in last words of final
  // If it does, it's likely a continuation
  const firstWordInFinal = finalLastWords.includes(partialFirstWord);
  
  // Check if partial starts with any of the last words of final (handles cases like "unplug" -> "unplugged")
  // CRITICAL: Only match if the final word is at least 3 characters to avoid false matches (e.g., "a" matching "anyrandomword")
  const startsWithFinalWord = finalLastWords.some(finalWord => 
    (finalWord.length >= 3 && partialFirstWord.startsWith(finalWord)) || 
    (partialFirstWord.length >= 3 && finalWord.startsWith(partialFirstWord))
  );
  
  // If first word appears in final or starts with a final word, it's likely a continuation
  if (firstWordInFinal || startsWithFinalWord) {
    return false;
  }
  
  // Check for punctuation + capital letter pattern (strong indicator of new segment)
  const finalEndsWithPunctuation = /[.!?]$/.test(finalTrimmed);
  const partialStartsWithCapital = /^[A-Z]/.test(partialTrimmed);
  
  if (finalEndsWithPunctuation && partialStartsWithCapital) {
    return true; // Strong indicator: punctuation + capital = new segment
  }
  
  // Check if partial shares ANY words with the end of final
  // If no shared words, it's likely a new segment
  const sharedWords = partialWords.filter(w => finalLastWords.includes(w));
  
  // If no shared words AND final ends with punctuation, likely new segment
  // This works for ANY words, not just a hardcoded list
  if (sharedWords.length === 0 && finalEndsWithPunctuation) {
    return true;
  }
  
  // If partial is very short and doesn't share words with final, likely new segment
  // This works for ANY words, not just a hardcoded list
  if (partialWords.length <= 2 && sharedWords.length === 0) {
    return true;
  }
  
  // If no shared words at all (even if no punctuation), likely new segment
  // This is the most generic check - works for ANY words
  if (sharedWords.length === 0) {
    return true;
  }
  
  // Default: if no clear continuation indicators, treat as new segment
  // This is safer than defaulting to continuation, which can cause missed commits
  // Works generically for ANY words, not just specific ones
  return true;
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

// Test 1: "open" after "unplug" - should be new segment (no hardcoded list needed)
test('Test 1: "open" after "unplug" = new segment (generic)', () => {
  const final = "Desires cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than. unplug";
  const partial = "open";
  
  const result = isNewSegment(partial, final);
  
  if (!result) {
    throw new Error(`"open" was NOT detected as new segment! Should work generically without hardcoded list.`);
  }
});

// Test 2: Random word "xyzabc" after final - should be new segment (not in any list)
test('Test 2: Random word "xyzabc" = new segment (generic)', () => {
  const final = "This is a test sentence.";
  const partial = "xyzabc";
  
  const result = isNewSegment(partial, final);
  
  if (!result) {
    throw new Error(`Random word "xyzabc" was NOT detected as new segment! Should work for ANY words.`);
  }
});

// Test 3: Continuation should NOT be new segment
test('Test 3: Continuation "than unplug" = NOT new segment', () => {
  const final = "Desires cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than";
  const partial = "than unplug";
  
  const result = isNewSegment(partial, final);
  
  if (result) {
    throw new Error(`Continuation "than unplug" was incorrectly detected as new segment! Should be continuation.`);
  }
});

// Test 4: Any word after punctuation = new segment (generic)
test('Test 4: Any word after punctuation = new segment (generic)', () => {
  const final = "This is a test sentence.";
  const partial = "anyrandomword";
  
  const result = isNewSegment(partial, final);
  
  if (!result) {
    throw new Error(`Word after punctuation was NOT detected as new segment! Should work for ANY words.`);
  }
});

// Test 5: Word that appears in final = continuation
test('Test 5: Word in final = continuation', () => {
  const final = "This is a test sentence with word";
  const partial = "word continues";
  
  const result = isNewSegment(partial, final);
  
  if (result) {
    throw new Error(`Word that appears in final was incorrectly detected as new segment! Should be continuation.`);
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
  console.log(`\n✅ All tests passed! isNewSegment works generically for ANY words.`);
  process.exit(0);
}

