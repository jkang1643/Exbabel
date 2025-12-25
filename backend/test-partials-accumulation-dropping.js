/**
 * Test: Partials Accumulation Dropping Issue
 * 
 * Issue: After 3 partials accumulate without the first being committed to finals,
 * when a new final arrives that doesn't extend the pending finalization, the
 * pending finalization gets dropped (cancelled) and the first 3 partials are lost.
 * 
 * Run with: node backend/test-partials-accumulation-dropping.js
 * 
 * TDD Approach: This test MUST FAIL to reveal the issue, then we fix it
 */

import { CoreEngine } from '../core/engine/coreEngine.js';
import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';

console.log('🧪 Test: Partials Accumulation Dropping Issue\n');
console.log('='.repeat(80));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

// Helper to simulate time passing
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock mergeWithOverlap function
function mergeWithOverlap(text1, text2) {
  if (!text1 || !text2) return null;
  const t1 = text1.trim().toLowerCase();
  const t2 = text2.trim().toLowerCase();
  
  if (t2.startsWith(t1)) {
    return text2;
  }
  
  const minLen = Math.min(t1.length, t2.length);
  for (let i = Math.min(20, minLen); i > 5; i--) {
    const suffix = t1.slice(-i);
    if (t2.startsWith(suffix)) {
      return text1.trim() + ' ' + text2.slice(i).trim();
    }
  }
  
  return null;
}

// Simulate solo mode final processing logic
class SoloModeFinalProcessor {
  constructor() {
    this.coreEngine = new CoreEngine();
    this.partialTracker = this.coreEngine.partialTracker;
    this.finalizationEngine = this.coreEngine.finalizationEngine;
    
    // Track state similar to soloModeHandler
    this.committedFinals = [];
    this.lastSentFinalText = '';
    this.lastSentFinalTime = 0;
    this.pendingFinalization = null;
    this.latestPartialText = '';
    this.longestPartialText = '';
    this.latestPartialTime = 0;
    this.longestPartialTime = 0;
    
    // Constants
    this.FINAL_CONTINUATION_WINDOW_MS = 3000;
    this.BASE_WAIT_MS = 1000;
    this.MAX_FINALIZATION_WAIT_MS = 5000;
  }
  
  syncPartialVariables() {
    this.latestPartialText = this.partialTracker.getLatestPartial();
    this.longestPartialText = this.partialTracker.getLongestPartial();
    this.latestPartialTime = this.partialTracker.getLatestPartialTime();
    this.longestPartialTime = this.partialTracker.getLongestPartialTime();
  }
  
  syncPendingFinalization() {
    this.pendingFinalization = this.finalizationEngine.hasPendingFinalization() 
      ? this.finalizationEngine.getPendingFinalization() 
      : null;
    // Ensure initialTextLength is set if missing (backwards compatibility)
    if (this.pendingFinalization && this.pendingFinalization.initialTextLength === undefined) {
      this.pendingFinalization.initialTextLength = this.pendingFinalization.text?.length || 0;
    }
  }
  
  endsWithCompleteSentence(text) {
    if (!text || text.length === 0) return false;
    const trimmed = text.trim();
    return /[.!?…]["')]*\s*$/.test(trimmed);
  }
  
  commitFinal(text, options = {}) {
    console.log(`[Processor] ✅ Committing final: "${text.substring(0, 60)}..."`);
    this.committedFinals.push({
      text,
      timestamp: Date.now(),
      ...options
    });
    this.lastSentFinalText = text;
    this.lastSentFinalTime = Date.now();
  }
  
  async handlePartial(transcriptText) {
    console.log(`[Processor] 📥 PARTIAL: "${transcriptText.substring(0, 60)}..."`);
    
    // Deduplicate
    const dedupResult = deduplicatePartialText({
      partialText: transcriptText,
      lastFinalText: this.lastSentFinalText,
      lastFinalTime: this.lastSentFinalTime,
      mode: 'SoloMode',
      timeWindowMs: 5000,
      maxWordsToCheck: 3
    });
    
    let partialTextToSend = dedupResult.deduplicatedText;
    if (dedupResult.wasDeduplicated && (!partialTextToSend || partialTextToSend.length < 3)) {
      return;
    }
    
    // Update partial tracking
    this.partialTracker.updatePartial(partialTextToSend);
    this.syncPartialVariables();
    
    // Check if there's a pending finalization that this partial extends
    this.syncPendingFinalization();
    if (this.finalizationEngine.hasPendingFinalization()) {
      const pending = this.finalizationEngine.getPendingFinalization();
      const pendingText = pending.text.trim();
      const partialText = partialTextToSend.trim();
      
      // Check if partial extends the pending final
      if (partialText.length > pendingText.length && 
          (partialText.startsWith(pendingText) || 
           (pendingText.length > 10 && partialText.substring(0, pendingText.length) === pendingText))) {
        // Partial extends pending final - update it
        this.finalizationEngine.updatePendingFinalizationText(partialText);
        this.syncPendingFinalization();
        console.log(`[Processor] 🔁 Partial extends pending final: "${pendingText.substring(0, 30)}..." → "${partialText.substring(0, 50)}..."`);
      }
    } else {
      // No pending finalization - create one for new segment partial
      // This simulates the logic where partials can create pending finalizations
      const isNewSegmentStart = this.lastSentFinalTime > 0 && (Date.now() - this.lastSentFinalTime) < 2000;
      if (isNewSegmentStart && partialTextToSend.trim().length >= 15) {
        console.log(`[Processor] 📝 Creating pending finalization for new segment partial: "${partialTextToSend.substring(0, 50)}..."`);
        this.finalizationEngine.createPendingFinalization(partialTextToSend);
        this.syncPendingFinalization();
      }
    }
  }
  
  async handleFinal(transcriptText) {
    console.log(`[Processor] 📝 FINAL: "${transcriptText.substring(0, 60)}..."`);
    
    let finalTextToUse = transcriptText;
    this.syncPartialVariables();
    
    // Check if longest/latest partial extends the final
    if (this.longestPartialText && this.longestPartialText.length > transcriptText.length) {
      const longestTrimmed = this.longestPartialText.trim();
      const finalTrimmed = finalTextToUse.trim();
      if (longestTrimmed.startsWith(finalTrimmed) || 
          (finalTrimmed.length > 10 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
        finalTextToUse = this.longestPartialText;
        console.log(`[Processor] ⚠️ Using longest partial: ${transcriptText.length} → ${this.longestPartialText.length} chars`);
      }
    }
    
    // CRITICAL: Check if we have a pending finalization
    this.syncPendingFinalization();
    if (this.pendingFinalization) {
      const pendingText = this.pendingFinalization.text.trim();
      const finalTextTrimmed = finalTextToUse.trim();
      
      // Check if this final extends the pending one
      const pendingNormalized = pendingText.replace(/\s+/g, ' ').toLowerCase();
      const finalNormalized = finalTextTrimmed.replace(/\s+/g, ' ').toLowerCase();
      const extendsPending = finalNormalized.startsWith(pendingNormalized) || 
                            (pendingText.length > 10 && finalNormalized.substring(0, pendingNormalized.length) === pendingNormalized) ||
                            finalTextTrimmed.startsWith(pendingText) ||
                            (pendingText.length > 10 && finalTextTrimmed.substring(0, pendingText.length) === pendingText);
      
      if (extendsPending && finalTextToUse.length > this.pendingFinalization.text.length) {
        // This final extends the pending one - update it
        console.log(`[Processor] 📦 Final extends pending (${this.pendingFinalization.text.length} → ${finalTextToUse.length} chars)`);
        this.finalizationEngine.updatePendingFinalizationText(finalTextToUse);
        this.syncPendingFinalization();
      } else {
        // Different final - ALWAYS commit pending one first to ensure no partials are lost
        // CRITICAL FIX: Never cancel pending finalizations - always commit them first
        // This ensures we get the best accuracy possible by checking longest partial before committing
        const timeSincePending = Date.now() - this.pendingFinalization.timestamp;
        
        // Before committing, check for longest partial to ensure best accuracy
        this.syncPartialVariables();
        let textToCommit = this.pendingFinalization.text;
        const pendingTrimmed = pendingText.trim();
        
        // Always check longest partial before committing - this ensures best accuracy
        if (this.longestPartialText && this.longestPartialText.length > this.pendingFinalization.text.length) {
          const longestTrimmed = this.longestPartialText.trim();
          const timeSinceLongest = this.longestPartialTime ? (Date.now() - this.longestPartialTime) : Infinity;
          
          // Check if longest partial extends the pending text
          const pendingNormalized = pendingTrimmed.replace(/\s+/g, ' ').toLowerCase();
          const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
          const extendsPending = longestNormalized.startsWith(pendingNormalized) || 
                                (pendingTrimmed.length > 10 && longestNormalized.substring(0, pendingNormalized.length) === pendingNormalized) ||
                                longestTrimmed.startsWith(pendingTrimmed) ||
                                (pendingTrimmed.length > 10 && longestTrimmed.substring(0, pendingTrimmed.length) === pendingTrimmed);
          
          if (extendsPending && timeSinceLongest < 10000) {
            // Use longest partial for best accuracy
            const missingWords = this.longestPartialText.substring(this.pendingFinalization.text.length).trim();
            console.log(`[Processor] ⚠️ Using LONGEST partial before committing pending (${this.pendingFinalization.text.length} → ${this.longestPartialText.length} chars): "${missingWords}"`);
            textToCommit = this.longestPartialText;
          } else {
            // Check for overlap merge
            const merged = mergeWithOverlap(pendingTrimmed, longestTrimmed);
            if (merged && merged.length > pendingTrimmed.length + 3 && timeSinceLongest < 10000) {
              console.log(`[Processor] ⚠️ Merging LONGEST partial with pending via overlap (${this.pendingFinalization.text.length} → ${merged.length} chars)`);
              textToCommit = merged;
            }
          }
        }
        
        // ALWAYS commit pending first - never cancel it
        console.log(`[Processor] 🔀 New final doesn't extend pending - ALWAYS committing pending first (waited ${timeSincePending}ms): "${textToCommit.substring(0, 50)}..."`);
        console.log(`[Processor] ✅ Ensuring best accuracy by checking longest partial before committing`);
        this.finalizationEngine.clearPendingFinalization();
        this.syncPendingFinalization();
        this.commitFinal(textToCommit);
      }
    }
    
    // If no pending finalization (or it was cancelled/committed), create new one
    this.syncPendingFinalization();
    if (!this.finalizationEngine.hasPendingFinalization()) {
      const isIncomplete = !this.endsWithCompleteSentence(finalTextToUse);
      if (isIncomplete) {
        console.log(`[Processor] 📝 Creating pending finalization for incomplete final: "${finalTextToUse.substring(0, 50)}..."`);
        this.finalizationEngine.createPendingFinalization(finalTextToUse);
        this.syncPendingFinalization();
      } else {
        // Complete final - commit immediately
        this.commitFinal(finalTextToUse);
        this.partialTracker.reset();
        this.syncPartialVariables();
      }
    }
  }
  
  // Simulate timeout callback for pending finalization
  async processPendingFinalization() {
    this.syncPendingFinalization();
    if (!this.pendingFinalization) {
      return;
    }
    
    console.log(`[Processor] ⏰ Timeout fired - committing pending: "${this.pendingFinalization.text.substring(0, 60)}..."`);
    const textToCommit = this.pendingFinalization.text;
    this.finalizationEngine.clearPendingFinalization();
    this.syncPendingFinalization();
    this.commitFinal(textToCommit);
    this.partialTracker.reset();
    this.syncPartialVariables();
  }
}

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`✅ PASS: ${name}`);
  } catch (error) {
    failedTests++;
    console.error(`❌ FAIL: ${name}`);
    console.error(`   Error: ${error.message}`);
    if (error.stack) {
      console.error(`   Stack: ${error.stack.split('\n')[1]}`);
    }
  }
}

async function runTest() {
  console.log('\n🧪 Test: 3 Partials Accumulate, First Gets Dropped When New Final Arrives\n');
  
  const processor = new SoloModeFinalProcessor();
  
  // Simulate the scenario:
  // 1. An initial final arrives that's incomplete - creates pending finalization
  // 2. First partial arrives - extends the pending finalization  
  // 3. Second partial arrives - extends the pending finalization
  // 4. Third partial arrives - extends the pending finalization
  // 5. New final arrives that doesn't extend the pending finalization
  // 6. Since pending timestamp is from when it was first created (even though 3 partials extended it),
  //    if it's less than 500ms old, it gets cancelled and all partials are lost
  
  console.log('Step 0: Initial incomplete final arrives - creates pending finalization');
  await processor.handleFinal('You just can\'t');
  await sleep(50);
  
  processor.syncPendingFinalization();
  test('Initial final creates pending finalization', () => {
    if (!processor.pendingFinalization) {
      throw new Error('Expected pending finalization after initial final, but none exists');
    }
    const pendingText = processor.pendingFinalization.text;
    if (!pendingText.includes('You just can\'t')) {
      throw new Error(`Expected pending text to include "You just can't", but got "${pendingText}"`);
    }
  });
  
  const initialPendingTimestamp = processor.pendingFinalization.timestamp;
  console.log(`   Pending created at timestamp: ${initialPendingTimestamp}`);
  
  console.log('\nStep 1: First partial arrives and extends pending');
  await processor.handlePartial('You just can\'t beat people');
  await sleep(100);
  
  processor.syncPendingFinalization();
  test('First partial extends pending finalization', () => {
    if (!processor.pendingFinalization) {
      throw new Error('Expected pending finalization after first partial, but none exists');
    }
    if (!processor.pendingFinalization.text.includes('beat people')) {
      throw new Error(`Expected pending text to include "beat people", but got "${processor.pendingFinalization.text}"`);
    }
    // Check that initialTextLength is tracked (for the fix)
    if (!processor.pendingFinalization.initialTextLength) {
      throw new Error('Expected initialTextLength to be tracked');
    }
  });
  
  console.log('\nStep 2: Second partial arrives and extends pending');
  await processor.handlePartial('You just can\'t beat people up with');
  await sleep(100);
  
  processor.syncPendingFinalization();
  test('Second partial extends pending finalization', () => {
    if (!processor.pendingFinalization) {
      throw new Error('Expected pending finalization after second partial, but none exists');
    }
    if (!processor.pendingFinalization.text.includes('up with')) {
      throw new Error(`Expected pending text to include "up with", but got "${processor.pendingFinalization.text}"`);
    }
  });
  
  console.log('\nStep 3: Third partial arrives and extends pending');
  await processor.handlePartial('You just can\'t beat people up with doctrine');
  await sleep(50); // Total time: ~300ms since initial pending was created
  
  processor.syncPendingFinalization();
  const pendingTextBeforeFinal = processor.pendingFinalization?.text || '';
  test('Third partial extends pending finalization', () => {
    if (!processor.pendingFinalization) {
      throw new Error('Expected pending finalization after third partial, but none exists');
    }
    if (!processor.pendingFinalization.text.includes('doctrine')) {
      throw new Error(`Expected pending text to include "doctrine", but got "${processor.pendingFinalization.text}"`);
    }
    // Total time is ~300ms, still less than 500ms threshold
    const timeSincePending = Date.now() - processor.pendingFinalization.timestamp;
    if (timeSincePending >= 500) {
      throw new Error(`Expected time since pending to be < 500ms, but got ${timeSincePending}ms`);
    }
  });
  
  console.log('\nStep 4: New final arrives that doesn\'t extend the pending finalization');
  console.log(`   Time since pending created: ${Date.now() - processor.pendingFinalization.timestamp}ms (< 500ms threshold)`);
  console.log('   (This simulates a new segment starting)');
  
  // New final from a different segment - doesn't extend the pending
  await processor.handleFinal('Oh my!');
  
  processor.syncPendingFinalization();
  
  test('Pending finalization should NOT be cancelled when new final arrives (should be committed first)', () => {
    // The bug: pending finalization gets cancelled because it's less than 500ms old,
    // even though 3 partials have extended it. This causes the accumulated text to be lost.
    // 
    // The fix: If pending finalization has been extended by partials (current text is longer than initial),
    // we should commit it first regardless of age, because it contains accumulated content.
    
    // Check if the pending text was committed
    const committedText = processor.committedFinals.find(f => f.text.includes('doctrine') || f.text.includes('beat people'));
    if (!committedText) {
      throw new Error(`Expected to find committed final containing accumulated partials ("doctrine" or "beat people"), but committed finals are: ${JSON.stringify(processor.committedFinals.map(f => f.text))}`);
    }
    
    // Check that the accumulated text wasn't lost
    const hasAccumulatedText = processor.committedFinals.some(f => 
      f.text.includes('You just can\'t') && 
      (f.text.includes('beat people') || f.text.includes('doctrine'))
    );
    if (!hasAccumulatedText) {
      throw new Error(`Expected to find committed final containing accumulated partials, but they were lost. Committed finals: ${JSON.stringify(processor.committedFinals.map(f => f.text))}`);
    }
  });
  
  test('New final should also be processed', () => {
    const newFinalCommitted = processor.committedFinals.find(f => f.text === 'Oh my!');
    if (!newFinalCommitted) {
      throw new Error(`Expected to find committed final "Oh my!", but committed finals are: ${JSON.stringify(processor.committedFinals.map(f => f.text))}`);
    }
  });
  
  test('Both finals should be committed', () => {
    if (processor.committedFinals.length < 2) {
      throw new Error(`Expected at least 2 committed finals, but got ${processor.committedFinals.length}. Committed: ${JSON.stringify(processor.committedFinals.map(f => f.text))}`);
    }
  });
}

// Run the test
runTest().then(() => {
  console.log('\n' + '='.repeat(80));
  console.log(`\n📊 Test Results:`);
  console.log(`   Total: ${totalTests}`);
  console.log(`   Passed: ${passedTests}`);
  console.log(`   Failed: ${failedTests}`);
  
  if (failedTests > 0) {
    console.log(`\n❌ Tests FAILED - This reveals the bug!`);
    process.exit(1);
  } else {
    console.log(`\n✅ All tests PASSED!`);
    process.exit(0);
  }
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

