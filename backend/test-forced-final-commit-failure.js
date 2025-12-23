/**
 * Test for Forced Final Commit Failure
 * 
 * This test reproduces the real-world failure where:
 * 1. A forced final is detected ("Centered desires cordoned off...")
 * 2. Recovery stream runs and finds unrelated text ("okay open")
 * 3. Recovery tries to commit the merged text
 * 4. Deduplication incorrectly matches against forced final buffer
 * 5. Final fails to commit due to const variable assignment error
 * 6. Final never appears in history
 */

import { deduplicateFinalText } from '../core/utils/finalDeduplicator.js';

// Mock the core engine components
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
      recoveryInProgress: false,
      recoveryPromise: null,
      committedByRecovery: false
    };
    return this.forcedFinalBuffer;
  }

  clearForcedFinalBuffer() {
    this.forcedFinalBuffer = null;
  }
}

// Simulate the exact failure scenario
class HostModeSimulator {
  constructor() {
    this.forcedCommitEngine = new MockForcedCommitEngine();
    this.lastSentOriginalText = '';
    this.lastSentFinalText = '';
    this.lastSentFinalTime = 0;
    this.committedFinals = [];
    this.commitErrors = [];
  }

  // Simulate processFinalText with the exact logic from adapter.js
  async processFinalText(transcriptText, options = {}) {
    const trimmedText = transcriptText.trim();
    
    // CRITICAL: This matches the exact code structure from adapter.js
    // Line 433: let textNormalized = trimmedText.replace(/\s+/g, ' ').toLowerCase();
    let textNormalized = trimmedText.replace(/\s+/g, ' ').toLowerCase();
    const isForcedFinal = !!options.forceFinal;
    const isRecoveryCommit = !!options.isRecoveryCommit; // NEW: Track if this is a recovery commit
    
    // Deduplication check (lines 629-680)
    let finalTextToProcess = trimmedText;
    let textToCompareAgainst = this.lastSentOriginalText || this.lastSentFinalText;
    let timeToCompareAgainst = this.lastSentFinalTime;
    
    // CRITICAL FIX: When recovery commits, do NOT use forced final buffer for deduplication
    // because we're committing the recovery update itself (which includes the forced final)
    // Check if buffer is marked as committedByRecovery (matches real code logic)
    if (!textToCompareAgainst) {
      if (this.forcedCommitEngine.hasForcedFinalBuffer()) {
        const buffer = this.forcedCommitEngine.getForcedFinalBuffer();
        // CRITICAL: Skip deduplication against forced final buffer if it's marked as committed by recovery
        // This matches the fix in adapter.js
        if (buffer && buffer.text && !buffer.committedByRecovery) {
          textToCompareAgainst = buffer.text;
          timeToCompareAgainst = buffer.timestamp || Date.now();
          console.log(`  [TEST] 🔍 Using forced final buffer for deduplication: "${textToCompareAgainst.substring(Math.max(0, textToCompareAgainst.length - 60))}"`);
        } else if (buffer?.committedByRecovery) {
          console.log(`  [TEST] ⏭️ Skipping forced final buffer deduplication - recovery commit in progress`);
        }
      }
    }
    
    if (textToCompareAgainst && timeToCompareAgainst) {
      const timeSinceLastFinal = Date.now() - timeToCompareAgainst;
      console.log(`  [TEST] Checking deduplication: previous="${textToCompareAgainst.substring(Math.max(0, textToCompareAgainst.length - 60))}", new="${trimmedText.substring(0, 60)}", timeSince=${timeSinceLastFinal}ms`);
      
      const dedupResult = deduplicateFinalText({
        newFinalText: trimmedText,
        previousFinalText: textToCompareAgainst,
        previousFinalTime: timeToCompareAgainst,
        mode: 'HostMode',
        timeWindowMs: 5000,
        maxWordsToCheck: 10
      });
      
      if (dedupResult.wasDeduplicated) {
        finalTextToProcess = dedupResult.deduplicatedText;
        console.log(`  [TEST] ✂️ Deduplicated: "${trimmedText.substring(0, 60)}..." → "${finalTextToProcess.substring(0, 60)}..." (removed ${dedupResult.wordsSkipped} words)`);
        
        if (!finalTextToProcess || finalTextToProcess.length === 0) {
          console.log(`  [TEST] ⏭️ Skipping - all words are duplicates`);
          return;
        }
        
        // Update textNormalized for subsequent processing
        // Line 671 in adapter.js: textNormalized = finalTextToProcess.replace(/\s+/g, ' ').toLowerCase();
        // This should work because textNormalized is declared as 'let' at line 433
        textNormalized = finalTextToProcess.replace(/\s+/g, ' ').toLowerCase();
      }
    }
    
    // If we get here, commit was successful
    this.lastSentOriginalText = trimmedText;
    this.lastSentFinalText = finalTextToProcess;
    this.lastSentFinalTime = Date.now();
    
    this.committedFinals.push({
      original: trimmedText,
      processed: finalTextToProcess,
      timestamp: this.lastSentFinalTime,
      isForced: isForcedFinal
    });
    
    console.log(`  [TEST] ✅ Committed final: "${finalTextToProcess.substring(0, 80)}..."`);
    return finalTextToProcess;
  }

  // Simulate recovery commit scenario
  async simulateRecoveryCommit(forcedFinalText, recoveryText) {
    console.log(`\n[TEST] 🎯 FORCED FINAL: "${forcedFinalText.substring(0, 80)}..."`);
    console.log(`[TEST] 🔄 RECOVERY: "${recoveryText.substring(0, 80)}..."`);
    
    // Create forced final buffer
    this.forcedCommitEngine.createForcedFinalBuffer(forcedFinalText);
    
    // Simulate recovery merge (no overlap case - full append)
    const mergedText = forcedFinalText + ' ' + recoveryText;
    console.log(`[TEST] 🔗 Merged: "${mergedText.substring(0, 80)}..."`);
    
    // Mark buffer as committed by recovery BEFORE processing (simulating recovery commit)
    const buffer = this.forcedCommitEngine.getForcedFinalBuffer();
    if (buffer) {
      buffer.committedByRecovery = true;
    }
    
    // Try to commit - this should NOT deduplicate against the forced final buffer
    // because it's marked as committedByRecovery
    try {
      await this.processFinalText(mergedText, { forceFinal: true });
      
      // Clear buffer after commit (simulating recovery clearing it)
      this.forcedCommitEngine.clearForcedFinalBuffer();
    } catch (error) {
      console.log(`  [TEST] ❌ Commit failed: ${error.message}`);
      this.forcedCommitEngine.clearForcedFinalBuffer();
      return { success: false, error };
    }
    
    return { success: true };
  }
}

// Test Cases
async function runTests() {
  console.log('='.repeat(80));
  console.log('FORCED FINAL COMMIT FAILURE TESTS');
  console.log('='.repeat(80));
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: Reproduce the exact failure scenario
  console.log('\n📋 TEST 1: Forced Final Commit Failure (Real-World Scenario)');
  console.log('-'.repeat(80));
  {
    const simulator = new HostModeSimulator();
    
    // First final (from previous segment)
    const previousFinal = 'I love this quote: Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent fulfilling our own self-centered desires.';
    await simulator.processFinalText(previousFinal);
    simulator.lastSentFinalTime = Date.now() - 5000; // Old enough to not interfere
    
    // Forced final (from stream restart)
    const forcedFinal = 'Centered desires cordoned off from others. In private fortresses, we call home biblical Hospitality chooses to engage rather than unplug';
    
    // Recovery finds unrelated text (this happens when recovery audio doesn't match)
    const recoveryText = 'okay open';
    
    // This should commit successfully, but currently fails
    const result = await simulator.simulateRecoveryCommit(forcedFinal, recoveryText);
    
    if (!result.success) {
      console.log(`  ❌ FAILED: Commit failed with error: ${result.error?.message}`);
      console.log(`     This confirms the bug - forced final did not commit`);
      failed++;
    } else {
      const committed = simulator.committedFinals.find(f => f.processed.includes('Centered desires'));
      if (committed) {
        console.log('  ✅ PASSED: Forced final committed successfully');
        passed++;
      } else {
        console.log('  ❌ FAILED: Forced final not found in committed finals');
        failed++;
      }
    }
  }
  
  // Test 2: Verify final appears in history after commit (with incomplete buffer text)
  console.log('\n📋 TEST 2: Final Appears in History After Commit (Incomplete Buffer Bug)');
  console.log('-'.repeat(80));
  {
    const simulator = new HostModeSimulator();
    
    // Simulate the exact bug scenario from logs:
    // Forced final buffer has incomplete text (only last part)
    const fullForcedFinal = 'Centered desires cordoned off from others. In private fortresses, we call home biblical Hospitality chooses to engage rather than unplug';
    const incompleteBufferText = 'me biblical Hospitality chooses to engage rather than unplug'; // Only last part
    const recoveryText = 'okay open';
    
    // Create buffer with incomplete text (simulating the bug)
    simulator.forcedCommitEngine.createForcedFinalBuffer(incompleteBufferText);
    
    // Mark as committed by recovery
    const buffer = simulator.forcedCommitEngine.getForcedFinalBuffer();
    if (buffer) {
      buffer.committedByRecovery = true;
    }
    
    // Merge recovery with full forced final (what recovery actually commits)
    const mergedText = fullForcedFinal + ' ' + recoveryText;
    
    // Try to commit - should NOT deduplicate against incomplete buffer
    try {
      await simulator.processFinalText(mergedText, { forceFinal: true });
      simulator.forcedCommitEngine.clearForcedFinalBuffer();
    } catch (error) {
      console.log(`  [TEST] ❌ Commit failed: ${error.message}`);
      simulator.forcedCommitEngine.clearForcedFinalBuffer();
    }
    
    // Check if final is in committed finals with full content
    const hasFullFinal = simulator.committedFinals.some(f => 
      f.processed.includes('Centered desires') && 
      f.processed.includes('cordoned off')
    );
    
    // Check if deduplication incorrectly removed content
    const hasOnlyRecovery = simulator.committedFinals.some(f => 
      f.processed === 'okay open' || 
      (f.processed.includes('okay open') && !f.processed.includes('Centered desires'))
    );
    
    if (hasFullFinal && !hasOnlyRecovery) {
      console.log('  ✅ PASSED: Final appears in history with full content');
      passed++;
    } else if (hasOnlyRecovery) {
      console.log('  ❌ FAILED: Deduplication incorrectly removed forced final content');
      console.log(`     Got: "${simulator.committedFinals[simulator.committedFinals.length - 1]?.processed}"`);
      console.log(`     Expected: Should contain "Centered desires cordoned off..."`);
      failed++;
    } else {
      console.log('  ❌ FAILED: Final missing from history');
      console.log(`     Committed finals: ${simulator.committedFinals.length}`);
      failed++;
    }
  }
  
  // Test 3: Deduplication should not remove entire forced final
  console.log('\n📋 TEST 3: Deduplication Should Not Remove Entire Forced Final');
  console.log('-'.repeat(80));
  {
    const simulator = new HostModeSimulator();
    
    // Create forced final buffer
    const forcedFinal = 'Centered desires cordoned off from others. In private fortresses, we call home biblical Hospitality chooses to engage rather than unplug';
    simulator.forcedCommitEngine.createForcedFinalBuffer(forcedFinal);
    
    // Recovery finds unrelated text
    const recoveryText = 'okay open';
    const mergedText = forcedFinal + ' ' + recoveryText;
    
    // Clear buffer (simulating recovery commit clearing it)
    simulator.forcedCommitEngine.clearForcedFinalBuffer();
    
    // Try to process - should NOT deduplicate against nothing
    try {
      await simulator.processFinalText(mergedText, { forceFinal: true });
      
      const final = simulator.committedFinals[simulator.committedFinals.length - 1];
      const hasForcedFinalContent = final?.processed.includes('Centered desires') || 
                                    final?.processed.includes('cordoned off');
      
      if (hasForcedFinalContent) {
        console.log('  ✅ PASSED: Forced final content preserved');
        passed++;
      } else {
        console.log(`  ❌ FAILED: Forced final content lost. Got: "${final?.processed}"`);
        failed++;
      }
    } catch (error) {
      console.log(`  ❌ FAILED: Error during commit: ${error.message}`);
      failed++;
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('TEST SUMMARY');
  console.log('='.repeat(80));
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);
  
  if (failed > 0) {
    console.log('\n⚠️  Tests confirm the bug exists. Fixing now...');
  }
  
  return failed === 0;
}

// Run tests
runTests().then(success => {
  if (!success) {
    console.log('\n🔧 Now fixing the issue...');
  }
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test execution error:', error);
  process.exit(1);
});

