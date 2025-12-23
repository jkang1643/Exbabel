/**
 * Final-to-Final Text Deduplication Test Suite
 * 
 * Tests for removing duplicate words from new final transcripts that overlap
 * with the end of previous final transcripts.
 * 
 * Run with: node backend/test-final-deduplication.js
 */

import { deduplicateFinalText } from '../core/utils/finalDeduplicator.js';

console.log('🧪 Final-to-Final Text Deduplication Test Suite\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

function test(name, previousFinal, newFinal, expected, description = '') {
  totalTests++;
  const startTime = Date.now();
  
  try {
    // Create a recent timestamp (within time window)
    const recentTime = Date.now() - 1000; // 1 second ago
    
    const result = deduplicateFinalText({
      newFinalText: newFinal,
      previousFinalText: previousFinal,
      previousFinalTime: recentTime,
      mode: 'TestMode',
      timeWindowMs: 5000,
      maxWordsToCheck: 10 // Increased to catch words further back in previous final
    });
    
    const actual = result.deduplicatedText;
    const passed = actual === expected;
    const duration = Date.now() - startTime;
    
    if (passed) {
      console.log(`✅ ${name}`);
      if (description) console.log(`   ${description}`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration, description });
    } else {
      console.log(`❌ ${name}`);
      if (description) console.log(`   ${description}`);
      console.log(`   Previous Final: "${previousFinal}"`);
      console.log(`   New Final:       "${newFinal}"`);
      console.log(`   Expected:        "${expected}"`);
      console.log(`   Actual:          "${actual}"`);
      failedTests++;
      testDetails.push({ 
        name, 
        status: 'failed', 
        duration, 
        description,
        previousFinal,
        newFinal,
        expected,
        actual
      });
    }
    
    return passed;
  } catch (error) {
    console.log(`❌ ${name} - ERROR: ${error.message}`);
    console.error(error.stack);
    failedTests++;
    testDetails.push({ name, status: 'error', duration: Date.now() - startTime, error: error.message });
    return false;
  }
}

// ============================================================================
// CATEGORY 1: Real-World Failing Cases from User
// ============================================================================

console.log('\n📋 Category 1: Real-World Failing Cases\n');

// Case 1: "selves." → "Own self-centered desires"
test(
  'Case 1: Remove "Own" from start of new final',
  "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate. ' Life is best spent fulfilling our own selves.",
  'Own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than to.',
  'self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than to.',
  'Should remove "Own" from start since it overlaps with "selves" ending'
);

// Case 2: "desires." → "Our desires are"
test(
  'Case 2: Remove "Our desires" from start of new final',
  "I love this quote: biblical hospitality is the polar opposite of the cultural trends to separate and isolate. It rejects the notion that life is best spent fulfilling our own self-centered desires.",
  'Our desires are cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than run.',
  'are cordoned off from others. In private fortresses, we call home, biblical hospitality chooses to engage rather than run.',
  'Should remove "Our desires" from start since "desires" overlaps with previous final'
);

// Case 3: Similar to Case 1 but different ending
test(
  'Case 3: Remove "Own" from start (variant)',
  "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate, and rejects the notion that life is best spent fulfilling one's own self. '",
  'Own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.',
  'self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.',
  'Should remove "Own" from start since it overlaps with "self" ending'
);

// Case 4: "together." → "Gather together in My name"
test(
  'Case 4: Remove "Gather together" from start',
  "You know, when you entertain strangers, you may be entertaining angels unaware. You know, but if you miss that, let me give you this one. Where two or three are gathered together.",
  'Gather together in My name, I show up and I show out.',
  'in My name, I show up and I show out.',
  'Should remove "Gather together" from start since "together" overlaps with previous final'
);

// Case 5: "our own." → "Our own self-centered desires" (NEW FAILING CASE)
test(
  'Case 5: Remove "Our own" from start when "our own" appears in previous final',
  "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent fulfilling our own. '",
  'Our own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.',
  'self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.',
  'Should remove "Our own" from start since "our own" appears in previous final (not necessarily at end)'
);

// ============================================================================
// CATEGORY 2: Edge Cases and General Patterns
// ============================================================================

console.log('\n📋 Category 2: Edge Cases and General Patterns\n');

// Test: Words appear in middle of previous final, not at end
test(
  'Edge Case 1: Remove words that appear in middle of previous final',
  "The sentence talks about our own personal goals and aspirations.",
  'Our own personal goals are important.',
  'personal goals are important.',
  'Should remove "Our own" even though "our own" appears in middle, not at end'
);

// Test: Words with different punctuation
test(
  'Edge Case 2: Handle punctuation differences',
  "We discussed our own, personal matters.",
  'Our own personal matters need attention.',
  'personal matters need attention.',
  'Should handle punctuation differences (comma, period)'
);

// Test: Words with extra spacing
test(
  'Edge Case 3: Handle extra spacing',
  "We talked about our  own  goals.",
  'Our own goals are clear.',
  'goals are clear.',
  'Should handle extra spaces in previous final'
);

// Test: Case variations
test(
  'Edge Case 4: Case variations',
  "The text mentions OUR OWN values.",
  'our own values matter.',
  'values matter.',
  'Should handle different case variations (OUR OWN vs our own)'
);

// Test: Words separated by other words in previous final
test(
  'Edge Case 5: Words separated in previous final',
  "I want to discuss our personal and own goals.",
  'Our own goals are clear.',
  'goals are clear.',
  'Should match even when words are separated in previous final'
);

// Test: Multiple word sequence at start
test(
  'Edge Case 6: Three word sequence',
  "The previous sentence ends with the words our own personal.",
  'Our own personal goals are important.',
  'goals are important.',
  'Should remove three-word sequence "Our own personal"'
);

// Test: Words at very end with punctuation
test(
  'Edge Case 7: Words at end with punctuation',
  "The sentence ends with our own.",
  'Our own goals are clear.',
  'goals are clear.',
  'Should match words at end even with punctuation'
);

// Test: Words not consecutive in new final but matching
test(
  'Edge Case 8: Non-consecutive match in new final',
  "We discussed our own values.",
  'Our values and own goals matter.',
  'values and goals matter.',
  'Should handle when words appear but not consecutively in new final'
);

// ============================================================================
// Test Summary
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log('\n📊 Test Summary\n');
console.log(`Total Tests: ${totalTests}`);
console.log(`✅ Passed: ${passedTests}`);
console.log(`❌ Failed: ${failedTests}`);
console.log(`Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%\n`);

if (failedTests > 0) {
  console.log('❌ Failed Tests:\n');
  testDetails
    .filter(t => t.status === 'failed')
    .forEach(t => {
      console.log(`  - ${t.name}`);
      if (t.description) console.log(`    ${t.description}`);
      console.log(`    Previous Final: "${t.previousFinal}"`);
      console.log(`    New Final:     "${t.newFinal}"`);
      console.log(`    Expected:      "${t.expected}"`);
      console.log(`    Actual:        "${t.actual}"\n`);
    });
}

if (failedTests === 0) {
  console.log('🎉 All tests passed!\n');
  process.exit(0);
} else {
  console.log(`\n⚠️  ${failedTests} test(s) failed. Please review the implementation.\n`);
  process.exit(1);
}

