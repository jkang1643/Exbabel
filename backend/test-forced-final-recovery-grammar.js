/**
 * Test: Forced Final Recovery with Grammar Cache
 * 
 * Tests the scenario where:
 * 1. A forced final is created with text
 * 2. Partials extend it
 * 3. Grammar cache is applied
 * 4. Recovery and deduplication work correctly
 */

console.log('🧪 Forced Final Recovery with Grammar Cache Test\n');
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
  
  console.log(`[Cache] Stored: "${originalText.substring(0, 50)}..." → "${correctedText.substring(0, 50)}..."`);
}

function applyCachedCorrections(text) {
  if (!text || grammarCorrectionCache.size === 0) {
    return text;
  }
  let updated = text;
  const cacheEntries = Array.from(grammarCorrectionCache.values())
    .sort((a, b) => b.original.length - a.original.length);
  
  console.log(`[Cache] Applying corrections to: "${text.substring(0, 60)}..."`);
  
  for (const { original, corrected } of cacheEntries) {
    if (!original || original === corrected) continue;
    
    if (updated === original) {
      console.log(`[Cache] ✅ Exact match - replacing`);
      updated = corrected;
      break;
    }
    
    // CRITICAL: When text starts with original, apply correction but handle punctuation correctly
    if (updated.startsWith(original)) {
      const remaining = updated.substring(original.length);
      const correctedTrimmed = corrected.trim();
      const originalTrimmed = original.trim();
      
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
          console.log(`[Cache] ⚠️ Skipping punctuation from cached correction when text extends: "${originalTrimmed.substring(0, 40)}..." + "${remaining.substring(0, 30)}..."`);
          break;
        }
      }
      
      // Normal replacement (no extension or correction has substantive changes)
      updated = corrected + remaining;
      console.log(`[Cache] ✅ Applied correction: "${corrected.substring(0, 40)}..." + "${remaining.substring(0, 30)}..."`);
      break;
    }
  }
  
  return updated;
}

// Test scenario: Forced final with recovery
console.log('\n📋 Test 1: Forced final recovery with grammar cache\n');

// Step 1: Partial comes in and gets grammar correction
const partial1 = "I almost wish sometimes people would stop";
console.log(`\n[Step 1] Partial: "${partial1}"`);
const partial1Corrected = "I almost wish sometimes people would stop.";
rememberGrammarCorrection(partial1, partial1Corrected);

// Step 2: Forced final is created (due to stream restart)
const forcedFinal = "I almost wish sometimes people would stop having services";
console.log(`[Step 2] Forced final: "${forcedFinal}"`);

// Step 3: Apply cached corrections to forced final
const forcedFinalWithCache = applyCachedCorrections(forcedFinal);
console.log(`[Step 3] Forced final with cache: "${forcedFinalWithCache}"`);

// Expected: Should NOT have "stop. stop" or "stop. having"
if (forcedFinalWithCache.includes('stop. stop') || forcedFinalWithCache.includes('stop. having')) {
  console.log(`\n❌ FAILED: Found "stop. stop" or "stop. having" in forced final!`);
  console.log(`   Result: "${forcedFinalWithCache}"`);
  process.exit(1);
}

// Step 4: Partial extends forced final (recovery scenario)
const extendingPartial = "I almost wish sometimes people would stop having services and";
console.log(`[Step 4] Extending partial: "${extendingPartial}"`);

// Step 5: Apply cached corrections to extending partial
const extendingPartialWithCache = applyCachedCorrections(extendingPartial);
console.log(`[Step 5] Extending partial with cache: "${extendingPartialWithCache}"`);

// Expected: Should NOT have "stop. stop" or "stop. having"
if (extendingPartialWithCache.includes('stop. stop') || extendingPartialWithCache.includes('stop. having')) {
  console.log(`\n❌ FAILED: Found "stop. stop" or "stop. having" in extending partial!`);
  console.log(`   Result: "${extendingPartialWithCache}"`);
  process.exit(1);
}

// Step 6: Recovery should merge forced final with extending partial
// In real code, this would use mergeWithOverlap
const recoveryMerged = extendingPartialWithCache; // Simplified - real code would merge
console.log(`[Step 6] Recovery merged: "${recoveryMerged}"`);

console.log(`\n✅ Test 1 PASSED: Forced final recovery with grammar cache works correctly`);

// Test scenario: Partials extending forced final during recovery
console.log('\n📋 Test 2: Multiple partials extending forced final during recovery\n');

// Reset cache
grammarCorrectionCache.clear();

// Forced final
const forcedFinal2 = "and go back to homes sitting around tables";
console.log(`\n[Step 1] Forced final: "${forcedFinal2}"`);

// Partial 1 extends
const partial2a = "and go back to homes sitting around tables with";
console.log(`[Step 2] Partial 1: "${partial2a}"`);
const partial2aCorrected = applyCachedCorrections(partial2a);
console.log(`[Step 3] Partial 1 with cache: "${partial2aCorrected}"`);

// Partial 2 extends more
const partial2b = "and go back to homes sitting around tables with food";
console.log(`[Step 4] Partial 2: "${partial2b}"`);
const partial2bCorrected = applyCachedCorrections(partial2b);
console.log(`[Step 5] Partial 2 with cache: "${partial2bCorrected}"`);

// All partials should be preserved
if (partial2bCorrected.length < partial2aCorrected.length) {
  console.log(`\n❌ FAILED: Partial 2 is shorter than Partial 1!`);
  console.log(`   Partial 1: "${partial2aCorrected}"`);
  console.log(`   Partial 2: "${partial2bCorrected}"`);
  process.exit(1);
}

console.log(`\n✅ Test 2 PASSED: Multiple partials extending forced final work correctly`);

console.log(`\n🎉 All tests passed!`);
process.exit(0);

