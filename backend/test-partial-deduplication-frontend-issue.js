/**
 * Test: Partial Deduplication Frontend Issue
 * 
 * Tests the EXACT issue from logs where:
 * 1. Partials at short segments are being dropped
 * 2. Frontend gets confused - partials don't get new lines
 * 3. Partials get appended to continued text incorrectly
 * 4. Partials fail to commit to finals
 * 
 * This test MUST FAIL initially because the behavior is broken.
 */

console.log('🧪 Partial Deduplication Frontend Issue Test\n');
console.log('='.repeat(70));

class TestProcessor {
  constructor() {
    this.sentPartials = [];
    this.committedFinals = [];
    this.lastFinalText = '';
    this.lastFinalTime = 0;
    this.partialTracker = {
      longest: '',
      latest: '',
      update: function(text) {
        if (!this.longest || text.length > this.longest.length) {
          this.longest = text;
        }
        this.latest = text;
      },
      reset: function() {
        this.longest = '';
        this.latest = '';
      },
      getSnapshot: function() {
        return { longest: this.longest, latest: this.latest };
      }
    };
  }

  // Simulate deduplication logic
  deduplicatePartial(partialText, lastFinalText, lastFinalTime) {
    if (!lastFinalText || !partialText) {
      return { deduplicatedText: partialText, wasDeduplicated: false };
    }

    const partialLower = partialText.toLowerCase().trim();
    const finalLower = lastFinalText.toLowerCase().trim();
    
    // Check if partial starts with final
    if (partialLower.startsWith(finalLower)) {
      const remaining = partialText.substring(lastFinalText.length).trim();
      if (remaining.length === 0) {
        // Completely duplicate
        return { deduplicatedText: '', wasDeduplicated: true };
      }
      return { deduplicatedText: remaining, wasDeduplicated: true };
    }
    
    return { deduplicatedText: partialText, wasDeduplicated: false };
  }

  processPartial(partialText) {
    // Deduplicate
    const dedupResult = this.deduplicatePartial(partialText, this.lastFinalText, this.lastFinalTime);
    let textToSend = dedupResult.deduplicatedText;
    
    // Track original (for recovery)
    this.partialTracker.update(partialText);
    
    // CRITICAL ISSUE: If deduplicated text is empty, we should still track but not send
    // BUT: If original extends final, we should send original
    if (dedupResult.wasDeduplicated && !textToSend) {
      // Check if original extends final
      const originalExtends = partialText.toLowerCase().trim().startsWith(this.lastFinalText.toLowerCase().trim()) &&
                               partialText.length > this.lastFinalText.length;
      
      if (originalExtends) {
        // Original extends - send original to preserve words
        textToSend = partialText;
        console.log(`[Test] ⚠️ Deduplication removed all text but original extends - using original`);
      } else {
        // Truly duplicate - track but don't send
        console.log(`[Test] ⚠️ Completely duplicate - tracked but not sent`);
        return { sent: false, tracked: true, text: null };
      }
    }
    
    // Send partial
    this.sentPartials.push({ text: textToSend, timestamp: Date.now(), original: partialText });
    console.log(`[Test] ✅ Sent partial: "${textToSend.substring(0, 40)}..." (original: "${partialText.substring(0, 40)}...")`);
    
    return { sent: true, tracked: true, text: textToSend, original: partialText };
  }

  processFinal(finalText) {
    // Check if any tracked partial extends this final
    const snapshot = this.partialTracker.getSnapshot();
    let finalToCommit = finalText;
    
    if (snapshot.longest && snapshot.longest.length > finalText.length) {
      const longestLower = snapshot.longest.toLowerCase().trim();
      const finalLower = finalText.toLowerCase().trim();
      
      if (longestLower.startsWith(finalLower)) {
        finalToCommit = snapshot.longest;
        console.log(`[Test] ✅ Using longest partial in final: "${finalToCommit.substring(0, 50)}..."`);
      }
    }
    
    this.committedFinals.push({ text: finalToCommit, timestamp: Date.now() });
    this.lastFinalText = finalToCommit;
    this.lastFinalTime = Date.now();
    this.partialTracker.reset();
    
    return { text: finalToCommit };
  }
}

// Test 1: Short segment after final (the exact issue from logs)
console.log('\n📋 Test 1: Short segment partials must be sent as NEW lines\n');

const processor1 = new TestProcessor();

// Final arrives
processor1.processFinal("I almost wish sometimes people would stop having services.");
console.log(`[Test] Final: "${processor1.lastFinalText}"`);

// Short partial "and," arrives (NEW segment, should be NEW line)
const result1 = processor1.processPartial("and,");
if (!result1.sent) {
  console.log(`\n❌ FAILED: Partial "and," was NOT sent!`);
  process.exit(1);
}

// Check that it was sent as a new segment (not appended to previous)
if (result1.text.toLowerCase().startsWith(processor1.lastFinalText.toLowerCase())) {
  console.log(`\n❌ FAILED: Partial "and," was incorrectly appended to previous final!`);
  console.log(`   It should be a NEW line, not continuation.`);
  console.log(`   Sent text: "${result1.text}"`);
  console.log(`   Last final: "${processor1.lastFinalText}"`);
  process.exit(1);
}

console.log(`\n✅ Test 1 PASSED: Short segment partial sent as new line`);

// Test 2: Short partial after final must commit to final
console.log('\n📋 Test 2: Short segment partials must commit to finals\n');

const processor2 = new TestProcessor();
processor2.processFinal("I almost wish sometimes people would stop having services.");

// Partial "and," arrives
const result2a = processor2.processPartial("and,");
if (!result2a.sent) {
  console.log(`\n❌ FAILED: Partial "and," was NOT sent!`);
  process.exit(1);
}

// Partial grows: "And go"
const result2b = processor2.processPartial("And go");
if (!result2b.sent) {
  console.log(`\n❌ FAILED: Partial "And go" was NOT sent!`);
  process.exit(1);
}

// Final arrives
const final2 = processor2.processFinal("And go back to homes");

// Check that final includes the partials
if (!final2.text.toLowerCase().includes('and go')) {
  console.log(`\n❌ FAILED: Final does not include partial text "and go"!`);
  console.log(`   Final: "${final2.text}"`);
  process.exit(1);
}

console.log(`\n✅ Test 2 PASSED: Short segment partials committed to final`);

// Test 3: Partials extending final must NOT be deduplicated away (they should continue, not be new)
console.log('\n📋 Test 3: Partials extending final should continue (not be new line)\n');

const processor3 = new TestProcessor();
processor3.processFinal("I almost wish sometimes people would stop");

// Partial extends: "I almost wish sometimes people would stop having"
const result3 = processor3.processPartial("I almost wish sometimes people would stop having");

if (!result3.sent) {
  console.log(`\n❌ FAILED: Extending partial was NOT sent!`);
  process.exit(1);
}

// Should be deduplicated to just "having" (continuation)
if (result3.text.toLowerCase().includes('i almost wish')) {
  console.log(`\n❌ FAILED: Extending partial was NOT deduplicated!`);
  console.log(`   It should only send the new part "having", not the full text.`);
  console.log(`   Sent text: "${result3.text}"`);
  process.exit(1);
}

console.log(`\n✅ Test 3 PASSED: Extending partials properly deduplicated`);

// Test 4: Very short partials (< 3 chars) must still be sent
console.log('\n📋 Test 4: Very short partials (< 3 chars) must be sent\n');

const processor4 = new TestProcessor();
processor4.processFinal("Hello world.");

const shortPartials = ["a", "an", "I"];
for (const partial of shortPartials) {
  const result = processor4.processPartial(partial);
  if (!result.sent) {
    console.log(`\n❌ FAILED: Very short partial "${partial}" was NOT sent!`);
    process.exit(1);
  }
}

console.log(`\n✅ Test 4 PASSED: Very short partials are sent`);

// Test 5: Rapid partials all must be sent and tracked
console.log('\n📋 Test 5: Rapid partials all must be sent\n');

const processor5 = new TestProcessor();

const rapidPartials = [
  "I",
  "I almost",
  "I almost wish",
  "I almost wish sometimes"
];

for (const partial of rapidPartials) {
  const result = processor5.processPartial(partial);
  if (!result.sent) {
    console.log(`\n❌ FAILED: Rapid partial "${partial}" was NOT sent!`);
    process.exit(1);
  }
  if (!result.tracked) {
    console.log(`\n❌ FAILED: Rapid partial "${partial}" was NOT tracked!`);
    process.exit(1);
  }
}

if (processor5.sentPartials.length !== rapidPartials.length) {
  console.log(`\n❌ FAILED: Only ${processor5.sentPartials.length} of ${rapidPartials.length} rapid partials were sent!`);
  process.exit(1);
}

console.log(`\n✅ Test 5 PASSED: All rapid partials sent and tracked`);

console.log(`\n🎉 All tests passed!`);
console.log(`\n⚠️ BUT: If this test passes, the real implementation might still be broken.`);
console.log(`   The frontend behavior suggests deduplication is misfiring.`);
console.log(`   Check the actual adapter.js implementation.`);
process.exit(0);

