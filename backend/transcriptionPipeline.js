/**
 * Transcription Pipeline - Main orchestrator for comprehensive transcription cleanup
 *
 * Uses hybrid approach:
 * - Partials: Ultra-fast (<1ms) synchronous processing - NO Xenova, just whitespace cleanup
 * - Finals: Comprehensive async processing (~100-200ms) with Xenova grammar correction
 *
 * ⚠️ CRITICAL: Partials do NOT use Xenova to avoid slowdown from frequent updates
 */

// Load environment variables FIRST
import './loadEnv.js';

import { processPartialSync, processWithRetext } from './retext-processor.js';
import {
  normalizeNumbers,
  normalizeDates,
  normalizeTimes,
  normalizeUnits,
  insertMissingWords
} from './transcriptionCleanup.js';
import { protectedWords } from './cleanupRules.js';
import { getGrammarCorrectorModel } from './grammarCorrectorModel.js';

// Initialize Xenova grammar model (enabled via ENABLE_XENOVA_GRAMMAR env variable)
console.log('[TranscriptionPipeline] Module loading... ENABLE_XENOVA_GRAMMAR=' + process.env.ENABLE_XENOVA_GRAMMAR);
const ENABLE_XENOVA_GRAMMAR = process.env.ENABLE_XENOVA_GRAMMAR === 'true';
console.log('[TranscriptionPipeline] Evaluated to:', ENABLE_XENOVA_GRAMMAR);
let grammarModel = null;

if (ENABLE_XENOVA_GRAMMAR) {
  console.log('[TranscriptionPipeline] Initializing Xenova model...');
  grammarModel = getGrammarCorrectorModel();
  console.log('[TranscriptionPipeline] 🚀 Xenova grammar model enabled - initializing in background...');
  grammarModel.init().catch(err => {
    console.warn('[TranscriptionPipeline] Xenova model initialization failed:', err.message);
  });
} else {
  console.log('[TranscriptionPipeline] ❌ Xenova model NOT enabled (ENABLE_XENOVA_GRAMMAR=' + process.env.ENABLE_XENOVA_GRAMMAR + ')');
}

/**
 * Normalize whitespace - clean up spacing issues
 */
function normalizeWhitespace(text) {
  if (!text || text.trim().length === 0) return text;
  
  let result = text;
  
  // Remove multiple spaces
  result = result.replace(/\s+/g, ' ');
  
  // Remove spaces at start/end
  result = result.trim();
  
  // Remove spaces before punctuation (but keep spaces after)
  result = result.replace(/\s+([,.!?;:])/g, '$1');
  
  // Ensure space after punctuation
  result = result.replace(/([,.!?;:])([a-zA-Z])/g, '$1 $2');
  
  return result;
}

/**
 * Correct common grammar issues
 */
function correctCommonGrammar(text) {
  let result = text;
  
  // Fix "He going" → "He is going" (already handled in insertMissingWords, but double-check)
  result = insertMissingWords(result);
  
  // Fix article mistakes: "a apple" → "an apple"
  result = result.replace(/\ba\s+([aeiouAEIOU])/g, 'an $1');
  result = result.replace(/\ban\s+([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/gi, 'a $1');
  
  return result;
}

/**
 * Final cleanup - remove extra spaces, ensure proper formatting
 */
function finalClean(text) {
  if (!text || text.trim().length === 0) return text;
  
  let result = text;
  
  // Remove multiple spaces
  result = result.replace(/\s+/g, ' ');
  
  // Remove spaces at start/end
  result = result.trim();
  
  // Ensure proper spacing around punctuation
  result = result.replace(/\s+([,.!?;:])/g, '$1');
  result = result.replace(/([,.!?;:])([a-zA-Z])/g, '$1 $2');
  
  return result;
}

/**
 * Check if word is protected (should not be corrected)
 */
function isProtected(word) {
  const wordLower = word.toLowerCase();
  return protectedWords.some(protectedWord => 
    wordLower === protectedWord.toLowerCase() || 
    wordLower.includes(protectedWord.toLowerCase()) ||
    protectedWord.toLowerCase().includes(wordLower)
  );
}

/**
 * Main transcription cleanup pipeline
 *
 * Uses hybrid approach:
 * - Partials: Ultra-fast synchronous - NO Xenova (just whitespace cleanup)
 * - Finals: Comprehensive async with Xenova grammar correction (~100-200ms)
 *
 * @param {string} rawText - Raw STT transcription text
 * @param {boolean} isPartial - Whether this is a partial (incomplete) transcript
 * @param {Object} options - Configuration options
 * @returns {string|Promise<string>} Cleaned, production-ready text
 */
export function cleanTranscription(rawText, isPartial = false, options = {}) {
  if (!rawText || rawText.trim().length === 0) {
    return rawText || '';
  }
  
  // TEMPORARILY DISABLED: All grammar pipeline steps except Xenova
  // const {
  //   enableNumbers = false,
  //   enableDates = true,
  //   enableTimes = true,
  //   enableColloquialisms = true,
  //   enableDomainSpecific = true
  // } = options;
  
  // Simple whitespace normalization only
  let text = rawText.trim().replace(/\s+/g, ' ');
  
  if (isPartial) {
    // PARTIALS: NO Xenova - return immediately for speed
    // Xenova grammar correction is ONLY for finals to avoid slowdown
    return text;
  } else {
    // FINALS: Only Xenova
    return (async () => {
      // Apply Xenova AI grammar model if enabled
      if (ENABLE_XENOVA_GRAMMAR && grammarModel) {
        try {
          const beforeXenova = text;
          const result = await grammarModel.correct(text);
          text = result.corrected || text;
          if (text !== beforeXenova) {
            console.log(`[GrammarPipeline] ✨ Xenova corrected (${result.matches} fix(es)): "${beforeXenova.substring(0, 80)}" → "${text.substring(0, 80)}"`);
          }
        } catch (xenovaError) {
          console.warn(`[GrammarPipeline] ⚠️ Xenova model error, using text as-is:`, xenovaError.message);
        }
      }
      
      return text;
    })();
  }
}

/**
 * Clean partial transcript (wrapper for cleanTranscription with isPartial=true)
 * Partials are FAST - no Xenova processing, just whitespace cleanup
 * Returns synchronous result wrapped in Promise for consistency
 */
export function cleanPartialTranscription(rawText, options = {}) {
  const result = cleanTranscription(rawText, true, options);
  // Partials return synchronously (no Xenova), wrap in Promise for consistency
  return Promise.resolve(result);
}

/**
 * Clean final transcript (wrapper for cleanTranscription with isPartial=false)
 * Async - returns Promise
 */
export function cleanFinalTranscription(rawText, options = {}) {
  return cleanTranscription(rawText, false, options);
}

