/**
 * Test Suite: Missing Words in Host Mode Partials
 * 
 * TDD Approach: Write failing tests that expose why short segments and small words
 * get left out of the final transcript, sometimes cutting off mid-sentence.
 * 
 * Run with: node backend/test-host-mode-missing-words.js
 */

import { PartialTracker } from '../core/engine/partialTracker.js';
import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';

console.log('🧪 Host Mode Missing Words Test Suite\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

/**
 * Simulate host mode partial processing logic
 */
class HostModePartialProcessor {
  constructor() {
    this.partialTracker = new PartialTracker();
    this.lastSentFinalText = '';
    this.lastSentFinalTime = 0;
    this.sentPartials = [];
    this.sentFinals = [];
    this.droppedPartials = [];
  }

  /**
   * Process a partial transcript
   * Simulates the logic from backend/host/adapter.js lines 1050-1320
   */
  processPartial(transcriptText, isPartial = true) {
    if (!transcriptText || transcriptText.length === 0) {
      return { sent: false, reason: 'empty' };
    }

    if (!isPartial) {
      return this.processFinal(transcriptText);
    }

    // Deduplicate against last final
    let partialTextToSend = transcriptText;
    let shouldDeduplicate = true;

    // Check if partial is a new segment (similar to lines 1142-1178)
    if (this.lastSentFinalText) {
      const forcedText = this.lastSentFinalText.trim();
      const partialText = transcriptText.trim();
      const forcedEndsWithPunctuation = /[.!?]$/.test(forcedText);
      const partialStartsWithCapital = /^[A-Z]/.test(partialText);
      
      if (forcedEndsWithPunctuation && partialStartsWithCapital) {
        shouldDeduplicate = false;
      }
    }

    if (shouldDeduplicate && this.lastSentFinalText) {
      const dedupResult = deduplicatePartialText({
        partialText: transcriptText,
        lastFinalText: this.lastSentFinalText,
        lastFinalTime: this.lastSentFinalTime,
        mode: 'HostMode',
        timeWindowMs: 5000,
        maxWordsToCheck: 3
      });

      partialTextToSend = dedupResult.deduplicatedText;

      // CRITICAL ISSUE: Current logic skips if text is completely removed
      // This causes words to be lost!
      const trimmedDeduped = partialTextToSend ? partialTextToSend.trim() : '';
      if (dedupResult.wasDeduplicated && trimmedDeduped.length === 0) {
        this.droppedPartials.push({ text: transcriptText, reason: 'all_duplicates' });
        return { sent: false, reason: 'all_duplicates' };
      }
    }

    // Update partial tracking
    this.partialTracker.updatePartial(partialTextToSend);

    // Check if partial extends a final - CHECK ORIGINAL TEXT FIRST (before deduplication)
    // This matches the fixed logic in backend/host/adapter.js
    let extendsAnyFinal = false;
    const originalPartialText = transcriptText.trim();
    
    // Check if original extends lastSentFinalText (most common case)
    if (this.lastSentFinalText && originalPartialText) {
      const lastSentText = this.lastSentFinalText.trim();
      const lastSentNormalized = lastSentText.toLowerCase();
      const originalNormalized = originalPartialText.toLowerCase();
      
      if (originalPartialText.length > lastSentText.length && 
          (originalNormalized.startsWith(lastSentNormalized) || 
           (lastSentText.length > 10 && originalNormalized.substring(0, lastSentNormalized.length) === lastSentNormalized) ||
           originalPartialText.startsWith(lastSentText))) {
        extendsAnyFinal = true;
      }
    }
    
    const isExtremelyShort = partialTextToSend.trim().length < 3; // Only filter truly tiny partials (< 3 chars)
    const timeSinceLastFinal = this.lastSentFinalTime ? (Date.now() - this.lastSentFinalTime) : Infinity;
    const isNewSegmentStart = timeSinceLastFinal < 2000;

    // FIXED: Only skip if extremely short (< 3 chars) AND at segment start AND very recent AND does NOT extend any final
    // Changed threshold from 4 to 3 chars to allow single words like "But", "I", "A", etc. to be sent
    // If partial extends a final, it should ALWAYS be sent to prevent word loss
    if (isExtremelyShort && isNewSegmentStart && timeSinceLastFinal < 500 && !extendsAnyFinal) {
      this.droppedPartials.push({ text: partialTextToSend, reason: 'very_short_at_start' });
      return { sent: false, reason: 'very_short_at_start' };
    }

    // Send partial
    this.sentPartials.push({
      text: partialTextToSend,
      timestamp: Date.now(),
      originalText: transcriptText
    });

    return { sent: true, type: 'partial', text: partialTextToSend };
  }

  processFinal(transcriptText) {
    // Check if partials extend this final
    const snapshot = this.partialTracker.getSnapshot();
    let finalText = transcriptText;

    // Use longest partial if it extends the final
    if (snapshot.longest && snapshot.longest.length > transcriptText.length) {
      const longestTrimmed = snapshot.longest.trim();
      const finalTrimmed = transcriptText.trim();
      
      if (longestTrimmed.startsWith(finalTrimmed) || 
          longestTrimmed.toLowerCase().startsWith(finalTrimmed.toLowerCase())) {
        finalText = snapshot.longest;
      }
    }

    this.sentFinals.push({
      text: finalText,
      timestamp: Date.now(),
      originalText: transcriptText
    });

    this.lastSentFinalText = finalText;
    this.lastSentFinalTime = Date.now();

    // Reset partial tracking
    this.partialTracker.reset();

    return { sent: true, type: 'final', text: finalText };
  }
}

function test(name, testFn) {
  totalTests++;
  const startTime = Date.now();
  
  try {
    const processor = new HostModePartialProcessor();
    const result = testFn(processor);
    const duration = Date.now() - startTime;
    
    if (result.passed) {
      console.log(`✅ ${name} (${duration}ms)`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration });
    } else {
      console.log(`❌ ${name} (${duration}ms)`);
      if (result.message) console.log(`   ${result.message}`);
      if (result.expected !== undefined) console.log(`   Expected: ${result.expected}`);
      if (result.actual !== undefined) console.log(`   Actual: ${result.actual}`);
      failedTests++;
      testDetails.push({ 
        name, 
        status: 'failed', 
        duration,
        message: result.message,
        expected: result.expected,
        actual: result.actual
      });
    }
    
    return result.passed;
  } catch (error) {
    console.log(`❌ ${name} - ERROR: ${error.message}`);
    console.error(error.stack);
    failedTests++;
    testDetails.push({ name, status: 'error', duration: Date.now() - startTime, error: error.message });
    return false;
  }
}

// ============================================================================
// Test Cases: Missing Words
// ============================================================================

console.log('\n📋 Category 1: Short Segments and Small Words\n');

test('Test 1: Single word partials should not be dropped', (p) => {
  // Scenario: User says "I" then pauses, then continues
  // Current behavior: "I" might be dropped as very short partial
  // Expected: "I" should be sent so it appears in final transcript
  
  const result1 = p.processPartial('I', true);
  
  return {
    passed: result1.sent && result1.text === 'I',
    message: 'Single word partial "I" should not be dropped',
    expected: 'Partial sent with text "I"',
    actual: result1.sent ? `Sent: "${result1.text}"` : `Dropped: ${result1.reason}`
  };
});

test('Test 2: Two-word partials should not be dropped', (p) => {
  // Scenario: User says "Oh my" then pauses
  // Current behavior: "Oh my" (5 chars) might be dropped if very recent after final
  // Expected: "Oh my" should be sent
  
  // Simulate recent final
  p.lastSentFinalTime = Date.now() - 200; // 200ms ago
  
  const result = p.processPartial('Oh my', true);
  
  return {
    passed: result.sent && result.text.includes('Oh') && result.text.includes('my'),
    message: 'Two-word partial "Oh my" should not be dropped',
    expected: 'Partial sent with both words',
    actual: result.sent ? `Sent: "${result.text}"` : `Dropped: ${result.reason}`
  };
});

test('Test 3: Short words like "a", "an", "the" should not be lost', (p) => {
  // Scenario: Final "Open" followed by partial "Open a"
  // Current behavior: "a" might be deduplicated or dropped
  // Expected: "a" should be preserved
  
  p.processFinal('Open', false);
  
  const result = p.processPartial('Open a', true);
  
  return {
    passed: result.sent && result.text.includes('a'),
    message: 'Small word "a" should not be lost',
    expected: 'Partial contains "a"',
    actual: result.sent ? `Sent: "${result.text}"` : `Dropped: ${result.reason}`
  };
});

test('Test 4: Words cut off mid-sentence should be captured', (p) => {
  // Scenario: Final "I've been" followed by partials that extend it
  // Issue: Sometimes mid-sentence cuts happen and words are lost
  // Expected: All extending words should be captured
  
  p.processFinal('I\'ve been', false);
  
  const partials = [
    'I\'ve been to',
    'I\'ve been to grocery',
    'I\'ve been to grocery stores'
  ];
  
  const results = partials.map(partial => p.processPartial(partial, true));
  const allSent = results.every(r => r.sent);
  const finalText = results[results.length - 1].text;
  
  return {
    passed: allSent && finalText.includes('grocery') && finalText.includes('stores'),
    message: 'All extending words should be captured',
    expected: 'Partial "I\'ve been to grocery stores" sent with all words',
    actual: allSent ? `Final partial: "${finalText}"` : 'Some partials dropped'
  };
});

test('Test 5: Short segment after long final should not be dropped', (p) => {
  // Scenario: Long final "This is a very long sentence about something important."
  // Followed by short partial "But"
  // Current behavior: "But" might be dropped as very short
  // Expected: "But" should be sent (it's a new segment start)
  
  p.processFinal('This is a very long sentence about something important.', false);
  
  // Small delay to simulate real scenario
  p.lastSentFinalTime = Date.now() - 100;
  
  const result = p.processPartial('But', true);
  
  return {
    passed: result.sent && result.text === 'But',
    message: 'Short word "But" starting new segment should not be dropped',
    expected: 'Partial "But" sent',
    actual: result.sent ? `Sent: "${result.text}"` : `Dropped: ${result.reason}`
  };
});

test('Test 6: Small words in continuation should not be deduplicated away', (p) => {
  // Scenario: Final "the end" followed by partial "the end of"
  // Current behavior: "of" might be deduplicated if "the end" matches
  // Expected: "of" should be preserved
  
  p.processFinal('the end', false);
  
  const result = p.processPartial('the end of', true);
  
  return {
    passed: result.sent && result.text.includes('of') && !result.text.endsWith('the end'),
    message: 'Small word "of" should not be lost during deduplication',
    expected: 'Partial contains "of"',
    actual: result.sent ? `Sent: "${result.text}"` : `Dropped: ${result.reason}`
  };
});

test('Test 7: Mid-sentence cutoff should use longest partial', (p) => {
  // Scenario: Final "You just can't" but partials extend to "You just can't beat"
  // Issue: Final might commit before seeing the extending partials
  // Expected: Final should use longest partial that extends it
  
  // Simulate partials arriving
  p.processPartial('You just can\'t', true);
  p.processPartial('You just can\'t beat', true);
  p.processPartial('You just can\'t beat people', true);
  
  // Now final arrives
  const finalResult = p.processFinal('You just can\'t', false);
  
  return {
    passed: finalResult.text && finalResult.text.includes('beat'),
    message: 'Final should use longest partial that extends it',
    expected: 'Final text includes "beat" from longest partial',
    actual: finalResult.text ? `Final: "${finalResult.text}"` : 'No final text'
  };
});

test('Test 8: Rapid short partials should all be tracked', (p) => {
  // Scenario: Rapid sequence "I", "I am", "I am here"
  // Current behavior: First "I" might be dropped, losing it from final
  // Expected: All partials should be tracked, longest should be preserved
  
  p.processPartial('I', true);
  p.processPartial('I am', true);
  p.processPartial('I am here', true);
  
  const snapshot = p.partialTracker.getSnapshot();
  const longest = snapshot.longest;
  
  return {
    passed: longest && longest.includes('here') && longest.includes('I'),
    message: 'All rapid partials should be tracked, longest preserved',
    expected: 'Longest partial contains "I am here"',
    actual: longest ? `Longest: "${longest}"` : 'No longest partial'
  };
});

test('Test 9: Words after punctuation should not be lost', (p) => {
  // Scenario: Final "Hello." followed by partial "Hello. How"
  // Current behavior: "How" might be dropped if deduplication is too aggressive
  // Expected: "How" should be preserved (new sentence after period)
  
  p.processFinal('Hello.', false);
  
  const result = p.processPartial('Hello. How', true);
  
  return {
    passed: result.sent && result.text.includes('How'),
    message: 'Words after punctuation should not be lost',
    expected: 'Partial contains "How"',
    actual: result.sent ? `Sent: "${result.text}"` : `Dropped: ${result.reason}`
  };
});

test('Test 10: Single character words should be preserved', (p) => {
  // Scenario: Partial "I a" (user saying "I a..." before completing thought)
  // Current behavior: "a" might be lost
  // Expected: Both "I" and "a" should be preserved
  
  const result = p.processPartial('I a', true);
  
  return {
    passed: result.sent && result.text.includes('I') && result.text.includes('a'),
    message: 'Single character words should be preserved',
    expected: 'Partial contains both "I" and "a"',
    actual: result.sent ? `Sent: "${result.text}"` : `Dropped: ${result.reason}`
  };
});

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
      if (t.message) console.log(`    ${t.message}`);
      if (t.expected !== undefined) console.log(`    Expected: ${t.expected}`);
      if (t.actual !== undefined) console.log(`    Actual: ${t.actual}\n`);
    });
}

if (failedTests === 0) {
  console.log('🎉 All tests passed!\n');
  process.exit(0);
} else {
  console.log(`\n⚠️  ${failedTests} test(s) failed. These identify issues that need to be fixed.\n`);
  process.exit(1);
}

