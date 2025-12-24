/**
 * Test: Partial Extension After Final
 * 
 * Tests the scenario from the logs where:
 * - Final: "I almost wish sometimes people would stop having services."
 * - Partial: "and," or "And go"
 * - These should extend the final, not be dropped
 */

import { PartialTracker } from '../core/engine/partialTracker.js';
import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';

console.log('🧪 Partial Extension After Final Test\n');
console.log('='.repeat(70));

class TestProcessor {
  constructor() {
    this.partialTracker = new PartialTracker();
    this.lastSentFinalText = '';
    this.lastSentFinalTime = 0;
    this.sentPartials = [];
  }

  processPartial(transcriptText) {
    // Deduplicate
    let partialTextToSend = transcriptText;
    if (this.lastSentFinalText) {
      const dedupResult = deduplicatePartialText({
        partialText: transcriptText,
        lastFinalText: this.lastSentFinalText,
        lastFinalTime: this.lastSentFinalTime,
        mode: 'HostMode',
        timeWindowMs: 5000,
        maxWordsToCheck: 3
      });
      partialTextToSend = dedupResult.deduplicatedText;
      
      const trimmedDeduped = partialTextToSend ? partialTextToSend.trim() : '';
      if (dedupResult.wasDeduplicated && trimmedDeduped.length === 0) {
        return { sent: false, reason: 'all_duplicates' };
      }
    }

    // Track partial
    this.partialTracker.updatePartial(partialTextToSend);

    // Check if extends final (using ORIGINAL text first)
    let extendsAnyFinal = false;
    const originalPartialText = transcriptText.trim();
    
    if (this.lastSentFinalText && originalPartialText) {
      const lastSentText = this.lastSentFinalText.trim();
      const lastSentNormalized = lastSentText.toLowerCase();
      const originalNormalized = originalPartialText.toLowerCase();
      
      if (originalPartialText.length > lastSentText.length && 
          (originalNormalized.startsWith(lastSentNormalized) || 
           originalPartialText.startsWith(lastSentText))) {
        extendsAnyFinal = true;
        console.log(`[Test] ✅ Original partial extends final`);
      }
    }

    const isExtremelyShort = partialTextToSend.trim().length < 3;
    const timeSinceLastFinal = this.lastSentFinalTime ? (Date.now() - this.lastSentFinalTime) : Infinity;
    const isNewSegmentStart = timeSinceLastFinal < 2000;

    // Only skip if extremely short AND new segment AND recent AND does NOT extend
    if (isExtremelyShort && isNewSegmentStart && timeSinceLastFinal < 500 && !extendsAnyFinal) {
      return { sent: false, reason: 'very_short_at_start' };
    }

    this.sentPartials.push({ text: partialTextToSend, timestamp: Date.now() });
    return { sent: true, text: partialTextToSend };
  }

  processFinal(text) {
    // Use longest partial if it extends
    const snapshot = this.partialTracker.getSnapshot();
    let finalText = text;
    
    if (snapshot.longest && snapshot.longest.length > text.length) {
      const longestTrimmed = snapshot.longest.trim();
      const finalTrimmed = text.trim();
      
      if (longestTrimmed.startsWith(finalTrimmed) || 
          longestTrimmed.toLowerCase().startsWith(finalTrimmed.toLowerCase())) {
        finalText = snapshot.longest;
        console.log(`[Test] ✅ Using longest partial: "${finalText}"`);
      }
    }

    this.lastSentFinalText = finalText;
    this.lastSentFinalTime = Date.now();
    this.partialTracker.reset();
    
    return { text: finalText };
  }
}

// Test scenario from logs
console.log('\n📋 Test: "and," after final should extend\n');

const processor = new TestProcessor();

// Final arrives
processor.processFinal("I almost wish sometimes people would stop having services.");
console.log(`[Test] Final: "${processor.lastSentFinalText}"`);

// Partial "and," arrives shortly after
setTimeout(() => {
  const result = processor.processPartial("and,");
  
  if (!result.sent) {
    console.log(`\n❌ FAILED: Partial "and," was dropped: ${result.reason}`);
    process.exit(1);
  } else {
    console.log(`\n✅ PASSED: Partial "and," was sent`);
    
    // Check if it's tracked
    const snapshot = processor.partialTracker.getSnapshot();
    if (snapshot.longest && snapshot.longest.includes('and')) {
      console.log(`✅ PASSED: Partial is tracked in longest: "${snapshot.longest}"`);
      process.exit(0);
    } else {
      console.log(`❌ FAILED: Partial not in longest tracker`);
      process.exit(1);
    }
  }
}, 100);

setTimeout(() => process.exit(1), 1000);

