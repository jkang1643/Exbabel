/**
 * Comprehensive Test Suite: Partials Being Dropped
 * 
 * This test suite uses TDD to identify ALL cases where partials get dropped.
 * These tests are DESIGNED TO FAIL to demonstrate the failure scenarios.
 * 
 * Identified Failure Cases:
 * 1. Final starts with punctuation (comma), partial starts with different text - startsWith check fails
 * 2. mergeWithOverlap looks for suffix-prefix match, but overlap is in the middle of strings
 * 3. Partials arriving after snapshot but with different prefix get dropped
 * 4. Partials that contain final's content but don't extend it get dropped
 * 
 * Run with: node backend/test-partials-dropped-comprehensive.js
 * 
 * EXPECTED: Tests should FAIL to demonstrate the issues
 */

import { PartialTracker } from '../core/engine/partialTracker.js';

console.log('🧪 Comprehensive Test Suite: Partials Being Dropped\n');
console.log('='.repeat(70));
console.log('These tests verify that partials are NOT dropped in failure scenarios.\n');

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
    console.log(`❌ ${name}`);
    console.log(`   ${error.message.split('\n').join('\n   ')}`);
    testDetails.push({ name, status: 'FAILED', error: error.message });
  }
}

// ============================================================================
// FAILURE CASE 1: Final with leading punctuation, partial with different prefix
// ============================================================================

test('FAILURE CASE 1: Final starts with comma, partial starts with "And" - mergeWithOverlap should handle it', () => {
  const tracker = new PartialTracker();
  const final = ", let's pray right now";
  const partial = "And you know what our people are going to do? Well, let's pray right now";
  
  // startsWith check fails (as expected)
  const finalNormalized = final.trim().replace(/\s+/g, ' ').toLowerCase();
  const partialNormalized = partial.trim().replace(/\s+/g, ' ').toLowerCase();
  const extendsFinal = partialNormalized.startsWith(finalNormalized);
  
  // But mergeWithOverlap should handle it
  const merged = tracker.mergeWithOverlap(final.trim(), partial.trim());
  
  // Verify mergeWithOverlap successfully merged them
  if (!merged || !merged.includes("And you know")) {
    throw new Error(
      `mergeWithOverlap FAILED to merge:\n` +
      `  Final: "${final}"\n` +
      `  Partial: "${partial}"\n` +
      `  startsWith check: ${extendsFinal} (fails as expected)\n` +
      `  mergeWithOverlap result: ${merged || 'null'}\n` +
      `  Result: Partial is DROPPED even though mergeWithOverlap should handle it`
    );
  }
});

// ============================================================================
// FAILURE CASE 2: mergeWithOverlap fails when overlap is in middle of strings
// ============================================================================

test('FAILURE CASE 2: mergeWithOverlap fails - overlap is in middle, not suffix-prefix', () => {
  const tracker = new PartialTracker();
  
  // Real scenario from terminal output
  const final = ", let's pray right now and outside the taco stand, they start holding hands and they start praying, or someone says my mother's. someone says, my mother's having surgery. This week all";
  const partial = "And you know what our people are going to do? Well, let's pray right now";
  
  const merged = tracker.mergeWithOverlap(final.trim(), partial.trim());
  
  // The overlap is "let's pray right now" which appears:
  // - In final: after the comma at the start
  // - In partial: at the end
  // mergeWithOverlap looks for suffix-prefix match, but here:
  // - Final suffix: "...all"
  // - Partial prefix: "And you know..."
  // No match!
  
  if (!merged || !merged.includes("And you know")) {
    throw new Error(
      `mergeWithOverlap FAILS:\n` +
      `  Final: "${final.substring(0, 80)}..."\n` +
      `  Partial: "${partial}"\n` +
      `  Merged: ${merged || 'null'}\n` +
      `  Reason: mergeWithOverlap looks for suffix-prefix overlap\n` +
      `  - Final suffix: "...all"\n` +
      `  - Partial prefix: "And you know..."\n` +
      `  - No match found, even though both contain "let's pray right now"\n` +
      `  Result: Partial is DROPPED`
    );
  }
});

// ============================================================================
// FAILURE CASE 3: Partials with different prefix get dropped
// ============================================================================

test('FAILURE CASE 3: Partial contains final content but different prefix - gets dropped', () => {
  const tracker = new PartialTracker();
  
  const final = ", let's pray right now";
  const partial = "And you know what our people are going to do? Well, let's pray right now";
  
  // Simulate the check in hostModeHandler.js
  const finalTrimmed = final.trim();
  const longestTrimmed = partial.trim();
  const finalNormalized = finalTrimmed.replace(/\s+/g, ' ').toLowerCase();
  const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
  
  // Check 1: startsWith (fails)
  const extendsFinal = longestNormalized.startsWith(finalNormalized);
  
  let finalText = final;
  if (extendsFinal) {
    finalText = partial;
  } else {
    // Check 2: mergeWithOverlap
    const merged = tracker.mergeWithOverlap(finalTrimmed, longestTrimmed);
    if (merged && merged.length > finalTrimmed.length + 3) {
      finalText = merged;
    } else {
      // Both checks fail - partial is dropped
      finalText = final; // Use original final
    }
  }
  
  const includesOpening = finalText.includes("And you know");
  
  if (!includesOpening) {
    throw new Error(
      `Partial with different prefix is DROPPED:\n` +
      `  Final: "${final}"\n` +
      `  Partial: "${partial}"\n` +
      `  startsWith check: ${extendsFinal} (FAILS)\n` +
      `  mergeWithOverlap: ${tracker.mergeWithOverlap(finalTrimmed, longestTrimmed) ? 'works' : 'FAILS'}\n` +
      `  Result: "${finalText}" (opening phrase lost)`
    );
  }
});

// ============================================================================
// FAILURE CASE 4: Real terminal scenario - opening phrase dropped
// ============================================================================

test('FAILURE CASE 4: Real terminal scenario - opening phrase dropped from sent final', () => {
  // From terminal output lines 6128-6132:
  // Final sent: ", let's pray right now and outside the taco stand..."
  // Grammar corrected: "And you know what our people are going to do? Well, let's pray right now..."
  
  const tracker = new PartialTracker();
  
  // Partials that arrived before final
  tracker.updatePartial("And you know what our people are going to do? Well");
  tracker.updatePartial("And you know what our people are going to do? Well, let's pray right now");
  
  // Final that arrived (missing opening phrase)
  const final = ", let's pray right now and outside the taco stand, they start holding hands and they start praying, or someone says my mother's. someone says, my mother's having surgery. This week all";
  
  // Snapshot is taken
  const snapshot = tracker.getSnapshot();
  const longestSnapshot = snapshot.longest; // "And you know...let's pray right now"
  
  // Check if snapshot extends final
  const finalTrimmed = final.trim();
  const longestTrimmed = longestSnapshot.trim();
  const finalNormalized = finalTrimmed.replace(/\s+/g, ' ').toLowerCase();
  const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
  const extendsFinal = longestNormalized.startsWith(finalNormalized);
  
  let finalText = final;
  if (extendsFinal) {
    finalText = longestSnapshot;
  } else {
    const merged = tracker.mergeWithOverlap(finalTrimmed, longestTrimmed);
    if (merged && merged.length > finalTrimmed.length + 3) {
      finalText = merged;
    }
  }
  
  const includesOpening = finalText.includes("And you know what our people are going to do? Well");
  
  if (!includesOpening) {
    throw new Error(
      `REAL SCENARIO: Opening phrase was DROPPED:\n` +
      `  Snapshot partial: "${longestSnapshot}"\n` +
      `  Final received: "${final.substring(0, 80)}..."\n` +
      `  extendsFinal check: ${extendsFinal} (FAILS - different prefixes)\n` +
      `  mergeWithOverlap: ${tracker.mergeWithOverlap(finalTrimmed, longestTrimmed) ? 'works' : 'FAILS'}\n` +
      `  Final text used: "${finalText.substring(0, 80)}..."\n` +
      `  Result: Opening phrase "And you know what our people are going to do? Well" was LOST`
    );
  }
});

// ============================================================================
// FAILURE CASE 5: Partials arriving during async processing get reset
// ============================================================================

test('FAILURE CASE 5: Partials arriving during async processing (after timeout check) get dropped', async () => {
  const tracker = new PartialTracker();
  const processedFinals = [];
  
  // Final arrives, snapshot taken
  const final = "And you know what our people are going to do? Well";
  
  // Simulate timeout check (line 2287-2331)
  // After timeout, check live values
  await new Promise(resolve => setTimeout(resolve, 500)); // Wait
  
  // Partial arrives DURING async processing (after timeout check but before reset)
  tracker.updatePartial("And you know what our people are going to do? Well, let's pray right now and outside");
  
  const longestPartial = tracker.getLongestPartial();
  const timeSinceLongest = tracker.getLongestPartialTime() ? (Date.now() - tracker.getLongestPartialTime()) : Infinity;
  
  let finalText = final;
  if (longestPartial && longestPartial.length > final.length && timeSinceLongest < 10000) {
    const longestTrimmed = longestPartial.trim();
    const finalTrimmed = final.trim();
    const finalNormalized = finalTrimmed.replace(/\s+/g, ' ').toLowerCase();
    const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
    const extendsFinal = longestNormalized.startsWith(finalNormalized);
    
    if (extendsFinal) {
      finalText = longestPartial;
    }
  }
  
  processedFinals.push(finalText);
  
  // Simulate async processing delay (grammar correction, translation)
  await new Promise(resolve => setTimeout(resolve, 300));
  
  // Reset partials (line 992) - this happens AFTER async processing
  tracker.reset();
  
  // Check if extending partial was included
  const includesExtended = finalText.includes("pray right now and outside");
  
  // This might PASS if the partial was checked before reset
  // But it will FAIL if partial arrives after timeout check completes
  if (!includesExtended) {
    throw new Error(
      `Partial arriving during async processing was DROPPED:\n` +
      `  Partial: "And you know...let's pray right now and outside"\n` +
      `  Arrived: After timeout check, during async processing\n` +
      `  Final used: "${finalText}"\n` +
      `  Result: Extended content was LOST`
    );
  }
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log(`\n📊 Test Summary:`);
console.log(`   Total: ${totalTests}`);
console.log(`   ✅ Passed: ${passedTests}`);
console.log(`   ❌ Failed: ${failedTests}`);

if (failedTests > 0) {
  console.log(`\n❌ FAILING TESTS (These identify the exact failure cases):`);
  console.log(`\n${'='.repeat(70)}\n`);
  
  testDetails
    .filter(t => t.status === 'FAILED')
    .forEach((t, i) => {
      console.log(`FAILURE CASE ${i + 1}: ${t.name}\n`);
      console.log(`${t.error}\n`);
      console.log(`${'─'.repeat(70)}\n`);
    });
  
  console.log(`\n💡 SUMMARY OF IDENTIFIED FAILURE CASES:\n`);
  console.log(`1. startsWith check fails when final has different prefix (comma vs "And")`);
  console.log(`2. mergeWithOverlap fails when overlap is in middle, not suffix-prefix`);
  console.log(`3. Partials with different prefix get dropped even if they contain final's content`);
  console.log(`4. Real scenario: Opening phrase dropped from final (terminal output lines 6128-6132)`);
  console.log(`5. Partials arriving during async processing may get dropped`);
  
  console.log(`\n🔧 RECOMMENDED FIXES:\n`);
  console.log(`1. Improve mergeWithOverlap to detect content overlap in middle of strings`);
  console.log(`2. Add logic to check if partial contains final's content (not just prefix match)`);
  console.log(`3. Check partial's continuation against final's beginning (reverse check)`);
  console.log(`4. Don't reset partials until ALL checks complete (including after async processing)`);
  console.log(`5. Use a more sophisticated merge algorithm that finds common substrings`);
  
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed! The implementation correctly handles all failure cases.`);
  process.exit(0);
}

