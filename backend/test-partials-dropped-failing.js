/**
 * Test Suite: Partials Being Dropped - Failing Tests
 * 
 * These tests are DESIGNED TO FAIL to identify the exact failure cases.
 * They simulate scenarios where partials get dropped in the actual implementation.
 * 
 * Run with: node backend/test-partials-dropped-failing.js
 */

import { PartialTracker } from '../core/engine/partialTracker.js';

console.log('🧪 Test Suite: Partials Dropped - Failing Tests (Expected to Fail)\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`✅ ${name}`);
    testDetails.push({ name, status: 'PASSED', error: null });
  } catch (error) {
    failedTests++;
    console.log(`❌ ${name}: ${error.message}`);
    testDetails.push({ name, status: 'FAILED', error: error.message });
  }
}

// Test 1: Final starts with comma, partial starts with "And" - no overlap detected
test('Test 1: Final with comma prefix, partial with "And" prefix - overlap should merge but might not', () => {
  const tracker = new PartialTracker();
  
  const final = ", let's pray right now and outside the taco stand";
  const partial = "And you know what our people are going to do? Well, let's pray right now";
  
  // Try to merge
  const merged = tracker.mergeWithOverlap(final, partial);
  
  console.log(`  Final: "${final}"`);
  console.log(`  Partial: "${partial}"`);
  console.log(`  Merged: "${merged || 'null'}"`);
  
  // The overlap is "let's pray right now" - should merge
  // But mergeWithOverlap looks for suffix-prefix overlap
  // Final ends with: "...taco stand"
  // Partial starts with: "And you know..."
  // No overlap found!
  
  if (!merged || !merged.includes("And you know")) {
    throw new Error(
      `Overlap merge failed - partial starts with "And", final starts with "," - no direct overlap detected.\n` +
      `  This is the failure case: mergeWithOverlap looks for suffix-prefix overlap, but there is none.\n` +
      `  The partial contains the final's content but in a different position.`
    );
  }
});

// Test 2: Check if startsWith logic fails when final has leading punctuation
test('Test 2: startsWith check fails when final has leading punctuation', () => {
  const final = ", let's pray right now";
  const partial = "And you know what our people are going to do? Well, let's pray right now";
  
  const finalNormalized = final.trim().replace(/\s+/g, ' ').toLowerCase();
  const partialNormalized = partial.trim().replace(/\s+/g, ' ').toLowerCase();
  
  const extendsFinal = partialNormalized.startsWith(finalNormalized);
  
  console.log(`  Final normalized: "${finalNormalized}"`);
  console.log(`  Partial normalized: "${partialNormalized}"`);
  console.log(`  startsWith: ${extendsFinal}`);
  
  // This WILL FAIL - partial doesn't start with final
  if (!extendsFinal) {
    throw new Error(
      `startsWith check fails: partial doesn't start with final.\n` +
      `  Final: ", let's pray right now"\n` +
      `  Partial: "And you know...let's pray right now"\n` +
      `  The partial contains the final's content but doesn't start with it.`
    );
  }
});

// Test 3: Partials that arrive after snapshot, don't extend (different prefix), and no overlap
test('Test 3: Partials arriving after snapshot with different prefix get dropped', async () => {
  const tracker = new PartialTracker();
  const processedFinals = [];
  
  // Snapshot is taken here (final arrives)
  const final = ", let's pray right now";
  
  // Partial arrives AFTER snapshot (but should be checked in timeout)
  tracker.updatePartial("And you know what our people are going to do? Well, let's pray right now");
  
  // Check if partial extends final (this is what the code does)
  const longestPartial = tracker.getLongestPartial();
  const finalTrimmed = final.trim();
  const longestTrimmed = longestPartial.trim();
  const finalNormalized = finalTrimmed.replace(/\s+/g, ' ').toLowerCase();
  const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
  const extendsFinal = longestNormalized.startsWith(finalNormalized);
  
  console.log(`  Final: "${final}"`);
  console.log(`  Longest partial: "${longestPartial}"`);
  console.log(`  extendsFinal: ${extendsFinal}`);
  
  let finalText = final;
  if (extendsFinal) {
    finalText = longestPartial;
    console.log(`  ✅ Using partial`);
  } else {
    // Try overlap
    const merged = tracker.mergeWithOverlap(finalTrimmed, longestTrimmed);
    if (merged && merged.length > finalTrimmed.length + 3) {
      finalText = merged;
      console.log(`  ✅ Using merged: "${merged}"`);
    } else {
      console.log(`  ❌ No extension or overlap - using final as-is`);
    }
  }
  
  processedFinals.push(finalText);
  
  // Check if opening phrase was included
  const includesOpening = finalText.includes("And you know");
  
  // This WILL FAIL - no extension, no overlap, so opening phrase is lost
  if (!includesOpening) {
    throw new Error(
      `Opening phrase was dropped because:\n` +
      `  1. Partial doesn't start with final (startsWith fails)\n` +
      `  2. No suffix-prefix overlap detected\n` +
      `  3. Final used as-is without the opening phrase`
    );
  }
});

// Test 4: Real scenario - check what mergeWithOverlap actually returns
test('Test 4: Test mergeWithOverlap with real scenario strings', () => {
  const tracker = new PartialTracker();
  
  const final = ", let's pray right now and outside the taco stand, they start holding hands and they start praying, or someone says my mother's. someone says, my mother's having surgery. This week all";
  const partial = "And you know what our people are going to do? Well, let's pray right now";
  
  const merged = tracker.mergeWithOverlap(final.trim(), partial.trim());
  
  console.log(`  Final: "${final.substring(0, 80)}..."`);
  console.log(`  Partial: "${partial}"`);
  console.log(`  Merged: "${merged || 'null'}"`);
  
  // Check if merge would work
  // The overlap should be "let's pray right now"
  // But mergeWithOverlap looks for suffix of first matching prefix of second
  // Final suffix: "...all"
  // Partial prefix: "And you know..."
  // No match!
  
  if (!merged || !merged.includes("And you know")) {
    throw new Error(
      `mergeWithOverlap fails for this case:\n` +
      `  - Final is much longer and ends with "...all"\n` +
      `  - Partial starts with "And you know..."\n` +
      `  - The common content "let's pray right now" is in the middle of final and start of partial's continuation\n` +
      `  - But mergeWithOverlap can't find it because it's looking for suffix-prefix match`
    );
  }
});

// Summary
console.log('\n' + '='.repeat(70));
console.log(`\n📊 Test Summary:`);
console.log(`   Total: ${totalTests}`);
console.log(`   ✅ Passed: ${passedTests}`);
console.log(`   ❌ Failed: ${failedTests}`);

if (failedTests > 0) {
  console.log(`\n❌ Failed Tests (These identify the exact failure cases):`);
  testDetails
    .filter(t => t.status === 'FAILED')
    .forEach(t => {
      console.log(`\n   - ${t.name}`);
      console.log(`     ${t.error}`);
    });
  
  console.log(`\n💡 These failing tests identify WHY partials get dropped:`);
  console.log(`   1. startsWith check fails when final has different prefix`);
  console.log(`   2. mergeWithOverlap fails when there's no suffix-prefix match`);
  console.log(`   3. Partials with different prefixes get dropped`);
  
  console.log(`\n🔧 To fix:`);
  console.log(`   - Improve mergeWithOverlap to handle content that appears in middle of strings`);
  console.log(`   - Add logic to detect when partial contains final's content even if prefix differs`);
  console.log(`   - Check if partial's continuation matches final's beginning`);
  
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed (unexpected - they should fail to demonstrate the issue)`);
  process.exit(0);
}

