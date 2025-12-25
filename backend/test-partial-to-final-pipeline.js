/**
 * Comprehensive TDD Test Suite: Partial to Final Pipeline
 * 
 * Tests the entire transcription pipeline from audio input to final commit
 * to identify why:
 * 1. Not every partial in the pipeline gets committed to finals
 * 2. Some are inaccurate due to recovery merge or logic issues
 * 
 * Run with: node backend/test-partial-to-final-pipeline.js
 * 
 * TDD Approach: These tests MUST FAIL to reveal the issues
 */

import { CoreEngine } from '../core/engine/coreEngine.js';
import { PartialTracker } from '../core/engine/partialTracker.js';
import { FinalizationEngine } from '../core/engine/finalizationEngine.js';
import { ForcedCommitEngine } from '../core/engine/forcedCommitEngine.js';
import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';
import { mergeRecoveryText } from './utils/recoveryMerge.js';

console.log('🧪 Comprehensive Partial-to-Final Pipeline Test Suite\n');
console.log('='.repeat(80));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

// Helper to simulate time passing
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock mergeWithOverlap function (simplified version)
function mergeWithOverlap(text1, text2) {
  if (!text1 || !text2) return null;
  const t1 = text1.trim().toLowerCase();
  const t2 = text2.trim().toLowerCase();
  
  // Check if t2 extends t1
  if (t2.startsWith(t1)) {
    return text2;
  }
  
  // Try to find overlap
  const minLen = Math.min(t1.length, t2.length);
  for (let i = Math.min(20, minLen); i > 5; i--) {
    const suffix = t1.slice(-i);
    if (t2.startsWith(suffix)) {
      return text1.trim() + ' ' + text2.slice(i).trim();
    }
  }
  
  return null;
}

// Simulate the entire pipeline from soloModeHandler
class SoloModePipelineSimulator {
  constructor() {
    this.coreEngine = new CoreEngine();
    this.partialTracker = this.coreEngine.partialTracker;
    this.finalizationEngine = this.coreEngine.finalizationEngine;
    this.forcedCommitEngine = this.coreEngine.forcedCommitEngine;
    
    // Track state
    this.sentPartials = [];
    this.committedFinals = [];
    this.lastSentFinalText = '';
    this.lastSentFinalTime = 0;
    this.lastSentOriginalText = '';
    this.pendingFinalization = null;
    this.forcedFinalBuffer = null;
    this.latestPartialText = '';
    this.longestPartialText = '';
    this.latestPartialTime = 0;
    this.longestPartialTime = 0;
    
    // Track recovery state
    this.recoveryInProgress = false;
    this.recoveryPromise = null;
  }
  
  // Simulate onResult callback
  async onResult(transcriptText, isPartial, meta = {}) {
    if (!transcriptText || transcriptText.length === 0) {
      return;
    }
    
    console.log(`[Pipeline] 📥 ${isPartial ? 'PARTIAL' : 'FINAL'}: "${transcriptText.substring(0, 60)}..."`);
    
    if (isPartial) {
      await this.handlePartial(transcriptText);
    } else {
      await this.handleFinal(transcriptText);
    }
  }
  
  async handlePartial(transcriptText) {
    // Check for forced final buffer
    if (this.forcedCommitEngine.hasForcedFinalBuffer()) {
      const extension = this.forcedCommitEngine.checkPartialExtendsForcedFinal(transcriptText);
      
      if (extension && extension.extends) {
        // Partial extends forced final
        if (this.recoveryInProgress && this.recoveryPromise) {
          // Wait for recovery
          const recoveredText = await this.recoveryPromise;
          const merged = mergeWithOverlap(recoveredText, transcriptText);
          if (merged) {
            this.commitFinal(merged, { forceFinal: true });
            this.forcedCommitEngine.clearForcedFinalBuffer();
            return;
          }
        } else {
          // Merge and commit
          const merged = mergeWithOverlap(this.forcedCommitEngine.getForcedFinalBuffer().text, transcriptText);
          if (merged) {
            this.commitFinal(merged, { forceFinal: true });
          } else {
            this.commitFinal(extension.extendedText, { forceFinal: true });
          }
          this.forcedCommitEngine.clearForcedFinalBuffer();
          return;
        }
      }
    }
    
    // Deduplicate against last final
    const dedupResult = deduplicatePartialText({
      partialText: transcriptText,
      lastFinalText: this.lastSentFinalText,
      lastFinalTime: this.lastSentFinalTime,
      mode: 'SoloMode',
      timeWindowMs: 5000,
      maxWordsToCheck: 3
    });
    
    let partialTextToSend = dedupResult.deduplicatedText;
    
    // Skip if all duplicates
    if (dedupResult.wasDeduplicated && (!partialTextToSend || partialTextToSend.length < 3)) {
      console.log(`[Pipeline] ⏭️ Skipping partial - all duplicates`);
      return;
    }
    
    // Update partial tracking
    this.partialTracker.updatePartial(partialTextToSend);
    this.latestPartialText = partialTextToSend;
    this.latestPartialTime = Date.now();
    if (partialTextToSend.length > (this.longestPartialText?.length || 0)) {
      this.longestPartialText = partialTextToSend;
      this.longestPartialTime = Date.now();
    }
    
    // Check for very short partials at segment start
    const isVeryShortPartial = partialTextToSend.trim().length < 15;
    const hasPendingFinal = this.finalizationEngine.hasPendingFinalization();
    const timeSinceLastFinal = this.lastSentFinalTime ? (Date.now() - this.lastSentFinalTime) : Infinity;
    const isNewSegmentStart = !hasPendingFinal && 
                              !this.forcedCommitEngine.hasForcedFinalBuffer() &&
                              timeSinceLastFinal < 2000;
    
    if (isVeryShortPartial && isNewSegmentStart) {
      console.log(`[Pipeline] ⏳ Delaying very short partial at segment start`);
      return;
    }
    
    // Send partial
    this.sentPartials.push({
      text: partialTextToSend,
      timestamp: Date.now(),
      isPartial: true
    });
    
    // Check if partial extends pending final
    if (this.finalizationEngine.hasPendingFinalization()) {
      const pending = this.finalizationEngine.getPendingFinalization();
      const timeSinceFinal = Date.now() - pending.timestamp;
      const finalText = pending.text.trim();
      const partialText = partialTextToSend.trim();
      
      const extendsFinal = partialText.length > finalText.length && 
                           (partialText.startsWith(finalText) || 
                            (finalText.length > 10 && partialText.substring(0, finalText.length) === finalText));
      
      // CRITICAL: Check if partial extends the final (case-insensitive, normalized)
      const finalNormalized = finalText.replace(/\s+/g, ' ').toLowerCase();
      const partialNormalized = partialText.replace(/\s+/g, ' ').toLowerCase();
      const actuallyExtendsFinal = partialNormalized.startsWith(finalNormalized) || 
                                   (finalText.length > 10 && partialNormalized.substring(0, finalNormalized.length) === finalNormalized) ||
                                   partialText.startsWith(finalText) ||
                                   (finalText.length > 10 && partialText.substring(0, finalText.length) === finalText);
      
      if (actuallyExtendsFinal && timeSinceFinal < 3000) {
        // Update pending final with extended text - use longest partial if available
        let textToUpdate = partialText;
        if (this.longestPartialText && this.longestPartialText.length > partialText.length) {
          const longestTrimmed = this.longestPartialText.trim();
          if (longestTrimmed.startsWith(finalText) || 
              (finalText.length > 10 && longestTrimmed.substring(0, finalText.length) === finalText)) {
            textToUpdate = this.longestPartialText;
            console.log(`[Pipeline] 📝 Using longest partial for update: ${partialText.length} → ${this.longestPartialText.length} chars`);
          }
        }
        
        this.finalizationEngine.updatePendingFinalizationText(textToUpdate);
        console.log(`[Pipeline] 📝 Updating pending final with extended partial (${finalText.length} → ${textToUpdate.length} chars)`);
        
        // Reschedule timeout to give more time for additional extending partials
        this.finalizationEngine.clearPendingFinalizationTimeout();
        const remainingWait = Math.max(800, 2000 - timeSinceFinal);
        this.finalizationEngine.setPendingFinalizationTimeout(() => {
          this.commitPendingFinal();
        }, remainingWait);
      } else if (!actuallyExtendsFinal && timeSinceFinal > 600) {
        // New segment - commit pending final
        this.commitPendingFinal();
        
        // CRITICAL FIX: Create pending finalization for the new segment partial so it eventually becomes a final
        // This ensures all partials eventually get committed as finals
        if (partialTextToSend && partialTextToSend.trim().length > 0) {
          console.log(`[Pipeline] 📝 Creating pending finalization for new segment partial: "${partialTextToSend.substring(0, 50)}..."`);
          this.finalizationEngine.createPendingFinalization(partialTextToSend);
          this.pendingFinalization = this.finalizationEngine.getPendingFinalization();
          // Schedule timeout to commit this new segment partial as a final
          const waitTime = this.finalizationEngine.calculateWaitTime(partialTextToSend, 1500);
          this.finalizationEngine.setPendingFinalizationTimeout(() => {
            this.commitPendingFinal();
          }, waitTime);
        }
      }
    } else {
      // No pending finalization - this is a new segment start
      // CRITICAL FIX: Create pending finalization for new segment partials so they eventually become finals
      if (partialTextToSend && partialTextToSend.trim().length > 15) {
        // Only create pending finalization for longer partials (avoid very short ones)
        console.log(`[Pipeline] 📝 Creating pending finalization for new segment partial (no pending final): "${partialTextToSend.substring(0, 50)}..."`);
        this.finalizationEngine.createPendingFinalization(partialTextToSend);
        this.pendingFinalization = this.finalizationEngine.getPendingFinalization();
        // Schedule timeout to commit this new segment partial as a final
        const waitTime = this.finalizationEngine.calculateWaitTime(partialTextToSend, 1500);
        this.finalizationEngine.setPendingFinalizationTimeout(() => {
          this.commitPendingFinal();
        }, waitTime);
      }
    }
  }
  
  async handleFinal(transcriptText) {
    // CRITICAL: If there's a pending finalization for a new segment partial, check if this final extends it
    // If not, commit the partial first, then handle this final
    if (this.finalizationEngine.hasPendingFinalization()) {
      const pending = this.finalizationEngine.getPendingFinalization();
      const pendingText = pending.text.trim();
      const newFinalText = transcriptText.trim();
      
      // Check if new final extends pending (case-insensitive, normalized)
      const pendingNormalized = pendingText.replace(/\s+/g, ' ').toLowerCase();
      const newFinalNormalized = newFinalText.replace(/\s+/g, ' ').toLowerCase();
      const extendsPending = newFinalNormalized.startsWith(pendingNormalized) || 
                            (pendingText.length > 10 && newFinalNormalized.substring(0, pendingNormalized.length) === pendingNormalized) ||
                            newFinalText.startsWith(pendingText) ||
                            (pendingText.length > 10 && newFinalText.substring(0, pendingText.length) === pendingText);
      
      if (!extendsPending && newFinalText !== pendingText) {
        // New final doesn't extend pending - commit pending first (it's a different segment)
        console.log(`[Pipeline] 🔀 New final doesn't extend pending - committing pending first: "${pendingText.substring(0, 50)}..."`);
        this.commitPendingFinal();
      }
    }
    
    // Check if latest partial extends beyond this final
    let finalTextToProcess = transcriptText;
    
    // Check longest partial first (more reliable)
    if (this.longestPartialText && this.longestPartialText.length > transcriptText.length) {
      const longestTrimmed = this.longestPartialText.trim();
      const finalTrimmed = transcriptText.trim();
      if (longestTrimmed.startsWith(finalTrimmed) || 
          (finalTrimmed.length > 10 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
        finalTextToProcess = this.longestPartialText;
        console.log(`[Pipeline] ⚠️ FINAL truncated - using longest partial instead`);
      } else {
        // Try overlap merge
        const overlap = mergeWithOverlap(transcriptText, this.longestPartialText);
        if (overlap && overlap.length > transcriptText.length) {
          finalTextToProcess = overlap;
          console.log(`[Pipeline] ⚠️ FINAL merged with longest partial via overlap`);
        }
      }
    } else if (this.latestPartialText && this.latestPartialText.length > transcriptText.length) {
      const latestTrimmed = this.latestPartialText.trim();
      const finalTrimmed = transcriptText.trim();
      if (latestTrimmed.startsWith(finalTrimmed) || 
          (finalTrimmed.length > 10 && latestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
        finalTextToProcess = this.latestPartialText;
        console.log(`[Pipeline] ⚠️ FINAL truncated - using latest partial instead`);
      } else {
        // Try overlap merge
        const overlap = mergeWithOverlap(transcriptText, this.latestPartialText);
        if (overlap && overlap.length > transcriptText.length) {
          finalTextToProcess = overlap;
          console.log(`[Pipeline] ⚠️ FINAL merged with latest partial via overlap`);
        }
      }
    }
    
    // Check for duplicate
    if (finalTextToProcess === this.lastSentFinalText) {
      console.log(`[Pipeline] ⏭️ Skipping duplicate final`);
      this.latestPartialText = '';
      this.longestPartialText = '';
      return;
    }
    
    // CRITICAL: Detect false finals - short finals with periods that are clearly incomplete
    const finalTrimmed = finalTextToProcess.trim();
    const endsWithPeriod = finalTrimmed.endsWith('.');
    const isShort = finalTrimmed.length < 25;
    const isCommonIncompletePattern = /^(I've|I've been|You|You just|You just can't|We|We have|They|They have|It|It has)\s/i.test(finalTrimmed);
    const isFalseFinal = endsWithPeriod && isShort && isCommonIncompletePattern;
    
    if (isFalseFinal) {
      console.log(`[Pipeline] ⚠️ FALSE FINAL DETECTED: "${finalTrimmed.substring(0, 50)}..." - will wait longer`);
    }
    
    // Create pending finalization
    this.finalizationEngine.createPendingFinalization(finalTextToProcess, null, isFalseFinal);
    this.pendingFinalization = this.finalizationEngine.getPendingFinalization();
    
    // Calculate wait time - longer for false finals
    let baseWait = 1000;
    if (isFalseFinal) {
      baseWait = 3000; // Wait at least 3 seconds for false finals
    }
    const waitTime = this.finalizationEngine.calculateWaitTime(finalTextToProcess, baseWait);
    
    // Schedule finalization
    this.finalizationEngine.setPendingFinalizationTimeout(() => {
      this.commitPendingFinal();
    }, waitTime);
  }
  
  commitPendingFinal() {
    if (!this.finalizationEngine.hasPendingFinalization()) {
      return;
    }
    
    const pending = this.finalizationEngine.getPendingFinalization();
    let textToCommit = pending.text;
    
    // CRITICAL: Check for extending partials using tracker methods first
    const longestExtends = this.partialTracker.checkLongestExtends(textToCommit, 10000);
    const latestExtends = this.partialTracker.checkLatestExtends(textToCommit, 5000);
    
    if (longestExtends) {
      textToCommit = longestExtends.extendedText;
      console.log(`[Pipeline] ⚠️ Using longest partial from tracker: "${longestExtends.missingWords}"`);
    } else if (latestExtends) {
      textToCommit = latestExtends.extendedText;
      console.log(`[Pipeline] ⚠️ Using latest partial from tracker: "${latestExtends.missingWords}"`);
    } else {
      // Fallback: check direct partial text
      const finalTrimmed = textToCommit.trim();
      if (this.longestPartialText && this.longestPartialText.length > textToCommit.length) {
        const longestTrimmed = this.longestPartialText.trim();
        if (longestTrimmed.startsWith(finalTrimmed) || 
            (finalTrimmed.length > 10 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
          textToCommit = this.longestPartialText;
          console.log(`[Pipeline] ⚠️ Using longest partial directly: ${textToCommit.length} → ${this.longestPartialText.length} chars`);
        }
      } else if (this.latestPartialText && this.latestPartialText.length > textToCommit.length) {
        const latestTrimmed = this.latestPartialText.trim();
        if (latestTrimmed.startsWith(finalTrimmed) || 
            (finalTrimmed.length > 10 && latestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
          textToCommit = this.latestPartialText;
          console.log(`[Pipeline] ⚠️ Using latest partial directly: ${textToCommit.length} → ${this.latestPartialText.length} chars`);
        }
      }
    }
    
    this.commitFinal(textToCommit);
    this.finalizationEngine.clearPendingFinalization();
    this.partialTracker.reset();
    this.latestPartialText = '';
    this.longestPartialText = '';
  }
  
  commitFinal(text, options = {}) {
    this.committedFinals.push({
      text: text,
      timestamp: Date.now(),
      forceFinal: options.forceFinal || false
    });
    
    this.lastSentFinalText = text;
    this.lastSentFinalTime = Date.now();
    this.lastSentOriginalText = text;
    
    console.log(`[Pipeline] ✅ COMMITTED FINAL: "${text.substring(0, 60)}..."`);
  }
  
  // Simulate recovery stream
  async simulateRecovery(recoveredText) {
    this.recoveryInProgress = true;
    this.recoveryPromise = new Promise(resolve => {
      setTimeout(() => {
        this.recoveryInProgress = false;
        resolve(recoveredText);
      }, 100);
    });
    return this.recoveryPromise;
  }
}

// Test 1: Partials not committed when they should be
async function test1_MissingPartialsInFinals() {
  console.log('\n📋 Test 1: Partials not committed to finals');
  console.log('-'.repeat(80));
  
  const simulator = new SoloModePipelineSimulator();
  
  // Simulate the transcript scenario from user
  // Partial 1: "Bend."
  await simulator.onResult("Bend.", true);
  await sleep(50);
  
  // Partial 2: "Bend. Oh boy, I've been to the grocery store, so we're friendlier than them."
  await simulator.onResult("Bend. Oh boy, I've been to the grocery store, so we're friendlier than them.", true);
  await sleep(50);
  
  // Final 1: "Bend."
  await simulator.onResult("Bend.", false);
  await sleep(2000);
  
  // Partial 3: "I've been to the cage fight matches. No, I haven't."
  await simulator.onResult("I've been to the cage fight matches. No, I haven't.", true);
  await sleep(50);
  
  // Final 2: "You just can't."
  await simulator.onResult("You just can't.", false);
  await sleep(2000);
  
  // Partial 4: "People struggle with doctrine all the time; you got to care about them."
  await simulator.onResult("People struggle with doctrine all the time; you got to care about them.", true);
  await sleep(50);
  
  // Final 3: "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate. ' The notion that life is best for."
  await simulator.onResult("I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate. ' The notion that life is best for.", false);
  await sleep(2000);
  
  // Check results
  const expectedFinals = [
    "Bend. Oh boy, I've been to the grocery store, so we're friendlier than them.",
    "I've been to the cage fight matches. No, I haven't.",
    "People struggle with doctrine all the time; you got to care about them.",
    "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate. ' The notion that life is best for."
  ];
  
  console.log(`\n📊 Results:`);
  console.log(`   Sent Partials: ${simulator.sentPartials.length}`);
  console.log(`   Committed Finals: ${simulator.committedFinals.length}`);
  console.log(`   Expected Finals: ${expectedFinals.length}`);
  
  let allPartialsCommitted = true;
  const missingPartials = [];
  
  for (const partial of simulator.sentPartials) {
    const foundInFinal = simulator.committedFinals.some(final => 
      final.text.includes(partial.text) || partial.text.includes(final.text)
    );
    if (!foundInFinal) {
      allPartialsCommitted = false;
      missingPartials.push(partial.text);
    }
  }
  
  const testPassed = allPartialsCommitted && 
                     simulator.committedFinals.length >= expectedFinals.length;
  
  if (!testPassed) {
    console.log(`\n❌ TEST FAILED:`);
    if (!allPartialsCommitted) {
      console.log(`   Missing partials in finals:`);
      missingPartials.forEach(p => console.log(`     - "${p.substring(0, 60)}..."`));
    }
    if (simulator.committedFinals.length < expectedFinals.length) {
      console.log(`   Expected ${expectedFinals.length} finals, got ${simulator.committedFinals.length}`);
    }
  } else {
    console.log(`\n✅ TEST PASSED`);
  }
  
  return testPassed;
}

// Test 2: Recovery merge causing inaccuracies
async function test2_RecoveryMergeInaccuracies() {
  console.log('\n📋 Test 2: Recovery merge causing inaccuracies');
  console.log('-'.repeat(80));
  
  const simulator = new SoloModePipelineSimulator();
  
  // Scenario: Final arrives, but partial has more text
  // Partial 1: "You just can't beat people up with doctrine"
  await simulator.onResult("You just can't beat people up with doctrine", true);
  await sleep(50);
  
  // Final arrives early: "You just can't."
  await simulator.onResult("You just can't.", false);
  
  // Simulate recovery stream finding: "beat people up with doctrine"
  await simulator.simulateRecovery("beat people up with doctrine");
  await sleep(200);
  
  // Partial 2 extends: "You just can't beat people up with doctrine all the time"
  await simulator.onResult("You just can't beat people up with doctrine all the time", true);
  await sleep(50);
  
  await sleep(2000);
  
  // Check if final is accurate
  const expectedFinal = "You just can't beat people up with doctrine all the time";
  const actualFinal = simulator.committedFinals[simulator.committedFinals.length - 1];
  
  console.log(`\n📊 Results:`);
  console.log(`   Expected: "${expectedFinal}"`);
  console.log(`   Actual: "${actualFinal?.text || 'NONE'}"`);
  
  const testPassed = actualFinal && 
                     actualFinal.text.trim() === expectedFinal.trim() &&
                     !actualFinal.text.includes('beat people up with doctrine beat people up with doctrine'); // No duplication
  
  if (!testPassed) {
    console.log(`\n❌ TEST FAILED:`);
    if (!actualFinal) {
      console.log(`   No final was committed`);
    } else if (actualFinal.text !== expectedFinal) {
      console.log(`   Final text doesn't match expected`);
      console.log(`   Difference: "${actualFinal.text.substring(expectedFinal.length)}"`);
    } else if (actualFinal.text.includes('beat people up with doctrine beat people up with doctrine')) {
      console.log(`   Recovery merge caused duplication`);
    }
  } else {
    console.log(`\n✅ TEST PASSED`);
  }
  
  return testPassed;
}

// Test 3: Partials dropped due to deduplication
async function test3_PartialsDroppedByDeduplication() {
  console.log('\n📋 Test 3: Partials dropped due to deduplication');
  console.log('-'.repeat(80));
  
  const simulator = new SoloModePipelineSimulator();
  
  // Final 1: "Bend."
  await simulator.onResult("Bend.", false);
  await sleep(100);
  
  // Partial that should be kept: "Bend. Oh boy"
  await simulator.onResult("Bend. Oh boy", true);
  await sleep(50);
  
  // Partial extends: "Bend. Oh boy, I've been"
  await simulator.onResult("Bend. Oh boy, I've been", true);
  await sleep(50);
  
  // Final 2: "Bend. Oh boy, I've been to the grocery store"
  await simulator.onResult("Bend. Oh boy, I've been to the grocery store", false);
  await sleep(2000);
  
  // Check if all partials were sent
  const expectedPartials = 2;
  const actualPartials = simulator.sentPartials.length;
  
  console.log(`\n📊 Results:`);
  console.log(`   Expected Partials Sent: ${expectedPartials}`);
  console.log(`   Actual Partials Sent: ${actualPartials}`);
  
  const testPassed = actualPartials >= expectedPartials;
  
  if (!testPassed) {
    console.log(`\n❌ TEST FAILED:`);
    console.log(`   Partials were dropped due to deduplication`);
    console.log(`   Missing ${expectedPartials - actualPartials} partial(s)`);
  } else {
    console.log(`\n✅ TEST PASSED`);
  }
  
  return testPassed;
}

// Test 4: False final detection causing missed partials
async function test4_FalseFinalDetection() {
  console.log('\n📋 Test 4: False final detection causing missed partials');
  console.log('-'.repeat(80));
  
  const simulator = new SoloModePipelineSimulator();
  
  // Short final that looks complete but isn't: "You just can't."
  await simulator.onResult("You just can't.", false);
  await sleep(100);
  
  // Partial extends it: "You just can't beat people"
  await simulator.onResult("You just can't beat people", true);
  await sleep(50);
  
  // Partial extends more: "You just can't beat people up with doctrine"
  await simulator.onResult("You just can't beat people up with doctrine", true);
  await sleep(2000);
  
  // Check if final includes all partials
  const final = simulator.committedFinals[simulator.committedFinals.length - 1];
  const expectedText = "You just can't beat people up with doctrine";
  
  console.log(`\n📊 Results:`);
  console.log(`   Expected Final: "${expectedText}"`);
  console.log(`   Actual Final: "${final?.text || 'NONE'}"`);
  
  const testPassed = final && 
                     final.text.includes("beat people up with doctrine");
  
  if (!testPassed) {
    console.log(`\n❌ TEST FAILED:`);
    if (!final) {
      console.log(`   No final was committed`);
    } else {
      console.log(`   Final doesn't include extending partials`);
      console.log(`   Final was committed too early: "${final.text}"`);
    }
  } else {
    console.log(`\n✅ TEST PASSED`);
  }
  
  return testPassed;
}

// Test 5: Partials not tracked when final arrives quickly
async function test5_PartialsLostOnQuickFinal() {
  console.log('\n📋 Test 5: Partials lost when final arrives quickly');
  console.log('-'.repeat(80));
  
  const simulator = new SoloModePipelineSimulator();
  
  // Partial 1: "I've been"
  await simulator.onResult("I've been", true);
  await sleep(20);
  
  // Partial 2: "I've been to the"
  await simulator.onResult("I've been to the", true);
  await sleep(20);
  
  // Final arrives quickly: "I've been to the grocery store"
  await simulator.onResult("I've been to the grocery store", false);
  await sleep(2000);
  
  // Check if longest partial was used
  const final = simulator.committedFinals[simulator.committedFinals.length - 1];
  const expectedText = "I've been to the grocery store";
  
  console.log(`\n📊 Results:`);
  console.log(`   Expected Final: "${expectedText}"`);
  console.log(`   Actual Final: "${final?.text || 'NONE'}"`);
  console.log(`   Partials Sent: ${simulator.sentPartials.length}`);
  
  const testPassed = final && 
                     final.text.trim() === expectedText.trim();
  
  if (!testPassed) {
    console.log(`\n❌ TEST FAILED:`);
    if (!final) {
      console.log(`   No final was committed`);
    } else {
      console.log(`   Final text doesn't match (partials may have been lost)`);
    }
  } else {
    console.log(`\n✅ TEST PASSED`);
  }
  
  return testPassed;
}

// Test 6: Recovery merge duplicating text
async function test6_RecoveryMergeDuplication() {
  console.log('\n📋 Test 6: Recovery merge duplicating text');
  console.log('-'.repeat(80));
  
  const simulator = new SoloModePipelineSimulator();
  
  // Partial: "People struggle with doctrine"
  await simulator.onResult("People struggle with doctrine", true);
  await sleep(50);
  
  // Final: "People struggle"
  await simulator.onResult("People struggle", false);
  
  // Simulate recovery finding: "with doctrine"
  await simulator.simulateRecovery("with doctrine");
  await sleep(200);
  
  // Partial extends: "People struggle with doctrine all the time"
  await simulator.onResult("People struggle with doctrine all the time", true);
  await sleep(2000);
  
  // Check for duplication
  const final = simulator.committedFinals[simulator.committedFinals.length - 1];
  const expectedText = "People struggle with doctrine all the time";
  
  console.log(`\n📊 Results:`);
  console.log(`   Expected: "${expectedText}"`);
  console.log(`   Actual: "${final?.text || 'NONE'}"`);
  
  const hasDuplication = final && (
    final.text.includes('with doctrine with doctrine') ||
    final.text.includes('People struggle People struggle')
  );
  
  const testPassed = final && 
                     final.text.trim() === expectedText.trim() &&
                     !hasDuplication;
  
  if (!testPassed) {
    console.log(`\n❌ TEST FAILED:`);
    if (hasDuplication) {
      console.log(`   Recovery merge caused text duplication`);
    } else if (!final || final.text !== expectedText) {
      console.log(`   Final text doesn't match expected`);
    }
  } else {
    console.log(`\n✅ TEST PASSED`);
  }
  
  return testPassed;
}

// Test 7: Partials arriving during finalization wait not being included
async function test7_PartialsDuringFinalizationWait() {
  console.log('\n📋 Test 7: Partials arriving during finalization wait not being included');
  console.log('-'.repeat(80));
  
  const simulator = new SoloModePipelineSimulator();
  
  // Final arrives: "You just can't."
  await simulator.onResult("You just can't.", false);
  await sleep(100);
  
  // Partial extends during wait: "You just can't beat"
  await simulator.onResult("You just can't beat", true);
  await sleep(100);
  
  // Partial extends more: "You just can't beat people"
  await simulator.onResult("You just can't beat people", true);
  await sleep(100);
  
  // Partial extends even more: "You just can't beat people up with doctrine"
  await simulator.onResult("You just can't beat people up with doctrine", true);
  await sleep(2000);
  
  // Check if final includes all extending partials
  const final = simulator.committedFinals[simulator.committedFinals.length - 1];
  const expectedText = "You just can't beat people up with doctrine";
  
  console.log(`\n📊 Results:`);
  console.log(`   Expected Final: "${expectedText}"`);
  console.log(`   Actual Final: "${final?.text || 'NONE'}"`);
  console.log(`   Partials Sent During Wait: ${simulator.sentPartials.length}`);
  
  const testPassed = final && 
                     final.text.includes("beat people up with doctrine");
  
  if (!testPassed) {
    console.log(`\n❌ TEST FAILED:`);
    if (!final) {
      console.log(`   No final was committed`);
    } else {
      console.log(`   Final doesn't include partials that arrived during finalization wait`);
      console.log(`   Final: "${final.text}"`);
    }
  } else {
    console.log(`\n✅ TEST PASSED`);
  }
  
  return testPassed;
}

// Test 8: New segment partials causing premature final commit
async function test8_NewSegmentPrematureCommit() {
  console.log('\n📋 Test 8: New segment partials causing premature final commit');
  console.log('-'.repeat(80));
  
  const simulator = new SoloModePipelineSimulator();
  
  // Final 1: "Bend."
  await simulator.onResult("Bend.", false);
  await sleep(100);
  
  // Partial for new segment: "I've been"
  await simulator.onResult("I've been", true);
  await sleep(50);
  
  // Partial extends: "I've been to the"
  await simulator.onResult("I've been to the", true);
  await sleep(50);
  
  // Final 2 arrives: "I've been to the grocery store"
  await simulator.onResult("I've been to the grocery store", false);
  await sleep(2000);
  
  // Check that both finals were committed separately
  const finals = simulator.committedFinals;
  const hasFirstFinal = finals.some(f => f.text.includes("Bend"));
  const hasSecondFinal = finals.some(f => f.text.includes("grocery store"));
  
  console.log(`\n📊 Results:`);
  console.log(`   Total Finals: ${finals.length}`);
  console.log(`   Has First Final: ${hasFirstFinal}`);
  console.log(`   Has Second Final: ${hasSecondFinal}`);
  
  const testPassed = finals.length >= 2 && hasFirstFinal && hasSecondFinal;
  
  if (!testPassed) {
    console.log(`\n❌ TEST FAILED:`);
    if (finals.length < 2) {
      console.log(`   Expected 2 finals, got ${finals.length}`);
    }
    if (!hasFirstFinal) {
      console.log(`   First final was not committed or was overwritten`);
    }
    if (!hasSecondFinal) {
      console.log(`   Second final was not committed`);
    }
  } else {
    console.log(`\n✅ TEST PASSED`);
  }
  
  return testPassed;
}

// Test 9: Longest partial not being used when it should be
async function test9_LongestPartialNotUsed() {
  console.log('\n📋 Test 9: Longest partial not being used when it should be');
  console.log('-'.repeat(80));
  
  const simulator = new SoloModePipelineSimulator();
  
  // Partial 1: "People struggle"
  await simulator.onResult("People struggle", true);
  await sleep(50);
  
  // Partial 2 (longer): "People struggle with doctrine"
  await simulator.onResult("People struggle with doctrine", true);
  await sleep(50);
  
  // Partial 3 (shorter, but latest): "People struggle with"
  await simulator.onResult("People struggle with", true);
  await sleep(50);
  
  // Final arrives: "People struggle"
  await simulator.onResult("People struggle", false);
  await sleep(2000);
  
  // Check if longest partial was used
  const final = simulator.committedFinals[simulator.committedFinals.length - 1];
  const expectedText = "People struggle with doctrine";
  
  console.log(`\n📊 Results:`);
  console.log(`   Expected Final (longest partial): "${expectedText}"`);
  console.log(`   Actual Final: "${final?.text || 'NONE'}"`);
  
  const testPassed = final && 
                     final.text.includes("with doctrine");
  
  if (!testPassed) {
    console.log(`\n❌ TEST FAILED:`);
    console.log(`   Longest partial was not used in final`);
    console.log(`   Final only contains: "${final?.text || 'NONE'}"`);
  } else {
    console.log(`\n✅ TEST PASSED`);
  }
  
  return testPassed;
}

// Run all tests
async function runAllTests() {
  totalTests = 9;
  
  const results = await Promise.all([
    test1_MissingPartialsInFinals(),
    test2_RecoveryMergeInaccuracies(),
    test3_PartialsDroppedByDeduplication(),
    test4_FalseFinalDetection(),
    test5_PartialsLostOnQuickFinal(),
    test6_RecoveryMergeDuplication(),
    test7_PartialsDuringFinalizationWait(),
    test8_NewSegmentPrematureCommit(),
    test9_LongestPartialNotUsed()
  ]);
  
  passedTests = results.filter(r => r).length;
  failedTests = results.filter(r => !r).length;
  
  console.log('\n' + '='.repeat(80));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total Tests: ${totalTests}`);
  console.log(`✅ Passed: ${passedTests}`);
  console.log(`❌ Failed: ${failedTests}`);
  
  if (failedTests > 0) {
    console.log('\n⚠️  TESTS FAILED - Issues found in partial-to-final pipeline!');
    console.log('   Review the failures above to identify the root causes.');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }
}

// Run tests
runAllTests().catch(error => {
  console.error('❌ Test suite error:', error);
  process.exit(1);
});

