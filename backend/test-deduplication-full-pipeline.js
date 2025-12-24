/**
 * Full Pipeline Test Suite: Deduplication from Partials to Finalization
 * 
 * This test suite simulates the complete flow:
 * 1. Partials arrive and are deduplicated against previous final
 * 2. Partials are finalized
 * 3. Final is deduplicated against previous final
 * 4. Grammar correction happens
 * 5. Recovery merge happens (if applicable)
 * 6. Final output is verified
 * 
 * Each test case verifies deduplication works correctly at every stage.
 * 
 * Run with: node backend/test-deduplication-full-pipeline.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env file from backend directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

import { deduplicateFinalText } from '../core/utils/finalDeduplicator.js';
import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';
import { mergeRecoveryText } from './utils/recoveryMerge.js';

console.log('🧪 Full Pipeline Deduplication Test Suite\n');
console.log('='.repeat(80));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

function test(name, fn) {
  totalTests++;
  const startTime = Date.now();
  try {
    const result = fn();
    const duration = Date.now() - startTime;
    if (result === true || (result && result !== false)) {
      console.log(`✅ ${name} (${duration}ms)`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration, error: null });
      return true;
    } else {
      console.log(`❌ ${name} (${duration}ms)`);
      testDetails.push({ name, status: 'failed', duration, error: 'Test returned false' });
      failedTests++;
      return false;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ ${name}: ${error.message} (${duration}ms)`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1]?.trim()}`);
    }
    testDetails.push({ name, status: 'failed', duration, error: error.message });
    failedTests++;
    return false;
  }
}

/**
 * Simulate the full pipeline for a test case
 */
function simulateFullPipeline({
  previousFinal,
  previousFinalTime,
  partials,
  finalText,
  recoveryText,
  grammarCorrection,
  expectedFinalOutput,
  testName
}) {
  console.log(`\n   📋 Test: ${testName}`);
  console.log(`   Previous final: "...${previousFinal.substring(Math.max(0, previousFinal.length - 50))}"`);
  
  const pipeline = {
    stage1_partials: [],
    stage2_finalized: null,
    stage3_deduplicated: null,
    stage4_grammarCorrected: null,
    stage5_recoveryMerged: null,
    stage6_finalOutput: null
  };
  
  // Stage 1: Process partials as they arrive
  console.log(`   Stage 1: Processing ${partials.length} partial(s)...`);
  for (let i = 0; i < partials.length; i++) {
    const partial = partials[i];
    const dedupResult = deduplicatePartialText({
      partialText: partial,
      lastFinalText: previousFinal,
      lastFinalTime: previousFinalTime,
      mode: 'HostMode',
      timeWindowMs: 5000,
      maxWordsToCheck: 10
    });
    
    pipeline.stage1_partials.push({
      original: partial,
      deduplicated: dedupResult.deduplicatedText,
      wasDeduplicated: dedupResult.wasDeduplicated,
      wordsSkipped: dedupResult.wordsSkipped
    });
    
    console.log(`     Partial ${i + 1}: "${partial.substring(0, 40)}..." → "${dedupResult.deduplicatedText.substring(0, 40)}..." (dedup: ${dedupResult.wasDeduplicated})`);
  }
  
  // Stage 2: Finalization (use the final text provided)
  console.log(`   Stage 2: Finalization...`);
  pipeline.stage2_finalized = finalText;
  console.log(`     Finalized: "${finalText.substring(0, 50)}..."`);
  
  // Stage 3: Deduplicate final against previous final
  console.log(`   Stage 3: Deduplicating final against previous final...`);
  const finalDedupResult = deduplicateFinalText({
    newFinalText: finalText,
    previousFinalText: previousFinal,
    previousFinalTime: previousFinalTime,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 10
  });
  
  pipeline.stage3_deduplicated = finalDedupResult.deduplicatedText;
  console.log(`     Deduplicated: "${finalDedupResult.deduplicatedText.substring(0, 50)}..." (dedup: ${finalDedupResult.wasDeduplicated}, skipped: ${finalDedupResult.wordsSkipped})`);
  
  // Stage 4: Grammar correction (if provided)
  if (grammarCorrection) {
    console.log(`   Stage 4: Grammar correction...`);
    pipeline.stage4_grammarCorrected = grammarCorrection(pipeline.stage3_deduplicated);
    console.log(`     Grammar corrected: "${pipeline.stage4_grammarCorrected.substring(0, 50)}..."`);
  } else {
    pipeline.stage4_grammarCorrected = pipeline.stage3_deduplicated;
  }
  
  // Stage 5: Recovery merge (if provided)
  if (recoveryText) {
    console.log(`   Stage 5: Recovery merge...`);
    const mergeResult = mergeRecoveryText(
      pipeline.stage4_grammarCorrected,
      recoveryText,
      { mode: 'HostMode' }
    );
    pipeline.stage5_recoveryMerged = mergeResult.mergedText;
    console.log(`     Recovery merged: "${mergeResult.mergedText.substring(0, 50)}..."`);
  } else {
    pipeline.stage5_recoveryMerged = pipeline.stage4_grammarCorrected;
  }
  
  // Stage 6: Final output (this is what goes to history)
  pipeline.stage6_finalOutput = pipeline.stage5_recoveryMerged;
  
  // Verify final output
  const expectedNormalized = expectedFinalOutput.trim().toLowerCase();
  const actualNormalized = pipeline.stage6_finalOutput.trim().toLowerCase();
  
  console.log(`   Stage 6: Final output verification...`);
  console.log(`     Expected: "${expectedFinalOutput.substring(0, 50)}..."`);
  console.log(`     Actual: "${pipeline.stage6_finalOutput.substring(0, 50)}..."`);
  
  if (actualNormalized !== expectedNormalized) {
    throw new Error(
      `Final output mismatch!\n` +
      `  Expected: "${expectedFinalOutput}"\n` +
      `  Actual: "${pipeline.stage6_finalOutput}"\n` +
      `  Pipeline stages:\n` +
      `    Stage 1 (Partials): ${pipeline.stage1_partials.map(p => `"${p.deduplicated}"`).join(', ')}\n` +
      `    Stage 2 (Finalized): "${pipeline.stage2_finalized}"\n` +
      `    Stage 3 (Deduplicated): "${pipeline.stage3_deduplicated}"\n` +
      `    Stage 4 (Grammar): "${pipeline.stage4_grammarCorrected}"\n` +
      `    Stage 5 (Recovery): "${pipeline.stage5_recoveryMerged}"\n` +
      `    Stage 6 (Final): "${pipeline.stage6_finalOutput}"`
    );
  }
  
  return true;
}

// ============================================================================
// Test Case 1: Standard Case - "are" at end matches "are" at start
// ============================================================================

console.log('\n📋 Test 1: Full Pipeline - "where two or three are" → "are gathered together"\n');
test('Full pipeline: Standard case with "are" overlap', () => {
  return simulateFullPipeline({
    previousFinal: "where two or three are",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "are",
      "are gathered",
      "are gathered together"
    ],
    finalText: "are gathered together",
    grammarCorrection: null,
    recoveryText: null,
    expectedFinalOutput: "gathered together",
    testName: "Standard case - 'are' overlap"
  });
});

// ============================================================================
// Test Case 2: Case Insensitive - "are" vs "Are"
// ============================================================================

console.log('\n📋 Test 2: Full Pipeline - Case Insensitive "are" vs "Are"\n');
test('Full pipeline: Case insensitive "are" vs "Are"', () => {
  return simulateFullPipeline({
    previousFinal: "where two or three are",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "Are",
      "Are gathered",
      "Are gathered together"
    ],
    finalText: "Are gathered together",
    grammarCorrection: null,
    recoveryText: null,
    expectedFinalOutput: "gathered together",
    testName: "Case insensitive - 'Are' vs 'are'"
  });
});

// ============================================================================
// Test Case 3: "Our own" vs "their own" - Main Bug Scenario
// ============================================================================

console.log('\n📋 Test 3: Full Pipeline - "their own" → "Our own self-centered"\n');
test('Full pipeline: "Our own" should deduplicate from "their own"', () => {
  return simulateFullPipeline({
    previousFinal: "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent for their own. '",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "Our",
      "Our own",
      "Our own self-centered",
      "Our own self-centered desires",
      "Our own self-centered desires cordoned off from others."
    ],
    finalText: "Our own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.",
    grammarCorrection: null,
    recoveryText: null,
    expectedFinalOutput: "self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.",
    testName: "Main bug - 'Our own' vs 'their own'"
  });
});

// ============================================================================
// Test Case 4: Extra Word Before Match - "our are"
// ============================================================================

console.log('\n📋 Test 4: Full Pipeline - Extra Word "our are"\n');
test('Full pipeline: Extra word "our" before "are" match', () => {
  return simulateFullPipeline({
    previousFinal: "where two or three are.",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "our",
      "our are",
      "our are gathered",
      "our are gathered together"
    ],
    finalText: "our are gathered together",
    grammarCorrection: null,
    recoveryText: null,
    expectedFinalOutput: "gathered together",
    testName: "Extra word - 'our are'"
  });
});

// ============================================================================
// Test Case 5: Multiple Extra Words - "they indeed are"
// ============================================================================

console.log('\n📋 Test 5: Full Pipeline - Multiple Extra Words "they indeed are"\n');
test('Full pipeline: Multiple extra words "they indeed are"', () => {
  return simulateFullPipeline({
    previousFinal: "where two or three are.",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "they",
      "they indeed",
      "they indeed are",
      "they indeed are gathered",
      "they indeed are gathered together"
    ],
    finalText: "they indeed are gathered together",
    grammarCorrection: null,
    recoveryText: null,
    expectedFinalOutput: "gathered together",
    testName: "Multiple extra words - 'they indeed are'"
  });
});

// ============================================================================
// Test Case 6: With Grammar Correction
// ============================================================================

console.log('\n📋 Test 6: Full Pipeline - With Grammar Correction\n');
test('Full pipeline: Deduplication after grammar correction', () => {
  return simulateFullPipeline({
    previousFinal: "where two or three are",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "are",
      "are gathered",
      "are gathered together"
    ],
    finalText: "are gathered together",
    grammarCorrection: (text) => {
      // Simulate grammar correction adding punctuation
      return text.trim() + ".";
    },
    recoveryText: null,
    expectedFinalOutput: "gathered together.",
    testName: "With grammar correction"
  });
});

// ============================================================================
// Test Case 7: With Recovery Merge
// ============================================================================

console.log('\n📋 Test 7: Full Pipeline - With Recovery Merge\n');
test('Full pipeline: Deduplication after recovery merge', () => {
  return simulateFullPipeline({
    previousFinal: "where two or three are",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "are",
      "are gathered",
      "are gathered together"
    ],
    finalText: "are gathered together",
    grammarCorrection: null,
    recoveryText: "together in My name", // Recovery adds more text
    expectedFinalOutput: "gathered together in My name",
    testName: "With recovery merge"
  });
});

// ============================================================================
// Test Case 8: User Scenario 1 - "our own selves" → "Own self-centered"
// ============================================================================

console.log('\n📋 Test 8: Full Pipeline - User Scenario 1\n');
test('Full pipeline: User scenario 1 - "our own selves" → "Own self-centered"', () => {
  return simulateFullPipeline({
    previousFinal: "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate. ' Life is best spent fulfilling our own selves.",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "Own",
      "Own self-centered",
      "Own self-centered desires",
      "Own self-centered desires cordoned off from others."
    ],
    finalText: "Own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than to.",
    grammarCorrection: null,
    recoveryText: null,
    expectedFinalOutput: "self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than to.",
    testName: "User scenario 1 - 'our own selves' → 'Own'"
  });
});

// ============================================================================
// Test Case 9: User Scenario 2 - "our own self-centered desires" → "Our desires"
// ============================================================================

console.log('\n📋 Test 9: Full Pipeline - User Scenario 2\n');
test('Full pipeline: User scenario 2 - "our own self-centered desires" → "Our desires"', () => {
  return simulateFullPipeline({
    previousFinal: "I love this quote: biblical hospitality is the polar opposite of the cultural trends to separate and isolate. It rejects the notion that life is best spent fulfilling our own self-centered desires.",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "Our",
      "Our desires",
      "Our desires are",
      "Our desires are cordoned off from others."
    ],
    finalText: "Our desires are cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than run.",
    grammarCorrection: null,
    recoveryText: null,
    expectedFinalOutput: "are cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than run.",
    testName: "User scenario 2 - 'our own self-centered desires' → 'Our desires'"
  });
});

// ============================================================================
// Test Case 10: User Scenario 3 - "one's own self" → "Own self-centered"
// ============================================================================

console.log('\n📋 Test 10: Full Pipeline - User Scenario 3\n');
test('Full pipeline: User scenario 3 - "one\'s own self" → "Own self-centered"', () => {
  return simulateFullPipeline({
    previousFinal: "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate, and rejects the notion that life is best spent fulfilling one's own self. '",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "Own",
      "Own self-centered",
      "Own self-centered desires",
      "Own self-centered desires cordoned off from others."
    ],
    finalText: "Own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.",
    grammarCorrection: null,
    recoveryText: null,
    expectedFinalOutput: "self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.",
    testName: "User scenario 3 - 'one's own self' → 'Own'"
  });
});

// ============================================================================
// Test Case 11: User Scenario 4 - "are gathered together" → "Gather together"
// ============================================================================

console.log('\n📋 Test 11: Full Pipeline - User Scenario 4 (Stem Matching)\n');
test('Full pipeline: User scenario 4 - "are gathered together" → "Gather together"', () => {
  return simulateFullPipeline({
    previousFinal: "You know, when you entertain strangers, you may be entertaining angels unaware. You know, but if you miss that, let me give you this one. Where two or three are gathered together.",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "Gather",
      "Gather together",
      "Gather together in My name",
      "Gather together in My name, I show up and I show out."
    ],
    finalText: "Gather together in My name, I show up and I show out.",
    grammarCorrection: null,
    recoveryText: null,
    expectedFinalOutput: "in My name, I show up and I show out.",
    testName: "User scenario 4 - 'gathered' → 'Gather' (stem matching)"
  });
});

// ============================================================================
// Test Case 12: Full Pipeline with All Stages
// ============================================================================

console.log('\n📋 Test 12: Full Pipeline - All Stages (Partial → Final → Grammar → Recovery)\n');
test('Full pipeline: Complete flow with all stages', () => {
  return simulateFullPipeline({
    previousFinal: "where two or three are",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "are",
      "are gathered",
      "are gathered together"
    ],
    finalText: "are gathered together",
    grammarCorrection: (text) => {
      // Grammar correction might add punctuation or fix capitalization
      return text.trim() + ".";
    },
    recoveryText: "together in My name", // Recovery adds continuation
    expectedFinalOutput: "gathered together in My name.",
    testName: "Complete flow - all stages"
  });
});

// ============================================================================
// Test Case 13: Compound Word Protection
// ============================================================================

console.log('\n📋 Test 13: Full Pipeline - Compound Word Protection\n');
test('Full pipeline: Should NOT deduplicate "are" from compound word "are-gathered"', () => {
  return simulateFullPipeline({
    previousFinal: "where two or three are-gathered",
    previousFinalTime: Date.now() - 2000,
    partials: [
      "are",
      "are gathered",
      "are gathered together"
    ],
    finalText: "are gathered together",
    grammarCorrection: null,
    recoveryText: null,
    expectedFinalOutput: "are gathered together", // Should NOT deduplicate because "are" is part of compound word
    testName: "Compound word protection - 'are-gathered'"
  });
});

// ============================================================================
// Test Summary
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('\n📊 Test Summary\n');
console.log(`Total Tests: ${totalTests}`);
console.log(`✅ Passed: ${passedTests}`);
console.log(`❌ Failed: ${failedTests}`);
console.log(`\n${failedTests > 0 ? '⚠️  Some tests are failing - these expose the bugs that need to be fixed.' : '✅ All tests passed!'}\n`);

if (failedTests > 0) {
  console.log('Failed Tests:\n');
  testDetails
    .filter(t => t.status === 'failed')
    .forEach(t => {
      console.log(`  ❌ ${t.name}`);
      if (t.error) {
        console.log(`     Error: ${t.error.substring(0, 200)}...`);
      }
    });
  console.log('\n');
}

process.exit(failedTests > 0 ? 1 : 0);

