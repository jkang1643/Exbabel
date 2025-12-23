/**
 * Comprehensive Test Suite for Final-to-Final Deduplication
 * 
 * Tests the general rule: Check several words from the END of previous final
 * and several words from the START of new final. If any words overlap,
 * remove all words from the start up to and including the last matching word.
 * 
 * This should work for EVERY possible duplication scenario.
 */

import { deduplicateFinalText } from '../core/utils/finalDeduplicator.js';

console.log('🧪 Comprehensive Duplication Test Suite\n');
console.log('Testing the general rule: Check windows at end of previous and start of new\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

function test(name, previousFinal, newFinal, expected, description = '') {
  totalTests++;
  
  try {
    const result = deduplicateFinalText({
      newFinalText: newFinal,
      previousFinalText: previousFinal,
      previousFinalTime: Date.now() - 1000,
      mode: 'Test',
      timeWindowMs: 5000,
      maxWordsToCheck: 10
    });
    
    const actual = result.deduplicatedText;
    const passed = actual === expected;
    
    if (passed) {
      console.log(`✅ ${name}`);
      passedTests++;
    } else {
      console.log(`❌ ${name}`);
      if (description) console.log(`   ${description}`);
      console.log(`   Previous: "${previousFinal.substring(Math.max(0, previousFinal.length - 60))}"`);
      console.log(`   New:      "${newFinal.substring(0, 60)}"`);
      console.log(`   Expected: "${expected}"`);
      console.log(`   Actual:   "${actual}"`);
      failedTests++;
      failures.push({ name, previousFinal, newFinal, expected, actual, description });
    }
    
    return passed;
  } catch (error) {
    console.log(`❌ ${name} - ERROR: ${error.message}`);
    failedTests++;
    failures.push({ name, error: error.message });
    return false;
  }
}

// ============================================================================
// Category 1: Single Word Overlaps
// ============================================================================

console.log('\n📋 Category 1: Single Word Overlaps\n');

test(
  '1.1: Word at position 0',
  'Sentence ends with test.',
  'test continues here.',
  'continues here.',
  'Single word at start'
);

test(
  '1.2: Word at position 1',
  'Ends with important.',
  'Some important matters.',
  'matters.',
  'Word not at start (your case pattern)'
);

test(
  '1.3: Word at position 2',
  'Text concludes with matters.',
  'A few matters need attention.',
  'need attention.',
  'Word at position 2'
);

test(
  '1.4: Word at position 5',
  'Previous ends with goals.',
  'One two three four five goals are clear.',
  'are clear.',
  'Word deep in start window'
);

// ============================================================================
// Category 2: Multiple Word Overlaps
// ============================================================================

console.log('\n📋 Category 2: Multiple Word Overlaps\n');

test(
  '2.1: Two words consecutive at start',
  'Ends with our own.',
  'our own goals matter.',
  'goals matter.',
  'Two words at start'
);

test(
  '2.2: Two words, one at start, one later',
  'Ends with desires.',
  'our desires are important.',
  'are important.',
  'First word doesn\'t match, second does'
);

test(
  '2.3: Three words scattered',
  'Text has our goals and matters.',
  'Some our matters goals are clear.',
  'are clear.',
  'Words appear in different order'
);

test(
  '2.4: Multiple words, some match, some don\'t',
  'Ends with personal goals.',
  'Third personal goals matter.',
  'matter.',
  'Some words match, some don\'t'
);

// ============================================================================
// Category 3: Words at End of Previous
// ============================================================================

console.log('\n📋 Category 3: Words at End of Previous\n');

test(
  '3.1: Last word matches',
  'Sentence ends with test.',
  'test continues.',
  'continues.',
  'Last word of previous matches'
);

test(
  '3.2: Second-to-last word matches',
  'Ends with important test.',
  'important continues.',
  'continues.',
  'Word near end matches'
);

test(
  '3.3: Word deep in end window',
  'The text discusses many topics including our own personal goals.',
  'our own goals matter.',
  'matter.',
  'Words appear earlier in end window'
);

// ============================================================================
// Category 4: Real-World Patterns
// ============================================================================

console.log('\n📋 Category 4: Real-World Patterns\n');

test(
  '4.1: Your case #6→#7',
  "I love this quote: biblical hospitality is the polar opposite of the cultural trends to separate and isolate, and it rejects the notion that life is best spent fulfilling our own self-serving desires.",
  'Third desires cordoned off from others.',
  'cordoned off from others.',
  'Real-world case: word at position 1'
);

test(
  '4.2: Quote continuation',
  "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent fulfilling our own. '",
  'Our own self-centered desires cordoned off.',
  'self-centered desires cordoned off.',
  'Quote continuation pattern'
);

test(
  '4.3: Sentence continuation',
  'We discussed our personal goals and aspirations.',
  'Our personal goals are important.',
  'are important.',
  'Sentence continuation'
);

// ============================================================================
// Category 5: Edge Cases
// ============================================================================

console.log('\n📋 Category 5: Edge Cases\n');

test(
  '5.1: Punctuation differences',
  'Ends with test, period.',
  'test period continues.',
  'continues.',
  'Punctuation in previous'
);

test(
  '5.2: Case variations',
  'Ends with IMPORTANT.',
  'important matters.',
  'matters.',
  'Case differences'
);

test(
  '5.3: Extra spacing',
  'Ends with  our  own.',
  'our own goals.',
  'goals.',
  'Extra spaces in previous'
);

test(
  '5.4: Compound words',
  'Ends with self-centered person.',
  'self-centered person is good.',
  'is good.',
  'Compound word handling'
);

test(
  '5.5: Numbers',
  'Ends with 123.',
  '123 continues.',
  'continues.',
  'Number matching'
);

test(
  '5.6: Very long overlap',
  'This is a very long sentence that ends with multiple overlapping words here.',
  'multiple overlapping words here continue.',
  'continue.',
  'Long phrase overlap'
);

// ============================================================================
// Category 6: No Overlap Cases (Should Not Deduplicate)
// ============================================================================

console.log('\n📋 Category 6: No Overlap (Should Not Deduplicate)\n');

test(
  '6.1: Completely different',
  'Previous sentence ends here.',
  'New sentence starts fresh.',
  'New sentence starts fresh.',
  'No overlap - should not change'
);

test(
  '6.2: Similar but different words',
  'Ends with testing.',
  'test continues.',
  'test continues.',
  'Similar words but not exact match'
);

test(
  '6.3: Words too far apart',
  'First sentence.',
  'Second sentence.',
  'Second sentence.',
  'No overlap in windows'
);

// ============================================================================
// Category 7: Complex Scenarios
// ============================================================================

console.log('\n📋 Category 7: Complex Scenarios\n');

test(
  '7.1: Multiple matches, remove all',
  'Ends with our own personal goals.',
  'Third our own personal goals matter.',
  'matter.',
  'Multiple words match, remove all including non-matching prefix'
);

test(
  '7.2: Partial phrase match',
  'Discusses our personal matters and goals.',
  'Some our personal goals are clear.',
  'are clear.',
  'Partial phrase in previous, full phrase in new'
);

test(
  '7.3: Words separated in previous',
  'We talked about our values and personal goals.',
  'our personal goals matter.',
  'matter.',
  'Words separated in previous, together in new'
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
  failures.forEach((f, i) => {
    console.log(`${i + 1}. ${f.name}`);
    if (f.description) console.log(`   ${f.description}`);
    if (f.error) {
      console.log(`   Error: ${f.error}`);
    } else {
      console.log(`   Previous: "${f.previousFinal.substring(Math.max(0, f.previousFinal.length - 50))}"`);
      console.log(`   New:      "${f.newFinal.substring(0, 50)}"`);
      console.log(`   Expected: "${f.expected}"`);
      console.log(`   Actual:   "${f.actual}"`);
    }
    console.log('');
  });
  process.exit(1);
} else {
  console.log('🎉 All tests passed! The general window-based approach works for every scenario!\n');
  process.exit(0);
}

