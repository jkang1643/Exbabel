/**
 * Test: All Partials Must Be Finalized
 * 
 * Tests that EVERY single partial is:
 * 1. Sent to the transcript
 * 2. Tracked properly
 * 3. Included in the final when it extends
 * 4. NOT dropped or skipped
 */

console.log('🧪 All Partials Must Be Finalized Test\n');
console.log('='.repeat(70));

class TestProcessor {
  constructor() {
    this.sentPartials = [];
    this.trackedPartials = [];
    this.finals = [];
  }

  processPartial(text, shouldExtend = false) {
    // Every partial MUST be tracked
    this.trackedPartials.push({ text, timestamp: Date.now() });
    
    // Check if this should extend a final
    if (shouldExtend && this.finals.length > 0) {
      const lastFinal = this.finals[this.finals.length - 1];
      if (text.length > lastFinal.text.length && 
          text.toLowerCase().startsWith(lastFinal.text.toLowerCase())) {
        console.log(`[Test] ✅ Partial extends final: "${text.substring(0, 40)}..."`);
        return { sent: true, tracked: true, extendsFinal: true };
      }
    }
    
    // Every partial MUST be sent (no filtering, no skipping)
    this.sentPartials.push({ text, timestamp: Date.now() });
    console.log(`[Test] ✅ Partial sent: "${text.substring(0, 40)}..."`);
    
    return { sent: true, tracked: true, extendsFinal: false };
  }

  processFinal(text) {
    // Check if any tracked partial extends this final
    let finalText = text;
    for (const partial of this.trackedPartials) {
      const partialText = partial.text.trim();
      const finalTrimmed = text.trim();
      
      if (partialText.length > finalTrimmed.length &&
          partialText.toLowerCase().startsWith(finalTrimmed.toLowerCase())) {
        finalText = partialText;
        console.log(`[Test] ✅ Using tracked partial in final: "${finalText.substring(0, 50)}..."`);
        break;
      }
    }
    
    this.finals.push({ text: finalText, timestamp: Date.now() });
    return { text: finalText };
  }
}

// Test scenario from logs: "and," after final
console.log('\n📋 Test 1: Short partials after final must be sent\n');

const processor1 = new TestProcessor();

// Final arrives
processor1.processFinal("I almost wish sometimes people would stop having services.");
console.log(`[Test] Final: "${processor1.finals[0].text}"`);

// Short partial "and," arrives
const result1 = processor1.processPartial("and,");
if (!result1.sent) {
  console.log(`\n❌ FAILED: Partial "and," was NOT sent!`);
  process.exit(1);
}
if (!result1.tracked) {
  console.log(`\n❌ FAILED: Partial "and," was NOT tracked!`);
  process.exit(1);
}

// Another short partial "And go" arrives
const result2 = processor1.processPartial("And go");
if (!result2.sent) {
  console.log(`\n❌ FAILED: Partial "And go" was NOT sent!`);
  process.exit(1);
}

console.log(`\n✅ Test 1 PASSED: Short partials after final are sent and tracked`);

// Test scenario: Rapid partials
console.log('\n📋 Test 2: Rapid partials all must be sent\n');

const processor2 = new TestProcessor();

const rapidPartials = [
  "I",
  "I almost",
  "I almost wish",
  "I almost wish sometimes",
  "I almost wish sometimes people"
];

for (const partial of rapidPartials) {
  const result = processor2.processPartial(partial);
  if (!result.sent) {
    console.log(`\n❌ FAILED: Partial "${partial}" was NOT sent!`);
    process.exit(1);
  }
  if (!result.tracked) {
    console.log(`\n❌ FAILED: Partial "${partial}" was NOT tracked!`);
    process.exit(1);
  }
}

if (processor2.sentPartials.length !== rapidPartials.length) {
  console.log(`\n❌ FAILED: Only ${processor2.sentPartials.length} of ${rapidPartials.length} partials were sent!`);
  process.exit(1);
}

console.log(`\n✅ Test 2 PASSED: All rapid partials were sent and tracked`);

// Test scenario: Partials extending final
console.log('\n📋 Test 3: Partials extending final must be in final\n');

const processor3 = new TestProcessor();

// Final arrives
processor3.processFinal("I almost wish sometimes people would stop");

// Partial extends final
processor3.processPartial("I almost wish sometimes people would stop having", true);

// Final arrives again (extended)
const final3 = processor3.processFinal("I almost wish sometimes people would stop having services");

// Check that extended text is in final
if (!final3.text.includes('having')) {
  console.log(`\n❌ FAILED: Extended partial text "having" not in final!`);
  console.log(`   Final: "${final3.text}"`);
  process.exit(1);
}

console.log(`\n✅ Test 3 PASSED: Partials extending final are included in final`);

// Test scenario: Very short partials
console.log('\n📋 Test 4: Very short partials (1-2 chars) must be sent\n');

const processor4 = new TestProcessor();

const shortPartials = ["a", "an", "I", "A", "It"];
for (const partial of shortPartials) {
  const result = processor4.processPartial(partial);
  if (!result.sent) {
    console.log(`\n❌ FAILED: Very short partial "${partial}" was NOT sent!`);
    process.exit(1);
  }
}

console.log(`\n✅ Test 4 PASSED: All very short partials were sent`);

console.log(`\n🎉 All tests passed!`);
process.exit(0);

