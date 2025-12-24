/**
 * Debug Test: Why "Our own" vs "their own" isn't deduplicating
 * 
 * This test helps debug the exact issue with phrase matching
 */

import { deduplicateFinalText } from '../core/utils/finalDeduplicator.js';

// Test the exact scenario
const previousFinal = "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate and rejects the notion that life is best spent for their own. '";
const nextFinal = "Our own self-centered desires cordoned off from others.";

console.log('🔍 Debug: Why deduplication is failing\n');
console.log('='.repeat(80));

// Extract words manually (simplified)
function extractWordsSimple(text) {
  if (!text) return [];
  return text.trim().split(/\s+/).map(word => {
    const clean = word.toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
    return { original: word, clean: clean };
  });
}

const previousWords = extractWordsSimple(previousFinal);
const nextWords = extractWordsSimple(nextFinal);

console.log('\n📋 Previous Final Words:');
previousWords.slice(-10).forEach((w, i) => {
  console.log(`  [${previousWords.length - 10 + i}] "${w.original}" (clean: "${w.clean}")`);
});

console.log('\n📋 Next Final Words:');
nextWords.slice(0, 10).forEach((w, i) => {
  console.log(`  [${i}] "${w.original}" (clean: "${w.clean}")`);
});

// Check last 5 words of previous
const last5Previous = previousWords.slice(-5);
const first5Next = nextWords.slice(0, 5);

console.log('\n📋 Last 5 words of previous:');
last5Previous.forEach((w, i) => {
  console.log(`  "${w.original}" (clean: "${w.clean}")`);
});

console.log('\n📋 First 5 words of next:');
first5Next.forEach((w, i) => {
  console.log(`  "${w.original}" (clean: "${w.clean}")`);
});

// Check for matches
console.log('\n📋 Word-by-word matching:');
for (let i = 0; i < first5Next.length; i++) {
  const nextWord = first5Next[i];
  let foundMatch = false;
  let matchedWord = null;
  
  for (let j = last5Previous.length - 1; j >= 0; j--) {
    const prevWord = last5Previous[j];
    if (nextWord.clean === prevWord.clean) {
      foundMatch = true;
      matchedWord = prevWord;
      break;
    }
  }
  
  console.log(`  "${nextWord.original}" (clean: "${nextWord.clean}") → ${foundMatch ? `✅ MATCHES "${matchedWord.original}"` : '❌ NO MATCH'}`);
}

// Check phrase matching
console.log('\n📋 Phrase matching:');
const last2Previous = last5Previous.slice(-2);
const first2Next = first5Next.slice(0, 2);

console.log(`  Last 2 words of previous: "${last2Previous.map(w => w.original).join(' ')}" (clean: "${last2Previous.map(w => w.clean).join(' ')}")`);
console.log(`  First 2 words of next: "${first2Next.map(w => w.original).join(' ')}" (clean: "${first2Next.map(w => w.clean).join(' ')}")`);

const last2Clean = last2Previous.map(w => w.clean).join(' ');
const first2Clean = first2Next.map(w => w.clean).join(' ');

console.log(`  Phrase match: ${last2Clean === first2Clean ? '✅ EXACT MATCH' : '❌ NO MATCH'}`);

// Now test actual deduplication
console.log('\n📋 Actual Deduplication Test:');
const dedupResult = deduplicateFinalText({
  newFinalText: nextFinal,
  previousFinalText: previousFinal,
  previousFinalTime: Date.now() - 2000,
  mode: 'HostMode',
  timeWindowMs: 5000,
  maxWordsToCheck: 10
});

console.log(`  Result: "${dedupResult.deduplicatedText}"`);
console.log(`  Was deduplicated: ${dedupResult.wasDeduplicated}`);
console.log(`  Words skipped: ${dedupResult.wordsSkipped}`);

// Expected behavior analysis
console.log('\n📋 Expected Behavior:');
console.log('  - "own" in "their own" (previous) should match "own" in "Our own" (next)');
console.log('  - Since "own" matches, we should deduplicate "Our own" (both words)');
console.log('  - The logic should recognize that when a word at the end of previous matches');
console.log('    a word in the next segment, we should remove all words from the start');
console.log('    of the next segment up to and including the matching word');

console.log('\n' + '='.repeat(80));

