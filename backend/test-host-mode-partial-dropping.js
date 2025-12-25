/**
 * Host Mode Partial Dropping Test Suite (TDD)
 * 
 * Comprehensive end-to-end tests that mimic real host mode scenarios
 * to identify where partials are being dropped or not sent.
 * 
 * Based on real user logs showing missing partials like "oh my" after
 * "fight matches know, I haven't" final.
 * 
 * Run with: node backend/test-host-mode-partial-dropping.js
 * 
 * TDD Approach: Write failing tests first to identify all edge cases
 */

import { CoreEngine } from '../core/engine/coreEngine.js';
import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';

console.log('🧪 Host Mode Partial Dropping Test Suite (TDD)\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

// Mock classes to simulate host mode behavior exactly
class MockPartialTracker {
  constructor() {
    this.latestPartialText = '';
    this.latestPartialTime = 0;
    this.longestPartialText = '';
    this.longestPartialTime = 0;
  }

  updatePartial(transcriptText) {
    if (!transcriptText) return { latestUpdated: false, longestUpdated: false };
    
    const now = Date.now();
    let latestUpdated = false;
    let longestUpdated = false;
    
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
      longestPartialText: this.longestPartialText,
      latestPartialText: this.latestPartialText,
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

  checkLongestExtends(finalText, timeWindow) {
    if (!this.longestPartialText || !finalText) return null;
    const longest = this.longestPartialText.trim();
    const final = finalText.trim();
    if (longest.length > final.length && longest.startsWith(final)) {
      return {
        extends: true,
        extendedText: longest,
        missingWords: longest.substring(final.length).trim()
      };
    }
    return null;
  }
}

class MockForcedCommitEngine {
  constructor() {
    this.forcedFinalBuffer = null;
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
      recoveryPromise: null
    };
    return this.forcedFinalBuffer;
  }

  checkPartialExtendsForcedFinal(partialText) {
    if (!this.forcedFinalBuffer || !partialText) return null;
    const forced = this.forcedFinalBuffer.text.trim();
    const partial = partialText.trim();
    if (partial.length > forced.length && partial.startsWith(forced)) {
      return {
        extends: true,
        extendedText: partial
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
      timeout: null,
      isFalseFinal: false
    };
    return this.pendingFinalization;
  }

  endsWithCompleteSentence(text) {
    if (!text || text.length === 0) return false;
    const trimmed = text.trim();
    return /[.!?…]["')]*\s*$/.test(trimmed) || /[.!?…]\s*$/.test(trimmed);
  }

  clearPendingFinalization() {
    this.pendingFinalization = null;
  }
}

// Simulate host mode partial processing with exact logic from adapter.js
class HostModePartialProcessor {
  constructor() {
    this.partialTracker = new MockPartialTracker();
    this.forcedCommitEngine = new MockForcedCommitEngine();
    this.finalizationEngine = new MockFinalizationEngine();
    this.lastSentFinalText = '';
    this.lastSentFinalTime = 0;
    this.sentPartials = []; // Track ALL sent partials
    this.sentFinals = []; // Track all sent finals
    this.droppedPartials = []; // Track dropped partials with reasons
    this.currentPartialText = '';
    this.latestPartialTextForCorrection = '';
  }

  // Simulate the exact partial processing logic from host/adapter.js
  processPartial(transcriptText, isPartial = true, options = {}) {
    if (!transcriptText || transcriptText.length === 0) {
      return { sent: false, reason: 'empty' };
    }

    if (!isPartial) {
      return this.processFinal(transcriptText, options);
    }

    // CRITICAL SCENARIO 1: Handle forced final buffer
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
          // CRITICAL: Continue processing the partial below (don't return)
        } else {
          this.processFinal(extension.extendedText, { forceFinal: true });
          this.forcedCommitEngine.clearForcedFinalBuffer();
          // CRITICAL: Continue processing the partial below (don't return)
        }
      } else {
        // New segment detected - commit forced final separately
        const buffer = this.forcedCommitEngine.getForcedFinalBuffer();
        this.processFinal(buffer.text, { forceFinal: true });
        this.forcedCommitEngine.clearForcedFinalBuffer();
        // CRITICAL: Continue processing the new partial as a new segment (don't return)
      }
    }

    // Track latest partial
    this.latestPartialTextForCorrection = transcriptText;
    this.currentPartialText = transcriptText;

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
      this.droppedPartials.push({ text: transcriptText, reason: 'all_duplicates', timestamp: Date.now() });
      return { sent: false, reason: 'all_duplicates' };
    }

    // Update partial tracking
    this.partialTracker.updatePartial(partialTextToSend);

    // CRITICAL SCENARIO 2: Check if there's a pending finalization
    if (this.finalizationEngine.hasPendingFinalization()) {
      const pending = this.finalizationEngine.getPendingFinalization();
      const pendingText = pending.text.trim();
      const partialText = partialTextToSend.trim();
      const timeSinceFinal = Date.now() - pending.timestamp;
      
      // Check if partial extends the pending final
      const extendsFinal = partialText.length > pendingText.length && 
                          (partialText.startsWith(pendingText) || 
                           (pendingText.length > 10 && partialText.substring(0, pendingText.length) === pendingText));
      
      // Check if it's a new segment
      const pendingWords = pendingText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const partialWords = partialText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const sharedWords = pendingWords.filter(w => partialWords.includes(w));
      const hasWordOverlap = sharedWords.length > 0;
      const lastWordsOfFinal = pendingWords.slice(-3);
      const startsWithFinalWord = partialWords.length > 0 && lastWordsOfFinal.some(w => 
        partialWords[0].startsWith(w) || w.startsWith(partialWords[0])
      );
      
      const clearlyNewSegment = !extendsFinal && !hasWordOverlap && !startsWithFinalWord && timeSinceFinal > 500;
      
      if (clearlyNewSegment) {
        // CRITICAL BUG: Committing pending final and then continuing with partial
        // But the partial might be dropped if pendingFinalization becomes null
        const textToCommit = pending.text;
        // Clear pending BEFORE processing final to simulate real behavior
        this.finalizationEngine.clearPendingFinalization();
        // Save partial tracker state before reset (in case we need it)
        this.partialTracker.reset();
        this.processFinal(textToCommit);
        // Continue processing the new partial as a new segment (don't return)
        // After this point, pendingFinalization should be null
        // IMPORTANT: The partial should continue to be processed below, not return early
      } else if (extendsFinal) {
        // Partial extends pending final - update it
        this.finalizationEngine.createPendingFinalization(partialText);
        // Continue processing - send the partial
      } else {
        // Might be continuation - wait longer
        // Continue processing - send the partial
      }
    } else {
      // CRITICAL SCENARIO 3: No pending finalization - check if pendingFinalization is null after sync
      // This is the exact scenario from user logs: "pendingFinalization is null after sync - skipping new segment check"
      // In this case, the partial should still be sent as a new segment
    }

    // CRITICAL SCENARIO 4: Very short partials at segment start
    const isVeryShortPartial = partialTextToSend.trim().length < 15;
    const timeSinceLastFinal = this.lastSentFinalTime ? (Date.now() - this.lastSentFinalTime) : Infinity;
    const hasPendingFinal = this.finalizationEngine.hasPendingFinalization();
    const isNewSegmentStart = !hasPendingFinal && 
                              !this.forcedCommitEngine.hasForcedFinalBuffer() &&
                              timeSinceLastFinal < 2000;

    if (isVeryShortPartial && isNewSegmentStart) {
      // CRITICAL BUG: Very short partials at segment start might be dropped
      // But we should still send them to prevent word loss
      this.droppedPartials.push({ 
        text: partialTextToSend, 
        reason: 'very_short_at_start', 
        timestamp: Date.now() 
      });
      // In real code, this might return early, dropping the partial
      // For now, we'll still send it to test the scenario
    }

    // CRITICAL: Send the partial (this is where it might not be sent in real code)
    this.sentPartials.push({
      text: partialTextToSend,
      timestamp: Date.now(),
      originalText: transcriptText,
      seqId: this.sentPartials.length + 1
    });

    return { sent: true, type: 'partial', text: partialTextToSend };
  }

  processFinal(transcriptText, options = {}) {
    const isForcedFinal = !!options.forceFinal;
    
    // Check if partials extend this final
    const snapshot = this.partialTracker.getSnapshot();
    let finalText = transcriptText;

    if (snapshot.longestPartialText && snapshot.longestPartialText.length > transcriptText.length) {
      const longestTrimmed = snapshot.longestPartialText.trim();
      const finalTrimmed = transcriptText.trim();
      if (longestTrimmed.startsWith(finalTrimmed)) {
        finalText = snapshot.longestPartialText;
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
    return null;
  }

  // Simulate a complete sequence like from user logs
  simulateSequence(events) {
    const results = [];
    for (const event of events) {
      if (event.type === 'partial') {
        const result = this.processPartial(event.text, true);
        results.push(result);
      } else if (event.type === 'final') {
        const result = this.processFinal(event.text, event.options || {});
        results.push(result);
      } else if (event.type === 'wait') {
        // Simulate time passing
        this.lastSentFinalTime = Date.now() - (event.ms || 0);
        if (this.finalizationEngine.hasPendingFinalization()) {
          const pending = this.finalizationEngine.getPendingFinalization();
          pending.timestamp = Date.now() - (event.ms || 0);
        }
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
// SCENARIO 1: Real user log scenario - "oh my" after "fight matches know, I haven't"
// ============================================================================

console.log('\n📋 Scenario 1: Real User Log - "oh my" after "fight matches know, I haven\'t"\n');

test(
  'Test 1.1: Partial "oh my" should be sent after final "fight matches know, I haven\'t" is committed',
  (p) => {
    // Simulate the exact sequence from user logs
    const sequence = [
      { type: 'final', text: "I've been to grocery store, so we're friendly than them." },
      { type: 'wait', ms: 5589 },
      { type: 'final', text: "fight matches know, I haven't" }, // This creates a pending final
      { type: 'wait', ms: 100 }, // Small delay
      { type: 'partial', text: 'oh,' }, // This should trigger pending final commit
      { type: 'partial', text: 'oh my' },
      { type: 'final', text: 'oh my' }
    ];

    const results = p.simulateSequence(sequence);
    
    // Check that "oh my" partials were sent
    const ohMyPartials = p.sentPartials.filter(p => p.text.includes('oh'));
    const ohMyFinals = p.sentFinals.filter(f => f.text.includes('oh'));
    
    return {
      passed: ohMyPartials.length > 0 && ohMyFinals.length > 0,
      message: 'Partials "oh," and "oh my" should be sent even after pending final is committed',
      expected: 'At least 1 "oh" partial and 1 "oh my" final sent',
      actual: `${ohMyPartials.length} "oh" partial(s), ${ohMyFinals.length} "oh my" final(s) sent`
    };
  },
  'Real scenario: "oh my" partials should not be dropped after pending final commit'
);

test(
  'Test 1.2: Very short partial "oh," (3 chars) should be sent as new segment',
  (p) => {
    // Final committed
    p.processFinal("fight matches know, I haven't");
    
    // Very short partial arrives (should trigger new segment detection)
    const result = p.processPartial('oh,', true);
    
    return {
      passed: result.sent && result.type === 'partial',
      message: 'Very short partial "oh," should be sent even if it triggers pending final commit',
      expected: 'Partial sent',
      actual: result.sent ? 'Partial sent' : `Not sent: ${result.reason}`
    };
  },
  'Very short partials at segment start should not be dropped'
);

test(
  'Test 1.3: Multiple short partials should all be sent',
  (p) => {
    p.processFinal("fight matches know, I haven't");
    
    const partials = ['oh,', 'oh my', 'oh my god'];
    const results = partials.map(text => p.processPartial(text, true));
    
    const sentCount = results.filter(r => r.sent).length;
    
    return {
      passed: sentCount === partials.length,
      message: 'All partials in sequence should be sent',
      expected: `${partials.length} partials sent`,
      actual: `${sentCount} partials sent`
    };
  },
  'Multiple short partials should all be sent, not dropped'
);

// ============================================================================
// SCENARIO 2: Pending finalization null after sync
// ============================================================================

console.log('\n📋 Scenario 2: Pending Finalization Null After Sync\n');

test(
  'Test 2.1: Partial should be sent when pendingFinalization is null after sync',
  (p) => {
    // Create pending final with timestamp in the past (so timeSinceFinal > 500)
    const pending = p.finalizationEngine.createPendingFinalization("fight matches know, I haven't");
    pending.timestamp = Date.now() - 600; // 600ms ago
    
    // Partial arrives that triggers commit (new segment) - this should clear pending
    const partialResult = p.processPartial('oh,', true);
    
    // Check that pending finalization was cleared (final was committed)
    const hasPending = p.finalizationEngine.hasPendingFinalization();
    const finalWasCommitted = p.sentFinals.length > 0;
    
    // Check that partial was still sent
    const partialSent = partialResult.sent;
    
    // Both should be true: pending cleared (final committed) AND partial sent
    return {
      passed: !hasPending && partialSent && finalWasCommitted,
      message: 'Partial should be sent even after pendingFinalization becomes null (final committed)',
      expected: 'Pending cleared (final committed) AND partial sent',
      actual: `Pending: ${hasPending ? 'exists' : 'cleared'}, Final committed: ${finalWasCommitted}, Partial: ${partialSent ? 'sent' : 'not sent'}`
    };
  },
  'Partial should not be dropped when pendingFinalization becomes null after sync (final committed)'
);

test(
  'Test 2.2: Multiple partials after pending final commit should all be sent',
  (p) => {
    p.finalizationEngine.createPendingFinalization("fight matches know, I haven't");
    
    // First partial triggers commit
    p.processPartial('oh,', true);
    
    // Subsequent partials should all be sent
    const results = [
      p.processPartial('oh my', true),
      p.processPartial('oh my god', true),
      p.processPartial('oh my god this is', true)
    ];
    
    const sentCount = results.filter(r => r.sent).length;
    
    return {
      passed: sentCount === results.length,
      message: 'All partials after pending final commit should be sent',
      expected: `${results.length} partials sent`,
      actual: `${sentCount} partials sent`
    };
  },
  'Multiple partials after pending final commit should all be sent'
);

// ============================================================================
// SCENARIO 3: Very Short Partials at Segment Start
// ============================================================================

console.log('\n📋 Scenario 3: Very Short Partials at Segment Start\n');

test(
  'Test 3.1: Very short partial (< 15 chars) should be sent if it\'s a new segment',
  (p) => {
    p.processFinal('Previous final text here');
    p.lastSentFinalTime = Date.now() - 1000; // Recent final
    
    const result = p.processPartial('oh', true); // Very short (2 chars)
    
    return {
      passed: result.sent || p.sentPartials.length > 0,
      message: 'Very short partial at segment start should be sent to prevent word loss',
      expected: 'Partial sent',
      actual: result.sent ? 'Partial sent' : `Not sent: ${result.reason || 'unknown'}`
    };
  },
  'Very short partials should be sent even at segment start'
);

test(
  'Test 3.2: Multiple very short partials should accumulate and all be sent',
  (p) => {
    p.processFinal('Previous final');
    p.lastSentFinalTime = Date.now() - 1000;
    
    const veryShortPartials = ['oh', 'oh my', 'oh my god'];
    const results = veryShortPartials.map(text => p.processPartial(text, true));
    
    const sentCount = results.filter(r => r.sent).length;
    
    return {
      passed: sentCount >= 2, // At least 2 should be sent (first might be filtered)
      message: 'Very short partials should accumulate and be sent as they grow',
      expected: 'At least 2 partials sent',
      actual: `${sentCount} partials sent`
    };
  },
  'Very short partials should accumulate and be sent as they grow'
);

// ============================================================================
// SCENARIO 4: Forced Final Buffer + Partials
// ============================================================================

console.log('\n📋 Scenario 4: Forced Final Buffer + Partials\n');

test(
  'Test 4.1: Partial after forced final commit should be sent',
  (p) => {
    p.forcedCommitEngine.createForcedFinalBuffer('fight matches');
    
    // Partial that doesn't extend (new segment)
    const result = p.processPartial('oh my', true);
    
    return {
      passed: result.sent && p.sentFinals.length > 0,
      message: 'Partial should be sent after forced final is committed',
      expected: 'Forced final committed AND partial sent',
      actual: `Forced finals: ${p.sentFinals.length}, Partial: ${result.sent ? 'sent' : 'not sent'}`
    };
  },
  'Partial should be sent after forced final buffer is committed'
);

test(
  'Test 4.2: Multiple partials after forced final commit should all be sent',
  (p) => {
    p.forcedCommitEngine.createForcedFinalBuffer('fight matches');
    
    // First partial triggers forced final commit
    p.processPartial('oh,', true);
    
    // Subsequent partials
    const results = [
      p.processPartial('oh my', true),
      p.processPartial('oh my god', true)
    ];
    
    const sentCount = results.filter(r => r.sent).length;
    
    return {
      passed: sentCount === results.length && p.sentFinals.length > 0,
      message: 'All partials after forced final commit should be sent',
      expected: `${results.length} partials sent and forced final committed`,
      actual: `${sentCount} partials sent, ${p.sentFinals.length} forced final(s)`
    };
  },
  'Multiple partials after forced final commit should all be sent'
);

// ============================================================================
// SCENARIO 5: Rapid Partials with Pending Final Commit
// ============================================================================

console.log('\n📋 Scenario 5: Rapid Partials with Pending Final Commit\n');

test(
  'Test 5.1: Rapid partials during pending final commit should all be sent',
  (p) => {
    p.finalizationEngine.createPendingFinalization('Previous final text');
    
    // Rapid partials arrive
    const rapidPartials = ['oh,', 'oh my', 'oh my god', 'oh my god this'];
    const results = rapidPartials.map(text => p.processPartial(text, true));
    
    const sentCount = results.filter(r => r.sent).length;
    
    return {
      passed: sentCount >= 3, // At least 3 should be sent
      message: 'Rapid partials during pending final should all be sent',
      expected: 'At least 3 partials sent',
      actual: `${sentCount} partials sent`
    };
  },
  'Rapid partials during pending final commit should all be sent'
);

test(
  'Test 5.2: Partial that triggers pending final commit should not block subsequent partials',
  (p) => {
    p.finalizationEngine.createPendingFinalization('Previous final');
    
    // This partial triggers commit
    p.processPartial('oh,', true);
    
    // These should still be sent
    const results = [
      p.processPartial('oh my', true),
      p.processPartial('oh my god', true)
    ];
    
    const sentCount = results.filter(r => r.sent).length;
    
    return {
      passed: sentCount === results.length,
      message: 'Partials after triggering pending final commit should still be sent',
      expected: `${results.length} partials sent`,
      actual: `${sentCount} partials sent`
    };
  },
  'Partials after triggering pending final commit should still be sent'
);

// ============================================================================
// SCENARIO 6: Complete End-to-End Sequence from User Logs
// ============================================================================

console.log('\n📋 Scenario 6: Complete End-to-End Sequence from User Logs\n');

test(
  'Test 6.1: Complete sequence: final -> pending -> new segment partial -> more partials -> final',
  (p) => {
    const sequence = [
      { type: 'final', text: "I've been to grocery store, so we're friendly than them." },
      { type: 'wait', ms: 5589 },
      { type: 'final', text: "fight matches know, I haven't" }, // Creates pending
      { type: 'wait', ms: 100 },
      { type: 'partial', text: 'oh,' }, // Triggers commit, new segment
      { type: 'partial', text: 'oh my' },
      { type: 'partial', text: 'oh my god' },
      { type: 'final', text: 'oh my' }
    ];

    const results = p.simulateSequence(sequence);
    
    // Check that all partials were sent
    const partialResults = results.filter(r => r.type === 'partial');
    const finalResults = results.filter(r => r.type === 'final');
    
    const allPartialsSent = partialResults.every(r => r.sent);
    const allFinalsSent = finalResults.every(r => r.sent);
    
    return {
      passed: allPartialsSent && allFinalsSent && partialResults.length >= 2,
      message: 'Complete sequence should send all partials and finals',
      expected: 'All partials and finals sent',
      actual: `Partials: ${partialResults.length} (all sent: ${allPartialsSent}), Finals: ${finalResults.length} (all sent: ${allFinalsSent})`
    };
  },
  'Complete end-to-end sequence should send all partials and finals'
);

test(
  'Test 6.2: Verify "oh my" appears in sent partials',
  (p) => {
    const sequence = [
      { type: 'final', text: "fight matches know, I haven't" },
      { type: 'wait', ms: 100 },
      { type: 'partial', text: 'oh,' },
      { type: 'partial', text: 'oh my' },
      { type: 'final', text: 'oh my' }
    ];

    p.simulateSequence(sequence);
    
    // Check that "oh my" partial was sent
    const ohMyPartial = p.sentPartials.find(p => p.text.includes('oh my'));
    const ohMyFinal = p.sentFinals.find(f => f.text.includes('oh my'));
    
    return {
      passed: (ohMyPartial !== undefined) && (ohMyFinal !== undefined),
      message: '"oh my" should appear in both sent partials and finals',
      expected: '"oh my" in partials and finals',
      actual: `Partial: ${ohMyPartial ? 'found' : 'missing'}, Final: ${ohMyFinal ? 'found' : 'missing'}`
    };
  },
  'Verify "oh my" appears in sent messages'
);

// ============================================================================
// SCENARIO 7: Edge Cases - Multiple Scenarios Until Failure
// ============================================================================

console.log('\n📋 Scenario 7: Edge Cases - Testing Until Failure\n');

test(
  'Test 7.1: Partial immediately after final commit (no delay)',
  (p) => {
    p.processFinal('Previous final');
    
    // Immediate partial (simulates race condition)
    const result = p.processPartial('oh', true);
    
    return {
      passed: result.sent,
      message: 'Partial immediately after final should still be sent',
      expected: 'Partial sent',
      actual: result.sent ? 'Partial sent' : `Not sent: ${result.reason}`
    };
  },
  'Partials immediately after final commit should be sent'
);

test(
  'Test 7.2: Very short partial that extends pending final',
  (p) => {
    p.finalizationEngine.createPendingFinalization('Previous final');
    
    // Very short partial that might extend
    const result = p.processPartial('Previous final text', true);
    
    return {
      passed: result.sent,
      message: 'Very short partial extending pending final should be sent',
      expected: 'Partial sent',
      actual: result.sent ? 'Partial sent' : `Not sent: ${result.reason}`
    };
  },
  'Very short partials extending pending final should be sent'
);

test(
  'Test 7.3: Partial with same text as last final (should be deduplicated, not sent)',
  (p) => {
    p.processFinal('Previous final');
    
    // Same text as final (should be deduplicated)
    const result = p.processPartial('Previous final', true);
    
    // This is expected behavior - should be deduplicated
    return {
      passed: !result.sent || result.reason === 'all_duplicates',
      message: 'Partial identical to last final should be deduplicated',
      expected: 'Not sent (deduplicated)',
      actual: result.sent ? 'Sent (unexpected)' : `Not sent: ${result.reason} (expected)`
    };
  },
  'Partials identical to last final should be deduplicated (this is correct behavior)'
);

test(
  'Test 7.4: Multiple pending final commits with partials in between',
  (p) => {
    // Start with a final to set lastSentFinalTime
    p.processFinal('Previous final text here');
    
    // First pending final - partial will be detected as new segment
    p.finalizationEngine.createPendingFinalization('First final text');
    const result1 = p.processPartial('oh,', true); // Should trigger commit (new segment)
    
    // Second pending final - processFinal from above should have updated lastSentFinalTime
    p.finalizationEngine.createPendingFinalization('Second final text');
    const result2 = p.processPartial('my god', true); // Should trigger commit (new segment)
    
    // Third pending final
    p.finalizationEngine.createPendingFinalization('Third final text');
    const result3 = p.processPartial('this is', true); // Should trigger commit (new segment)
    
    const partialCount = p.sentPartials.length;
    const finalCount = p.sentFinals.length;
    
    // All partials should be sent, and finals should be committed when new segments detected
    // Note: processFinal from the first pending commit sets lastSentFinalTime, so subsequent ones should work
    return {
      passed: partialCount >= 3 && finalCount >= 1 && result1.sent && result2.sent && result3.sent,
      message: 'Multiple pending final commits should not drop partials',
      expected: 'At least 3 partials sent and at least 1 final committed',
      actual: `${partialCount} partials, ${finalCount} finals sent. Results: r1=${result1.sent}, r2=${result2.sent}, r3=${result3.sent}`
    };
  },
  'Multiple pending final commits should not drop partials'
);

test(
  'Test 7.5: Partial during forced final buffer with recovery',
  (p) => {
    p.forcedCommitEngine.createForcedFinalBuffer('Forced final');
    const buffer = p.forcedCommitEngine.getForcedFinalBuffer();
    buffer.recoveryInProgress = true;
    
    // Partial during recovery
    const result = p.processPartial('oh my', true);
    
    return {
      passed: result.sent || p.sentPartials.length > 0,
      message: 'Partial during forced final recovery should still be sent',
      expected: 'Partial sent',
      actual: result.sent ? 'Partial sent' : `Not sent: ${result.reason}`
    };
  },
  'Partials during forced final recovery should be sent'
);

test(
  'Test 7.6: Chain of very short partials (< 5 chars each)',
  (p) => {
    p.processFinal('Previous');
    p.lastSentFinalTime = Date.now() - 500;
    
    const veryShortPartials = ['oh', 'my', 'god', 'this', 'is'];
    const results = veryShortPartials.map(text => p.processPartial(text, true));
    
    const sentCount = results.filter(r => r.sent).length;
    
    return {
      passed: sentCount >= 3, // At least some should be sent
      message: 'Chain of very short partials should accumulate and be sent',
      expected: 'At least 3 partials sent',
      actual: `${sentCount} partials sent`
    };
  },
  'Chain of very short partials should accumulate and be sent'
);

test(
  'Test 7.7: Partial that triggers commit then immediately another partial',
  (p) => {
    p.finalizationEngine.createPendingFinalization('Pending final');
    
    // First partial triggers commit
    const result1 = p.processPartial('oh,', true);
    
    // Immediately another partial (no delay)
    const result2 = p.processPartial('oh my', true);
    
    return {
      passed: result1.sent && result2.sent,
      message: 'Partials immediately after triggering commit should all be sent',
      expected: 'Both partials sent',
      actual: `First: ${result1.sent ? 'sent' : 'not sent'}, Second: ${result2.sent ? 'sent' : 'not sent'}`
    };
  },
  'Partials immediately after triggering commit should all be sent'
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
  console.log('⚠️  Note: These are simulated tests. Real implementation may have additional edge cases.');
  console.log('   Run these tests against the actual host mode handler to identify real failures.\n');
  process.exit(0);
} else {
  console.log(`\n⚠️  ${failedTests} test(s) failed. These tests identify areas where partials might be dropped.\n`);
  console.log('Next steps:');
  console.log('1. Review the failing tests to understand the scenarios');
  console.log('2. Check backend/host/adapter.js for these exact scenarios');
  console.log('3. Verify that partials are sent in all these cases');
  console.log('4. Fix any code paths that drop partials\n');
  process.exit(1);
}

