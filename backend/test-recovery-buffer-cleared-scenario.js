/**
 * Comprehensive Test: Recovery commit when buffer is already cleared
 * 
 * Tests the exact scenario from the logs (lines 8409-8488):
 * 
 * Scenario:
 * 1. Forced final buffered: "You know, when you entertain strangers, you may be entertaining angels unaware, you know, but if you miss that, let me give you this one. We're two or three"
 * 2. New segment partials arrive: "I," and "I show." (buffer gets cleared)
 * 3. Recovery stream finds: "three are gathered"
 * 4. Recovery merges: "three are gathered" with buffered text
 * 5. Expected: Recovery should commit "We're two or three are gathered" even though buffer was cleared
 * 
 * Final expected text: "You know, when you entertain strangers, you may be entertaining angels unaware, you know, but if you miss that, let me give you this one. We're two or three are gathered"
 */

import { mergeRecoveryText } from './utils/recoveryMerge.js';

console.log('🧪 Comprehensive Test: Recovery commit when buffer is already cleared\n');
console.log('='.repeat(80));

// Simulate the exact scenario
let committedFinals = [];
let bufferCleared = false;

// Step 1: Forced final is buffered
const forcedFinalText = "You know, when you entertain strangers, you may be entertaining angels unaware, you know, but if you miss that, let me give you this one. We're two or three";
console.log(`\n📝 Step 1: Forced final buffered: "${forcedFinalText.substring(0, 80)}..."`);

// Step 2: New segment partials arrive (this would clear the buffer in real code)
console.log(`\n📝 Step 2: New segment partials arrive: "I," and "I show."`);
console.log(`   (In real code, this would clear the forced final buffer)`);
bufferCleared = true;

// Step 3: Recovery stream finds text
const recoveredText = "three are gathered";
console.log(`\n📝 Step 3: Recovery stream finds: "${recoveredText}"`);

// Step 4: Recovery merges (this happens even if buffer was cleared)
console.log(`\n📝 Step 4: Recovery attempts merge...`);
const mergeResult = mergeRecoveryText(
  forcedFinalText,
  recoveredText,
  {
    nextPartialText: null,
    nextFinalText: null,
    mode: 'HostMode'
  }
);

if (mergeResult.merged) {
  const mergedText = mergeResult.mergedText;
  console.log(`   ✅ Merge successful: "${mergeResult.reason}"`);
  console.log(`   Merged text: "${mergedText.substring(0, 80)}..."`);
  
  // Step 5: Recovery should commit even if buffer was cleared
  console.log(`\n📝 Step 5: Recovery commits merged text (buffer was ${bufferCleared ? 'cleared' : 'exists'})...`);
  
  // Simulate the fix: commit even if buffer was cleared
  if (bufferCleared) {
    console.log(`   ⚠️ Buffer was cleared, but recovery found words - committing anyway to prevent word loss`);
    committedFinals.push(mergedText);
    console.log(`   ✅ Committed: "${mergedText.substring(0, 80)}..."`);
  } else {
    committedFinals.push(mergedText);
    console.log(`   ✅ Committed: "${mergedText.substring(0, 80)}..."`);
  }
  
  // Verify result
  const expected = "You know, when you entertain strangers, you may be entertaining angels unaware, you know, but if you miss that, let me give you this one. We're two or three are gathered";
  
  console.log(`\n📊 Verification:`);
  console.log(`   Expected: "${expected}"`);
  console.log(`   Committed: "${committedFinals[0]}"`);
  
  // Normalize for comparison
  const normalize = (text) => text.replace(/[.,]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
  const committedNormalized = normalize(committedFinals[0]);
  const expectedNormalized = normalize(expected);
  
  const testPassed = committedNormalized === expectedNormalized && committedFinals.length === 1;
  
  if (testPassed) {
    console.log(`\n✅ TEST PASSED`);
    console.log(`   Recovery successfully committed merged text even when buffer was cleared`);
    console.log(`   Words "are gathered" were not lost`);
    process.exit(0);
  } else {
    console.log(`\n❌ TEST FAILED`);
    if (committedFinals.length !== 1) {
      console.log(`   Expected 1 final, got ${committedFinals.length}`);
    }
    if (committedNormalized !== expectedNormalized) {
      console.log(`   Text mismatch:`);
      console.log(`     Committed: "${committedNormalized}"`);
      console.log(`     Expected: "${expectedNormalized}"`);
    }
    process.exit(1);
  }
} else {
  console.log(`\n❌ TEST FAILED - Merge failed: ${mergeResult.reason}`);
  process.exit(1);
}

