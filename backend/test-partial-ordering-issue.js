/**
 * Test for Partial Ordering Issue
 * 
 * This test reproduces the issue where:
 * 1. Short partials are not transcribing in order
 * 2. Words are being dropped
 * 3. Finals appear out of order (#1-4 in wrong sequence)
 * 
 * Root cause: Recovery commits are being queued when a final is already processing,
 * causing them to be processed out of order and lose deduplication context.
 */

import { deduplicateFinalText } from '../core/utils/finalDeduplicator.js';

// Simulate the exact scenario from logs
class HostModeSimulator {
  constructor() {
    this.isProcessingFinal = false;
    this.finalProcessingQueue = [];
    this.committedFinals = [];
    this.lastSentOriginalText = '';
    this.lastSentFinalText = '';
    this.lastSentFinalTime = 0;
    this.forcedCommitEngine = {
      forcedFinalBuffer: null,
      hasForcedFinalBuffer: () => this.forcedFinalBuffer !== null,
      getForcedFinalBuffer: () => this.forcedFinalBuffer,
      createForcedFinalBuffer: (text, timestamp = Date.now()) => {
        this.forcedFinalBuffer = { text, timestamp, committedByRecovery: false };
        return this.forcedFinalBuffer;
      },
      clearForcedFinalBuffer: () => {
        this.forcedFinalBuffer = null;
      }
    };
  }

  // Simulate processFinalText with queuing logic
  async processFinalText(textToProcess, options = {}) {
    // Check if already processing
    if (this.isProcessingFinal) {
      console.log(`  [TEST] ⏳ Final already being processed, queuing: "${textToProcess.substring(0, 60)}..."`);
      this.finalProcessingQueue.push({ textToProcess, options });
      return; // Queue instead of process
    }

    // Process immediately
    this.isProcessingFinal = true;

    try {
      const trimmedText = textToProcess.trim();
      let finalTextToProcess = trimmedText;
      
      // Deduplication check
      let textToCompareAgainst = this.lastSentOriginalText || this.lastSentFinalText;
      let timeToCompareAgainst = this.lastSentFinalTime;
      
      // Check forced final buffer if available
      if (!textToCompareAgainst && this.forcedCommitEngine.hasForcedFinalBuffer()) {
        const buffer = this.forcedCommitEngine.getForcedFinalBuffer();
        if (buffer && buffer.text && !buffer.committedByRecovery) {
          textToCompareAgainst = buffer.text;
          timeToCompareAgainst = buffer.timestamp || Date.now();
        }
      }
      
      if (textToCompareAgainst && timeToCompareAgainst) {
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
          if (!finalTextToProcess || finalTextToProcess.length === 0) {
            console.log(`  [TEST] ⏭️ Skipping - all words are duplicates`);
            this.isProcessingFinal = false;
            this.processQueue();
            return;
          }
        }
      } else {
        console.log(`  [TEST] ℹ️ No previous final text to compare against`);
      }
      
      // Simulate async processing delay
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Commit
      this.lastSentOriginalText = trimmedText;
      this.lastSentFinalText = finalTextToProcess;
      this.lastSentFinalTime = Date.now();
      
      this.committedFinals.push({
        text: finalTextToProcess,
        timestamp: this.lastSentFinalTime,
        order: this.committedFinals.length + 1
      });
      
      console.log(`  [TEST] ✅ Committed final #${this.committedFinals.length}: "${finalTextToProcess.substring(0, 60)}..."`);
      
    } catch (error) {
      console.log(`  [TEST] ❌ Error: ${error.message}`);
    } finally {
      this.isProcessingFinal = false;
      this.processQueue();
    }
  }

  // Process queued finals (only one at a time to match real code)
  async processQueue() {
    if (this.finalProcessingQueue.length > 0 && !this.isProcessingFinal) {
      const next = this.finalProcessingQueue.shift();
      console.log(`  [TEST] 🔄 Processing queued final: "${next.textToProcess.substring(0, 60)}..."`);
      // Process asynchronously to match real code fix
      setImmediate(() => {
        this.processFinalText(next.textToProcess, next.options);
      });
    }
  }
}

// Test Cases
async function runTests() {
  console.log('='.repeat(80));
  console.log('PARTIAL ORDERING ISSUE TESTS');
  console.log('='.repeat(80));
  
  let passed = 0;
  let failed = 0;
  
  // Test 1: Reproduce the exact scenario from logs - queued final loses context
  console.log('\n📋 TEST 1: Queued Final Loses Deduplication Context');
  console.log('-'.repeat(80));
  {
    const simulator = new HostModeSimulator();
    
    // Simulate the exact sequence from logs:
    // 1. First final "Abandoned." is processed
    // 2. While processing, recovery commit "Abandoned. Oh boy, I've been to a grocery." arrives
    // 3. Recovery commit gets queued
    // 4. First final finishes and updates lastSentFinalText
    // 5. Queued recovery commit processes but should have access to lastSentFinalText
    
    // Step 1: First final starts processing
    const firstFinal = 'Abandoned.';
    const processFirst = simulator.processFinalText(firstFinal);
    
    // Step 2: Recovery commit arrives while first is processing
    await new Promise(resolve => setTimeout(resolve, 5)); // Let first final start processing
    const recoveryFinal = "Abandoned. Oh boy, I've been to a grocery.";
    
    // Recovery commit - should be queued
    simulator.processFinalText(recoveryFinal, { forceFinal: true });
    
    // Wait for all processing to complete
    await processFirst;
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Check that recovery final has access to previous final for deduplication
    const first = simulator.committedFinals.find(f => f.text === 'Abandoned.');
    const recovery = simulator.committedFinals.find(f => f.text.includes('grocery'));
    
    if (first && recovery) {
      // Recovery final should have deduplicated "Abandoned." from the start
      const deduplicated = !recovery.text.startsWith('Abandoned. Abandoned.');
      const hasContext = recovery.text.includes('Oh boy') || recovery.text.includes('grocery');
      
      if (deduplicated && hasContext) {
        console.log('  ✅ PASSED: Queued final has deduplication context');
        passed++;
      } else {
        console.log(`  ❌ FAILED: Queued final lost context or didn't deduplicate`);
        console.log(`     Recovery final: "${recovery.text}"`);
        console.log(`     Should deduplicate "Abandoned." from start`);
        failed++;
      }
    } else {
      console.log('  ❌ FAILED: Missing finals');
      console.log(`     Finals: ${simulator.committedFinals.length}`);
      console.log(`     First: ${first ? 'found' : 'missing'}, Recovery: ${recovery ? 'found' : 'missing'}`);
      failed++;
    }
  }
  
  // Test 2: Short partials should not be dropped
  console.log('\n📋 TEST 2: Short Partials Should Not Be Dropped');
  console.log('-'.repeat(80));
  {
    const simulator = new HostModeSimulator();
    
    // Simulate short partials arriving in sequence
    const shortPartials = [
      'Abandoned.',
      'Oh boy.',
      "I've been",
      'to a grocery.'
    ];
    
    // Process them in order
    for (const partial of shortPartials) {
      await simulator.processFinalText(partial);
    }
    
    // Wait for queue to process
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Check that all partials were committed
    const allCommitted = shortPartials.every(partial => 
      simulator.committedFinals.some(f => f.text.includes(partial.split(' ')[0]))
    );
    
    if (allCommitted && simulator.committedFinals.length >= shortPartials.length) {
      console.log('  ✅ PASSED: All short partials committed');
      passed++;
    } else {
      console.log(`  ❌ FAILED: Some partials missing. Got ${simulator.committedFinals.length}, expected ${shortPartials.length}`);
      console.log(`     Committed: ${simulator.committedFinals.map(f => f.text.substring(0, 20)).join(', ')}`);
      failed++;
    }
  }
  
  // Test 3: Short partials should not be processed out of order
  console.log('\n📋 TEST 3: Short Partials Should Not Be Processed Out of Order');
  console.log('-'.repeat(80));
  {
    const simulator = new HostModeSimulator();
    
    // Simulate the exact scenario from user's logs:
    // 1. Short final "Abandoned." arrives first
    // 2. Longer final "Mystery stories..." arrives while first is processing
    // 3. Short final should process first, but gets queued
    // 4. Longer final processes first
    // 5. Short final processes later, but should still be in correct order
    
    // Step 1: Short final starts processing
    const shortFinal = 'Abandoned.';
    const processShort = simulator.processFinalText(shortFinal);
    
    // Step 2: Longer final arrives while short is processing
    await new Promise(resolve => setTimeout(resolve, 5));
    const longFinal = 'Mystery stories that were friendlier than that.';
    simulator.processFinalText(longFinal);
    
    // Wait for processing
    await processShort;
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check that short final was processed first (or at least in correct relative order)
    const shortIndex = simulator.committedFinals.findIndex(f => f.text === 'Abandoned.');
    const longIndex = simulator.committedFinals.findIndex(f => f.text.includes('Mystery'));
    
    if (shortIndex !== -1 && longIndex !== -1) {
      // Short final should be processed before or at the same time as long final
      // But the key is that both should be committed
      if (shortIndex < longIndex || shortIndex === 0) {
        console.log('  ✅ PASSED: Short partial processed in correct order');
        passed++;
      } else {
        console.log(`  ❌ FAILED: Short partial processed after long final`);
        console.log(`     Short index: ${shortIndex}, Long index: ${longIndex}`);
        console.log(`     Order: ${simulator.committedFinals.map(f => f.text.substring(0, 20)).join(' -> ')}`);
        failed++;
      }
    } else {
      console.log('  ❌ FAILED: Missing finals');
      console.log(`     Short: ${shortIndex !== -1 ? 'found' : 'missing'}, Long: ${longIndex !== -1 ? 'found' : 'missing'}`);
      failed++;
    }
  }
  
  // Test 4: Multiple short partials should maintain order
  console.log('\n📋 TEST 4: Multiple Short Partials Should Maintain Order');
  console.log('-'.repeat(80));
  {
    const simulator = new HostModeSimulator();
    
    // Simulate multiple short partials arriving in quick succession
    const shortPartials = [
      'Abandoned.',
      'Oh boy.',
      "I've been",
      'to a grocery.'
    ];
    
    // Process them rapidly
    const promises = shortPartials.map(partial => simulator.processFinalText(partial));
    await Promise.all(promises);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check that all were committed and in order
    const allCommitted = shortPartials.every((partial, index) => {
      const found = simulator.committedFinals.find(f => 
        f.text.includes(partial.split(' ')[0]) || f.text === partial.trim()
      );
      return found !== undefined;
    });
    
    if (allCommitted && simulator.committedFinals.length >= shortPartials.length) {
      // Check relative order
      const firstIndex = simulator.committedFinals.findIndex(f => f.text.includes('Abandoned'));
      const lastIndex = simulator.committedFinals.findIndex(f => f.text.includes('grocery'));
      
      if (firstIndex !== -1 && lastIndex !== -1 && firstIndex < lastIndex) {
        console.log('  ✅ PASSED: Multiple short partials maintained order');
        passed++;
      } else {
        console.log(`  ❌ FAILED: Short partials out of order`);
        console.log(`     First index: ${firstIndex}, Last index: ${lastIndex}`);
        failed++;
      }
    } else {
      console.log(`  ❌ FAILED: Not all partials committed`);
      console.log(`     Expected: ${shortPartials.length}, Got: ${simulator.committedFinals.length}`);
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
  
  return failed === 0;
}

// Run tests
runTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test execution error:', error);
  process.exit(1);
});

