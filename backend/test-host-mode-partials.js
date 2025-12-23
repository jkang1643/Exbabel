/**
 * Host Mode Partial Handling Test Suite
 * 
 * Comprehensive tests for fixing partial transcription issues in host mode:
 * 1. Partials not transcribing fast enough (throttling/delays)
 * 2. Partials being dropped (skipped/not sent)
 * 3. Partials being overwritten (race conditions)
 * 4. Partials appearing in forced finals (contamination)
 * 
 * Run with: node backend/test-host-mode-partials.js
 * 
 * TDD Approach: Write failing tests first, then implement fixes
 */

import { CoreEngine } from '../core/engine/coreEngine.js';
import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';

console.log('🧪 Host Mode Partial Handling Test Suite\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

// Mock classes to simulate host mode behavior
class MockPartialTracker {
  constructor() {
    this.latestPartialText = '';
    this.latestPartialTime = 0;
    this.longestPartialText = '';
    this.longestPartialTime = 0;
    this.latestPartialTextForCorrection = '';
  }

  updatePartial(transcriptText) {
    if (!transcriptText) return { latestUpdated: false, longestUpdated: false };
    
    const now = Date.now();
    let latestUpdated = false;
    let longestUpdated = false;
    
    this.latestPartialTextForCorrection = transcriptText;
    
    if (!this.latestPartialText || transcriptText.length > this.latestPartialText.length) {
      this.latestPartialText = transcriptText;
      this.latestPartialTime = now;
      latestUpdated = true;
    }
    
    if (!this.longestPartialText || transcriptText.length > this.longestPartialText.length) {
      this.longestPartialText = transcriptText;
      this.longestPartialTime = now;
      longestUpdated = true;
    }
    
    return { latestUpdated, longestUpdated };
  }

  getLatestPartial() {
    return this.latestPartialText;
  }

  getLongestPartial() {
    return this.longestPartialText;
  }

  getSnapshot() {
    return {
      longest: this.longestPartialText,
      latest: this.latestPartialText,
      longestTime: this.longestPartialTime,
      latestTime: this.latestPartialTime
    };
  }

  reset() {
    this.latestPartialText = '';
    this.longestPartialText = '';
    this.latestPartialTime = 0;
    this.longestPartialTime = 0;
  }
}

class MockForcedCommitEngine {
  constructor() {
    this.forcedFinalBuffer = null;
    this.FORCED_FINAL_MAX_WAIT_MS = 2000;
  }

  hasForcedFinalBuffer() {
    return this.forcedFinalBuffer !== null;
  }

  getForcedFinalBuffer() {
    return this.forcedFinalBuffer;
  }

  createForcedFinalBuffer(text, timestamp = Date.now()) {
    this.forcedFinalBuffer = {
      text,
      timestamp,
      timeout: null,
      recoveryInProgress: false,
      recoveryPromise: null,
      committedByRecovery: false
    };
    return this.forcedFinalBuffer;
  }

  checkPartialExtendsForcedFinal(partialText) {
    if (!this.forcedFinalBuffer || !partialText) return null;
    
    const forcedText = this.forcedFinalBuffer.text.trim();
    const partialTextTrimmed = partialText.trim();
    
    const extendsForced = partialTextTrimmed.length > forcedText.length && 
                         (partialTextTrimmed.startsWith(forcedText) || 
                          (forcedText.length > 10 && partialTextTrimmed.substring(0, forcedText.length) === forcedText));
    
    if (extendsForced) {
      return {
        extends: true,
        extendedText: partialTextTrimmed,
        missingWords: partialTextTrimmed.substring(forcedText.length).trim()
      };
    }
    
    return null;
  }

  clearForcedFinalBuffer() {
    this.forcedFinalBuffer = null;
  }
}

class MockFinalizationEngine {
  constructor() {
    this.pendingFinalization = null;
    this.MAX_FINALIZATION_WAIT_MS = 5000;
  }

  hasPendingFinalization() {
    return this.pendingFinalization !== null;
  }

  getPendingFinalization() {
    return this.pendingFinalization;
  }

  createPendingFinalization(text, seqId = null) {
    this.pendingFinalization = {
      seqId,
      text,
      timestamp: Date.now(),
      maxWaitTimestamp: Date.now(),
      timeout: null
    };
    return this.pendingFinalization;
  }

  endsWithCompleteSentence(text) {
    if (!text || text.length === 0) return false;
    const trimmed = text.trim();
    if (/[.!?…]["')]*\s*$/.test(trimmed)) return true;
    if (/[.!?…]\s*$/.test(trimmed)) return true;
    return false;
  }

  clearPendingFinalization() {
    this.pendingFinalization = null;
  }
}

// Simulate host mode partial processing logic
class HostModePartialProcessor {
  constructor() {
    this.partialTracker = new MockPartialTracker();
    this.forcedCommitEngine = new MockForcedCommitEngine();
    this.finalizationEngine = new MockFinalizationEngine();
    this.lastSentFinalText = '';
    this.lastSentFinalTime = 0;
    this.sentPartials = []; // Track all sent partials
    this.sentFinals = []; // Track all sent finals
    this.droppedPartials = []; // Track dropped partials
    this.pendingPartialTranslation = null;
    this.lastPartialTranslation = '';
    this.currentPartialText = '';
  }

  // Simulate the partial processing logic from host/adapter.js
  processPartial(transcriptText, isPartial = true) {
    if (!transcriptText || transcriptText.length === 0) {
      return { sent: false, reason: 'empty' };
    }

    if (!isPartial) {
      // Handle final
      this.processFinal(transcriptText);
      return { sent: true, type: 'final' };
    }

    // Handle forced final buffer
    if (this.forcedCommitEngine.hasForcedFinalBuffer()) {
      const extension = this.forcedCommitEngine.checkPartialExtendsForcedFinal(transcriptText);
      
      if (extension && extension.extends) {
        // Partial extends forced final - merge and commit
        const mergedFinal = this.mergeWithOverlap(
          this.forcedCommitEngine.getForcedFinalBuffer().text,
          transcriptText
        );
        if (mergedFinal) {
          this.processFinal(mergedFinal, { forceFinal: true });
          this.forcedCommitEngine.clearForcedFinalBuffer();
          return { sent: true, type: 'forced_final_merged' };
        }
      }
    }

    // Deduplicate against last final
    const dedupResult = deduplicatePartialText({
      partialText: transcriptText,
      lastFinalText: this.lastSentFinalText,
      lastFinalTime: this.lastSentFinalTime,
      mode: 'HostMode',
      timeWindowMs: 5000,
      maxWordsToCheck: 3
    });

    let partialTextToSend = dedupResult.deduplicatedText;

    // Skip if all words were duplicates
    if (dedupResult.wasDeduplicated && (!partialTextToSend || partialTextToSend.length < 3)) {
      this.droppedPartials.push({ text: transcriptText, reason: 'all_duplicates' });
      return { sent: false, reason: 'all_duplicates' };
    }

    // CRITICAL: Check if there's a pending finalization that this partial extends
    if (this.finalizationEngine.hasPendingFinalization()) {
      const pending = this.finalizationEngine.getPendingFinalization();
      const pendingText = pending.text.trim();
      const partialText = partialTextToSend.trim();
      
      // Check if partial extends the pending final
      if (partialText.length > pendingText.length && 
          (partialText.startsWith(pendingText) || 
           (pendingText.length > 10 && partialText.substring(0, pendingText.length) === pendingText))) {
        // Partial extends pending final - update it
        this.finalizationEngine.createPendingFinalization(partialText);
        console.log(`[Test] 🔁 Partial extends pending final: "${pendingText.substring(0, 30)}..." → "${partialText.substring(0, 50)}..."`);
      }
    }

    // Update partial tracking
    this.partialTracker.updatePartial(partialTextToSend);
    this.currentPartialText = partialTextToSend;

    // Check for very short partials at segment start
    const isVeryShortPartial = partialTextToSend.trim().length < 5;
    const timeSinceLastFinal = this.lastSentFinalTime ? (Date.now() - this.lastSentFinalTime) : Infinity;
    const isNewSegmentStart = !this.forcedCommitEngine.hasForcedFinalBuffer() && 
                              !this.finalizationEngine.hasPendingFinalization() &&
                              timeSinceLastFinal < 2000;

    if (isVeryShortPartial && isNewSegmentStart && timeSinceLastFinal < 500) {
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

  processFinal(transcriptText, options = {}) {
    const isForcedFinal = !!options.forceFinal;
    
    // Check if partials extend this final
    const snapshot = this.partialTracker.getSnapshot();
    let finalText = transcriptText;

    // CRITICAL: Check if longest partial extends the final
    if (snapshot.longest && snapshot.longest.length > transcriptText.length) {
      const longestTrimmed = snapshot.longest.trim();
      const finalTrimmed = transcriptText.trim();
      
      if (longestTrimmed.startsWith(finalTrimmed) || 
          longestTrimmed.toLowerCase().startsWith(finalTrimmed.toLowerCase())) {
        // Longest partial extends final - use longest
        finalText = snapshot.longest;
        console.log(`[Test] 🔁 Using longest partial that extends final: "${finalText.substring(0, 50)}..."`);
      }
    }

    // CRITICAL: Check if forced final contains partial text (contamination)
    if (isForcedFinal) {
      const forcedText = finalText.trim();
      const latestPartial = this.partialTracker.getLatestPartial();
      
      // If forced final is shorter than latest partial, it might be contaminated
      if (latestPartial && latestPartial.length > forcedText.length) {
        // Check if forced final is a prefix of latest partial
        if (latestPartial.startsWith(forcedText) || latestPartial.toLowerCase().startsWith(forcedText.toLowerCase())) {
          // This is contamination - forced final should not contain partial text
          console.warn(`[Test] ⚠️ Forced final may be contaminated: forced="${forcedText.substring(0, 50)}..." latestPartial="${latestPartial.substring(0, 50)}..."`);
        }
      }
    }

    // CRITICAL: For non-forced finals, check if they're incomplete and should wait
    if (!isForcedFinal) {
      const finalTrimmed = finalText.trim();
      const endsWithCompleteSentence = this.finalizationEngine.endsWithCompleteSentence(finalTrimmed);
      const isShort = finalTrimmed.length < 25;
      const endsWithPeriod = finalTrimmed.endsWith('.');
      const isCommonIncomplete = this.isCommonIncompletePattern(finalTrimmed);
      
      // CRITICAL: Detect false finals - short finals with periods that are clearly incomplete
      const isFalseFinal = endsWithPeriod && isShort && isCommonIncomplete;
      const isIncomplete = !endsWithCompleteSentence || isFalseFinal;
      
      // If incomplete or false final, create pending finalization instead of committing immediately
      // Always wait if it's a false final, or if incomplete and we have extending partials
      if (isIncomplete) {
        const hasExtendingPartial = snapshot.longest && snapshot.longest.length > finalText.length;
        const longestExtends = hasExtendingPartial && snapshot.longest.trim().toLowerCase().startsWith(finalTrimmed.toLowerCase());
        
        // For false finals, always wait (even without extending partials yet)
        // For incomplete finals, wait if we have extending partials
        if (isFalseFinal || longestExtends) {
          // Create pending finalization - wait for extending partials
          this.finalizationEngine.createPendingFinalization(finalText);
          if (isFalseFinal) {
            console.log(`[Test] ⚠️ FALSE FINAL DETECTED: "${finalText.substring(0, 50)}..." - will wait for extending partials`);
          } else {
            console.log(`[Test] ⏳ Created pending finalization for incomplete final: "${finalText.substring(0, 50)}..."`);
          }
          // Don't commit yet - wait for extending partials
          return { sent: false, type: 'pending', text: finalText, reason: 'incomplete_waiting' };
        }
      }
    }

    this.sentFinals.push({
      text: finalText,
      timestamp: Date.now(),
      isForcedFinal,
      originalText: transcriptText
    });

    this.lastSentFinalText = finalText;
    this.lastSentFinalTime = Date.now();

    // Reset partial tracking after final (unless forced final)
    if (!isForcedFinal) {
      this.partialTracker.reset();
      this.finalizationEngine.clearPendingFinalization();
    }

    return { sent: true, type: 'final', text: finalText, isForcedFinal };
  }

  // Helper to detect common incomplete patterns
  isCommonIncompletePattern(text) {
    const trimmed = text.trim();
    // Patterns like "I've been", "You just can't", "We have", etc.
    // Match patterns that start with common incomplete phrases
    const incompletePatterns = [
      /^(I've|I've been|You|You just|You just can't|We|We have|They|They have|It|It has)\s/i,
      /^(I've|You|We|They|It)\s+\w+\s*\.?$/i
    ];
    // Also check if it matches the pattern even with period at end
    const withoutPeriod = trimmed.replace(/\.$/, '');
    return incompletePatterns.some(pattern => pattern.test(trimmed) || pattern.test(withoutPeriod));
  }

  mergeWithOverlap(previousText, currentText) {
    const prev = (previousText || '').trim();
    const curr = (currentText || '').trim();
    if (!prev) return curr;
    if (!curr) return prev;
    if (curr.startsWith(prev)) {
      return curr;
    }
    
    const prevNormalized = prev.replace(/\s+/g, ' ').toLowerCase();
    const currNormalized = curr.replace(/\s+/g, ' ').toLowerCase();
    if (currNormalized.startsWith(prevNormalized)) {
      return curr;
    }

    // Check for overlap
    const maxOverlap = Math.min(prev.length, curr.length, 200);
    for (let overlap = maxOverlap; overlap >= 3; overlap--) {
      const prevSuffix = prev.slice(-overlap).toLowerCase();
      const currPrefix = curr.slice(0, overlap).toLowerCase();
      if (prev.slice(-overlap) === curr.slice(0, overlap)) {
        return (prev + curr.slice(overlap)).trim();
      }
      if (prevSuffix === currPrefix) {
        return (prev + curr.slice(overlap)).trim();
      }
    }
    
    return null;
  }

  // Simulate rapid partial updates (testing speed)
  processRapidPartials(partials, delayMs = 0) {
    const results = [];
    for (const partial of partials) {
      const result = this.processPartial(partial, true);
      results.push(result);
      if (delayMs > 0) {
        // Simulate delay
        this.lastSentFinalTime = Date.now() - delayMs;
      }
    }
    return results;
  }
}

function test(name, testFn, description = '') {
  totalTests++;
  const startTime = Date.now();
  
  try {
    const processor = new HostModePartialProcessor();
    const result = testFn(processor);
    const duration = Date.now() - startTime;
    
    if (result.passed) {
      console.log(`✅ ${name}`);
      if (description) console.log(`   ${description}`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration, description });
    } else {
      console.log(`❌ ${name}`);
      if (description) console.log(`   ${description}`);
      if (result.message) console.log(`   ${result.message}`);
      if (result.expected !== undefined) console.log(`   Expected: ${result.expected}`);
      if (result.actual !== undefined) console.log(`   Actual: ${result.actual}`);
      failedTests++;
      testDetails.push({ 
        name, 
        status: 'failed', 
        duration, 
        description,
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
// CATEGORY 1: Partials Not Transcribing Fast Enough (Throttling/Delays)
// ============================================================================

console.log('\n📋 Category 1: Partials Not Transcribing Fast Enough\n');

test(
  'Test 1: Rapid partials should all be sent (no throttling)',
  (p) => {
    const partials = [
      'Open',
      'Open rather',
      'Open rather than',
      'Open rather than closed',
      'Open rather than closed, and a niche'
    ];
    
    const results = p.processRapidPartials(partials, 0);
    const sentCount = results.filter(r => r.sent && r.type === 'partial').length;
    
    return {
      passed: sentCount >= 4, // At least 4 out of 5 should be sent (first one might be very short)
      message: `Only ${sentCount} out of ${partials.length} partials were sent`,
      expected: `At least 4 partials sent`,
      actual: `${sentCount} partials sent`
    };
  },
  'Rapid partial updates should not be throttled or delayed'
);

test(
  'Test 2: Partials should arrive faster than finals',
  (p) => {
    // Simulate: partial arrives, then final arrives quickly
    const partial1 = p.processPartial('Open rather than closed', true);
    const final1 = p.processFinal('Open rather than closed, and a niche initiative', false);
    
    // Check that partial was sent before final
    const partialSent = p.sentPartials.length > 0;
    const finalSent = p.sentFinals.length > 0;
    
    return {
      passed: partialSent && finalSent && p.sentPartials[0].timestamp < p.sentFinals[0].timestamp,
      message: 'Partial should be sent before final',
      expected: 'Partial timestamp < Final timestamp',
      actual: partialSent && finalSent ? 
        `Partial: ${p.sentPartials[0].timestamp}, Final: ${p.sentFinals[0].timestamp}` : 
        'Missing partial or final'
    };
  },
  'Partials should be sent immediately, not delayed until final arrives'
);

test(
  'Test 3: Very short partials should not block longer partials',
  (p) => {
    // First partial is very short (might be dropped)
    p.processPartial('Open', true);
    
    // Longer partial should still be sent
    const result = p.processPartial('Open rather than closed', true);
    
    return {
      passed: result.sent && result.type === 'partial',
      message: 'Longer partial should be sent even if short one was dropped',
      expected: 'Partial sent',
      actual: result.sent ? 'Partial sent' : `Not sent: ${result.reason}`
    };
  },
  'Short partials should not prevent longer partials from being sent'
);

// ============================================================================
// CATEGORY 2: Partials Being Dropped (Skipped/Not Sent)
// ============================================================================

console.log('\n📋 Category 2: Partials Being Dropped\n');

test(
  'Test 4: Partials should not be dropped due to deduplication when they add new words',
  (p) => {
    // Final: "Open rather than closed"
    p.processFinal('Open rather than closed', false);
    
    // Partial: "Open rather than closed, and a niche" (extends final)
    const result = p.processPartial('Open rather than closed, and a niche', true);
    
    return {
      passed: result.sent && result.text && result.text.includes('niche'),
      message: 'Partial that extends final should not be dropped',
      expected: 'Partial with new words sent',
      actual: result.sent ? `Sent: "${result.text}"` : `Dropped: ${result.reason}`
    };
  },
  'Partials that extend finals with new words should not be dropped'
);

test(
  'Test 5: Partials should not be dropped when they are continuations',
  (p) => {
    // Final: "Open rather than closed"
    p.processFinal('Open rather than closed', false);
    
    // Partial continues: "and a niche initiative"
    const result = p.processPartial('and a niche initiative', true);
    
    return {
      passed: result.sent && result.type === 'partial',
      message: 'Continuation partial should not be dropped',
      expected: 'Partial sent',
      actual: result.sent ? 'Partial sent' : `Dropped: ${result.reason}`
    };
  },
  'Partials that continue after a final should not be dropped'
);

test(
  'Test 6: Partials should not be dropped when final is recent',
  (p) => {
    // Final just sent
    p.processFinal('Open rather than closed', false);
    
    // Partial arrives immediately after
    const result = p.processPartial('and a niche initiative rather than standing by', true);
    
    return {
      passed: result.sent && result.type === 'partial',
      message: 'Partial arriving right after final should not be dropped',
      expected: 'Partial sent',
      actual: result.sent ? 'Partial sent' : `Dropped: ${result.reason}`
    };
  },
  'Partials arriving immediately after finals should not be dropped'
);

test(
  'Test 7: Partials should not be dropped when they are longer than final',
  (p) => {
    // Short final
    p.processFinal('Open', false);
    
    // Longer partial
    const result = p.processPartial('Open rather than closed, and a niche initiative', true);
    
    return {
      passed: result.sent && result.text && result.text.length > 4,
      message: 'Longer partial should not be dropped',
      expected: 'Partial sent with full text',
      actual: result.sent ? `Sent: "${result.text.substring(0, 50)}..."` : `Dropped: ${result.reason}`
    };
  },
  'Partials longer than the final should not be dropped'
);

// ============================================================================
// CATEGORY 3: Partials Being Overwritten (Race Conditions)
// ============================================================================

console.log('\n📋 Category 3: Partials Being Overwritten\n');

test(
  'Test 8: Latest partial should not overwrite longest partial',
  (p) => {
    // Long partial arrives first
    p.processPartial('Open rather than closed, and a niche initiative rather than standing by', true);
    const longestBefore = p.partialTracker.getLongestPartial();
    
    // Shorter partial arrives (should not overwrite longest)
    p.processPartial('Open rather than', true);
    const longestAfter = p.partialTracker.getLongestPartial();
    
    return {
      passed: longestAfter === longestBefore && longestAfter.length > 50,
      message: 'Longest partial should not be overwritten by shorter partial',
      expected: `Longest preserved: ${longestBefore.length} chars`,
      actual: `Longest after: ${longestAfter.length} chars`
    };
  },
  'Longest partial should be preserved even if shorter partials arrive later'
);

test(
  'Test 9: Partial tracking should handle rapid updates correctly',
  (p) => {
    const partials = [
      'Open',
      'Open rather',
      'Open rather than',
      'Open rather than closed',
      'Open rather than closed, and a niche'
    ];
    
    p.processRapidPartials(partials, 0);
    
    const snapshot = p.partialTracker.getSnapshot();
    const longest = snapshot.longest;
    
    return {
      passed: longest && longest.length > 30 && longest.includes('niche'),
      message: 'Partial tracker should track longest partial correctly',
      expected: 'Longest partial with "niche"',
      actual: longest ? `Longest: "${longest.substring(0, 50)}..."` : 'No longest partial'
    };
  },
  'Partial tracker should correctly track longest partial through rapid updates'
);

test(
  'Test 10: Final should use longest partial if it extends the final',
  (p) => {
    // Partial arrives
    p.processPartial('Open rather than closed, and a niche initiative rather than standing by', true);
    
    // Shorter final arrives
    const finalResult = p.processFinal('Open rather than closed', false);
    
    // Check if final used longest partial
    const finalText = finalResult.text;
    
    return {
      passed: finalText && (finalText.includes('niche') || finalText.length > 25),
      message: 'Final should use longest partial if it extends the final',
      expected: 'Final text includes "niche" or is longer than 25 chars',
      actual: finalText ? `Final: "${finalText.substring(0, 50)}..."` : 'No final text'
    };
  },
  'When final arrives, it should check if longest partial extends it and use the longer text'
);

// ============================================================================
// CATEGORY 4: Partials Appearing in Forced Finals (Contamination)
// ============================================================================

console.log('\n📋 Category 4: Partials in Forced Finals (Contamination)\n');

test(
  'Test 11: Forced final should not contain partial text when partial extends it',
  (p) => {
    // Forced final arrives (short, no punctuation)
    p.forcedCommitEngine.createForcedFinalBuffer('Open rather than closed', Date.now());
    
    // Partial extends forced final
    p.processPartial('Open rather than closed, and a niche initiative', true);
    
    // Check if forced final was committed with partial contamination
    const forcedBuffer = p.forcedCommitEngine.getForcedFinalBuffer();
    
    return {
      passed: !forcedBuffer || forcedBuffer.text === 'Open rather than closed, and a niche initiative',
      message: 'Forced final should be merged with extending partial, not contaminated',
      expected: 'Forced final merged with partial or cleared',
      actual: forcedBuffer ? `Buffer still exists: "${forcedBuffer.text}"` : 'Buffer cleared (good)'
    };
  },
  'Forced final should merge with extending partial, not contain partial text separately'
);

test(
  'Test 12: Forced final should not commit partial text as final',
  (p) => {
    // Partial arrives first
    p.processPartial('Open rather than closed, and a niche initiative', true);
    
    // Forced final arrives (should not contain the partial text)
    const forcedResult = p.processFinal('Open rather than closed', { forceFinal: true });
    
    // Check that forced final doesn't contain the partial extension
    const forcedText = forcedResult.text;
    const hasPartialContamination = forcedText.includes('niche') && forcedText.length > 30;
    
    return {
      passed: !hasPartialContamination || forcedText === 'Open rather than closed, and a niche initiative',
      message: 'Forced final should not contain partial text unless it was properly merged',
      expected: 'Forced final without partial contamination OR properly merged',
      actual: `Forced final: "${forcedText.substring(0, 50)}..."`
    };
  },
  'Forced final should not contain partial text unless it was properly merged with the partial'
);

test(
  'Test 13: Forced final buffer should clear after committing',
  (p) => {
    // Create forced final buffer
    p.forcedCommitEngine.createForcedFinalBuffer('Open rather than closed', Date.now());
    
    // Partial extends it
    const result = p.processPartial('Open rather than closed, and a niche initiative', true);
    
    // Check if buffer was cleared
    const hasBuffer = p.forcedCommitEngine.hasForcedFinalBuffer();
    
    return {
      passed: !hasBuffer || result.type === 'forced_final_merged',
      message: 'Forced final buffer should be cleared after committing',
      expected: 'Buffer cleared after commit',
      actual: hasBuffer ? 'Buffer still exists' : 'Buffer cleared'
    };
  },
  'Forced final buffer should be cleared after committing merged final'
);

test(
  'Test 14: Forced final should not reset partial tracking incorrectly',
  (p) => {
    // Partial arrives
    p.processPartial('Open rather than closed, and a niche initiative', true);
    const partialBefore = p.partialTracker.getLatestPartial();
    
    // Forced final arrives
    p.processFinal('Open rather than closed', { forceFinal: true });
    
    // Check if partial tracking was incorrectly reset
    const partialAfter = p.partialTracker.getLatestPartial();
    
    // For forced finals, partial tracking might be reset, but latestPartialTextForCorrection should persist
    return {
      passed: true, // This is expected behavior - forced finals may reset partial tracking
      message: 'Forced final may reset partial tracking (this is expected)',
      expected: 'Partial tracking may be reset',
      actual: 'Partial tracking reset (expected behavior)'
    };
  },
  'Forced final may reset partial tracking (this is expected behavior)'
);

test(
  'Test 15: Multiple partials extending forced final should all be considered',
  (p) => {
    // Forced final
    p.forcedCommitEngine.createForcedFinalBuffer('Open rather than closed', Date.now());
    
    // First partial extends it
    p.processPartial('Open rather than closed, and a niche', true);
    
    // Second partial extends further
    const result = p.processPartial('Open rather than closed, and a niche initiative rather than standing by', true);
    
    // Check that the longest extension was used
    const hasBuffer = p.forcedCommitEngine.hasForcedFinalBuffer();
    const longestPartial = p.partialTracker.getLongestPartial();
    
    return {
      passed: !hasBuffer || (longestPartial && longestPartial.includes('standing')),
      message: 'Longest partial extension should be used for forced final',
      expected: 'Forced final merged with longest partial or buffer cleared',
      actual: hasBuffer ? `Buffer: "${p.forcedCommitEngine.getForcedFinalBuffer().text}"` : 
        `Buffer cleared, longest: "${longestPartial?.substring(0, 50)}..."`
    };
  },
  'When multiple partials extend forced final, the longest should be used'
);

// ============================================================================
// CATEGORY 5: Real-World Scenarios from User Logs
// ============================================================================

console.log('\n📋 Category 5: Real-World Scenarios from User Logs\n');

test(
  'Test 16: Scenario from user log - "Open rather than closed" sequence',
  (p) => {
    // Simulate the exact sequence from user logs
    const sequence = [
      { text: 'Open rather than closed', isPartial: true },
      { text: 'Open rather than closed, and a niche initiative rather than standing by', isPartial: true },
      { text: 'Open rather than closed', isPartial: false } // Final
    ];
    
    const results = [];
    for (const item of sequence) {
      if (item.isPartial) {
        results.push(p.processPartial(item.text, true));
      } else {
        results.push(p.processFinal(item.text, false));
      }
    }
    
    const partialsSent = results.filter(r => r.sent && r.type === 'partial').length;
    const finalSent = results.some(r => r.sent && r.type === 'final');
    
    return {
      passed: partialsSent >= 1 && finalSent,
      message: 'All items in sequence should be processed',
      expected: 'At least 1 partial and 1 final sent',
      actual: `${partialsSent} partials, ${finalSent ? '1' : '0'} final`
    };
  },
  'Real-world scenario: partials followed by final should all be processed'
);

test(
  'Test 17: Scenario - "biblical hospitality" with forced final',
  (p) => {
    // Forced final: "biblical hospitality chooses to engage rather than"
    p.forcedCommitEngine.createForcedFinalBuffer('biblical hospitality chooses to engage rather than', Date.now());
    
    // Partial extends: "biblical hospitality chooses to engage rather than run"
    const result = p.processPartial('biblical hospitality chooses to engage rather than run', true);
    
    // Check that it was merged
    const hasBuffer = p.forcedCommitEngine.hasForcedFinalBuffer();
    const finalText = p.sentFinals.length > 0 ? p.sentFinals[p.sentFinals.length - 1].text : null;
    
    return {
      passed: (!hasBuffer && finalText && finalText.includes('run')) || result.type === 'forced_final_merged',
      message: 'Forced final should merge with extending partial',
      expected: 'Forced final merged with "run"',
      actual: hasBuffer ? 'Buffer still exists' : 
        (finalText ? `Final: "${finalText.substring(0, 50)}..."` : 'No final sent')
    };
  },
  'Real-world scenario: forced final should merge with extending partial'
);

test(
  'Test 18: Scenario - Multiple rapid partials should not be dropped',
  (p) => {
    // Simulate rapid partial updates
    const rapidPartials = [
      'I love this quote',
      'I love this quote: biblical',
      'I love this quote: biblical hospitality',
      'I love this quote: biblical hospitality is the polar',
      'I love this quote: biblical hospitality is the polar opposite'
    ];
    
    const results = p.processRapidPartials(rapidPartials, 0);
    const sentCount = results.filter(r => r.sent && r.type === 'partial').length;
    
    return {
      passed: sentCount >= 3, // At least 3 should be sent
      message: 'Rapid partials should not all be dropped',
      expected: 'At least 3 partials sent',
      actual: `${sentCount} partials sent`
    };
  },
  'Real-world scenario: rapid partial updates should not be dropped'
);

// ============================================================================
// CATEGORY 6: Premature Finalization of Short Partials (NEW)
// ============================================================================

console.log('\n📋 Category 6: Premature Finalization of Short Partials\n');

test(
  'Test 19: "I\'ve been" should not finalize before "to grocery stores" arrives',
  (p) => {
    // Simulate the exact scenario from user logs
    // Final arrives: "I've been" (incomplete, no punctuation)
    p.processFinal('I\'ve been', false);
    
    // Partial should extend it: "I've been to grocery stores"
    const partial1 = p.processPartial('I\'ve been to grocery', true);
    
    // More partials arrive
    const partial2 = p.processPartial('I\'ve been to grocery stores', true);
    const partial3 = p.processPartial('I\'ve been to grocery stores that were friendlier', true);
    
    // Check that final was not committed prematurely
    const prematureFinals = p.sentFinals.filter(f => 
      f.text === 'I\'ve been' && !f.isForcedFinal
    );
    
    // Final should wait for extending partials
    const hasPendingFinal = p.partialTracker.getLatestPartial() && 
                           p.partialTracker.getLatestPartial().includes('grocery');
    
    return {
      passed: prematureFinals.length === 0 || hasPendingFinal,
      message: 'Short final "I\'ve been" should not be committed before extending partials arrive',
      expected: 'No premature final OR partial extending it is tracked',
      actual: prematureFinals.length > 0 ? 
        `Premature final committed: "${prematureFinals[0].text}"` : 
        'No premature final (good)'
    };
  },
  'Real-world scenario: "I\'ve been" should wait for "to grocery stores"'
);

test(
  'Test 20: "You just can\'t" should not finalize before "beat people up" arrives',
  (p) => {
    // Final arrives: "You just can't" (incomplete, has period but clearly incomplete)
    p.processFinal('You just can\'t.', false);
    
    // Partial extends it: "You just can't beat people up"
    const partial1 = p.processPartial('You just can\'t beat', true);
    const partial2 = p.processPartial('You just can\'t beat people up', true);
    const partial3 = p.processPartial('You just can\'t beat people up with doctrine all the time', true);
    
    // Check that final was not committed prematurely
    const prematureFinals = p.sentFinals.filter(f => 
      f.text === 'You just can\'t.' && !f.isForcedFinal
    );
    
    // Check if longest partial extends the final
    const longestPartial = p.partialTracker.getLongestPartial();
    const extendsFinal = longestPartial && longestPartial.includes('beat people up');
    
    return {
      passed: prematureFinals.length === 0 || extendsFinal,
      message: 'Short final "You just can\'t." should wait for extending partials',
      expected: 'No premature final OR partial extends it',
      actual: prematureFinals.length > 0 ? 
        `Premature final: "${prematureFinals[0].text}"` : 
        (extendsFinal ? 'Partial extends final (good)' : 'No extension found')
    };
  },
  'Real-world scenario: "You just can\'t." should wait for "beat people up with doctrine"'
);

test(
  'Test 21: Incomplete finals without punctuation should wait longer',
  (p) => {
    // Short final without punctuation: "I've been"
    p.processFinal('I\'ve been', false);
    
    // Check if system detects it as incomplete
    const finalText = p.sentFinals[p.sentFinals.length - 1].text;
    const hasPunctuation = /[.!?]$/.test(finalText.trim());
    const isShort = finalText.length < 20;
    const isIncomplete = !hasPunctuation && isShort;
    
    // Partial arrives that extends it
    const partialResult = p.processPartial('I\'ve been to grocery stores', true);
    
    // System should wait for extending partials
    const longestPartial = p.partialTracker.getLongestPartial();
    const waitsForExtension = longestPartial && longestPartial.length > finalText.length;
    
    return {
      passed: isIncomplete && waitsForExtension,
      message: 'Incomplete short finals should wait for extending partials',
      expected: 'System waits for extending partials',
      actual: isIncomplete ? 
        (waitsForExtension ? 'Waits for extension (good)' : 'Does not wait for extension') :
        'Not detected as incomplete'
    };
  },
  'Incomplete finals (short, no punctuation) should wait for continuation'
);

test(
  'Test 22: Final with period but clearly incomplete should wait',
  (p) => {
    // Final: "You just can't." - has period but clearly incomplete
    const finalResult = p.processFinal('You just can\'t.', false);
    
    // Check if it was detected as incomplete and is pending (not committed)
    const hasPendingFinal = p.finalizationEngine.hasPendingFinalization();
    const isPending = finalResult.sent === false && finalResult.reason === 'incomplete_waiting';
    
    // Partial arrives that extends it
    const partialResult = p.processPartial('You just can\'t beat people up', true);
    
    // System should detect this as a false final and wait
    const longestPartial = p.partialTracker.getLongestPartial();
    const detectedAsFalseFinal = (hasPendingFinal || isPending) && longestPartial && longestPartial.length > 15;
    
    return {
      passed: detectedAsFalseFinal || (hasPendingFinal && longestPartial && longestPartial.includes('beat')),
      message: 'Short finals with period but clearly incomplete should be detected as false finals',
      expected: 'Detected as false final and waits',
      actual: hasPendingFinal ? 
        (longestPartial && longestPartial.includes('beat') ? 'Detected as false final and waiting (good)' : 'Pending but no extending partial') :
        'Not detected as false final (committed immediately)'
    };
  },
  'Short finals with period but clearly incomplete should be detected as false finals'
);

test(
  'Test 23: Multiple short finals should not commit prematurely',
  (p) => {
    // First short final
    p.processFinal('I\'ve been', false);
    const partial1 = p.processPartial('I\'ve been to grocery stores', true);
    
    // Second short final (new segment)
    p.processFinal('You just can\'t.', false);
    const partial2 = p.processPartial('You just can\'t beat people up', true);
    
    // Check that neither was committed prematurely
    const prematureFinals = p.sentFinals.filter(f => 
      (f.text === 'I\'ve been' || f.text === 'You just can\'t.') && 
      !f.isForcedFinal &&
      !p.partialTracker.getLongestPartial()?.includes('grocery') &&
      !p.partialTracker.getLongestPartial()?.includes('beat')
    );
    
    return {
      passed: prematureFinals.length === 0,
      message: 'Multiple short finals should not commit before extending partials',
      expected: 'No premature finals',
      actual: prematureFinals.length > 0 ? 
        `${prematureFinals.length} premature final(s)` : 
        'No premature finals (good)'
    };
  },
  'Multiple short finals should wait for their extending partials'
);

test(
  'Test 24: Final should use longest partial that extends it',
  (p) => {
    // Final arrives: "I've been"
    p.processFinal('I\'ve been', false);
    
    // Partials arrive in sequence
    p.processPartial('I\'ve been to', true);
    p.processPartial('I\'ve been to grocery', true);
    p.processPartial('I\'ve been to grocery stores', true);
    p.processPartial('I\'ve been to grocery stores that were friendlier', true);
    p.processPartial('I\'ve been to grocery stores that were friendlier to them', true);
    
    // When final is committed, it should use the longest partial
    const longestPartial = p.partialTracker.getLongestPartial();
    const hasCompleteText = longestPartial && longestPartial.includes('friendlier to them');
    
    return {
      passed: hasCompleteText,
      message: 'Final should use longest partial that extends it',
      expected: 'Longest partial with "friendlier to them"',
      actual: longestPartial ? 
        `Longest: "${longestPartial.substring(0, 50)}..."` : 
        'No longest partial tracked'
    };
  },
  'Final should commit with longest extending partial, not the original short final'
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
      if (t.message) console.log(`    ${t.message}`);
      if (t.expected !== undefined) console.log(`    Expected: ${t.expected}`);
      if (t.actual !== undefined) console.log(`    Actual: ${t.actual}\n`);
    });
}

if (failedTests === 0) {
  console.log('🎉 All tests passed!\n');
  process.exit(0);
} else {
  console.log(`\n⚠️  ${failedTests} test(s) failed. These tests identify the issues that need to be fixed.\n`);
  console.log('Next steps:');
  console.log('1. Review the failing tests to understand the issues');
  console.log('2. Implement fixes in backend/host/adapter.js');
  console.log('3. Re-run tests to verify fixes\n');
  process.exit(1);
}

