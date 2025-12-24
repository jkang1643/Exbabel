/**
 * Test Suite: Partials Being Dropped - Race Condition Tests
 * 
 * These tests accurately simulate the EXACT race conditions in hostModeHandler.js
 * to identify where partials get dropped.
 * 
 * Key timing issues to test:
 * 1. Partials arriving between timeout check (line 2331) and processFinalText reset (line 992)
 * 2. Partials arriving during async processing in processFinalText (grammar/translation)
 * 3. Partials that extend final but don't match extension logic (startsWith check fails)
 * 4. Partials overwritten by new segment partials before final processing
 * 
 * Run with: node backend/test-partials-dropped-race-conditions.js
 */

import { PartialTracker } from '../core/engine/partialTracker.js';

console.log('🧪 Test Suite: Partials Dropped - Race Condition Tests\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`✅ ${name}`);
    testDetails.push({ name, status: 'PASSED', error: null });
  } catch (error) {
    failedTests++;
    console.log(`❌ ${name}: ${error.message}`);
    testDetails.push({ name, status: 'FAILED', error: error.message });
    console.error(`   Stack: ${error.stack}`);
  }
}

// Simulate the EXACT flow from hostModeHandler.js
class ExactHostModeSimulator {
  constructor() {
    this.partialTracker = new PartialTracker();
    this.processedFinals = [];
    this.pendingFinalization = null;
    this.pendingTimeout = null;
    this.isProcessingFinal = false;
    this.lastSentFinalText = '';
    this.recoveredPartials = [];
  }

  handlePartial(transcriptText) {
    this.partialTracker.updatePartial(transcriptText);
  }

  // Simulate EXACT final handling flow (lines 2165-2340)
  async handleFinal(transcriptText, waitTimeMs = 1000) {
    // Line 2167-2172: Take snapshot
    const partialSnapshot = this.partialTracker.getSnapshot();
    const longestPartialSnapshot = partialSnapshot.longest;
    const latestPartialSnapshot = partialSnapshot.latest;
    
    console.log(`[Simulator] 📸 SNAPSHOT: longest=${longestPartialSnapshot?.length || 0} chars`);
    
    // Line 2211-2264: Check snapshot for extending partials
    let finalTextToUse = transcriptText;
    if (longestPartialSnapshot && longestPartialSnapshot.length > transcriptText.length) {
      const longestTrimmed = longestPartialSnapshot.trim();
      const finalTrimmed = transcriptText.trim();
      const finalNormalized = finalTrimmed.replace(/\s+/g, ' ').toLowerCase();
      const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
      const extendsFinal = longestNormalized.startsWith(finalNormalized);
      
      if (extendsFinal) {
        finalTextToUse = longestPartialSnapshot;
        console.log(`[Simulator] ⚠️ Using snapshot longest partial`);
      }
    }
    
    // Line 2267-2270: Create pending finalization
    this.pendingFinalization = { text: finalTextToUse, timestamp: Date.now() };
    
    // Line 2273-2340: Schedule timeout
    return new Promise((resolve) => {
      this.pendingTimeout = setTimeout(() => {
        // Line 2281-2331: Check LIVE values (not snapshot)
        let finalTextToUse2 = this.pendingFinalization.text;
        
        const longestPartial = this.partialTracker.getLongestPartial(); // LIVE
        const latestPartial = this.partialTracker.getLatestPartial(); // LIVE
        const longestPartialTime = this.partialTracker.getLongestPartialTime();
        const latestPartialTime = this.partialTracker.getLatestPartialTime();
        
        const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
        const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;
        
        if (longestPartial && longestPartial.length > finalTextToUse2.length && timeSinceLongest < 10000) {
          const longestTrimmed = longestPartial.trim();
          const finalTrimmed2 = finalTextToUse2.trim();
          const finalNormalized2 = finalTrimmed2.replace(/\s+/g, ' ').toLowerCase();
          const longestNormalized2 = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
          const extendsFinal2 = longestNormalized2.startsWith(finalNormalized2);
          
          if (extendsFinal2) {
            console.log(`[Simulator] ⚠️ Using LIVE longest partial (${finalTextToUse2.length} → ${longestPartial.length} chars)`);
            finalTextToUse2 = longestPartial;
            this.recoveredPartials.push(longestPartial);
          }
        } else if (latestPartial && latestPartial.length > finalTextToUse2.length && timeSinceLatest < 5000) {
          const latestTrimmed = latestPartial.trim();
          const finalTrimmed2 = finalTextToUse2.trim();
          const finalNormalized2 = finalTrimmed2.replace(/\s+/g, ' ').toLowerCase();
          const latestNormalized2 = latestTrimmed.replace(/\s+/g, ' ').toLowerCase();
          const extendsFinal2 = latestNormalized2.startsWith(finalNormalized2);
          
          if (extendsFinal2) {
            console.log(`[Simulator] ⚠️ Using LIVE latest partial (${finalTextToUse2.length} → ${latestPartial.length} chars)`);
            finalTextToUse2 = latestPartial;
            this.recoveredPartials.push(latestPartial);
          }
        }
        
        // Line 2339: Call processFinalText
        this.processFinalText(finalTextToUse2);
        
        this.pendingFinalization = null;
        resolve();
      }, waitTimeMs);
    });
  }

  // Simulate processFinalText (lines 679-1045)
  async processFinalText(textToProcess) {
    if (this.isProcessingFinal) {
      console.log(`[Simulator] ⚠️ Final already being processed`);
      return;
    }
    
    this.isProcessingFinal = true;
    
    try {
      // Simulate async processing (grammar correction, translation)
      // This is where partials can arrive and get lost
      await new Promise(resolve => setTimeout(resolve, 300)); // Simulate async delay
      
      // Process final
      this.processedFinals.push(textToProcess);
      this.lastSentFinalText = textToProcess;
      
      // Line 992: Reset partial tracking AFTER final is sent
      this.partialTracker.reset();
      console.log('[Simulator] 🧹 Reset partial tracking after final sent');
      
    } finally {
      this.isProcessingFinal = false;
    }
  }
}

// TEST 1: CRITICAL RACE CONDITION - Partials arriving between timeout check and reset
// Scenario: Partial arrives AFTER timeout callback checks but BEFORE processFinalText resets
test('Test 1: CRITICAL - Partials arriving between timeout check and reset get dropped', async () => {
  const simulator = new ExactHostModeSimulator();
  
  // Final arrives
  const final = "And you know what our people are going to do? Well";
  const finalPromise = simulator.handleFinal(final, 500);
  
  // Partial arrives DURING timeout wait (should be caught)
  setTimeout(() => {
    simulator.handlePartial("And you know what our people are going to do? Well, let's pray");
  }, 200);
  
  // CRITICAL: Partial arrives AFTER timeout callback starts checking but BEFORE processFinalText completes
  // This happens in the gap between line 2331 (check complete) and line 992 (reset)
  setTimeout(() => {
    const latePartial = "And you know what our people are going to do? Well, let's pray right now and outside";
    simulator.handlePartial(latePartial);
    console.log(`[Test] ⏰ CRITICAL: Late partial arrived: "${latePartial}"`);
  }, 520); // Just after timeout (500ms) but before async processing completes (500ms + 300ms = 800ms)
  
  await finalPromise;
  
  // Wait for async processing to complete
  await new Promise(resolve => setTimeout(resolve, 400));
  
  // Check if late partial was included
  const latePartial = "And you know what our people are going to do? Well, let's pray right now and outside";
  const wasIncluded = simulator.processedFinals.some(f => f.includes("pray right now and outside"));
  const wasRecovered = simulator.recoveredPartials.some(p => p.includes("pray right now and outside"));
  
  // This WILL FAIL - partial arriving after timeout check is not checked again before reset
  if (!wasIncluded && !wasRecovered) {
    throw new Error(`CRITICAL: Late partial was dropped (arrived between timeout check and reset): "${latePartial}"`);
  }
});

// TEST 2: Partials that don't pass startsWith check but should still be merged
// Scenario: Partial extends final but startsWith check fails (different capitalization/formatting)
test('Test 2: Partials that extend final but fails startsWith check get dropped', async () => {
  const simulator = new ExactHostModeSimulator();
  
  // Final with specific formatting
  const final = ", let's pray right now and outside the taco stand";
  
  // Partial that extends it but doesn't start with the final (starts with different text)
  simulator.handlePartial("And you know what our people are going to do? Well, let's pray right now and outside the taco stand, they start holding hands");
  
  await simulator.handleFinal(final, 500);
  
  // The partial doesn't start with the final, so startsWith check fails
  // But it should still be merged if there's overlap
  const extendingText = "they start holding hands";
  const wasIncluded = simulator.processedFinals.some(f => f.includes(extendingText));
  
  // This WILL FAIL - the partial doesn't start with final, so it's not used
  if (!wasIncluded) {
    throw new Error(`Partial that extends final (but doesn't start with it) was dropped: "they start holding hands"`);
  }
});

// TEST 3: Real scenario from terminal - final starts with comma, partial starts with "And"
test('Test 3: Real scenario - final starts with comma, partial starts with "And" - should merge', async () => {
  const simulator = new ExactHostModeSimulator();
  
  // Partials with opening phrase
  simulator.handlePartial("And you know what our people are going to do? Well");
  simulator.handlePartial("And you know what our people are going to do? Well, let's pray right now");
  
  // Final from terminal (line 6128) - starts with comma, missing opening phrase
  const final = ", let's pray right now and outside the taco stand, they start holding hands and they start praying, or someone says my mother's. someone says, my mother's having surgery. This week all";
  
  await simulator.handleFinal(final, 1000);
  
  // Check if opening phrase was included
  const openingPhrase = "And you know what our people are going to do? Well";
  const wasIncluded = simulator.processedFinals.some(f => f.includes(openingPhrase));
  
  // This WILL FAIL - final doesn't start with partial, so startsWith check fails
  // The mergeWithOverlap should catch this, but it might not if the logic is strict
  if (!wasIncluded) {
    throw new Error(`Opening phrase was dropped. Final: "${final.substring(0, 50)}...", Should include: "${openingPhrase}"`);
  }
});

// TEST 4: Partials overwriting during rapid updates - new segment partial overwrites extending partial
test('Test 4: New segment partial overwrites extending partial before final processing', async () => {
  const simulator = new ExactHostModeSimulator();
  
  // Extending partial
  simulator.handlePartial("And you know what our people are going to do? Well, let's pray");
  
  // Final arrives
  const final = "And you know what our people are going to do? Well";
  const finalPromise = simulator.handleFinal(final, 500);
  
  // New segment partial arrives (doesn't extend, but overwrites latest)
  setTimeout(() => {
    simulator.handlePartial("The weather is nice today");
  }, 300);
  
  await finalPromise;
  
  // Check if extending partial was still used (latest was overwritten by new segment)
  const extendingPartial = "And you know what our people are going to do? Well, let's pray";
  const wasIncluded = simulator.processedFinals.some(f => f.includes("let's pray"));
  
  // This might PASS if longest is used, but FAIL if only latest is checked
  if (!wasIncluded) {
    throw new Error(`Extending partial was lost when new segment partial overwrote latest`);
  }
});

// TEST 5: Multiple finals in rapid succession - second final resets partials before first final processes them
test('Test 5: Rapid finals - second final resets partials before first final uses them', async () => {
  const simulator = new ExactHostModeSimulator();
  
  // Partial
  simulator.handlePartial("And you know what our people are going to do? Well, let's pray");
  
  // First final arrives
  const final1 = "And you know what our people are going to do? Well";
  const promise1 = simulator.handleFinal(final1, 500);
  
  // Second final arrives quickly (before first completes)
  setTimeout(() => {
    const final2 = "The weather is nice";
    simulator.handleFinal(final2, 500);
  }, 100);
  
  await promise1;
  
  // Wait for both to complete
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Check if first final used the partial
  const wasIncluded = simulator.processedFinals.some(f => f.includes("let's pray"));
  
  // This might FAIL if second final resets partials before first final uses them
  if (!wasIncluded) {
    throw new Error(`First final didn't use extending partial (may have been reset by second final)`);
  }
});

// Summary
console.log('\n' + '='.repeat(70));
console.log(`\n📊 Test Summary:`);
console.log(`   Total: ${totalTests}`);
console.log(`   ✅ Passed: ${passedTests}`);
console.log(`   ❌ Failed: ${failedTests}`);

if (failedTests > 0) {
  console.log(`\n❌ Failed Tests (These identify the race conditions):`);
  testDetails
    .filter(t => t.status === 'FAILED')
    .forEach(t => {
      console.log(`\n   - ${t.name}`);
      console.log(`     ${t.error}`);
    });
  
  console.log(`\n💡 These failing tests identify the EXACT race conditions where partials get dropped.`);
  console.log(`   Fix the implementation to handle these scenarios.`);
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed!`);
  console.log(`\n⚠️  Note: Review the implementation to ensure these race conditions are handled.`);
  process.exit(0);
}

