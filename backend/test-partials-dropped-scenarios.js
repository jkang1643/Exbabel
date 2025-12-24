/**
 * Test Suite: Partials Being Dropped in High Load Scenarios
 * 
 * This test suite uses TDD to identify cases where partials get dropped:
 * 1. Partials overwriting each other during high load
 * 2. Partials falling behind during fast speech
 * 3. Partials arriving after snapshot but before final processing
 * 4. Partials arriving during async processing (grammar correction/translation)
 * 5. Partials that extend finals but arrive after snapshot
 * 
 * Run with: node backend/test-partials-dropped-scenarios.js
 * 
 * TDD Approach: Write failing tests first to identify the exact failure cases
 */

import { PartialTracker } from '../core/engine/partialTracker.js';

console.log('🧪 Test Suite: Partials Being Dropped in High Load Scenarios\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

// Test helper functions
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
  }
}

// More realistic simulation of hostModeHandler partial handling
class RealisticHostModePartialHandler {
  constructor() {
    this.partialTracker = new PartialTracker();
    this.processedFinals = [];
    this.recoveredPartials = [];
    this.droppedPartials = [];
    this.sentFinals = [];
    this.isProcessingFinal = false;
  }

  // Simulate partial update (as in hostModeHandler.js onResult callback)
  handlePartial(transcriptText) {
    // This simulates the partial handling in hostModeHandler.js
    this.partialTracker.updatePartial(transcriptText);
  }

  // Simulate the EXACT final processing logic from hostModeHandler.js (lines 2165-2340)
  async handleFinal(transcriptText, waitTimeMs = 1000) {
    // Prevent concurrent processing (line 683)
    if (this.isProcessingFinal) {
      console.log(`[MockHandler] ⚠️ Final already being processed, skipping`);
      return;
    }
    
    this.isProcessingFinal = true;
    
    try {
      // CRITICAL: Take snapshot BEFORE processing (line 2167-2172)
      const partialSnapshot = this.partialTracker.getSnapshot();
      const longestPartialSnapshot = partialSnapshot.longest;
      const latestPartialSnapshot = partialSnapshot.latest;
      
      console.log(`[MockHandler] 📸 SNAPSHOT: longest=${longestPartialSnapshot?.length || 0} chars, latest=${latestPartialSnapshot?.length || 0} chars`);
      
      // Calculate wait time (lines 2177-2192)
      const BASE_WAIT_MS = waitTimeMs;
      let WAIT_FOR_PARTIALS_MS = BASE_WAIT_MS;
      
      // Check snapshot for extending partials (lines 2216-2264)
      let finalTextToUse = transcriptText;
      const finalTrimmed = transcriptText.trim();
      
      if (longestPartialSnapshot && longestPartialSnapshot.length > transcriptText.length) {
        const longestTrimmed = longestPartialSnapshot.trim();
        const finalNormalized = finalTrimmed.replace(/\s+/g, ' ').toLowerCase();
        const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
        const extendsFinal = longestNormalized.startsWith(finalNormalized);
        
        if (extendsFinal) {
          console.log(`[MockHandler] ⚠️ FINAL extended by LONGEST partial SNAPSHOT`);
          finalTextToUse = longestPartialSnapshot;
        }
      }
      
      // Schedule timeout (lines 2273-2340)
      await new Promise(resolve => setTimeout(resolve, WAIT_FOR_PARTIALS_MS));
      
      // After waiting, check AGAIN using LIVE values (not snapshot) (lines 2287-2331)
      // THIS IS WHERE THE RACE CONDITION OCCURS:
      // - Partials that arrive after snapshot but before timeout are checked here (GOOD)
      // - But partials that arrive during this check might be lost
      let finalTextToUse2 = finalTextToUse;
      const longestPartial = this.partialTracker.getLongestPartial(); // LIVE value
      const latestPartial = this.partialTracker.getLatestPartial(); // LIVE value
      const longestPartialTime = this.partialTracker.getLongestPartialTime();
      const latestPartialTime = this.partialTracker.getLatestPartialTime();
      
      const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
      const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;
      
      if (longestPartial && longestPartial.length > finalTextToUse.length && timeSinceLongest < 10000) {
        const longestTrimmed = longestPartial.trim();
        const finalTrimmed2 = finalTextToUse.trim();
        const finalNormalized2 = finalTrimmed2.replace(/\s+/g, ' ').toLowerCase();
        const longestNormalized2 = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
        const extendsFinal2 = longestNormalized2.startsWith(finalNormalized2);
        
        if (extendsFinal2) {
          console.log(`[MockHandler] ⚠️ Using LONGEST partial (after timeout)`);
          finalTextToUse2 = longestPartial;
          this.recoveredPartials.push(longestPartial);
        }
      } else if (latestPartial && latestPartial.length > finalTextToUse.length && timeSinceLatest < 5000) {
        const latestTrimmed = latestPartial.trim();
        const finalTrimmed2 = finalTextToUse.trim();
        const finalNormalized2 = finalTrimmed2.replace(/\s+/g, ' ').toLowerCase();
        const latestNormalized2 = latestTrimmed.replace(/\s+/g, ' ').toLowerCase();
        const extendsFinal2 = latestNormalized2.startsWith(finalNormalized2);
        
        if (extendsFinal2) {
          console.log(`[MockHandler] ⚠️ Using LATEST partial (after timeout)`);
          finalTextToUse2 = latestPartial;
          this.recoveredPartials.push(latestPartial);
        }
      }
      
      // Process final
      this.processedFinals.push(finalTextToUse2);
      this.sentFinals.push(finalTextToUse2);
      
      // CRITICAL: Reset partial tracking AFTER final is sent (line 992)
      this.partialTracker.reset();
      console.log('[MockHandler] 🧹 Reset partial tracking after final sent');
      
    } finally {
      this.isProcessingFinal = false;
    }
  }

  // Check if partials that should have been included were dropped
  checkDroppedPartials(expectedPartials, expectedInFinal) {
    const processedText = this.processedFinals.join(' ');
    const dropped = [];
    
    for (const partial of expectedPartials) {
      // Check if partial should be in final
      if (expectedInFinal && expectedInFinal.includes(partial)) {
        // This partial should be in the final
        const wasInFinal = this.processedFinals.some(final => {
          const normalizedFinal = final.replace(/\s+/g, ' ').toLowerCase();
          const normalizedPartial = partial.replace(/\s+/g, ' ').toLowerCase();
          return normalizedFinal.includes(normalizedPartial) || 
                 normalizedPartial.startsWith(normalizedFinal.substring(0, Math.min(normalizedFinal.length, normalizedPartial.length)));
        });
        
        const wasRecovered = this.recoveredPartials.some(recovered => {
          const normalizedRecovered = recovered.replace(/\s+/g, ' ').toLowerCase();
          const normalizedPartial = partial.replace(/\s+/g, ' ').toLowerCase();
          return normalizedRecovered.includes(normalizedPartial);
        });
        
        if (!wasInFinal && !wasRecovered) {
          dropped.push(partial);
        }
      }
    }
    
    return dropped;
  }
}

// TEST CASE 1: Partials arriving after timeout check but before reset
// Scenario: Partial arrives after the timeout check completes but before reset() is called
test('Test 1: Partials arriving after timeout check but before reset get dropped', async () => {
  const handler = new RealisticHostModePartialHandler();
  const expectedPartials = [];
  
  // Initial partials
  handler.handlePartial("And you know what our people");
  expectedPartials.push("And you know what our people");
  
  // Final arrives - snapshot taken
  const final = "And you know what our people are going to do? Well";
  const finalPromise = handler.handleFinal(final, 500); // Short wait
  
  // Partial arrives DURING timeout wait (should be caught by live check)
  setTimeout(() => {
    handler.handlePartial("And you know what our people are going to do? Well, let's pray");
    expectedPartials.push("And you know what our people are going to do? Well, let's pray");
  }, 200);
  
  // CRITICAL: Partial arrives AFTER timeout check but BEFORE reset
  // This is the race condition - partial arrives after line 2331 check but before line 992 reset
  setTimeout(() => {
    const latePartial = "And you know what our people are going to do? Well, let's pray right now and outside";
    handler.handlePartial(latePartial);
    expectedPartials.push(latePartial);
    console.log(`[Test] ⏰ Late partial arrived: "${latePartial}"`);
  }, 600); // After timeout (500ms) but before reset
  
  await finalPromise;
  
  // Wait a bit to allow late partial to arrive
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // Check if late partial was included
  const latePartial = "And you know what our people are going to do? Well, let's pray right now and outside";
  const wasInFinal = handler.processedFinals.some(f => f.includes("pray right now and outside"));
  const wasRecovered = handler.recoveredPartials.some(p => p.includes("pray right now and outside"));
  
  // FAILING TEST: This should fail because partial arriving after timeout check is dropped
  if (!wasInFinal && !wasRecovered) {
    throw new Error(`Late partial was dropped (arrived after timeout check but before reset): "${latePartial}"`);
  }
});

// TEST CASE 2: Partials overwriting during rapid updates - shorter overwrites longer
// Scenario: During high load, updatePartial might overwrite longer with shorter if not careful
test('Test 2: Rapid partials - shorter partials should not overwrite longer ones', async () => {
  const handler = new RealisticHostModePartialHandler();
  
  // Long partial first
  const longPartial = "And you know what our people are going to do? Well, let's pray right now and outside the taco stand";
  handler.handlePartial(longPartial);
  
  // Verify longest is tracked
  let longest = handler.partialTracker.getLongestPartial();
  if (longest !== longPartial) {
    throw new Error(`Longest not tracked. Expected: "${longPartial}", Got: "${longest}"`);
  }
  
  // Rapid shorter partials
  handler.handlePartial("let's pray right now");
  handler.handlePartial("right now");
  handler.handlePartial("now");
  
  // Verify longest is STILL the long one
  longest = handler.partialTracker.getLongestPartial();
  
  // This should pass (PartialTracker handles this correctly)
  if (longest !== longPartial) {
    throw new Error(`Longest was overwritten by shorter. Expected: "${longPartial}", Got: "${longest}"`);
  }
});

// TEST CASE 3: Real scenario from terminal - segment with opening phrase dropped
// Scenario: Final sent without opening phrase, but partials had it
test('Test 3: Real scenario - opening phrase dropped from final', async () => {
  const handler = new RealisticHostModePartialHandler();
  const allPartials = [];
  
  // Partials with opening phrase
  handler.handlePartial("And you know what our people are going to do? Well");
  allPartials.push("And you know what our people are going to do? Well");
  
  handler.handlePartial("And you know what our people are going to do? Well, let's pray right now");
  allPartials.push("And you know what our people are going to do? Well, let's pray right now");
  
  // Final arrives WITHOUT opening phrase (as shown in terminal output line 6128)
  const final = ", let's pray right now and outside the taco stand, they start holding hands and they start praying, or someone says my mother's. someone says, my mother's having surgery. This week all";
  
  // Simulate processing with delay (grammar correction)
  await new Promise(resolve => setTimeout(resolve, 100)); // Simulate async delay
  await handler.handleFinal(final, 1000);
  
  // Check if opening phrase was recovered
  const openingPhrase = "And you know what our people are going to do? Well";
  const finalIncludesOpening = handler.processedFinals.some(f => f.includes(openingPhrase));
  const recoveredIncludesOpening = handler.recoveredPartials.some(p => p.includes(openingPhrase));
  
  // FAILING TEST: The final doesn't start with the opening phrase, so extension check fails
  // The partial doesn't extend the final because final starts with ", let's pray"
  // and partial starts with "And you know what..."
  if (!finalIncludesOpening && !recoveredIncludesOpening) {
    // This is expected to fail because the final doesn't extend from the partial
    // The real issue is that the partial should have been merged/used BEFORE final arrived
    throw new Error(`Opening phrase was dropped. Final starts with "${final.substring(0, 30)}..." but should include "${openingPhrase}"`);
  }
});

// TEST CASE 4: Partials building up during fast speech - multiple extending partials
// Scenario: Multiple partials extend a final, but only some are caught
test('Test 4: Multiple extending partials - all should be included', async () => {
  const handler = new RealisticHostModePartialHandler();
  const extendingPartials = [];
  
  // Final arrives
  const final = "And you know what our people are going to do? Well";
  const finalPromise = handler.handleFinal(final, 800);
  
  // Multiple extending partials arrive during timeout
  setTimeout(() => {
    const p1 = "And you know what our people are going to do? Well, let's pray";
    handler.handlePartial(p1);
    extendingPartials.push(p1);
  }, 200);
  
  setTimeout(() => {
    const p2 = "And you know what our people are going to do? Well, let's pray right now";
    handler.handlePartial(p2);
    extendingPartials.push(p2);
  }, 400);
  
  setTimeout(() => {
    const p3 = "And you know what our people are going to do? Well, let's pray right now and outside";
    handler.handlePartial(p3);
    extendingPartials.push(p3);
  }, 600);
  
  await finalPromise;
  
  // Check if longest extending partial was included
  const longestExtending = "And you know what our people are going to do? Well, let's pray right now and outside";
  const wasIncluded = handler.processedFinals.some(f => f.includes("pray right now and outside"));
  
  // FAILING TEST: Should include the longest extending partial
  if (!wasIncluded) {
    throw new Error(`Longest extending partial was not included: "${longestExtending}"`);
  }
});

// TEST CASE 5: Partials arriving during async processing (simulated)
// Scenario: Partials arrive while final is being processed (grammar correction, translation)
test('Test 5: Partials arriving during async final processing', async () => {
  const handler = new RealisticHostModePartialHandler();
  
  // Final arrives
  const final = "And you know what our people are going to do? Well";
  
  // Start processing (snapshot taken)
  const processPromise = (async () => {
    // Snapshot
    const snapshot = handler.partialTracker.getSnapshot();
    
    // Simulate async processing (grammar correction takes time)
    await new Promise(resolve => setTimeout(resolve, 600));
    
    // Partials arrive DURING async processing
    handler.handlePartial("And you know what our people are going to do? Well, let's pray");
    handler.handlePartial("And you know what our people are going to do? Well, let's pray right now");
    
    // After async processing, we need to check partials again
    // But in the real code, the timeout check might have already happened
    // So we simulate checking partials after async work
    const longestPartial = handler.partialTracker.getLongestPartial();
    let finalText = final;
    
    if (longestPartial && longestPartial.length > final.length) {
      const longestTrimmed = longestPartial.trim();
      const finalTrimmed = final.trim();
      if (longestTrimmed.startsWith(finalTrimmed)) {
        finalText = longestPartial;
        handler.recoveredPartials.push(longestPartial);
      }
    }
    
    handler.processedFinals.push(finalText);
    handler.partialTracker.reset();
  })();
  
  await processPromise;
  
  // Check if extending partial was included
  const extendingPartial = "And you know what our people are going to do? Well, let's pray right now";
  const wasIncluded = handler.processedFinals.some(f => f.includes("pray right now"));
  
  // FAILING TEST: If async processing doesn't check partials again, this will fail
  if (!wasIncluded) {
    throw new Error(`Partial arriving during async processing was not included: "${extendingPartial}"`);
  }
});

// TEST CASE 6: Built-up partials - longest gets lost when final arrives early
// Scenario: Long partial exists, but final arrives before timeout can use it
test('Test 6: Built-up partials - longest partial should be used', async () => {
  const handler = new RealisticHostModePartialHandler();
  
  // Long partial builds up
  const longPartial = "And you know what our people are going to do? Well, let's pray right now and outside the taco stand, they start holding hands";
  handler.handlePartial(longPartial);
  
  // Final arrives immediately (shorter than partial)
  const final = "And you know what our people are going to do? Well";
  
  await handler.handleFinal(final, 1000);
  
  // Check if long partial was used
  const wasIncluded = handler.processedFinals.some(f => f.includes("they start holding hands"));
  const wasRecovered = handler.recoveredPartials.some(p => p.includes("they start holding hands"));
  
  // FAILING TEST: Long partial should be used instead of short final
  if (!wasIncluded && !wasRecovered) {
    throw new Error(`Long partial was not used. Long: "${longPartial.substring(0, 50)}...", Final: "${final}"`);
  }
});

// TEST CASE 7: Partials that don't extend (different segment) should not overwrite
// Scenario: New segment partial arrives, should not interfere with pending final's partials
test('Test 7: New segment partial should not interfere with pending final', async () => {
  const handler = new RealisticHostModePartialHandler();
  
  // Partial for current segment
  handler.handlePartial("And you know what our people are going to do? Well, let's pray");
  
  // Final arrives
  const final = "And you know what our people are going to do? Well";
  const finalPromise = handler.handleFinal(final, 1000);
  
  // New segment partial arrives (doesn't extend the final)
  setTimeout(() => {
    handler.handlePartial("The weather is nice today");
  }, 300);
  
  await finalPromise;
  
  // Check if extending partial was still used (not overwritten by new segment)
  const extendingPartial = "And you know what our people are going to do? Well, let's pray";
  const wasIncluded = handler.processedFinals.some(f => f.includes("let's pray"));
  
  // This should pass - new segment partial shouldn't interfere
  if (!wasIncluded) {
    throw new Error(`Extending partial was lost when new segment partial arrived`);
  }
});

// Summary
console.log('\n' + '='.repeat(70));
console.log(`\n📊 Test Summary:`);
console.log(`   Total: ${totalTests}`);
console.log(`   ✅ Passed: ${passedTests}`);
console.log(`   ❌ Failed: ${failedTests}`);

if (failedTests > 0) {
  console.log(`\n❌ Failed Tests:`);
  testDetails
    .filter(t => t.status === 'FAILED')
    .forEach(t => {
      console.log(`   - ${t.name}`);
      console.log(`     Error: ${t.error}`);
    });
  
  console.log(`\n💡 These failing tests identify the exact scenarios where partials get dropped.`);
  console.log(`   Fix the implementation to make these tests pass.`);
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed!`);
  console.log(`\n⚠️  Note: If all tests pass, the mock may not accurately simulate the real failure scenarios.`);
  console.log(`   Review the actual code to identify race conditions.`);
  process.exit(0);
}
