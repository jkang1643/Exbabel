/**
 * Test: Real Partial Deduplication Issue (Using Actual Function)
 * 
 * Tests the EXACT issue where:
 * 1. Partials at short segments are incorrectly deduplicated against previous finals
 * 2. Frontend gets confused - partials don't get new lines
 * 3. Partials get appended to continued text incorrectly
 * 4. Partials fail to commit to finals
 * 
 * This test uses the ACTUAL deduplicatePartialText function and MUST FAIL initially.
 */

import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';
import { PartialTracker } from '../core/engine/partialTracker.js';

console.log('🧪 Real Partial Deduplication Issue Test (Using Actual Function)\n');
console.log('='.repeat(70));

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

// Test 1: Short segment partial "and," after final should NOT be deduplicated
test('Test 1: Short segment "and," after final should NOT be deduplicated', () => {
  const lastFinal = "I almost wish sometimes people would stop having services.";
  const lastFinalTime = Date.now() - 100; // Recent
  
  const partial = "and,";
  
  const result = deduplicatePartialText({
    partialText: partial,
    lastFinalText: lastFinal,
    lastFinalTime: lastFinalTime,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  // CRITICAL: "and," is a NEW segment (doesn't start with the final)
  // It should NOT be deduplicated because it's clearly a new sentence
  // The deduplicated text should be the full "and,"
  if (result.wasDeduplicated && result.deduplicatedText.trim().length < partial.trim().length) {
    throw new Error(
      `Short segment "and," was incorrectly deduplicated! ` +
      `Original: "${partial}" ` +
      `Deduplicated: "${result.deduplicatedText}" ` +
      `Words skipped: ${result.wordsSkipped}. ` +
      `This is a NEW segment and should NOT be deduplicated.`
    );
  }
  
  // If it was deduplicated, check that we still have the text
  if (result.wasDeduplicated && !result.deduplicatedText.includes('and')) {
    throw new Error(
      `Short segment "and," was completely removed by deduplication! ` +
      `This should NOT happen for a new segment.`
    );
  }
});

// Test 2: "And go" after final should NOT be deduplicated (new segment)
test('Test 2: "And go" after final should NOT be deduplicated', () => {
  const lastFinal = "I almost wish sometimes people would stop having services.";
  const lastFinalTime = Date.now() - 100;
  
  const partial = "And go";
  
  const result = deduplicatePartialText({
    partialText: partial,
    lastFinalText: lastFinal,
    lastFinalTime: lastFinalTime,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  // "And go" is a NEW segment - should NOT be deduplicated
  if (result.wasDeduplicated && result.deduplicatedText.trim().length < partial.trim().length) {
    throw new Error(
      `"And go" was incorrectly deduplicated! ` +
      `Original: "${partial}" ` +
      `Deduplicated: "${result.deduplicatedText}" ` +
      `This is a NEW segment starting with capital letter after period.`
    );
  }
});

// Test 3: Partial extending final SHOULD be deduplicated (continuation)
test('Test 3: Partial extending final SHOULD be deduplicated', () => {
  const lastFinal = "I almost wish sometimes people would stop";
  const lastFinalTime = Date.now() - 100;
  
  const partial = "I almost wish sometimes people would stop having";
  
  const result = deduplicatePartialText({
    partialText: partial,
    lastFinalText: lastFinal,
    lastFinalTime: lastFinalTime,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  // This SHOULD be deduplicated because it extends the final
  // Should only keep "having"
  if (!result.wasDeduplicated) {
    throw new Error(
      `Extending partial was NOT deduplicated! ` +
      `Original: "${partial}" ` +
      `Final: "${lastFinal}" ` +
      `This extends the final and should be deduplicated to just "having".`
    );
  }
  
  if (!result.deduplicatedText.toLowerCase().includes('having')) {
    throw new Error(
      `Deduplication removed the extending part! ` +
      `Original: "${partial}" ` +
      `Deduplicated: "${result.deduplicatedText}" ` +
      `Should keep "having".`
    );
  }
});

// Test 4: Very short partial "a" should NOT be deduplicated if it's a new segment
test('Test 4: Very short "a" should NOT be deduplicated for new segment', () => {
  const lastFinal = "Hello world.";
  const lastFinalTime = Date.now() - 100;
  
  const partial = "a";
  
  const result = deduplicatePartialText({
    partialText: partial,
    lastFinalText: lastFinal,
    lastFinalTime: lastFinalTime,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  // "a" is a new segment - should NOT be deduplicated
  if (result.wasDeduplicated && result.deduplicatedText.trim().length < partial.trim().length) {
    throw new Error(
      `Very short "a" was incorrectly deduplicated! ` +
      `Original: "${partial}" ` +
      `Deduplicated: "${result.deduplicatedText}" ` +
      `This is a NEW segment and should NOT be deduplicated.`
    );
  }
});

// Test 5: Check that partials starting with capital after period are not deduplicated
test('Test 5: Partials starting with capital after period should NOT be deduplicated', () => {
  const lastFinal = "I almost wish sometimes people would stop having services.";
  const lastFinalTime = Date.now() - 100;
  
  const partial = "But I think";
  
  const result = deduplicatePartialText({
    partialText: partial,
    lastFinalText: lastFinal,
    lastFinalTime: lastFinalTime,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 5
  });
  
  // "But I think" is a NEW segment (capital letter after period)
  // Should NOT be deduplicated
  if (result.wasDeduplicated && result.deduplicatedText.trim().length < partial.trim().length) {
    throw new Error(
      `"But I think" was incorrectly deduplicated! ` +
      `Original: "${partial}" ` +
      `Deduplicated: "${result.deduplicatedText}" ` +
      `This starts with capital after period - NEW segment.`
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
  console.log(`\n⚠️ These tests FAILED - the deduplication logic is incorrectly handling new segments!`);
  process.exit(1);
} else {
  console.log(`\n⚠️ All tests PASSED, but if frontend is still broken, the issue might be elsewhere.`);
  console.log(`   Check how the deduplicated text is used in adapter.js`);
  process.exit(0);
}

