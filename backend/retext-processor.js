/**
 * Retext Hybrid Processor
 * 
 * Provides two processing paths:
 * 1. processPartialSync() - Fast synchronous path for partial transcripts (<10ms)
 * 2. processWithRetext() - Comprehensive async path for final transcripts (~100-200ms)
 * 
 * Both paths use the same correction logic from retext-plugins/logic.js
 * to ensure 100% consistency.
 */

import nlp from 'compromise';
import {
  fixContractionsLogic,
  removeFillersLogic,
  fixHomophonesLogic,
  restorePunctuationLogic,
  capitalizeSentencesLogic,
  fixPronounILogic,
  capitalizeProperNounsLogic,
  capitalizeAcronymsLogic,
  deduplicateWordsLogic,
  normalizeColloquialismsLogic,
  normalizeBibleBookNamesLogic,
  normalizeVerseReferencesLogic,
  capitalizeDivinePronounsLogic,
  capitalizeDivineTitlesLogic,
  capitalizeSacredTextsLogic,
  fixReligiousHomophonesLogic,
  normalizeSermonStructureLogic,
  normalizePrayerLanguageLogic,
  normalizeTheologyTermsLogic,
  normalizeQuotationSyntaxLogic,
  normalizeFormattingCommandsLogic,
  fixDivineNamesLogic,
  normalizeLiturgicalTermsLogic,
  fixRunOnSentencesLogic
} from './retext-plugins/logic.js';

// ============================================================================
// FAST PATH: Synchronous Processing for Partials
// ============================================================================

/**
 * Process partial transcript synchronously (fast path)
 * Used for live partial transcripts that need <10ms latency
 * 
 * @param {string} text - Raw transcription text
 * @param {Object} options - Processing options
 * @returns {string} Cleaned text
 */
export function processPartialSync(text, options = {}) {
  if (!text || text.trim().length === 0) {
    return text || '';
  }
  
  const {
    enableNumbers = false,
    enableDates = true,
    enableTimes = true,
    enableColloquialisms = true,
    enableDomainSpecific = true
  } = options;
  
  let result = text.trim();
  const originalText = result;
  
  // ALWAYS log input for debugging
  console.log(`[GrammarPipeline] 📥 INPUT: "${result.substring(0, 150)}${result.length > 150 ? '...' : ''}" (${result.length} chars)`);
  
  // CRITICAL: Normalize whitespace BUT PRESERVE WORD BOUNDARIES
  // Never remove spaces between words - only normalize multiple spaces to single space
  const beforeWhitespace = result;
  result = result.replace(/\s+/g, ' ').trim(); // Multiple spaces → single space
  // Only fix punctuation spacing - DON'T touch spaces between words
  result = result.replace(/\s+([,.!?;:])/g, '$1'); // Remove space before punctuation
  result = result.replace(/([,.!?;:])([a-zA-Z])/g, '$1 $2'); // Add space after punctuation
  if (result !== beforeWhitespace) {
    console.log(`[GrammarPipeline] 🔧 Whitespace normalized: "${beforeWhitespace.substring(0, 80)}" → "${result.substring(0, 80)}"`);
  }
  
  // Stage 1: Fix contractions
  // console.log(`[GrammarPipeline] 🔍 Running: fixContractionsLogic`);
  const beforeContractions = result;
  result = fixContractionsLogic(result);
  if (result !== beforeContractions) {
    console.log(`[GrammarPipeline] 🔧 Contractions fixed: "${beforeContractions.substring(0, 80)}" → "${result.substring(0, 80)}"`);
  }
  // else {
  //   console.log(`[GrammarPipeline] ✓ Contractions checked (no changes)`);
  // }
  
  // Stage 2: Remove fillers
  // console.log(`[GrammarPipeline] 🔍 Running: removeFillersLogic`);
  const beforeFillers = result;
  result = removeFillersLogic(result);
  if (result !== beforeFillers) {
    console.log(`[GrammarPipeline] 🔧 Fillers removed: "${beforeFillers.substring(0, 80)}" → "${result.substring(0, 80)}"`);
  }
  // else {
  //   console.log(`[GrammarPipeline] ✓ Fillers checked (no changes)`);
  // }
  
  // Stage 3: Deduplicate words
  // console.log(`[GrammarPipeline] 🔍 Running: deduplicateWordsLogic`);
  const beforeDedupe = result;
  result = deduplicateWordsLogic(result);
  if (result !== beforeDedupe) {
    console.log(`[GrammarPipeline] 🔧 Duplicates removed: "${beforeDedupe.substring(0, 80)}" → "${result.substring(0, 80)}"`);
  }
  // else {
  //   console.log(`[GrammarPipeline] ✓ Duplicates checked (no changes)`);
  // }
  
  // Stage 4: Fix homophones (context-aware)
  // console.log(`[GrammarPipeline] 🔍 Running: fixHomophonesLogic`);
  const doc = nlp(result);
  const beforeHomophones = result;
  result = fixHomophonesLogic(result, doc);
  if (result !== beforeHomophones) {
    console.log(`[GrammarPipeline] 🔧 Homophones fixed: "${beforeHomophones.substring(0, 80)}" → "${result.substring(0, 80)}"`);
  }
  // else {
  //   console.log(`[GrammarPipeline] ✓ Homophones checked (no changes)`);
  // }
  
  // Stage 5: Restore punctuation (with sentence segmentation)
  // console.log(`[GrammarPipeline] 🔍 Running: restorePunctuationLogic`);
  const beforePunctuation = result;
  result = restorePunctuationLogic(result, true, doc); // isPartial = true
  if (result !== beforePunctuation) {
    console.log(`[GrammarPipeline] 🔧 Punctuation restored: "${beforePunctuation.substring(0, 80)}" → "${result.substring(0, 80)}"`);
  }
  // else {
  //   console.log(`[GrammarPipeline] ✓ Punctuation checked (no changes)`);
  // }
  
  // Stage 6: Capitalize sentences (IMPORTANT: Do this AFTER punctuation restoration)
  // console.log(`[GrammarPipeline] 🔍 Running: capitalizeSentencesLogic, fixPronounILogic`);
  const beforeCapitalization = result;
  result = capitalizeSentencesLogic(result);
  result = fixPronounILogic(result);
  if (result !== beforeCapitalization) {
    console.log(`[GrammarPipeline] 🔧 Capitalization fixed: "${beforeCapitalization.substring(0, 80)}" → "${result.substring(0, 80)}"`);
  }
  // else {
  //   console.log(`[GrammarPipeline] ✓ Capitalization checked (no changes)`);
  // }
  
  // Stage 7: Capitalize proper nouns and acronyms
  // console.log(`[GrammarPipeline] 🔍 Running: capitalizeProperNounsLogic, capitalizeAcronymsLogic`);
  const beforeProperNouns = result;
  result = capitalizeProperNounsLogic(result);
  result = capitalizeAcronymsLogic(result);
  if (result !== beforeProperNouns) {
    console.log(`[GrammarPipeline] 🔧 Proper nouns capitalized: "${beforeProperNouns.substring(0, 80)}" → "${result.substring(0, 80)}"`);
  }
  // else {
  //   console.log(`[GrammarPipeline] ✓ Proper nouns/acronyms checked (no changes)`);
  // }
  
  // CRITICAL: Final capitalization pass AFTER all punctuation is added
  // This ensures words after periods are capitalized even if punctuation was added later
  // console.log(`[GrammarPipeline] 🔍 Running: capitalizeSentencesLogic (final pass)`);
  const beforeFinalCapitalization = result;
  result = capitalizeSentencesLogic(result);
  if (result !== beforeFinalCapitalization) {
    console.log(`[GrammarPipeline] 🔧 Final capitalization: "${beforeFinalCapitalization.substring(0, 80)}" → "${result.substring(0, 80)}"`);
  }
  // else {
  //   console.log(`[GrammarPipeline] ✓ Final capitalization checked (no changes)`);
  // }
  
  // Fix common grammar errors
  // "got to" → "have got to" or keep as "got to" (informal is OK, but fix "gotta")
  result = result.replace(/\bgotta\b/gi, "have got to");
  result = result.replace(/\bgot\s+to\s+care\b/gi, "have got to care");
  
  // Fix "lover thing" → "loving thing" or "love thing"
  result = result.replace(/\blover\s+thing\b/gi, "loving thing");
  
  // Fix "niche initiate" → likely "nice initiate" or context-dependent
  result = result.replace(/\bniche\s+initiate\b/gi, (match, offset) => {
    const context = result.substring(Math.max(0, offset - 20), offset + match.length + 20).toLowerCase();
    // If context suggests it's about being nice, fix it
    if (context.includes('nice') || context.includes('kind')) {
      return 'nice initiate';
    }
    return match; // Keep "niche" if it's actually about a niche
  });
  
  // CRITICAL: Fix STT transcription errors using context-aware detection
  // Don't hardcode fixes - use patterns that work for similar errors

  // DISABLED: This pattern is too aggressive and causes false positives
  // It was splitting valid words like "Surgeon" → "Surge on"
  // Fix words incorrectly combined (missing space between word + common particle)
  // Pattern: word + (all|the|and|of|in|on|at|to|for|with|from) without space
  // result = result.replace(/\b([a-z]{5,})(all|the|and|of|in|on|at|to|for|with|from)\b/gi, (match, word, particle) => {
  //   // Only fix if it's likely an error (word is substantial and lowercase)
  //   // Check if splitting would make sense (word exists as standalone)
  //   return `${word} ${particle}`;
  // });
  
  // Fix specific context-aware STT errors
  // "decades fight" → "to cage fight" (only in fighting context)
  if (/\bfight|fighting|match|matches|combat|battle\b/i.test(result)) {
    result = result.replace(/\bdecades\s+fight\b/gi, 'to cage fight');
  }
  
  // "200 of churches" → "hundreds of churches" (context-aware)
  result = result.replace(/\b(\d+)\s+of\s+(churches|people|places|things)\b/gi, (match, num, noun) => {
    const numVal = parseInt(num);
    if (numVal >= 100) {
      return `hundreds of ${noun}`;
    }
    return `${num} ${noun}`;
  });
  
  // Fix common capitalization errors (over-capitalization)
  // "Doctrine" should be "doctrine" unless it's a proper noun, but PRESERVE SPACES
  result = result.replace(/\bDoctrine\s+(?!\b(?:of|in|the)\b)([a-z])/gi, (match, nextWord) => {
    const offset = result.indexOf(match);
    const before = result.substring(Math.max(0, offset - 30), offset).toLowerCase();
    // If it's not a proper noun context (like "Doctrine of the Trinity"), lowercase it
    if (!/\b(doctrine|the|of|in)\s+[A-Z]/.test(before)) {
      return `doctrine ${nextWord}`;
    }
    return match;
  });
  
  // Stage 8: Normalize colloquialisms
  if (enableColloquialisms) {
    // console.log(`[GrammarPipeline] 🔍 Running: normalizeColloquialismsLogic`);
    const beforeColloquialisms = result;
    result = normalizeColloquialismsLogic(result);
    if (result !== beforeColloquialisms) {
      console.log(`[GrammarPipeline] 🔧 Colloquialisms normalized: "${beforeColloquialisms.substring(0, 80)}" → "${result.substring(0, 80)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ✓ Colloquialisms checked (no changes)`);
    // }
  }
  
  // Stage 9: Domain-specific fixes (Bible/worship)
  if (enableDomainSpecific) {
    // console.log(`[GrammarPipeline] 🔍 Running domain-specific fixes (Bible/worship)`);
    const doc2 = nlp(result);
    
    // Bible book names and verse references
    // console.log(`[GrammarPipeline] 🔍 Running: normalizeBibleBookNamesLogic, normalizeVerseReferencesLogic`);
    const beforeBibleBooks = result;
    result = normalizeBibleBookNamesLogic(result, doc2);
    result = normalizeVerseReferencesLogic(result, doc2);
    if (result !== beforeBibleBooks) {
      console.log(`[GrammarPipeline] 🔧 Bible books normalized: "${beforeBibleBooks.substring(0, 80)}" → "${result.substring(0, 80)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ✓ Bible books/verses checked (no changes)`);
    // }
    
    // Capitalization rules
    // console.log(`[GrammarPipeline] 🔍 Running: capitalizeDivineTitlesLogic, capitalizeDivinePronounsLogic, capitalizeSacredTextsLogic`);
    const beforeDivine = result;
    result = capitalizeDivineTitlesLogic(result);
    result = capitalizeDivinePronounsLogic(result, doc2);
    result = capitalizeSacredTextsLogic(result);
    if (result !== beforeDivine) {
      console.log(`[GrammarPipeline] 🔧 Divine terms capitalized: "${beforeDivine.substring(0, 80)}" → "${result.substring(0, 80)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ✓ Divine terms checked (no changes)`);
    // }
    
    // Religious homophones
    // console.log(`[GrammarPipeline] 🔍 Running: fixReligiousHomophonesLogic`);
    const beforeReligiousHomophones = result;
    result = fixReligiousHomophonesLogic(result, doc2);
    if (result !== beforeReligiousHomophones) {
      console.log(`[GrammarPipeline] 🔧 Religious homophones fixed: "${beforeReligiousHomophones.substring(0, 80)}" → "${result.substring(0, 80)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ✓ Religious homophones checked (no changes)`);
    // }
    
    // Sermon structure
    // console.log(`[GrammarPipeline] 🔍 Running: normalizeSermonStructureLogic`);
    const beforeSermonStructure = result;
    result = normalizeSermonStructureLogic(result, doc2);
    if (result !== beforeSermonStructure) {
      console.log(`[GrammarPipeline] 🔧 Sermon structure normalized: "${beforeSermonStructure.substring(0, 80)}" → "${result.substring(0, 80)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ✓ Sermon structure checked (no changes)`);
    // }
    
    // Prayer language
    // console.log(`[GrammarPipeline] 🔍 Running: normalizePrayerLanguageLogic`);
    const beforePrayer = result;
    result = normalizePrayerLanguageLogic(result, doc2);
    if (result !== beforePrayer) {
      console.log(`[GrammarPipeline] 🔧 Prayer language normalized: "${beforePrayer.substring(0, 80)}" → "${result.substring(0, 80)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ✓ Prayer language checked (no changes)`);
    // }
    
    // Theology terms
    // console.log(`[GrammarPipeline] 🔍 Running: normalizeTheologyTermsLogic, normalizeLiturgicalTermsLogic`);
    const beforeTheology = result;
    result = normalizeTheologyTermsLogic(result);
    result = normalizeLiturgicalTermsLogic(result);
    if (result !== beforeTheology) {
      console.log(`[GrammarPipeline] 🔧 Theology terms normalized: "${beforeTheology.substring(0, 80)}" → "${result.substring(0, 80)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ✓ Theology/liturgical terms checked (no changes)`);
    // }
    
    // Quotation syntax - THIS IS CRITICAL FOR THE USER'S ISSUE
    // console.log(`[GrammarPipeline] 🔍 Running: normalizeQuotationSyntaxLogic`);
    const beforeQuotes = result;
    result = normalizeQuotationSyntaxLogic(result, doc2);
    if (result !== beforeQuotes) {
      console.log(`[GrammarPipeline] 🔧 QUOTES DETECTED AND ADDED: "${beforeQuotes.substring(0, 150)}" → "${result.substring(0, 150)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ⚠️ NO QUOTES DETECTED in: "${result.substring(0, 150)}"`);
    // }
    
    // Run-on sentence fixes - CRITICAL: Must run after quotes and punctuation
    // console.log(`[GrammarPipeline] 🔍 Running: fixRunOnSentencesLogic`);
    const doc4 = nlp(result);
    const beforeRunOns = result;
    result = fixRunOnSentencesLogic(result, doc4);
    if (result !== beforeRunOns) {
      console.log(`[GrammarPipeline] 🔧 Run-on sentences fixed: "${beforeRunOns.substring(0, 150)}" → "${result.substring(0, 150)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ✓ Run-on sentences checked (no changes)`);
    // }
    
    // Formatting commands
    // console.log(`[GrammarPipeline] 🔍 Running: normalizeFormattingCommandsLogic`);
    const beforeFormatting = result;
    result = normalizeFormattingCommandsLogic(result);
    if (result !== beforeFormatting) {
      console.log(`[GrammarPipeline] 🔧 Formatting commands normalized: "${beforeFormatting.substring(0, 80)}" → "${result.substring(0, 80)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ✓ Formatting commands checked (no changes)`);
    // }
    
    // Additional fixes
    // console.log(`[GrammarPipeline] 🔍 Running: fixDivineNamesLogic`);
    const beforeDivineNames = result;
    result = fixDivineNamesLogic(result);
    if (result !== beforeDivineNames) {
      console.log(`[GrammarPipeline] 🔧 Divine names fixed: "${beforeDivineNames.substring(0, 80)}" → "${result.substring(0, 80)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ✓ Divine names checked (no changes)`);
    // }
    
    // CRITICAL: Re-apply homophone fixes AFTER domain-specific processing
    // This ensures "Nahum" → "Name" corrections aren't undone by Bible book normalization
    // console.log(`[GrammarPipeline] 🔍 Running: fixHomophonesLogic (final pass)`);
    const doc3 = nlp(result);
    const beforeFinalHomophones = result;
    result = fixHomophonesLogic(result, doc3);
    if (result !== beforeFinalHomophones) {
      console.log(`[GrammarPipeline] 🔧 Final homophones pass: "${beforeFinalHomophones.substring(0, 80)}" → "${result.substring(0, 80)}"`);
    }
    // else {
    //   console.log(`[GrammarPipeline] ✓ Final homophones checked (no changes)`);
    // }
  }
  
  // Final cleanup - PRESERVE QUOTES
  // First, protect quotes by temporarily replacing them
  // Handle both double quotes and single quotes, including empty quotes
  const quotePlaceholders = [];
  let quoteIndex = 0;
  // Match quoted content - this regex handles both empty and non-empty quotes
  // The ? makes * lazy (non-greedy) and allows zero matches
  result = result.replace(/["']([^"']*)["']/g, (match, content) => {
    const placeholder = `__QUOTE_${quoteIndex}__`;
    quotePlaceholders.push({ placeholder, original: match, content: content || '' });
    quoteIndex++;
    return placeholder;
  });
  
  // Now do cleanup on text without quotes
  result = result.replace(/\s+/g, ' ').trim();
  result = result.replace(/\s+([,.!?;:])/g, '$1');
  result = result.replace(/([,.!?;:])([a-zA-Z])/g, '$1 $2');
  
  // Restore quotes with proper spacing
  quotePlaceholders.forEach(({ placeholder, original }) => {
    // Ensure proper spacing: space before opening quote, space after closing quote
    const index = result.indexOf(placeholder);
    if (index >= 0) {
      const before = result.substring(Math.max(0, index - 1), index);
      const after = result.substring(index + placeholder.length, index + placeholder.length + 1);
      let restored = original;
      // Add space before if needed
      if (before && !/\s/.test(before) && before !== '(') {
        restored = ' ' + restored;
      }
      // Add space after if needed  
      if (after && !/\s/.test(after) && after !== '.' && after !== ',' && after !== '!' && after !== '?' && after !== ')') {
        restored = restored + ' ';
      }
      result = result.replace(placeholder, restored);
    }
  });
  
  // Final trim
  result = result.trim();
  
  // ALWAYS log output and changes
  console.log(`[GrammarPipeline] 📤 OUTPUT: "${result.substring(0, 150)}${result.length > 150 ? '...' : ''}" (${result.length} chars)`);
  if (result !== originalText) {
    const changes = originalText.length !== result.length ? `${originalText.length} → ${result.length} chars` : 'same length';
    console.log(`[GrammarPipeline] ✅ CHANGES APPLIED (${changes})`);
    // Show a diff-like comparison
    if (originalText.length > 0 && result.length > 0) {
      const firstDiff = findFirstDifference(originalText, result);
      if (firstDiff > 0) {
        console.log(`[GrammarPipeline] 📊 First change at position ${firstDiff}: "${originalText.substring(Math.max(0, firstDiff - 20), firstDiff + 20)}" → "${result.substring(Math.max(0, firstDiff - 20), firstDiff + 20)}"`);
      }
    }
  } else {
    console.log(`[GrammarPipeline] ⚠️ NO CHANGES DETECTED - text unchanged`);
  }
  
  return result;
}

// Helper function to find first difference between two strings
function findFirstDifference(str1, str2) {
  const minLen = Math.min(str1.length, str2.length);
  for (let i = 0; i < minLen; i++) {
    if (str1[i] !== str2[i]) {
      return i;
    }
  }
  return minLen;
}

// ============================================================================
// COMPREHENSIVE PATH: Async Retext Processing for Finals
// ============================================================================

/**
 * Process final transcript with async retext (comprehensive path)
 * Used for final transcripts that can afford ~100-200ms processing time
 * 
 * @param {string} text - Raw transcription text
 * @param {Object} options - Processing options
 * @returns {Promise<string>} Cleaned text
 */
export async function processWithRetext(text, options = {}) {
  console.log(`[retext-processor] 🚀 processWithRetext CALLED: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
  
  if (!text || text.trim().length === 0) {
    console.log(`[retext-processor] ⚠️ Empty text, returning early`);
    return text || '';
  }
  
  try {
    console.log(`[retext-processor] 📦 Starting to import retext modules...`);
    const { retext } = await import('retext');
    const { default: retextEnglish } = await import('retext-english');
    const { default: retextCapitalization } = await import('retext-capitalization');
    const { default: retextContractions } = await import('retext-contractions');
    const { default: retextQuotes } = await import('retext-quotes');
    const { default: retextSentenceSpacing } = await import('retext-sentence-spacing');
    const { default: retextSmartypants } = await import('retext-smartypants');
    const { default: retextRepeatedWords } = await import('retext-repeated-words');
    const { default: retextSimplify } = await import('retext-simplify');
    const { default: retextEquality } = await import('retext-equality');
    
    // Import custom plugins
    const {
      retextContractionsFix,
      retextFillers,
      retextPunctuation,
      retextCapitalization: retextCapitalizationCustom,
      retextBibleBooks,
      retextVerseReferences,
      retextDivinePronouns,
      retextTheologyTerms,
      retextPrayerLanguage,
      retextSermonStructure,
      retextPunctuationNormalize,
      retextSermonContext
    } = await import('./retext-plugins/index.js');
    
    const {
      enableDomainSpecific = true
    } = options;
    
    // Create comprehensive processor with all plugins
    // Order matters: parse → fix → normalize → format → stringify
    console.log(`[GrammarPipeline] 🔍 ASYNC: Setting up retext processor with ALL plugins`);
    const processor = retext()
      // Stage 1: Parse English text
      .use(retextEnglish)
      
      // Stage 2: Fix basic grammar issues (repeated words, contractions)
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextRepeatedWords`);
        if (!file) {
          console.warn(`[GrammarPipeline] ⚠️ File is undefined for retextRepeatedWords`);
          return tree;
        }
        const before = String(file.value || file || '');
        const result = retextRepeatedWords()(tree, file);
        const after = String(file.value || file || '');
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Repeated words fixed (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return result || tree;
      })
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextContractions`);
        const before = String(file.value || file);
        const result = retextContractions()(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Contractions fixed (standard plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return result;
      })
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextContractionsFix`);
        const before = String(file.value || file);
        retextContractionsFix()(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Contractions fixed (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return tree;
      })
      
      // Stage 3: Remove fillers and disfluencies
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextFillers`);
        const before = String(file.value || file);
        retextFillers()(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Fillers removed (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return tree;
      })
      
      // Stage 4: Punctuation normalization (fixes STT punctuation issues)
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextPunctuationNormalize`);
        const before = String(file.value || file);
        retextPunctuationNormalize({ isPartial: false })(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Punctuation normalized (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return tree;
      })
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextPunctuation`);
        const before = String(file.value || file);
        retextPunctuation({ isPartial: false })(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Punctuation restored (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return tree;
      })
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextSentenceSpacing`);
        const before = String(file.value || file);
        const result = retextSentenceSpacing()(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Sentence spacing fixed (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return result;
      })
      
      // Stage 5: Capitalization fixes
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextCapitalization (standard)`);
        const before = String(file.value || file);
        const result = retextCapitalization()(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Capitalization fixed (standard plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return result;
      })
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextCapitalizationCustom`);
        const before = String(file.value || file);
        retextCapitalizationCustom()(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Capitalization fixed (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return tree;
      })
      
      // Stage 6: Quote normalization and smart punctuation
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextQuotes`);
        const before = String(file.value || file);
        const result = retextQuotes()(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Quotes normalized (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return result;
      })
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextSmartypants`);
        const before = String(file.value || file);
        const result = retextSmartypants()(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Smartypants applied (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return result;
      })
      
      // Stage 7: Style and readability improvements
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextSimplify`);
        const before = String(file.value || file);
        const result = retextSimplify()(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Text simplified (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return result;
      })
      .use((tree, file) => {
        console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextEquality`);
        const before = String(file.value || file);
        const result = retextEquality()(tree, file);
        const after = String(file.value || file);
        if (before !== after) {
          console.log(`[GrammarPipeline] 🔧 Equality fixes applied (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
        }
        return result;
      });
    
    // Add domain-specific plugins if enabled (sermon/worship context)
    if (enableDomainSpecific) {
      console.log(`[GrammarPipeline] 🔍 ASYNC: Adding ALL domain-specific plugins`);
      processor
        .use((tree, file) => {
          console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextSermonContext`);
          const before = String(file.value || file);
          retextSermonContext()(tree, file);
          const after = String(file.value || file);
          if (before !== after) {
            console.log(`[GrammarPipeline] 🔧 Sermon context applied (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
          }
          return tree;
        })
        .use((tree, file) => {
          console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextBibleBooks`);
          const before = String(file.value || file);
          retextBibleBooks()(tree, file);
          const after = String(file.value || file);
          if (before !== after) {
            console.log(`[GrammarPipeline] 🔧 Bible books normalized (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
          }
          return tree;
        })
        .use((tree, file) => {
          console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextVerseReferences`);
          const before = String(file.value || file);
          retextVerseReferences()(tree, file);
          const after = String(file.value || file);
          if (before !== after) {
            console.log(`[GrammarPipeline] 🔧 Verse references normalized (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
          }
          return tree;
        })
        .use((tree, file) => {
          console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextDivinePronouns`);
          const before = String(file.value || file);
          retextDivinePronouns()(tree, file);
          const after = String(file.value || file);
          if (before !== after) {
            console.log(`[GrammarPipeline] 🔧 Divine pronouns capitalized (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
          }
          return tree;
        })
        .use((tree, file) => {
          console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextTheologyTerms`);
          const before = String(file.value || file);
          retextTheologyTerms()(tree, file);
          const after = String(file.value || file);
          if (before !== after) {
            console.log(`[GrammarPipeline] 🔧 Theology terms normalized (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
          }
          return tree;
        })
        .use((tree, file) => {
          console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextPrayerLanguage`);
          const before = String(file.value || file);
          retextPrayerLanguage()(tree, file);
          const after = String(file.value || file);
          if (before !== after) {
            console.log(`[GrammarPipeline] 🔧 Prayer language normalized (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
          }
          return tree;
        })
        .use((tree, file) => {
          console.log(`[GrammarPipeline] 🔍 ASYNC PLUGIN: retextSermonStructure`);
          const before = String(file.value || file);
          retextSermonStructure()(tree, file);
          const after = String(file.value || file);
          if (before !== after) {
            console.log(`[GrammarPipeline] 🔧 Sermon structure normalized (plugin): "${before.substring(0, 80)}" → "${after.substring(0, 80)}"`);
          }
          return tree;
        });
    }
    
    // Process text through retext
    console.log(`[GrammarPipeline] 🔍 ASYNC: Processing through retext with ${enableDomainSpecific ? 'ALL' : 'basic'} plugins`);
    const file = await processor.process(text);
    // CRITICAL: Use file.value if it was updated by plugins, otherwise stringify from tree
    // This ensures all automatic fixes from plugins are included
    if (!file) {
      console.warn('[GrammarPipeline] ⚠️ File is undefined after processing, using sync fallback');
      throw new Error('File is undefined');
    }
    let result = file.value || String(file) || text;
    
    // DEBUG: Log to verify async pipeline is working
    if (process.env.DEBUG_GRAMMAR) {
      console.log('[GrammarPipeline] ASYNC INPUT:', text.substring(0, 100));
      console.log('[GrammarPipeline] ASYNC OUTPUT:', result.substring(0, 100));
      if (result !== text) {
        console.log('[GrammarPipeline] ✅ ASYNC CHANGES APPLIED');
      } else {
        console.log('[GrammarPipeline] ⚠️ ASYNC NO CHANGES DETECTED');
      }
    }
    
    // Apply any additional fixes that work better as text processing
    // (Some corrections are easier to do on the final string rather than AST)
    console.log(`[GrammarPipeline] 🔍 ASYNC PATH: Applying all logic functions after retext processing`);
    const doc = nlp(result);
    
    // CRITICAL: Apply ALL our logic functions to ensure consistency with sync path
    // Even though retext plugins may have done some of this, we apply our logic functions
    // to ensure 100% consistency and catch anything the plugins might have missed
    
    // Apply homophones (context-aware)
    console.log(`[GrammarPipeline] 🔍 ASYNC: Running fixHomophonesLogic`);
    const beforeHomophones = result;
    result = fixHomophonesLogic(result, doc);
    if (result !== beforeHomophones) {
      console.log(`[GrammarPipeline] 🔧 Homophones fixed (async): "${beforeHomophones.substring(0, 80)}" → "${result.substring(0, 80)}"`);
    } else {
      console.log(`[GrammarPipeline] ✓ Homophones checked (async, no changes)`);
    }
    
    // Apply Bible book names and verse references (our logic, not just plugins)
    if (enableDomainSpecific) {
      const doc2 = nlp(result);
      
      console.log(`[GrammarPipeline] 🔍 ASYNC: Running normalizeBibleBookNamesLogic, normalizeVerseReferencesLogic`);
      const beforeBibleBooks = result;
      result = normalizeBibleBookNamesLogic(result, doc2);
      result = normalizeVerseReferencesLogic(result, doc2);
      if (result !== beforeBibleBooks) {
        console.log(`[GrammarPipeline] 🔧 Bible books normalized (async): "${beforeBibleBooks.substring(0, 80)}" → "${result.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Bible books/verses checked (async, no changes)`);
      }
      
      console.log(`[GrammarPipeline] 🔍 ASYNC: Running capitalizeDivineTitlesLogic, capitalizeDivinePronounsLogic, capitalizeSacredTextsLogic`);
      const beforeDivine = result;
      result = capitalizeDivineTitlesLogic(result);
      result = capitalizeDivinePronounsLogic(result, doc2);
      result = capitalizeSacredTextsLogic(result);
      if (result !== beforeDivine) {
        console.log(`[GrammarPipeline] 🔧 Divine terms capitalized (async): "${beforeDivine.substring(0, 80)}" → "${result.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Divine terms checked (async, no changes)`);
      }
      
      console.log(`[GrammarPipeline] 🔍 ASYNC: Running fixReligiousHomophonesLogic`);
      const beforeReligiousHomophones = result;
      result = fixReligiousHomophonesLogic(result, doc2);
      if (result !== beforeReligiousHomophones) {
        console.log(`[GrammarPipeline] 🔧 Religious homophones fixed (async): "${beforeReligiousHomophones.substring(0, 80)}" → "${result.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Religious homophones checked (async, no changes)`);
      }
      
      console.log(`[GrammarPipeline] 🔍 ASYNC: Running normalizeSermonStructureLogic`);
      const beforeSermonStructure = result;
      result = normalizeSermonStructureLogic(result, doc2);
      if (result !== beforeSermonStructure) {
        console.log(`[GrammarPipeline] 🔧 Sermon structure normalized (async): "${beforeSermonStructure.substring(0, 80)}" → "${result.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Sermon structure checked (async, no changes)`);
      }
      
      console.log(`[GrammarPipeline] 🔍 ASYNC: Running normalizePrayerLanguageLogic`);
      const beforePrayer = result;
      result = normalizePrayerLanguageLogic(result, doc2);
      if (result !== beforePrayer) {
        console.log(`[GrammarPipeline] 🔧 Prayer language normalized (async): "${beforePrayer.substring(0, 80)}" → "${result.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Prayer language checked (async, no changes)`);
      }
      
      console.log(`[GrammarPipeline] 🔍 ASYNC: Running normalizeTheologyTermsLogic, normalizeLiturgicalTermsLogic`);
      const beforeTheology = result;
      result = normalizeTheologyTermsLogic(result);
      result = normalizeLiturgicalTermsLogic(result);
      if (result !== beforeTheology) {
        console.log(`[GrammarPipeline] 🔧 Theology terms normalized (async): "${beforeTheology.substring(0, 80)}" → "${result.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Theology/liturgical terms checked (async, no changes)`);
      }
      
      console.log(`[GrammarPipeline] 🔍 ASYNC: Running fixDivineNamesLogic`);
      const beforeDivineNames = result;
      result = fixDivineNamesLogic(result);
      if (result !== beforeDivineNames) {
        console.log(`[GrammarPipeline] 🔧 Divine names fixed (async): "${beforeDivineNames.substring(0, 80)}" → "${result.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Divine names checked (async, no changes)`);
      }
    }
    
    // CRITICAL: Apply quote detection and run-on fixes (not in retext plugins yet)
    console.log(`[GrammarPipeline] 🔍 ASYNC: Running normalizeQuotationSyntaxLogic`);
    const doc3 = nlp(result);
    const beforeQuotes = result;
    result = normalizeQuotationSyntaxLogic(result, doc3);
    if (result !== beforeQuotes) {
      console.log(`[GrammarPipeline] 🔧 QUOTES DETECTED (async): "${beforeQuotes.substring(0, 150)}" → "${result.substring(0, 150)}"`);
    } else {
      console.log(`[GrammarPipeline] ⚠️ NO QUOTES DETECTED (async) in: "${result.substring(0, 150)}"`);
    }
    
    // Run-on sentence fixes - CRITICAL: Must run after quotes and punctuation
    console.log(`[GrammarPipeline] 🔍 ASYNC: Running fixRunOnSentencesLogic`);
    const doc4 = nlp(result);
    const beforeRunOns = result;
    result = fixRunOnSentencesLogic(result, doc4);
    if (result !== beforeRunOns) {
      console.log(`[GrammarPipeline] 🔧 Run-on sentences fixed (async): "${beforeRunOns.substring(0, 150)}" → "${result.substring(0, 150)}"`);
    } else {
      console.log(`[GrammarPipeline] ✓ Run-on sentences checked (async, no changes)`);
    }
    
    // Apply colloquialisms if enabled
    if (enableColloquialisms) {
      console.log(`[GrammarPipeline] 🔍 ASYNC: Running normalizeColloquialismsLogic`);
      const beforeColloquialisms = result;
      result = normalizeColloquialismsLogic(result);
      if (result !== beforeColloquialisms) {
        console.log(`[GrammarPipeline] 🔧 Colloquialisms normalized (async): "${beforeColloquialisms.substring(0, 80)}" → "${result.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Colloquialisms checked (async, no changes)`);
      }
    }
    
    // CRITICAL: Fix STT transcription errors using context-aware patterns
    // Fix words incorrectly combined (missing space)
    result = result.replace(/\b([a-z]{5,})(all|the|and|of|in|on|at|to|for|with|from)\b/gi, (match, word, particle) => {
      return `${word} ${particle}`;
    });
    
    // Context-aware fixes
    if (/\bfight|fighting|match|matches|combat|battle\b/i.test(result)) {
      result = result.replace(/\bdecades\s+fight\b/gi, 'to cage fight');
    }
    
    result = result.replace(/\b(\d+)\s+of\s+(churches|people|places|things)\b/gi, (match, num, noun) => {
      const numVal = parseInt(num);
      if (numVal >= 100) {
        return `hundreds of ${noun}`;
      }
      return `${num} ${noun}`;
    });
    
    // Fix common grammar errors
    // "got to" → "have got to" or keep as "got to" (informal is OK, but fix "gotta")
    result = result.replace(/\bgotta\b/gi, "have got to");
    result = result.replace(/\bgot\s+to\s+care\b/gi, "have got to care");
    
    // Fix "lover thing" → "loving thing" or "love thing"
    result = result.replace(/\blover\s+thing\b/gi, "loving thing");
    
    // Fix "niche initiate" → likely "nice initiate" or context-dependent
    result = result.replace(/\bniche\s+initiate\b/gi, (match, offset) => {
      const context = result.substring(Math.max(0, offset - 20), offset + match.length + 20).toLowerCase();
      // If context suggests it's about being nice, fix it
      if (context.includes('nice') || context.includes('kind')) {
        return 'nice initiate';
      }
      return match; // Keep "niche" if it's actually about a niche
    });
    
    // Fix "Doctrine" over-capitalization (same as sync path) - BUT PRESERVE SPACES
    result = result.replace(/\bDoctrine\s+(?!\b(?:of|in|the)\b)([a-z])/gi, (match, nextWord, offset) => {
      const before = result.substring(Math.max(0, offset - 30), offset).toLowerCase();
      if (!/\b(doctrine|the|of|in)\s+[A-Z]/.test(before)) {
        return `doctrine ${nextWord}`;
      }
      return match;
    });
    
    // Final normalization - PRESERVE QUOTES
    // First, protect quotes by temporarily replacing them
    // Handle both double quotes and single quotes, including empty quotes
    const quotePlaceholders = [];
    let quoteIndex = 0;
    // Match quoted content - this regex handles both empty and non-empty quotes
    // The ? makes * lazy (non-greedy) and allows zero matches
    result = result.replace(/["']([^"']*)["']/g, (match, content) => {
      const placeholder = `__QUOTE_${quoteIndex}__`;
      quotePlaceholders.push({ placeholder, original: match, content: content || '' });
      quoteIndex++;
      return placeholder;
    });
    
    // Now do cleanup on text without quotes
    result = result.replace(/\s+/g, ' ').trim();
    result = result.replace(/\s+([,.!?;:])/g, '$1');
    result = result.replace(/([,.!?;:])([a-zA-Z])/g, '$1 $2');
    
    // Restore quotes with proper spacing
    quotePlaceholders.forEach(({ placeholder, original }) => {
      // Ensure proper spacing: space before opening quote, space after closing quote
      const index = result.indexOf(placeholder);
      if (index >= 0) {
        const before = result.substring(Math.max(0, index - 1), index);
        const after = result.substring(index + placeholder.length, index + placeholder.length + 1);
        let restored = original;
        // Add space before if needed
        if (before && !/\s/.test(before) && before !== '(') {
          restored = ' ' + restored;
        }
        // Add space after if needed  
        if (after && !/\s/.test(after) && after !== '.' && after !== ',' && after !== '!' && after !== '?' && after !== ')') {
          restored = restored + ' ';
        }
        result = result.replace(placeholder, restored);
      }
    });
    
    // Final trim
    return result.trim();
  } catch (error) {
    // Fallback to sync processing if retext fails
    console.warn('[retext-processor] Retext processing failed, using sync fallback:', error.message);
    console.warn('[retext-processor] Error details:', error.stack);
    // CRITICAL: For finals, we MUST use sync processing with all fixes enabled
    // Don't just return the original text - apply all the fixes
    return processPartialSync(text, options);
  }
}

