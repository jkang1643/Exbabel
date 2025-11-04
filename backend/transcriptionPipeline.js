/**
 * Transcription Pipeline - Main orchestrator for comprehensive transcription cleanup
 * 
 * Uses hybrid approach:
 * - Partials: Fast synchronous processing (<10ms) via processPartialSync
 * - Finals: Comprehensive async processing (~100-200ms) via processWithRetext
 * 
 * Both paths use the same correction logic from retext-plugins/logic.js
 * to ensure 100% consistency.
 */

import { processPartialSync, processWithRetext } from './retext-processor.js';
import {
  normalizeNumbers,
  normalizeDates,
  normalizeTimes,
  normalizeUnits,
  insertMissingWords
} from './transcriptionCleanup.js';
import { protectedWords } from './cleanupRules.js';

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
 * - Partials: Fast synchronous processing via processPartialSync (<10ms)
 * - Finals: Comprehensive async processing via processWithRetext (~100-200ms)
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
  
  const {
    enableNumbers = false,      // Convert "twenty five" → "25"
    enableDates = true,         // Normalize dates
    enableTimes = true,         // Normalize times
    enableColloquialisms = true, // "gonna" → "going to"
    enableDomainSpecific = true  // Bible/worship terms
  } = options;
  
  if (isPartial) {
    // FAST PATH: Use synchronous processing for partials (<10ms latency)
    // This ensures instant feedback for live partial transcripts
    let text = processPartialSync(rawText, {
      enableNumbers,
      enableDates,
      enableTimes,
      enableColloquialisms,
      enableDomainSpecific
    });
    
    // Apply additional fixes that aren't in the sync processor yet
    if (enableDates) {
      console.log(`[GrammarPipeline] 🔍 SYNC: Running normalizeDates`);
      const beforeDates = text;
      text = normalizeDates(text);
      if (text !== beforeDates) {
        console.log(`[GrammarPipeline] 🔧 Dates normalized (sync): "${beforeDates.substring(0, 80)}" → "${text.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Dates checked (sync, no changes)`);
      }
    }
    if (enableTimes) {
      console.log(`[GrammarPipeline] 🔍 SYNC: Running normalizeTimes`);
      const beforeTimes = text;
      text = normalizeTimes(text);
      if (text !== beforeTimes) {
        console.log(`[GrammarPipeline] 🔧 Times normalized (sync): "${beforeTimes.substring(0, 80)}" → "${text.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Times checked (sync, no changes)`);
      }
    }
    if (enableNumbers) {
      console.log(`[GrammarPipeline] 🔍 SYNC: Running normalizeNumbers`);
      const beforeNumbers = text;
      text = normalizeNumbers(text);
      if (text !== beforeNumbers) {
        console.log(`[GrammarPipeline] 🔧 Numbers normalized (sync): "${beforeNumbers.substring(0, 80)}" → "${text.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Numbers checked (sync, no changes)`);
      }
    }
    
    // Fix common grammar issues
    console.log(`[GrammarPipeline] 🔍 SYNC: Running insertMissingWords, article fixes`);
    const beforeGrammar = text;
    text = insertMissingWords(text);
    text = text.replace(/\ba\s+([aeiouAEIOU])/g, 'an $1');
    text = text.replace(/\ban\s+([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/gi, 'a $1');
    if (text !== beforeGrammar) {
      console.log(`[GrammarPipeline] 🔧 Grammar fixes applied (sync): "${beforeGrammar.substring(0, 80)}" → "${text.substring(0, 80)}"`);
    } else {
      console.log(`[GrammarPipeline] ✓ Grammar fixes checked (sync, no changes)`);
    }
    
    return text;
  } else {
    // COMPREHENSIVE PATH: Use async retext processing for finals (~100-200ms)
    // This provides more thorough cleanup using retext's AST-based processing
    console.log(`[GrammarPipeline] 🚀 STARTING ASYNC PIPELINE (FINAL): "${rawText.substring(0, 100)}${rawText.length > 100 ? '...' : ''}"`);
    console.log(`[GrammarPipeline] 📊 Options: enableNumbers=${enableNumbers}, enableDates=${enableDates}, enableTimes=${enableTimes}, enableColloquialisms=${enableColloquialisms}, enableDomainSpecific=${enableDomainSpecific}`);
    
    const result = processWithRetext(rawText, {
      enableNumbers,
      enableDates,
      enableTimes,
      enableColloquialisms,
      enableDomainSpecific
    }).then(text => {
      // Apply additional fixes that work better as text processing
      if (enableDates) {
        console.log(`[GrammarPipeline] 🔍 Running: normalizeDates`);
        const beforeDates = text;
        text = normalizeDates(text);
        if (text !== beforeDates) {
          console.log(`[GrammarPipeline] 🔧 Dates normalized: "${beforeDates.substring(0, 80)}" → "${text.substring(0, 80)}"`);
        } else {
          console.log(`[GrammarPipeline] ✓ Dates checked (no changes)`);
        }
      }
      if (enableTimes) {
        console.log(`[GrammarPipeline] 🔍 Running: normalizeTimes`);
        const beforeTimes = text;
        text = normalizeTimes(text);
        if (text !== beforeTimes) {
          console.log(`[GrammarPipeline] 🔧 Times normalized: "${beforeTimes.substring(0, 80)}" → "${text.substring(0, 80)}"`);
        } else {
          console.log(`[GrammarPipeline] ✓ Times checked (no changes)`);
        }
      }
      if (enableNumbers) {
        console.log(`[GrammarPipeline] 🔍 Running: normalizeNumbers`);
        const beforeNumbers = text;
        text = normalizeNumbers(text);
        if (text !== beforeNumbers) {
          console.log(`[GrammarPipeline] 🔧 Numbers normalized: "${beforeNumbers.substring(0, 80)}" → "${text.substring(0, 80)}"`);
        } else {
          console.log(`[GrammarPipeline] ✓ Numbers checked (no changes)`);
        }
      }
      
      // Fix common grammar issues
      console.log(`[GrammarPipeline] 🔍 Running: insertMissingWords, article fixes`);
      const beforeGrammar = text;
      text = insertMissingWords(text);
      text = text.replace(/\ba\s+([aeiouAEIOU])/g, 'an $1');
      text = text.replace(/\ban\s+([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/gi, 'a $1');
      if (text !== beforeGrammar) {
        console.log(`[GrammarPipeline] 🔧 Grammar fixes applied: "${beforeGrammar.substring(0, 80)}" → "${text.substring(0, 80)}"`);
      } else {
        console.log(`[GrammarPipeline] ✓ Grammar fixes checked (no changes)`);
      }
      
      return text;
    });
  }
}

/**
 * Clean partial transcript (wrapper for cleanTranscription with isPartial=true)
 * Synchronous - returns immediately
 */
export function cleanPartialTranscription(rawText, options = {}) {
  return cleanTranscription(rawText, true, options);
}

/**
 * Clean final transcript (wrapper for cleanTranscription with isPartial=false)
 * Async - returns Promise
 */
export function cleanFinalTranscription(rawText, options = {}) {
  return cleanTranscription(rawText, false, options);
}

