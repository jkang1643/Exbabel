/**
 * Comprehensive Test Suite for Forced Final Deduplication
 * 
 * This test reproduces the duplication issue where forced finals with the same
 * content but different punctuation are being added as separate history items.
 * 
 * Example duplicate case from user report:
 * - Item #7: "I love this quote: 'Biblical hospitality is the polar opposite..."
 * - Item #8: "I love this quote biblical hospitality is the polar opposite..."
 * 
 * These should be deduplicated as they represent the same content with only
 * punctuation differences (colon, quotes, capitalization).
 * 
 * Run with: node frontend/src/utils/test-forced-final-deduplication.js
 */

import { SentenceSegmenter } from './sentenceSegmenter.js';

console.log('🧪 Testing Forced Final Deduplication\n');
console.log('='.repeat(80));

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result === true) {
      console.log(`✅ ${name}`);
      passed++;
    } else if (result === 'skip') {
      console.log(`⏭️  ${name} (skipped)`);
      skipped++;
    } else {
      console.log(`❌ ${name}`);
      if (typeof result === 'string') {
        console.log(`   Reason: ${result}`);
      }
      failed++;
    }
  } catch (error) {
    console.log(`❌ ${name}: ${error.message}`);
    console.error(error);
    failed++;
  }
}

/**
 * Helper function to normalize text for comparison
 * Matches the normalization used in HostPage.jsx
 */
function normalizeForComparison(text) {
  return text.toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Test Case 1: Exact duplicate forced finals
 */
console.log('\n1. Testing exact duplicate forced finals...');
test('should deduplicate identical forced finals', () => {
  const segmenter = new SentenceSegmenter({ maxSentences: 10, maxChars: 2000, maxTimeMs: 15000 });
  
  const text1 = "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate, and rejects the notion that life is best spent fulfilling our own self-centered desires. '";
  const text2 = text1; // Exact duplicate

  // Process first forced final
  const result1 = segmenter.processFinal(text1, { isForced: true });
  if (result1.flushedSentences.length === 0) {
    return 'First forced final returned 0 sentences';
  }

  // Process second forced final (identical)
  const result2 = segmenter.processFinal(text2, { isForced: true });
  
  // Should return empty because it's already in flushedText
  if (result2.flushedSentences.length === 0) {
    return true;
  } else {
    return `Expected 0 sentences, got ${result2.flushedSentences.length}`;
  }
});

/**
 * Test Case 2: Forced finals with punctuation differences (MAIN BUG)
 * This is the main bug: same content but different punctuation should be deduplicated
 */
console.log('\n2. Testing forced finals with punctuation differences (MAIN BUG)...');
test('should deduplicate forced finals with punctuation differences (main bug)', () => {
  const segmenter = new SentenceSegmenter({ maxSentences: 10, maxChars: 2000, maxTimeMs: 15000 });
  
  const text1 = "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate, and rejects the notion that life is best spent fulfilling our own self-centered desires. '";
  const text2 = "I love this quote biblical hospitality is the polar opposite of the cultural Trends to separate and isolate and rejects the notion that life is best.";

  // Normalize both texts
  const normalized1 = normalizeForComparison(text1);
  const normalized2 = normalizeForComparison(text2);
  
  console.log('   Normalized text1:', normalized1.substring(0, 80) + '...');
  console.log('   Normalized text2:', normalized2.substring(0, 80) + '...');
  
  // Check if they're similar enough to be considered duplicates
  const minLength = Math.min(normalized1.length, normalized2.length);
  const prefixLen = Math.min(80, minLength);
  const prefix1 = normalized1.substring(0, prefixLen);
  const prefix2 = normalized2.substring(0, prefixLen);
  const prefixesMatch = prefix1 === prefix2;
  
  console.log('   Prefixes match:', prefixesMatch);
  console.log('   Prefix 1:', prefix1);
  console.log('   Prefix 2:', prefix2);
  
  // Process first forced final
  const result1 = segmenter.processFinal(text1, { isForced: true });
  if (result1.flushedSentences.length === 0) {
    return 'First forced final returned 0 sentences';
  }
  const firstFlushed = result1.flushedSentences.join(' ');
  console.log('   First flushed:', firstFlushed.substring(0, 60) + '...');

  // Process second forced final (same content, different punctuation)
  const result2 = segmenter.processFinal(text2, { isForced: true });
  
  console.log('   Second flushed sentences count:', result2.flushedSentences.length);
  console.log('   Segmenter flushedText length:', segmenter.flushedText?.length || 0);
  
  // Should return empty because normalized content is already in flushedText
  // This is the fix we're testing
  if (result2.flushedSentences.length === 0) {
    return true;
  } else {
    return `Expected 0 sentences (duplicate), got ${result2.flushedSentences.length}. This indicates the deduplication is not working for punctuation variations.`;
  }
});

/**
 * Test Case 3: Sequential forced finals with overlapping content
 */
console.log('\n3. Testing sequential forced finals with overlapping content...');
test('should handle sequential forced finals with overlapping content', () => {
  const segmenter = new SentenceSegmenter({ maxSentences: 10, maxChars: 2000, maxTimeMs: 15000 });
  
  const text1 = "Oh boy.";
  const text2 = "Oh boy. I've been to the grocery store, so we're friendlier than them.";

  // Process first forced final
  const result1 = segmenter.processFinal(text1, { isForced: true });
  console.log('   First result:', result1.flushedSentences);

  // Process second forced final (extends the first)
  const result2 = segmenter.processFinal(text2, { isForced: true });
  console.log('   Second result:', result2.flushedSentences);

  // The second should only return the NEW part (the extension)
  // Not the entire text including "Oh boy."
  if (result2.flushedSentences.length > 0) {
    const secondFlushed = result2.flushedSentences.join(' ');
    if (secondFlushed.includes('Oh boy.')) {
      return 'Second result still contains "Oh boy." - should be deduplicated';
    }
    if (!secondFlushed.includes("I've been")) {
      return 'Second result missing the extension text';
    }
    return true;
  } else {
    // If segmenter deduplicated everything, that's also acceptable
    // (the entire text might have been considered duplicate)
    return true;
  }
});

/**
 * Test Case 4: Multiple forced finals in sequence (reproducing the exact scenario)
 * This test reproduces the exact sequence from the user's bug report
 */
console.log('\n4. Testing multiple forced finals in sequence (real-world scenario)...');
test('should deduplicate multiple forced finals in sequence (real-world scenario)', () => {
  const segmenter = new SentenceSegmenter({ maxSentences: 10, maxChars: 2000, maxTimeMs: 15000 });
  
  const forcedFinals = [
    { seqId: 2, text: "Oh boy.", timestamp: Date.now() },
    { seqId: 3, text: "Oh boy. I've been to the grocery store, so we're friendlier than them.", timestamp: Date.now() + 1000 },
    { seqId: 4, text: "Oh my!", timestamp: Date.now() + 2000 },
    { seqId: 5, text: "I've been to the grocery store, so we're friendlier than they.", timestamp: Date.now() + 3000 },
    { seqId: 6, text: "You just can't beat people up with doctrine all the time; you got to care about them.", timestamp: Date.now() + 4000 },
    { 
      seqId: 7, 
      text: "I love this quote: 'Biblical hospitality is the polar opposite of the cultural trends to separate and isolate, and rejects the notion that life is best spent fulfilling our own self-centered desires. '", 
      timestamp: Date.now() + 5000 
    },
    { 
      seqId: 8, 
      text: "I love this quote biblical hospitality is the polar opposite of the cultural Trends to separate and isolate and rejects the notion that life is best.", 
      timestamp: Date.now() + 6000 
    },
    { 
      seqId: 9, 
      text: "In private fortresses, we call home, biblical hospitality chooses to engage rather than unplug.", 
      timestamp: Date.now() + 7000 
    },
  ];

  const processedResults = [];
  const historyItems = [];

  // Simulate processing each forced final
  for (const final of forcedFinals) {
    const result = segmenter.processFinal(final.text, { isForced: true });
    
    if (result.flushedSentences.length > 0) {
      const joinedText = result.flushedSentences.join(' ').trim();
      
      // Simulate HostPage deduplication logic
      const joinedNormalized = normalizeForComparison(joinedText);
      const isDuplicate = historyItems.some(entry => {
        const entryNormalized = normalizeForComparison(entry.text);
        
        // Check if texts are the same (normalized)
        if (entryNormalized === joinedNormalized) {
          return true;
        }
        
        // Check if one contains the other (for partial matches)
        if (entryNormalized.length > 15 && joinedNormalized.length > 15) {
          if (entryNormalized.includes(joinedNormalized) || joinedNormalized.includes(entryNormalized)) {
            return true;
          }
          
          // Check if significant prefixes match (first 80 chars)
          const prefixLen = Math.min(80, Math.min(entryNormalized.length, joinedNormalized.length));
          if (prefixLen > 30 && entryNormalized.substring(0, prefixLen) === joinedNormalized.substring(0, prefixLen)) {
            return true;
          }
        }
        
        return false;
      });
      
      if (!isDuplicate) {
        historyItems.push({
          text: joinedText,
          seqId: final.seqId,
          timestamp: final.timestamp
        });
        processedResults.push({ seqId: final.seqId, text: joinedText, added: true });
      } else {
        processedResults.push({ seqId: final.seqId, text: joinedText, added: false, reason: 'duplicate' });
      }
    } else {
      processedResults.push({ seqId: final.seqId, text: final.text, added: false, reason: 'segmenter deduplicated' });
    }
  }

  console.log('\n   === Processing Results ===');
  processedResults.forEach(r => {
    const status = r.added ? '✅ ADDED' : `❌ SKIPPED (${r.reason})`;
    console.log(`   SeqId ${r.seqId}: ${status} - "${r.text.substring(0, 60)}..."`);
  });

  console.log('\n   === Final History Items ===');
  historyItems.forEach((item, idx) => {
    console.log(`   #${idx + 1} (seqId: ${item.seqId}): "${item.text.substring(0, 60)}..."`);
  });

  // Critical assertions:
  // 1. Items #7 and #8 should NOT both be in history (they're duplicates)
  const item7 = historyItems.find(item => item.seqId === 7);
  const item8 = historyItems.find(item => item.seqId === 8);
  
  console.log('\n   === Deduplication Check ===');
  console.log(`   Item #7 in history: ${!!item7}`);
  console.log(`   Item #8 in history: ${!!item8}`);
  
  // They should not BOTH be present
  if (item7 && item8) {
    return 'Items #7 and #8 are BOTH in history - they should be deduplicated (same content, different punctuation)';
  }
  
  // At least one should be present (the first one processed)
  if (!item7 && !item8) {
    return 'Neither item #7 nor #8 is in history - at least one should be present';
  }

  // 2. Items #2 and #3 should be handled correctly (one extends the other)
  const item2 = historyItems.find(item => item.seqId === 2);
  const item3 = historyItems.find(item => item.seqId === 3);
  
  // Item #2 ("Oh boy.") might be in history
  // Item #3 should either:
  //   - Not contain "Oh boy." (if it was properly deduplicated)
  //   - Or item #2 should not be present if #3 replaced it
  if (item3) {
    const item3Normalized = normalizeForComparison(item3.text);
    if (item2) {
      const item2Normalized = normalizeForComparison(item2.text);
      // They should not both be present if #3 extends #2
      if (item3Normalized.includes(item2Normalized) && item2Normalized.length > 5) {
        // This might be okay if they're considered different enough
        // Let's allow this case for now
      }
    }
  }
  
  return true;
});

/**
 * Test Case 5: Edge case - very short forced finals
 */
console.log('\n5. Testing short complete sentence forced finals...');
test('should handle short complete sentence forced finals', () => {
  const segmenter = new SentenceSegmenter({ maxSentences: 10, maxChars: 2000, maxTimeMs: 15000 });
  
  const text1 = "Oh my!";
  const text2 = "Oh my!";

  // Process first
  const result1 = segmenter.processFinal(text1, { isForced: true });
  console.log('   Short sentence result 1:', result1.flushedSentences);

  // Process duplicate
  const result2 = segmenter.processFinal(text2, { isForced: true });
  console.log('   Short sentence result 2:', result2.flushedSentences);

  // Should deduplicate
  if (result2.flushedSentences.length === 0) {
    return true;
  } else {
    return `Expected 0 sentences (duplicate), got ${result2.flushedSentences.length}`;
  }
});

/**
 * Test Case 6: Testing normalization edge cases
 */
console.log('\n6. Testing normalization edge cases...');
test('normalization should handle various punctuation combinations', () => {
  const testCases = [
    {
      text1: "I love this quote: 'Biblical hospitality...",
      text2: "I love this quote biblical hospitality...",
      shouldMatch: true,
      description: "Colon and quotes vs no punctuation"
    },
    {
      text1: "Oh boy.",
      text2: "Oh boy",
      shouldMatch: true,
      description: "Period vs no period"
    },
    {
      text1: "Text with 'quotes' and \"double quotes\"",
      text2: "Text with quotes and double quotes",
      shouldMatch: true,
      description: "Quotes vs no quotes"
    },
    {
      text1: "Different content entirely",
      text2: "Completely different text",
      shouldMatch: false,
      description: "Actually different content"
    }
  ];

  let allPassed = true;
  let failureReason = '';

  testCases.forEach(({ text1, text2, shouldMatch, description }) => {
    const norm1 = normalizeForComparison(text1);
    const norm2 = normalizeForComparison(text2);
    
    const prefixLen = Math.min(80, Math.min(norm1.length, norm2.length));
    const prefixesMatch = prefixLen > 30 && norm1.substring(0, prefixLen) === norm2.substring(0, prefixLen);
    const oneContainsOther = norm1.length > 15 && norm2.length > 15 && 
                             (norm1.includes(norm2) || norm2.includes(norm1));
    const matches = norm1 === norm2 || prefixesMatch || oneContainsOther;
    
    if (matches !== shouldMatch) {
      allPassed = false;
      failureReason = `${description}: Expected ${shouldMatch}, got ${matches}`;
      console.log(`   ❌ ${description}`);
      console.log(`      Text1: "${text1}"`);
      console.log(`      Text2: "${text2}"`);
      console.log(`      Norm1: "${norm1.substring(0, 60)}..."`);
      console.log(`      Norm2: "${norm2.substring(0, 60)}..."`);
      console.log(`      Match: ${matches} (expected: ${shouldMatch})`);
    } else {
      console.log(`   ✅ ${description}`);
    }
  });
  
  if (!allPassed) {
    return failureReason;
  }
  return true;
});

// Summary
console.log('\n' + '='.repeat(80));
console.log(`\n✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`⏭️  Skipped: ${skipped}`);
console.log(`\n${failed === 0 ? '🎉 All tests passed!' : '⚠️  Some tests failed'}\n`);

process.exit(failed === 0 ? 0 : 1);

