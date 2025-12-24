/**
 * Test: Grammar Cache Period Issue
 * 
 * Reproduces the issue where grammar correction cache is adding periods incorrectly
 * when applying cached corrections, resulting in "stop. stop having services"
 */

console.log('🧪 Grammar Cache Period Issue Test\n');
console.log('='.repeat(70));

// Simulate the grammar correction cache
const grammarCorrectionCache = new Map();

function rememberGrammarCorrection(originalText, correctedText) {
  if (!originalText || !correctedText) return;
  if (originalText === correctedText) return;
  if (originalText.length < 5) return;
  
  grammarCorrectionCache.set(originalText, {
    original: originalText,
    corrected: correctedText,
    timestamp: Date.now()
  });
  
  console.log(`[Cache] Stored: "${originalText}" → "${correctedText}"`);
}

function applyCachedCorrections(text) {
  if (!text || grammarCorrectionCache.size === 0) {
    return text;
  }
  let updated = text;
  const cacheEntries = Array.from(grammarCorrectionCache.values())
    .sort((a, b) => b.original.length - a.original.length);
  
  console.log(`[Cache] Applying corrections to: "${text}"`);
  console.log(`[Cache] Available entries: ${cacheEntries.length}`);
  
  for (const { original, corrected } of cacheEntries) {
    if (!original || original === corrected) continue;
    
    console.log(`[Cache] Checking: original="${original}", corrected="${corrected}"`);
    
    if (updated === original) {
      console.log(`[Cache] ✅ Exact match - replacing`);
      updated = corrected;
      break;
    }
    
    // FIXED: Handle punctuation correctly when text extends cached correction
    if (updated.startsWith(original)) {
      const remaining = updated.substring(original.length);
      const correctedTrimmed = corrected.trim();
      const originalTrimmed = original.trim();
      
      // Check if corrected text just adds punctuation at the end
      const correctedEndsWithPeriod = /\.$/.test(correctedTrimmed);
      const originalEndsWithPeriod = /\.$/.test(originalTrimmed);
      
      // CRITICAL: If there's remaining text, we're extending the cached correction
      // Check if the correction ONLY adds punctuation (period, comma, etc.) at the end
      // If so, don't apply the punctuation when extending (it would create awkward spacing)
      if (remaining.trim().length > 0) {
        // We're extending the text - check if correction only adds punctuation
        const correctedNoPunct = correctedTrimmed.replace(/[.!?,:;]$/, '');
        const originalNoPunct = originalTrimmed.replace(/[.!?,:;]$/, '');
        
        // If the only difference is punctuation at the end, skip applying it when extending
        if (correctedNoPunct === originalNoPunct) {
          // Correction only added punctuation - don't apply it when text extends
          // Use original text + remaining to avoid awkward "word. nextword" patterns
          updated = originalTrimmed + remaining;
          console.log(`[Cache] ⚠️ Skipping punctuation from cached correction when text extends: "${originalTrimmed}" + "${remaining}"`);
          break;
        }
      }
      
      // Normal replacement (no extension or correction has substantive changes)
      updated = corrected + remaining;
      console.log(`[Cache] ⚠️ Starts with match - replacing "${original}" with "${corrected}" and appending "${remaining}"`);
      console.log(`[Cache] Result: "${updated}"`);
      break;
    }
  }
  
  return updated;
}

// Simulate the scenario from the logs
console.log('\n📋 Scenario: Partial gets grammar correction, then final extends it\n');

// Step 1: Partial comes in: "I almost wish sometimes people would stop"
const partial1 = "I almost wish sometimes people would stop";
console.log(`\n[Step 1] Partial received: "${partial1}"`);

// Step 2: Grammar correction adds period (simulating what grammar worker does)
const partial1Corrected = "I almost wish sometimes people would stop.";
console.log(`[Step 2] Grammar correction: "${partial1}" → "${partial1Corrected}"`);

// Step 3: Store in cache
rememberGrammarCorrection(partial1, partial1Corrected);

// Step 4: Final comes in that extends the partial
const final = "I almost wish sometimes people would stop having services";
console.log(`\n[Step 4] Final received: "${final}"`);
console.log(`[Step 4] Final extends partial: true`);

// Step 5: Apply cached corrections
const finalWithCache = applyCachedCorrections(final);
console.log(`\n[Step 5] After applying cached corrections: "${finalWithCache}"`);

// Expected: Should NOT have "stop. stop" or "stop. having"
// Actual: Might have "stop. stop" or "stop. having" depending on cache matching

if (finalWithCache.includes('stop. stop') || finalWithCache.includes('stop. having')) {
  console.log(`\n❌ BUG REPRODUCED: Found "stop. stop" or "stop. having" in result!`);
  console.log(`   This is the issue - periods are being added incorrectly.`);
  process.exit(1);
} else {
  console.log(`\n✅ No double periods found`);
  process.exit(0);
}

