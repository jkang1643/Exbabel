/**
 * Test to check if "Oh my!" is incorrectly identified as extending "You gotta care about Him."
 */

// Simulate the extension detection logic from host/adapter.js lines 1213-1229
function checkExtendsFinal(partialText, finalText) {
  const partialTrimmed = partialText.trim();
  const finalTrimmed = finalText.trim();
  
  const extendsFinal = partialTrimmed.length > finalTrimmed.length && 
                       (partialTrimmed.startsWith(finalTrimmed) || 
                        (finalTrimmed.length > 10 && partialTrimmed.substring(0, finalTrimmed.length) === finalTrimmed));
  
  return extendsFinal;
}

console.log('🧪 Testing extension detection logic\n');

// Test Case 1: "Oh my!" after "You gotta care about Him."
console.log('Test 1: Does "Oh my!" extend "You gotta care about Him."?');
const test1 = checkExtendsFinal('Oh my!', 'You gotta care about Him.');
console.log(`  Result: ${test1 ? 'YES ❌ (WRONG - should be NO)' : 'NO ✅ (CORRECT)'}`);
console.log(`  Partial: "Oh my!" (${'Oh my!'.length} chars)`);
console.log(`  Final: "You gotta care about Him." (${'You gotta care about Him.'.length} chars)`);
console.log(`  Partial starts with final? ${'Oh my!'.startsWith('You gotta care about Him.')}`);
console.log('');

// Test Case 2: Check various partials after "You gotta care about Him."
const testPartials = [
  'Oh my!',
  'Oh my',
  'Oh',
  'You gotta care about Him. Oh my!',
  'You gotta care about Him. Oh',
];

console.log('Test 2: Various partials after "You gotta care about Him."');
testPartials.forEach(partial => {
  const extendsResult = checkExtendsFinal(partial, 'You gotta care about Him.');
  console.log(`  "${partial}" (${partial.length} chars): ${extendsResult ? 'EXTENDS ❌' : 'NEW SEGMENT ✅'}`);
});
console.log('');

// Test Case 3: Check the actual condition logic step by step
console.log('Test 3: Step-by-step analysis for "Oh my!" after "You gotta care about Him."');
const partial = 'Oh my!';
const final = 'You gotta care about Him.';
const partialTrimmed = partial.trim();
const finalTrimmed = final.trim();
const partialLen = partialTrimmed.length;
const finalLen = finalTrimmed.length;

console.log(`  partialTrimmed: "${partialTrimmed}" (${partialLen} chars)`);
console.log(`  finalTrimmed: "${finalTrimmed}" (${finalLen} chars)`);
console.log(`  partialLen > finalLen? ${partialLen > finalLen} (${partialLen} > ${finalLen})`);
console.log(`  partialTrimmed.startsWith(finalTrimmed)? ${partialTrimmed.startsWith(finalTrimmed)}`);
console.log(`  finalLen > 10? ${finalLen > 10}`);
if (finalLen > 10) {
  const substring = partialTrimmed.substring(0, finalLen);
  console.log(`  partialTrimmed.substring(0, ${finalLen}): "${substring}"`);
  console.log(`  substring === finalTrimmed? ${substring === finalTrimmed}`);
}
console.log('');

// Test Case 4: What if partial is shorter than final?
console.log('Test 4: What happens when partial is shorter than final?');
const shortPartials = ['Oh', 'Oh my', 'Oh my!'];
shortPartials.forEach(p => {
  const len = p.trim().length;
  const extendsResult = len > finalTrimmed.length && p.trim().startsWith(finalTrimmed);
  console.log(`  "${p}" (${len} chars): ${extendsResult ? 'EXTENDS' : 'DOES NOT EXTEND'} (correct: DOES NOT EXTEND)`);
});
console.log('');

console.log('='.repeat(60));
console.log('CONCLUSION:');
if (!checkExtendsFinal('Oh my!', 'You gotta care about Him.')) {
  console.log('✅ "Oh my!" is correctly identified as NOT extending the final.');
  console.log('✅ Extension detection is NOT the issue.');
} else {
  console.log('❌ "Oh my!" is INCORRECTLY identified as extending the final.');
  console.log('❌ Extension detection IS the issue!');
}

