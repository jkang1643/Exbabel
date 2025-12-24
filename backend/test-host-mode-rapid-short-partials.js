/**
 * Test: Rapid Short Partials as Separate Segments
 * 
 * Scenario: Short partials arrive rapidly as separate segments:
 * 1. "when he" (partial 1)
 * 2. "got over" (partial 2 - new segment)
 * 3. "david's finest hour" (partial 3 - new segment)
 * 
 * Problem: If they arrive quickly and the first segment doesn't finalize,
 * will all three still be committed to history?
 * 
 * Run with: node backend/test-host-mode-rapid-short-partials.js
 */

import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';

console.log('🧪 Test: Rapid Short Partials as Separate Segments\n');
console.log('='.repeat(70));

// Simulate host mode behavior for rapid short partials
class RapidShortPartialsTest {
  constructor() {
    this.sentPartials = []; // All partials sent to history
    this.sentFinals = []; // All finals sent to history
    this.pendingFinalizations = []; // Pending finalizations waiting to commit
    this.lastSentFinalText = '';
    this.lastSentFinalTime = 0;
    this.partialTracker = {
      latestPartialText: '',
      longestPartialText: '',
      updatePartial(text) {
        if (!this.latestPartialText || text.length > this.latestPartialText.length) {
          this.latestPartialText = text;
        }
        if (!this.longestPartialText || text.length > this.longestPartialText.length) {
          this.longestPartialText = text;
        }
      },
      reset() {
        this.latestPartialText = '';
        this.longestPartialText = '';
      }
    };
  }

  // Simulate processing a partial (from host/adapter.js logic)
  processPartial(transcriptText, isPartial = true) {
    if (!transcriptText || transcriptText.length === 0) return { sent: false };

    if (!isPartial) {
      return this.processFinal(transcriptText);
    }

    // Deduplicate against last final
    const dedupResult = deduplicatePartialText({
      partialText: transcriptText,
      lastFinalText: this.lastSentFinalText,
      lastFinalTime: this.lastSentFinalTime,
      mode: 'HostMode',
      timeWindowMs: 5000,
      maxWordsToCheck: 5
    });

    let partialTextToSend = dedupResult.deduplicatedText;

    // CRITICAL ISSUE: If deduplication removed all text, we need to check if it's a new segment
    // User requirement: EVERY partial segment must be committed to history
    if (dedupResult.wasDeduplicated && (!partialTextToSend || partialTextToSend.length < 3)) {
      // Check if this is a new segment (doesn't extend previous final)
      const isNewSegmentCheck = this.isNewSegment(transcriptText, this.lastSentFinalText);
      
      if (isNewSegmentCheck) {
        // CRITICAL: Even if deduplication removed all text, if it's a new segment,
        // we MUST send it to preserve history completeness
        console.log(`[Test] ⚠️ New segment detected but deduplication removed all text - sending original to preserve history: "${transcriptText}"`);
        partialTextToSend = transcriptText; // Send original to ensure history completeness
      } else {
        // It's a continuation/duplicate - track but don't send
        console.log(`[Test] ⏭️ Duplicate partial (not new segment) - tracking but not sending: "${transcriptText}"`);
        return { sent: false, reason: 'duplicate' };
      }
    }

    // Update partial tracking
    this.partialTracker.updatePartial(transcriptText);

    // Check if there's a pending finalization
    const hasPendingFinal = this.pendingFinalizations.length > 0;
    
    if (hasPendingFinal) {
      const pending = this.pendingFinalizations[0];
      const pendingText = pending.text.trim();
      const partialText = partialTextToSend.trim();
      
      // Check if partial extends pending final
      const extendsPending = partialText.length > pendingText.length && 
                            (partialText.startsWith(pendingText) || 
                             (pendingText.length > 10 && partialText.substring(0, pendingText.length) === pendingText));
      
      if (extendsPending) {
        // Update pending finalization
        pending.text = partialText;
        pending.timestamp = Date.now();
        console.log(`[Test] 🔁 Partial extends pending final: "${pendingText}" → "${partialText}"`);
        // Don't send as new partial - it will be committed with the final
        return { sent: false, reason: 'extends_pending' };
      } else {
        // New segment - commit pending final immediately
        console.log(`[Test] 🔀 New segment detected - committing pending final: "${pendingText}"`);
        this.commitPendingFinal(pending);
        this.pendingFinalizations = [];
      }
    }

    // Send partial to history
    this.sentPartials.push({
      text: partialTextToSend,
      timestamp: Date.now(),
      originalText: transcriptText
    });

    return { sent: true, text: partialTextToSend };
  }

  // Simulate processing a final
  processFinal(transcriptText) {
    // Check if partials extend this final
    const longestPartial = this.partialTracker.longestPartialText;
    let finalText = transcriptText;

    if (longestPartial && longestPartial.length > transcriptText.length) {
      const longestTrimmed = longestPartial.trim();
      const finalTrimmed = transcriptText.trim();
      
      if (longestTrimmed.startsWith(finalTrimmed) || 
          longestTrimmed.toLowerCase().startsWith(finalTrimmed.toLowerCase())) {
        finalText = longestPartial;
        console.log(`[Test] 🔁 Using longest partial that extends final: "${finalText}"`);
      }
    }

    // Check if final is incomplete (short, no punctuation)
    const finalTrimmed = finalText.trim();
    const endsWithCompleteSentence = /[.!?…]["')]*\s*$/.test(finalTrimmed);
    const isShort = finalTrimmed.length < 25;
    const isIncomplete = !endsWithCompleteSentence || (isShort && !endsWithCompleteSentence);

    if (isIncomplete && longestPartial && longestPartial.length > finalText.length) {
      // Create pending finalization - wait for extending partials
      this.pendingFinalizations.push({
        text: finalText,
        timestamp: Date.now(),
        maxWaitTimestamp: Date.now()
      });
      console.log(`[Test] ⏳ Created pending finalization for incomplete final: "${finalText}"`);
      return { sent: false, reason: 'pending', text: finalText };
    }

    // Commit final immediately
    this.commitFinal(finalText);
    return { sent: true, text: finalText };
  }

  commitPendingFinal(pending) {
    this.commitFinal(pending.text);
  }

  commitFinal(finalText) {
    this.sentFinals.push({
      text: finalText,
      timestamp: Date.now()
    });
    this.lastSentFinalText = finalText;
    this.lastSentFinalTime = Date.now();
    this.partialTracker.reset();
  }

  isNewSegment(partialText, finalText) {
    if (!partialText || !finalText) return true;
    
    const partialTrimmed = partialText.trim();
    const finalTrimmed = finalText.trim();
    
    // Check if partial extends final
    if (partialTrimmed.length > finalTrimmed.length && 
        partialTrimmed.toLowerCase().startsWith(finalTrimmed.toLowerCase())) {
      return false; // Continuation, not new segment
    }
    
    // Check for word overlap
    const partialWords = partialTrimmed.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const finalWords = finalTrimmed.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const sharedWords = partialWords.filter(w => finalWords.includes(w));
    
    // If no shared words, it's a new segment
    if (sharedWords.length === 0) {
      return true;
    }
    
    // If partial starts with capital and final ends with punctuation, likely new segment
    if (/^[A-Z]/.test(partialTrimmed) && /[.!?]$/.test(finalTrimmed)) {
      return true;
    }
    
    return false;
  }
}

// Test the specific scenario
console.log('\n📋 Test Scenario: Rapid Short Partials\n');
console.log('Sequence:');
console.log('  1. "when he" (partial 1)');
console.log('  2. "got over" (partial 2 - new segment)');
console.log('  3. "david\'s finest hour" (partial 3 - new segment)');
console.log('\nExpected: All three should be committed to history\n');

const processor = new RapidShortPartialsTest();

// Simulate rapid arrival (all within 100ms)
const startTime = Date.now();

// Partial 1: "when he"
const result1 = processor.processPartial('when he', true);
console.log(`\n[${Date.now() - startTime}ms] Partial 1: "when he" - ${result1.sent ? '✅ SENT' : '❌ NOT SENT'}`);

// Wait a bit (simulate rapid but not instant)
setTimeout(() => {
  // Partial 2: "got over" (new segment - doesn't extend "when he")
  const result2 = processor.processPartial('got over', true);
  console.log(`[${Date.now() - startTime}ms] Partial 2: "got over" - ${result2.sent ? '✅ SENT' : '❌ NOT SENT'}`);
  
  setTimeout(() => {
    // Partial 3: "david's finest hour" (new segment)
    const result3 = processor.processPartial('david\'s finest hour', true);
    console.log(`[${Date.now() - startTime}ms] Partial 3: "david's finest hour" - ${result3.sent ? '✅ SENT' : '❌ NOT SENT'}`);
    
    // Final check
    setTimeout(() => {
      console.log('\n' + '='.repeat(70));
      console.log('\n📊 Results:\n');
      console.log(`Partials sent to history: ${processor.sentPartials.length}`);
      processor.sentPartials.forEach((p, i) => {
        console.log(`  ${i + 1}. "${p.text}" (original: "${p.originalText}")`);
      });
      
      console.log(`\nFinals sent to history: ${processor.sentFinals.length}`);
      processor.sentFinals.forEach((f, i) => {
        console.log(`  ${i + 1}. "${f.text}"`);
      });
      
      const allThreeSent = processor.sentPartials.length >= 3;
      const allThreeInHistory = processor.sentPartials.some(p => p.text.includes('when he')) &&
                                processor.sentPartials.some(p => p.text.includes('got over')) &&
                                processor.sentPartials.some(p => p.text.includes('david'));
      
      console.log('\n' + '='.repeat(70));
      if (allThreeSent && allThreeInHistory) {
        console.log('\n✅ TEST PASSED: All three short partials were committed to history');
        process.exit(0);
      } else {
        console.log('\n❌ TEST FAILED: Not all three short partials were committed to history');
        console.log(`   Expected: 3 partials in history`);
        console.log(`   Actual: ${processor.sentPartials.length} partials in history`);
        if (!allThreeInHistory) {
          console.log('   Missing segments in history!');
        }
        process.exit(1);
      }
    }, 50);
  }, 50);
}, 50);

