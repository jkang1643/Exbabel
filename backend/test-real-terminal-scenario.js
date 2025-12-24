/**
 * Test: Real Terminal Scenario - Opening Phrase Dropped
 * 
 * Based on terminal output lines 6128-6132:
 * - Final sent: ", let's pray right now and outside the taco stand..."
 * - Grammar corrected: "And you know what our people are going to do? Well, let's pray right now..."
 * 
 * This shows the opening phrase "And you know what our people are going to do? Well" was dropped.
 * 
 * Run with: node backend/test-real-terminal-scenario.js
 */

import { PartialTracker } from '../core/engine/partialTracker.js';

console.log('🧪 Test: Real Terminal Scenario - Opening Phrase Dropped\n');
console.log('='.repeat(70));

let failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.log(`❌ ${name}: ${error.message}`);
    failures.push({ name, error: error.message });
  }
}

// Simulate the exact scenario
class TerminalScenarioSimulator {
  constructor() {
    this.partialTracker = new PartialTracker();
    this.sentFinals = [];
    this.finalTexts = [];
  }

  handlePartial(text) {
    this.partialTracker.updatePartial(text);
  }

  // Simulate the exact flow from hostModeHandler.js
  async handleFinal(transcriptText, waitTimeMs = 1000) {
    // Line 2167-2172: Take snapshot
    const partialSnapshot = this.partialTracker.getSnapshot();
    const longestPartialSnapshot = partialSnapshot.longest;
    
    console.log(`[Simulator] 📸 SNAPSHOT taken: longest=${longestPartialSnapshot?.length || 0} chars`);
    if (longestPartialSnapshot) {
      console.log(`[Simulator]   Snapshot longest: "${longestPartialSnapshot.substring(0, 60)}..."`);
    }
    console.log(`[Simulator]   Final received: "${transcriptText.substring(0, 60)}..."`);
    
    // Line 2211-2264: Check snapshot for extending partials
    let finalTextToUse = transcriptText;
    const finalTrimmed = transcriptText.trim();
    
    if (longestPartialSnapshot && longestPartialSnapshot.length > transcriptText.length) {
      const longestTrimmed = longestPartialSnapshot.trim();
      const finalNormalized = finalTrimmed.replace(/\s+/g, ' ').toLowerCase();
      const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
      
      // This is the CRITICAL check - does longest start with final?
      const extendsFinal = longestNormalized.startsWith(finalNormalized);
      
      console.log(`[Simulator]   Checking if longest extends final:`);
      console.log(`[Simulator]     finalNormalized: "${finalNormalized.substring(0, 50)}..."`);
      console.log(`[Simulator]     longestNormalized: "${longestNormalized.substring(0, 50)}..."`);
      console.log(`[Simulator]     startsWith check: ${extendsFinal}`);
      
      if (extendsFinal) {
        finalTextToUse = longestPartialSnapshot;
        console.log(`[Simulator]   ✅ Using longest partial`);
      } else {
        // Try overlap merge
        const merged = this.partialTracker.mergeWithOverlap(finalTrimmed, longestTrimmed);
        if (merged && merged.length > finalTrimmed.length + 3) {
          console.log(`[Simulator]   ✅ Using merged text via overlap`);
          finalTextToUse = merged;
        } else {
          console.log(`[Simulator]   ❌ No extension or overlap - using final as-is`);
        }
      }
    }
    
    // Wait (simulate timeout)
    await new Promise(resolve => setTimeout(resolve, waitTimeMs));
    
    // Line 2287-2331: Check LIVE values after timeout
    const longestPartial = this.partialTracker.getLongestPartial();
    const longestPartialTime = this.partialTracker.getLongestPartialTime();
    const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
    
    console.log(`[Simulator]   After timeout - checking LIVE values:`);
    console.log(`[Simulator]     longest=${longestPartial?.length || 0} chars, age=${timeSinceLongest}ms`);
    
    if (longestPartial && longestPartial.length > finalTextToUse.length && timeSinceLongest < 10000) {
      const longestTrimmed2 = longestPartial.trim();
      const finalTrimmed2 = finalTextToUse.trim();
      const finalNormalized2 = finalTrimmed2.replace(/\s+/g, ' ').toLowerCase();
      const longestNormalized2 = longestTrimmed2.replace(/\s+/g, ' ').toLowerCase();
      const extendsFinal2 = longestNormalized2.startsWith(finalNormalized2);
      
      if (extendsFinal2) {
        console.log(`[Simulator]   ✅ Using LIVE longest partial`);
        finalTextToUse = longestPartial;
      } else {
        const merged = this.partialTracker.mergeWithOverlap(finalTrimmed2, longestTrimmed2);
        if (merged && merged.length > finalTrimmed2.length + 3) {
          console.log(`[Simulator]   ✅ Using LIVE merged text via overlap`);
          finalTextToUse = merged;
        }
      }
    }
    
    // Store what was sent
    this.sentFinals.push(finalTextToUse);
    this.finalTexts.push(finalTextToUse);
    
    console.log(`[Simulator] 📤 Final sent: "${finalTextToUse.substring(0, 80)}..."`);
    
    // Reset (line 992)
    this.partialTracker.reset();
  }
}

// TEST: Real terminal scenario
test('Real scenario: Opening phrase dropped when final starts with comma', async () => {
  const simulator = new TerminalScenarioSimulator();
  
  // Partials arrive with opening phrase (this is what should be in final)
  simulator.handlePartial("And you know what our people are going to do? Well");
  simulator.handlePartial("And you know what our people are going to do? Well, let's pray right now");
  
  // Final arrives WITHOUT opening phrase (starts with comma - this is the problem)
  const final = ", let's pray right now and outside the taco stand, they start holding hands and they start praying, or someone says my mother's. someone says, my mother's having surgery. This week all";
  
  await simulator.handleFinal(final, 1000);
  
  // Check if opening phrase was included
  const sentFinal = simulator.sentFinals[0];
  const openingPhrase = "And you know what our people are going to do? Well";
  const includesOpening = sentFinal.includes(openingPhrase);
  
  // This WILL FAIL - the final starts with comma, not "And", so startsWith check fails
  // and mergeWithOverlap might also fail because there's no overlap
  if (!includesOpening) {
    throw new Error(
      `Opening phrase was dropped!\n` +
      `  Expected: "${openingPhrase}..."\n` +
      `  Got: "${sentFinal.substring(0, 80)}..."\n` +
      `  Reason: Final starts with comma (", let's pray...") so it doesn't start with partial ("And you know...")`
    );
  }
});

// TEST: Same scenario but with overlap that should work
test('Real scenario: Should merge using overlap detection', async () => {
  const simulator = new TerminalScenarioSimulator();
  
  // Partials
  simulator.handlePartial("And you know what our people are going to do? Well");
  simulator.handlePartial("And you know what our people are going to do? Well, let's pray right now");
  
  // Final (starts with comma)
  const final = ", let's pray right now and outside the taco stand";
  
  await simulator.handleFinal(final, 1000);
  
  const sentFinal = simulator.sentFinals[0];
  const openingPhrase = "And you know what our people are going to do? Well";
  const includesOpening = sentFinal.includes(openingPhrase);
  
  // This should work if overlap detection is working
  // The overlap is: "let's pray right now"
  if (!includesOpening) {
    throw new Error(`Opening phrase should be merged via overlap detection`);
  }
});

// Summary
console.log('\n' + '='.repeat(70));
console.log(`\n📊 Test Summary:`);
console.log(`   ✅ Passed: ${2 - failures.length}`);
console.log(`   ❌ Failed: ${failures.length}`);

if (failures.length > 0) {
  console.log(`\n❌ Failed Tests:`);
  failures.forEach(f => {
    console.log(`\n   - ${f.name}`);
    console.log(`     ${f.error}`);
  });
  
  console.log(`\n💡 These tests identify the exact failure scenario from the terminal output.`);
  console.log(`   The issue is that when final starts with comma, it doesn't extend from partials.`);
  console.log(`   The overlap detection should catch this, but it might not be working correctly.`);
  process.exit(1);
} else {
  console.log(`\n✅ All tests passed!`);
  process.exit(0);
}

