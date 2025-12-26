/**
 * Test: Final Fragment Duplication
 * 
 * This test exposes the bug where short final fragments are committed
 * even when longer partials exist or arrive later, causing duplication.
 * 
 * Scenario:
 * 1. Short final arrives: "Oh yeah."
 * 2. Longer partial exists or arrives: "Oh yeah. I've been to the grocery store..."
 * 3. Both get committed → DUPLICATION
 * 
 * Expected: Only the longer version should be committed
 * 
 * Run with: node backend/test-final-fragment-duplication.js
 */

// Mock the partial tracker
class MockPartialTracker {
  constructor() {
    this.longest = '';
    this.latest = '';
    this.longestTime = 0;
    this.latestTime = 0;
  }

  updatePartial(text) {
    if (!this.longest || text.length > this.longest.length) {
      this.longest = text;
      this.longestTime = Date.now();
    }
    this.latest = text;
    this.latestTime = Date.now();
  }

  getSnapshot() {
    return {
      longest: this.longest,
      latest: this.latest,
      longestTime: this.longestTime,
      latestTime: this.latestTime
    };
  }

  reset() {
    this.longest = '';
    this.latest = '';
    this.longestTime = 0;
    this.latestTime = 0;
  }
}

// Simulate the final processing logic
class FinalProcessor {
  constructor(partialTracker) {
    this.partialTracker = partialTracker;
    this.committedFinals = [];
    this.lastSentFinalText = '';
    this.lastSentFinalTime = 0;
  }

  // Simulate the check that should happen BEFORE processing a final
  shouldSkipFinal(transcriptText) {
    const partialSnapshot = this.partialTracker.getSnapshot();
    const currentLongestPartial = partialSnapshot.longest || '';
    const currentLatestPartial = partialSnapshot.latest || '';
    
    const incomingFinalTrimmed = transcriptText.trim();
    const incomingFinalNormalized = incomingFinalTrimmed.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
    
    // Check longest partial
    if (currentLongestPartial && currentLongestPartial.trim().length > incomingFinalTrimmed.length) {
      const longestTrimmed = currentLongestPartial.trim();
      const longestNormalized = longestTrimmed.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
      
      if (longestNormalized.startsWith(incomingFinalNormalized) || 
          (incomingFinalNormalized.length > 10 && longestNormalized.includes(incomingFinalNormalized))) {
        return true; // Skip - fragment is contained in longer partial
      }
    }
    
    // Check latest partial
    if (currentLatestPartial && currentLatestPartial.trim().length > incomingFinalTrimmed.length) {
      const latestTrimmed = currentLatestPartial.trim();
      const latestNormalized = latestTrimmed.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
      
      if (latestNormalized.startsWith(incomingFinalNormalized) || 
          (incomingFinalNormalized.length > 10 && latestNormalized.includes(incomingFinalNormalized))) {
        return true; // Skip - fragment is contained in longer partial
      }
    }
    
    return false; // Don't skip
  }

  // Simulate processing a final
  processFinal(transcriptText, options = {}) {
    // CRITICAL: Check if we should skip this final BEFORE processing
    // Use word-by-word comparison to handle punctuation differences
    const isForcedFinal = !!options.forceFinal;
    const finalWords = transcriptText.trim().toLowerCase().replace(/[.,!?;:…]/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/).filter(w => w.length > 0);
    
    if (this.partialTracker.longest && finalWords.length > 0) {
      const longestPartial = this.partialTracker.longest.trim();
      const longestWords = longestPartial.toLowerCase().replace(/[.,!?;:…]/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/).filter(w => w.length > 0);
      
      if (longestPartial.length >= transcriptText.length) {
        // Helper function to check if words match (fuzzy matching)
        const wordsMatch = (word1, word2) => {
          if (word1 === word2) return true;
          if (word1.length > 3 && word2.length > 3 && 
              (word1.startsWith(word2.substring(0, Math.min(4, word1.length))) ||
               word2.startsWith(word1.substring(0, Math.min(4, word2.length))))) {
            return true;
          }
          if (word1.length <= 3 && word2.length <= 3 && word1 === word2) {
            return true;
          }
          return false;
        };
        
        // Check 1: If first N words match (where N = number of words in final)
        let matchingWordsAtStart = 0;
        for (let i = 0; i < finalWords.length && i < longestWords.length; i++) {
          if (wordsMatch(finalWords[i], longestWords[i])) {
            matchingWordsAtStart++;
          }
        }
        const startMatchRatio = matchingWordsAtStart / finalWords.length;
        
        // Check 2: If all final words appear in partial (in any order)
        let matchingWordsAnywhere = 0;
        for (const finalWord of finalWords) {
          for (const partialWord of longestWords) {
            if (wordsMatch(finalWord, partialWord)) {
              matchingWordsAnywhere++;
              break;
            }
          }
        }
        const containsAllRatio = matchingWordsAnywhere / finalWords.length;
        const lengthDiff = longestPartial.length - transcriptText.length;
        
        // Special case: For very short finals (2-3 words) and very long partials (50+ chars longer),
        // skip if at least 50% of words match (catches "Saying, second." when partial has "saying")
        if (finalWords.length <= 3 && lengthDiff > 50 && containsAllRatio >= 0.5) {
          const isSignificantlyLonger = longestPartial.length > transcriptText.length + 20;
          if (!isForcedFinal || isSignificantlyLonger) {
            console.log(`[Test] ⏸️ SKIPPING FINAL FRAGMENT: "${transcriptText.substring(0, 50)}..."`);
            console.log(`[Test]   Partial contains words: "${longestPartial.substring(0, 50)}..."`);
            console.log(`[Test]   Contains all ratio: ${(containsAllRatio * 100).toFixed(0)}% (${matchingWordsAnywhere}/${finalWords.length} words), length diff: ${lengthDiff}`);
            return { skipped: true, reason: 'fragment_contained_in_partial' };
          }
        }
        
        // Normal case: Skip if partial starts with final words OR contains all words
        if (startMatchRatio >= 0.8 || (containsAllRatio >= 0.9 && lengthDiff > 10) || (containsAllRatio >= 0.8 && lengthDiff > 50)) {
          const isSignificantlyLonger = longestPartial.length > transcriptText.length + 20;
          if (!isForcedFinal || isSignificantlyLonger) {
            console.log(`[Test] ⏸️ SKIPPING FINAL FRAGMENT: "${transcriptText.substring(0, 50)}..."`);
            console.log(`[Test]   Partial contains same words: "${longestPartial.substring(0, 50)}..."`);
            console.log(`[Test]   Start match: ${(startMatchRatio * 100).toFixed(0)}%, Contains all: ${(containsAllRatio * 100).toFixed(0)}%`);
            return { skipped: true, reason: 'fragment_contained_in_partial' };
          }
        }
      }
    }
    
    // Fallback to old check
    if (this.shouldSkipFinal(transcriptText)) {
      console.log(`[Test] ⏸️ SKIPPING FINAL FRAGMENT: "${transcriptText.substring(0, 50)}..."`);
      return { skipped: true, reason: 'fragment_contained_in_partial' };
    }

    // Check deduplication against last sent
    const trimmedText = transcriptText.trim();
    const textNormalized = trimmedText.replace(/\s+/g, ' ').toLowerCase();
    const lastSentNormalized = this.lastSentFinalText.replace(/\s+/g, ' ').toLowerCase();
    const timeSinceLastFinal = Date.now() - this.lastSentFinalTime;

    // CRITICAL: Check if new text is shorter and contained in last sent - skip the new (shorter) one
    // OR if new text is longer and contains the old one, we should skip it to prevent duplication
    // (since we can't "unsend" the shorter one that was already committed)
    if (this.lastSentFinalText && timeSinceLastFinal < 5000) {
      // Normalize both for comparison (remove punctuation)
      const textNormalizedForComparison = textNormalized.replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
      const lastSentNormalizedForComparison = lastSentNormalized.replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
      
      // Case 1: New text is shorter and contained in last sent - skip the new (shorter) one
      if (lastSentNormalizedForComparison.length > textNormalizedForComparison.length && 
          (lastSentNormalizedForComparison.startsWith(textNormalizedForComparison) || 
           (textNormalizedForComparison.length > 10 && lastSentNormalizedForComparison.includes(textNormalizedForComparison)))) {
        console.log(`[Test] ⏭️ SKIPPING shorter final - longer version already committed`);
        console.log(`[Test]   Shorter: "${trimmedText.substring(0, 50)}..." (${textNormalizedForComparison.length} chars)`);
        console.log(`[Test]   Longer (already committed): "${this.lastSentFinalText.substring(0, 50)}..." (${lastSentNormalizedForComparison.length} chars)`);
        return { skipped: true, reason: 'shorter_than_last_sent' };
      }
      
      // Case 2: New text is longer and contains the old one - skip the longer one to prevent duplication
      // (since shorter one was already sent, we can't "unsend" it, so we must skip the longer one)
      if (textNormalizedForComparison.length > lastSentNormalizedForComparison.length && 
          (textNormalizedForComparison.startsWith(lastSentNormalizedForComparison) || 
           lastSentNormalizedForComparison.startsWith(textNormalizedForComparison.substring(0, Math.min(textNormalizedForComparison.length, lastSentNormalizedForComparison.length))))) {
        // Skip the longer one to prevent duplication (matches real code fix)
        console.log(`[Test] ⚠️ Duplicate final detected (longer version contains shorter already sent), skipping longer to prevent duplication`);
        console.log(`[Test]   Shorter (already sent): "${this.lastSentFinalText.substring(0, 50)}..." (${lastSentNormalizedForComparison.length} chars)`);
        console.log(`[Test]   Longer (new, skipping): "${trimmedText.substring(0, 50)}..." (${textNormalizedForComparison.length} chars)`);
        return { skipped: true, reason: 'longer_contains_shorter_already_sent' };
      }
    }

    // Commit the final
    this.committedFinals.push({
      text: trimmedText,
      timestamp: Date.now(),
      isForced: !!options.forceFinal
    });

    this.lastSentFinalText = trimmedText;
    this.lastSentFinalTime = Date.now();

    return { committed: true, text: trimmedText };
  }
}

// Test runner
function runTest(name, testFn) {
  try {
    testFn();
    console.log(`✅ ${name}`);
    return true;
  } catch (error) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
    return false;
  }
}

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

// Run tests
console.log('\n🧪 Running Final Fragment Duplication Tests...\n');
console.log('='.repeat(70));

// Test 1: Skip short final when longer partial exists
totalTests++;
console.log('\nTest 1: Skip short final when longer partial exists');
const tracker1 = new MockPartialTracker();
const proc1 = new FinalProcessor(tracker1);
tracker1.updatePartial("Oh yeah. I've been to the grocery store, so we're friendlier than they.");
const result1 = proc1.processFinal("Oh yeah.");
if (result1.skipped && result1.reason === 'fragment_contained_in_partial' && proc1.committedFinals.length === 0) {
  passedTests++;
  console.log('✅ PASS');
} else {
  failedTests++;
  console.log('❌ FAIL');
  console.log(`   Expected: skipped=true, reason='fragment_contained_in_partial', committedFinals.length=0`);
  console.log(`   Got: skipped=${result1.skipped}, reason=${result1.reason}, committedFinals.length=${proc1.committedFinals.length}`);
}

// Test 2: Skip shorter final when longer partial exists (THE BUG)
totalTests++;
console.log('\nTest 2: Skip shorter final when longer partial exists (exposes duplication bug)');
const tracker2 = new MockPartialTracker();
const proc2 = new FinalProcessor(tracker2);
// Simulate a longer partial arriving first (this is the real scenario)
console.log(`   Step 1: Longer partial arrives: "Oh yeah. I've been to the grocery store, so we're friendlier than they."`);
tracker2.updatePartial("Oh yeah. I've been to the grocery store, so we're friendlier than they.");
// Short final arrives (should be skipped because partial starts with it)
console.log(`   Step 2: Short final arrives: "Oh yeah."`);
const result2 = proc2.processFinal("Oh yeah.");
console.log(`   After short final: ${proc2.committedFinals.length} final(s) committed`);
if (proc2.committedFinals.length === 0) {
  passedTests++;
  console.log('✅ PASS');
} else {
  failedTests++;
  console.log('❌ FAIL - THIS IS THE BUG!');
  console.log(`   Expected: 0 finals (shorter final should be skipped because partial starts with it)`);
  console.log(`   Got: ${proc2.committedFinals.length} final(s)`);
  proc2.committedFinals.forEach((f, i) => {
    console.log(`     Final ${i + 1}: "${f.text.substring(0, 60)}..." (${f.text.length} chars)`);
  });
  console.log(`   Bug: The shorter final should have been skipped because partial starts with it!`);
}

// Test 3: Skip short final when longer partial exists (regular final)
totalTests++;
console.log('\nTest 3: Skip short final when longer partial exists (regular final)');
const tracker3 = new MockPartialTracker();
const proc3 = new FinalProcessor(tracker3);
tracker3.updatePartial("Earlier than them. I've been to cage fight matches. No, I haven't.");
const result3 = proc3.processFinal("Earlier than them. I've been to cage.");
if (result3.skipped && result3.reason === 'fragment_contained_in_partial' && proc3.committedFinals.length === 0) {
  passedTests++;
  console.log('✅ PASS');
} else {
  failedTests++;
  console.log('❌ FAIL');
}

// Test 4: Handle forced final fragment duplication (THE BUG)
totalTests++;
console.log('\nTest 4: Handle forced final fragment duplication (exposes bug)');
const tracker4 = new MockPartialTracker();
const proc4 = new FinalProcessor(tracker4);
// Simulate a longer partial arriving first (this is the real scenario)
console.log(`   Step 1: Longer partial arrives: "Earlier than them. I've been to cage fight matches. No, I haven't."`);
tracker4.updatePartial("Earlier than them. I've been to cage fight matches. No, I haven't.");
// Short forced final arrives (should be skipped because partial starts with it)
console.log(`   Step 2: Short forced final arrives: "Earlier than them. I've been to cage."`);
const result4a = proc4.processFinal("Earlier than them. I've been to cage.", { forceFinal: true });
console.log(`   After short final: ${proc4.committedFinals.length} final(s) committed`);
// Longer forced final arrives (from recovery or extension)
console.log(`   Step 3: Longer forced final arrives: "Earlier than them. I've been to cage fight matches. No, I haven't."`);
const result4b = proc4.processFinal("Earlier than them. I've been to cage fight matches. No, I haven't.", { forceFinal: true });
console.log(`   After longer final: ${proc4.committedFinals.length} final(s) committed`);
if (proc4.committedFinals.length === 1 && 
    proc4.committedFinals[0].text === "Earlier than them. I've been to cage fight matches. No, I haven't.") {
  passedTests++;
  console.log('✅ PASS');
} else {
  failedTests++;
  console.log('❌ FAIL - FORCED FINAL DUPLICATION BUG!');
  console.log(`   Expected: 1 final with longer text`);
  console.log(`   Got: ${proc4.committedFinals.length} final(s)`);
  proc4.committedFinals.forEach((f, i) => {
    console.log(`     Final ${i + 1}: "${f.text.substring(0, 60)}..." (${f.text.length} chars)`);
  });
  console.log(`   Bug: The shorter final should have been skipped because partial starts with it, but both are committed!`);
}

// Test 5: Real-world scenario - "Desires cordoned off" fragment
totalTests++;
console.log('\nTest 5: Real-world scenario - "Desires cordoned off" fragment');
const tracker5 = new MockPartialTracker();
const proc5 = new FinalProcessor(tracker5);
// Simulate a longer partial arriving first
console.log(`   Step 1: Longer partial arrives: "Desires cordoned off from others. In private fortresses, we call home biblical Hospitality chooses to engage rather than unplug"`);
tracker5.updatePartial("Desires cordoned off from others. In private fortresses, we call home biblical Hospitality chooses to engage rather than unplug");
// Short final fragment arrives (should be skipped because partial starts with it)
console.log(`   Step 2: Short final fragment arrives: "Desires cordoned off"`);
const result5 = proc5.processFinal("Desires cordoned off");
console.log(`   After short final: ${proc5.committedFinals.length} final(s) committed`);
if (proc5.committedFinals.length === 0) {
  passedTests++;
  console.log('✅ PASS');
} else {
  failedTests++;
  console.log('❌ FAIL - FRAGMENT DUPLICATION BUG!');
  console.log(`   Expected: 0 finals (shorter final should be skipped because partial starts with it)`);
  console.log(`   Got: ${proc5.committedFinals.length} final(s)`);
  proc5.committedFinals.forEach((f, i) => {
    console.log(`     Final ${i + 1}: "${f.text.substring(0, 60)}..." (${f.text.length} chars)`);
  });
  console.log(`   Bug: The shorter final should have been skipped because partial starts with it!`);
}

// Test 6: Real-world scenario - "I've been decades. Fight matches." fragment
totalTests++;
console.log('\nTest 6: Real-world scenario - "I\'ve been decades. Fight matches." fragment');
const tracker6 = new MockPartialTracker();
const proc6 = new FinalProcessor(tracker6);
// Simulate a longer partial arriving first
console.log(`   Step 1: Longer partial arrives: "I've been decades fighting matches. I know I haven't."`);
tracker6.updatePartial("I've been decades fighting matches. I know I haven't.");
// Short final fragment arrives with punctuation differences (should be skipped)
console.log(`   Step 2: Short final fragment arrives: "I've been decades. Fight matches."`);
const result6 = proc6.processFinal("I've been decades. Fight matches.");
console.log(`   After short final: ${proc6.committedFinals.length} final(s) committed`);
if (proc6.committedFinals.length === 0) {
  passedTests++;
  console.log('✅ PASS');
} else {
  failedTests++;
  console.log('❌ FAIL - FRAGMENT DUPLICATION BUG!');
  console.log(`   Expected: 0 finals (shorter final should be skipped because partial contains same words)`);
  console.log(`   Got: ${proc6.committedFinals.length} final(s)`);
  proc6.committedFinals.forEach((f, i) => {
    console.log(`     Final ${i + 1}: "${f.text.substring(0, 60)}..." (${f.text.length} chars)`);
  });
  console.log(`   Bug: The shorter final should have been skipped because partial contains the same words!`);
}

// Test 7: Real-world scenario - "Saying, second." fragment
totalTests++;
console.log('\nTest 7: Real-world scenario - "Saying, second." fragment');
const tracker7 = new MockPartialTracker();
const proc7 = new FinalProcessor(tracker7);
// Simulate a longer partial that contains "saying" and "second" but in different order
console.log(`   Step 1: Longer partial arrives: "And you know what our people are going to do? Well, let's pray right now. Outside the taco stand, they start holding hands and they start praying. Someone says, 'My mother's having surgery this week. ' All we need is saying."`);
tracker7.updatePartial("And you know what our people are going to do? Well, let's pray right now. Outside the taco stand, they start holding hands and they start praying. Someone says, 'My mother's having surgery this week. ' All we need is saying.");
// Short final fragment arrives (should be skipped because partial contains "saying")
console.log(`   Step 2: Short final fragment arrives: "Saying, second."`);
const result7 = proc7.processFinal("Saying, second.");
console.log(`   After short final: ${proc7.committedFinals.length} final(s) committed`);
if (proc7.committedFinals.length === 0) {
  passedTests++;
  console.log('✅ PASS');
} else {
  failedTests++;
  console.log('❌ FAIL - FRAGMENT DUPLICATION BUG!');
  console.log(`   Expected: 0 finals (shorter final should be skipped because partial contains "saying")`);
  console.log(`   Got: ${proc7.committedFinals.length} final(s)`);
  proc7.committedFinals.forEach((f, i) => {
    console.log(`     Final ${i + 1}: "${f.text.substring(0, 60)}..." (${f.text.length} chars)`);
  });
  console.log(`   Bug: The shorter final should have been skipped because partial contains "saying"!`);
}

// Summary
console.log('\n' + '='.repeat(70));
console.log(`\n📊 Test Results: ${passedTests}/${totalTests} passed, ${failedTests} failed`);
if (failedTests > 0) {
  console.log('\n❌ TESTS FAILED - This exposes the duplication bug!');
  console.log('   The bug: Short fragments are being committed even when longer versions exist or arrive later.');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
  process.exit(0);
}

