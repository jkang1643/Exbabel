/**
 * Random Pattern Test Suite for Final-to-Final Deduplication
 * 
 * Tests the general pattern: if words at the end of previous final overlap
 * with words at the start of new final, remove the overlapping words.
 */

import { deduplicateFinalText } from '../core/utils/finalDeduplicator.js';

console.log('🧪 Random Pattern Test Suite for Final-to-Final Deduplication\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

function test(name, previousFinal, newFinal, expected, description = '') {
  totalTests++;
  const startTime = Date.now();
  
  try {
    const recentTime = Date.now() - 1000; // 1 second ago
    
    const result = deduplicateFinalText({
      newFinalText: newFinal,
      previousFinalText: previousFinal,
      previousFinalTime: recentTime,
      mode: 'TestMode',
      timeWindowMs: 5000,
      maxWordsToCheck: 10
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
      console.log(`   Previous Final: "${previousFinal.substring(Math.max(0, previousFinal.length - 60))}"`);
      console.log(`   New Final:       "${newFinal.substring(0, 60)}"`);
      console.log(`   Expected:        "${expected}"`);
      console.log(`   Actual:          "${actual}"`);
      console.log(`   Words skipped: ${result.wordsSkipped}, Was deduplicated: ${result.wasDeduplicated}`);
      failedTests++;
      testDetails.push({ 
        name, 
        status: 'failed', 
        duration, 
        description,
        previousFinal,
        newFinal,
        expected,
        actual,
        wordsSkipped: result.wordsSkipped,
        wasDeduplicated: result.wasDeduplicated
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
// Pattern-Based Random Tests
// ============================================================================

console.log('\n📋 Pattern 1: Single Word Overlap at End\n');

// Pattern: Previous ends with word X, new starts with X
test(
  'Random 1.1: Single word at end',
  'The previous sentence ends with the word test.',
  'test continues here with more text.',
  'continues here with more text.',
  'Should remove "test" from start'
);

test(
  'Random 1.2: Single word with punctuation',
  'Sentence ends with important.',
  'important matters need attention.',
  'matters need attention.',
  'Should handle punctuation'
);

test(
  'Random 1.3: Case variation',
  'Text ends with VALUE.',
  'value matters most.',
  'matters most.',
  'Should handle case differences'
);

console.log('\n📋 Pattern 2: Multiple Word Overlap at End\n');

// Pattern: Previous ends with words X Y, new starts with X Y
test(
  'Random 2.1: Two words at end',
  'The sentence ends with our own.',
  'our own goals are clear.',
  'goals are clear.',
  'Should remove "our own" from start'
);

test(
  'Random 2.2: Three words at end',
  'Text concludes with the final words.',
  'the final words continue here.',
  'continue here.',
  'Should remove "the final words" from start'
);

test(
  'Random 2.3: Words with punctuation',
  'Ends with our own, personal.',
  'our own personal matters.',
  'matters.',
  'Should handle punctuation between words'
);

console.log('\n📋 Pattern 3: Words in Middle (Not at End)\n');

// Pattern: Previous contains words X Y in middle, new starts with X Y
test(
  'Random 3.1: Words in middle of previous',
  'I love this quote about our own personal goals and aspirations.',
  'our own personal goals matter.',
  'matter.',
  'Should remove "our own personal goals" even though not at end'
);

test(
  'Random 3.2: Words earlier in previous',
  'The text discusses our own values throughout the document.',
  'our own values are important.',
  'are important.',
  'Should find and remove words from middle'
);

console.log('\n📋 Pattern 4: Non-Consecutive Overlap\n');

// Pattern: Previous has word X, then other words, then word Y at end. New starts with X Y
test(
  'Random 4.1: Non-consecutive - word at end + word earlier',
  'We discussed our personal matters and desires.',
  'our desires are important.',
  'are important.',
  'Should remove "our desires" even though separated in previous'
);

test(
  'Random 4.2: Non-consecutive with multiple words',
  'The text mentions our own personal goals and final desires.',
  'our own desires matter.',
  'matter.',
  'Should find "our own" earlier and "desires" at end'
);

console.log('\n📋 Pattern 5: User\'s Specific Case\n');

test(
  'User Case: "our own" in previous, "Our own" at start of new',
  "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent fulfilling our own. '",
  'Our own self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.',
  'self-centered desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.',
  'Should remove "Our own" - detects "own" in both segments'
);

console.log('\n📋 Pattern 6: Edge Cases\n');

test(
  'Edge 6.1: Compound words',
  'The text ends with self-centered person.',
  'self-centered person is good.',
  'is good.',
  'Should handle compound words correctly'
);

test(
  'Edge 6.2: Very long overlap',
  'This is a very long sentence that ends with multiple overlapping words here.',
  'multiple overlapping words here continue the thought.',
  'continue the thought.',
  'Should handle long phrase overlaps'
);

test(
  'Edge 6.3: Partial word match (should not match)',
  'Sentence ends with testing.',
  'test continues.',
  'test continues.',
  'Should NOT match "testing" with "test" (different words)'
);

console.log('\n📋 Pattern 7: Real-World Cases\n');

test(
  'Real-World Case #6→#7: Word not at start position',
  "I love this quote: biblical hospitality is the polar opposite of the cultural trends to separate and isolate, and it rejects the notion that life is best spent fulfilling our own self-serving desires.",
  'Third desires cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.',
  'cordoned off from others. In private fortresses we call home, biblical hospitality chooses to engage rather than unplug.',
  'Should detect "desires" at end of #6 and remove "Third desires" from #7 (word not at position 0)'
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
      console.log(`    Previous Final: "${t.previousFinal.substring(Math.max(0, t.previousFinal.length - 60))}"`);
      console.log(`    New Final:     "${t.newFinal.substring(0, 60)}"`);
      console.log(`    Expected:      "${t.expected}"`);
      console.log(`    Actual:        "${t.actual}"`);
      console.log(`    Words skipped: ${t.wordsSkipped}, Was deduplicated: ${t.wasDeduplicated}\n`);
    });
}

if (failedTests === 0) {
  console.log('🎉 All tests passed!\n');
  process.exit(0);
} else {
  console.log(`\n⚠️  ${failedTests} test(s) failed. Please review the implementation.\n`);
  process.exit(1);
}

