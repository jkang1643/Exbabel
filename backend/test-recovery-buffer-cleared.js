/**
 * Test: Recovery commit when buffer is already cleared
 * 
 * Scenario from logs:
 * - Finalized segment: "You know, when you entertain strangers, you may be entertaining angels unaware. You know, but if you miss that, let me give you this one. We're two or three."
 * - Expected: "You know, when you entertain strangers, you may be entertaining angels unaware, you know, but if you miss that, let me give you this one. We're two or three are gathered"
 * 
 * Issue: Recovery found "three are gathered" and merged it, but buffer was already cleared so commit was skipped
 */

console.log('🧪 Test: Recovery commit when buffer is already cleared\n');
console.log('='.repeat(80));

// Simulate the scenario
const originalBufferedText = "You know, when you entertain strangers, you may be entertaining angels unaware. You know, but if you miss that, let me give you this one. We're two or three";
const recoveredText = "three are gathered";
const expectedFinal = "You know, when you entertain strangers, you may be entertaining angels unaware, you know, but if you miss that, let me give you this one. We're two or three are gathered";

// Simulate merge
function mergeWithOverlap(text1, text2) {
  if (!text1 || !text2) return null;
  const t1 = text1.trim().toLowerCase();
  const t2 = text2.trim().toLowerCase();
  
  // Check if t2 extends t1
  if (t2.startsWith(t1)) {
    return text2;
  }
  
  // Try to find overlap
  const minLen = Math.min(t1.length, t2.length);
  for (let i = Math.min(20, minLen); i > 5; i--) {
    const suffix = t1.slice(-i);
    if (t2.startsWith(suffix)) {
      return text1.trim() + ' ' + text2.slice(i).trim();
    }
  }
  
  return null;
}

// Check word overlap
const bufferedWords = originalBufferedText.toLowerCase().split(/\s+/).filter(w => w.length > 0);
const recoveredWords = recoveredText.toLowerCase().split(/\s+/).filter(w => w.length > 0);
const sharedWords = bufferedWords.filter(w => recoveredWords.includes(w));

console.log(`📊 Test Data:`);
console.log(`   Original buffered: "${originalBufferedText}"`);
console.log(`   Recovered: "${recoveredText}"`);
console.log(`   Shared words: ${sharedWords.join(', ')}`);

if (sharedWords.length > 0) {
  // Find overlap point
  const lastSharedWord = sharedWords[sharedWords.length - 1];
  const bufferedLastIndex = bufferedWords.lastIndexOf(lastSharedWord);
  const recoveredFirstIndex = recoveredWords.indexOf(lastSharedWord);
  
  if (bufferedLastIndex >= 0 && recoveredFirstIndex >= 0) {
    const wordsToAppend = recoveredWords.slice(recoveredFirstIndex + 1);
    const mergedText = originalBufferedText.trim() + ' ' + wordsToAppend.join(' ');
    
    console.log(`\n✅ Merge successful:`);
    console.log(`   Merged text: "${mergedText}"`);
    console.log(`   Expected: "${expectedFinal}"`);
    
    const testPassed = mergedText.trim() === expectedFinal.trim();
    
    if (testPassed) {
      console.log(`\n✅ TEST PASSED - Merge produces expected result`);
    } else {
      console.log(`\n❌ TEST FAILED - Merge doesn't match expected`);
      console.log(`   Difference: "${mergedText.substring(expectedFinal.length)}" vs "${expectedFinal.substring(mergedText.length)}"`);
    }
    
    console.log(`\n📝 Fix Required:`);
    console.log(`   Recovery engine should commit merged text even if buffer was cleared`);
    console.log(`   This prevents word loss when buffer is cleared by new segment but recovery found missing words`);
    
    process.exit(testPassed ? 0 : 1);
  } else {
    console.log(`\n❌ TEST FAILED - Could not find overlap point`);
    process.exit(1);
  }
} else {
  console.log(`\n❌ TEST FAILED - No shared words found`);
  process.exit(1);
}

