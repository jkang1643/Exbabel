/**
 * Test: Real Scenario from Logs
 * 
 * Tests the EXACT scenario that's failing:
 * 1. Partial: "I almost wish sometimes people would stop"
 * 2. Grammar correction: "I almost wish sometimes people would stop."
 * 3. Final: "I almost wish sometimes people would stop having services"
 * 4. Cache application should NOT create "stop. stop" or "stop. having"
 * 5. But forced final recovery should still work
 */

console.log('🧪 Real Scenario from Logs Test\n');
console.log('='.repeat(70));

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
}

function applyCachedCorrections(text) {
  if (!text || grammarCorrectionCache.size === 0) {
    return text;
  }
  let updated = text;
  const cacheEntries = Array.from(grammarCorrectionCache.values())
    .sort((a, b) => b.original.length - a.original.length);
  
  for (const { original, corrected } of cacheEntries) {
    if (!original || original === corrected) continue;
    
    if (updated === original) {
      updated = corrected;
      break;
    }
    
    if (updated.startsWith(original)) {
      const remaining = updated.substring(original.length);
      const correctedTrimmed = corrected.trim();
      const originalTrimmed = original.trim();
      
      // CRITICAL: If there's remaining text, we're extending the cached correction
      if (remaining.trim().length > 0) {
        // We're extending the text - check if correction only adds punctuation
        const correctedNoPunct = correctedTrimmed.replace(/[.!?,:;]$/, '');
        const originalNoPunct = originalTrimmed.replace(/[.!?,:;]$/, '');
        
        // If the only difference is punctuation at the end, skip applying it when extending
        if (correctedNoPunct === originalNoPunct) {
          // Correction only added punctuation - don't apply it when text extends
          updated = originalTrimmed + remaining;
          break;
        }
      }
      
      // Normal replacement (no extension or correction has substantive changes)
      updated = corrected + remaining;
      break;
    }
  }
  
  return updated;
}

// Real scenario from logs
console.log('\n📋 Scenario from logs\n');

// Step 1: Partial gets grammar correction
const partial = "I almost wish sometimes people would stop";
const partialCorrected = "I almost wish sometimes people would stop.";
rememberGrammarCorrection(partial, partialCorrected);
console.log(`[Step 1] Cache: "${partial}" → "${partialCorrected}"`);

// Step 2: Final arrives (not a forced final yet, but will test both)
const final1 = "I almost wish sometimes people would stop having services";
console.log(`[Step 2] Final: "${final1}"`);

// Step 3: Apply cache
const final1WithCache = applyCachedCorrections(final1);
console.log(`[Step 3] Final with cache: "${final1WithCache}"`);

// Should NOT have "stop. stop" or "stop. having"
if (final1WithCache.includes('stop. stop') || final1WithCache.includes('stop. having')) {
  console.log(`\n❌ FAILED: Found invalid pattern in final: "${final1WithCache}"`);
  process.exit(1);
}

// Step 4: Forced final scenario (recovery)
console.log(`\n[Step 4] Forced final scenario`);
const forcedFinal = "and go back to homes sitting around tables";
console.log(`  Forced final: "${forcedFinal}"`);

// Step 5: Extending partial arrives
const extendingPartial1 = "and go back to homes sitting around tables with";
console.log(`  Extending partial 1: "${extendingPartial1}"`);

// Apply cache (should work normally since it extends)
const extending1WithCache = applyCachedCorrections(extendingPartial1);
console.log(`  Extending partial 1 with cache: "${extending1WithCache}"`);

// Step 6: Another extending partial
const extendingPartial2 = "and go back to homes sitting around tables with food";
console.log(`  Extending partial 2: "${extendingPartial2}"`);

const extending2WithCache = applyCachedCorrections(extendingPartial2);
console.log(`  Extending partial 2 with cache: "${extending2WithCache}"`);

// Recovery should use longest
if (extending2WithCache.length < extending1WithCache.length) {
  console.log(`\n❌ FAILED: Recovery partial 2 is shorter than partial 1`);
  process.exit(1);
}

// Step 7: Test case where forced final matches cached text exactly (no extension)
console.log(`\n[Step 7] Forced final matches cached text exactly`);
// Cache: "I almost wish sometimes people would stop" → "I almost wish sometimes people would stop."
// Forced final: "I almost wish sometimes people would stop" (exact match, no extension)

// Reset cache for this test
grammarCorrectionCache.clear();
rememberGrammarCorrection(partial, partialCorrected);

const exactMatchFinal = "I almost wish sometimes people would stop"; // Exact match, no extension
const exactMatchWithCache = applyCachedCorrections(exactMatchFinal);
console.log(`  Exact match final: "${exactMatchFinal}"`);
console.log(`  Exact match with cache: "${exactMatchWithCache}"`);

// Should have the period since it's an exact match (not extending)
if (!exactMatchWithCache.endsWith('.')) {
  console.log(`\n❌ FAILED: Exact match final should have period from cache: "${exactMatchWithCache}"`);
  process.exit(1);
}

console.log(`\n✅ All tests passed!`);
process.exit(0);

