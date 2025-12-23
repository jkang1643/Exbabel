/**
 * Test to check if forced final buffer logic is causing "Oh my!" to be missed
 * 
 * Scenario: What if "You gotta care about Him." is in the forced final buffer
 * when "Oh my!" arrives as a partial?
 */

import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';

// Simulate the forced final buffer extension check logic
function checkPartialExtendsForcedFinal(partialText, forcedFinalText) {
  const partialTrimmed = partialText.trim();
  const forcedTrimmed = forcedFinalText.trim();
  
  // Check if partial extends the forced final (is a continuation)
  const extendsForcedFinal = partialTrimmed.length > forcedTrimmed.length && 
                             (partialTrimmed.toLowerCase().startsWith(forcedTrimmed.toLowerCase()) || 
                              (forcedTrimmed.length > 10 && partialTrimmed.toLowerCase().substring(0, forcedTrimmed.length) === forcedTrimmed.toLowerCase()));
  
  return extendsForcedFinal;
}

console.log('🧪 Testing forced final buffer scenario for "Oh my!"\n');

// Test Case 1: "Oh my!" after "You gotta care about Him." in forced final buffer
console.log('Test 1: "Oh my!" arrives when "You gotta care about Him." is in forced final buffer');
const forcedFinal = 'You gotta care about Him.';
const partial = 'Oh my!';
const extendsResult = checkPartialExtendsForcedFinal(partial, forcedFinal);
console.log(`  Forced final: "${forcedFinal}"`);
console.log(`  Partial: "${partial}"`);
console.log(`  Extends forced final? ${extendsResult}`);
console.log(`  Expected: NO (should be identified as new segment)`);
console.log(`  Result: ${extendsResult ? '❌ INCORRECT' : '✅ CORRECT'}`);
console.log('');

// Test Case 2: Check what happens with progressive partials
console.log('Test 2: Progressive partials after forced final');
const progressivePartials = ['O', 'Oh', 'Oh m', 'Oh my', 'Oh my!'];
progressivePartials.forEach(p => {
  const extendsResult = checkPartialExtendsForcedFinal(p, forcedFinal);
  console.log(`  "${p}": ${extendsResult ? 'EXTENDS' : 'NEW SEGMENT'}`);
});
console.log('');

// Test Case 3: Simulate the deduplication check that happens when there's a forced final buffer
console.log('Test 3: Deduplication check when forced final buffer exists');
const forcedFinalText = 'You gotta care about Him.';
const partialText = 'Oh my!';
const forcedText = forcedFinalText.trim();
const partialTextTrimmed = partialText.trim();

// This is the logic from lines 1128-1163
const extendsForcedFinal = partialTextTrimmed.length > forcedText.length && 
                           (partialTextTrimmed.toLowerCase().startsWith(forcedText.toLowerCase()) || 
                            (forcedText.length > 10 && partialTextTrimmed.toLowerCase().substring(0, forcedText.length) === forcedText.toLowerCase()));

const startsWithForcedFinal = partialTextTrimmed.toLowerCase().startsWith(forcedText.toLowerCase().substring(0, Math.min(20, forcedText.length)));

let shouldDeduplicate = true;
if (!extendsForcedFinal && !startsWithForcedFinal) {
  const forcedEndsWithPunctuation = /[.!?]$/.test(forcedText);
  const partialStartsWithCapital = /^[A-Z]/.test(partialTextTrimmed);
  
  if (forcedEndsWithPunctuation && partialStartsWithCapital) {
    console.log('  ✅ New segment detected - skipping deduplication (forced final ends with punctuation, partial starts with capital)');
    shouldDeduplicate = false;
  } else {
    const partialFirstWord = partialTextTrimmed.split(/\s+/)[0]?.toLowerCase();
    const forcedLastWords = forcedText.split(/\s+/).slice(-3).map(w => w.toLowerCase().replace(/[.!?,]/g, ''));
    
    if (partialFirstWord && !forcedLastWords.includes(partialFirstWord)) {
      console.log(`  ✅ New segment detected - skipping deduplication (first word "${partialFirstWord}" not in last words of forced final)`);
      shouldDeduplicate = false;
    }
  }
}

console.log(`  shouldDeduplicate: ${shouldDeduplicate}`);
if (!shouldDeduplicate) {
  console.log('  ✅ Deduplication would be skipped - "Oh my!" should NOT be deduplicated');
} else {
  // Test what deduplication would do
  const dedupResult = deduplicatePartialText({
    partialText: partialText,
    lastFinalText: forcedFinalText,
    lastFinalTime: Date.now() - 300,
    mode: 'HostMode',
    timeWindowMs: 5000,
    maxWordsToCheck: 3
  });
  console.log(`  Deduplication result: "${dedupResult.deduplicatedText}"`);
  console.log(`  Was deduplicated: ${dedupResult.wasDeduplicated}`);
  if (dedupResult.wasDeduplicated && (!dedupResult.deduplicatedText || dedupResult.deduplicatedText.length < 3)) {
    console.log('  ❌ PROBLEM: Deduplication would remove "Oh my!"');
  }
}
console.log('');

// Test Case 4: Check if the issue is with the forced final buffer extension check returning early
console.log('Test 4: Simulating the full flow when forced final buffer exists');
console.log('  Scenario: Forced final "You gotta care about Him." is in buffer');
console.log('  Partial "Oh my!" arrives');
console.log('');

const extension = { extends: checkPartialExtendsForcedFinal('Oh my!', 'You gotta care about Him.') };
console.log(`  extension.extends = ${extension.extends}`);

if (extension && extension.extends) {
  console.log('  ❌ PROBLEM: Code would merge and commit (lines 1077-1088), then CONTINUE processing');
  console.log('  But wait - if it continues, it should still send the partial...');
} else {
  console.log('  ✅ New segment detected - code continues to deduplication check (line 1108+)');
  console.log('  This is the expected path for "Oh my!"');
}
console.log('');

console.log('='.repeat(60));
console.log('CONCLUSION:');
if (!checkPartialExtendsForcedFinal('Oh my!', 'You gotta care about Him.')) {
  console.log('✅ "Oh my!" is correctly identified as NOT extending the forced final.');
  console.log('✅ Forced final buffer logic should NOT be the issue.');
  console.log('✅ Code should continue to process "Oh my!" as a new partial.');
} else {
  console.log('❌ "Oh my!" is INCORRECTLY identified as extending the forced final.');
  console.log('❌ This could cause the partial to be processed incorrectly.');
}

