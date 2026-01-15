/**
 * Bible Reference Normalizer
 * 
 * Normalizes transcript text for Bible reference detection:
 * - Lowercase text
 * - Strip punctuation
 * - Collapse whitespace
 * - Tokenize words
 * - Basic lemmatization
 * - Convert spoken numbers to integers
 */

import { findAllSpokenNumbers } from './spokenNumberParser.js';

/**
 * Basic lemmatization map (common word variations)
 */
const LEMMATIZATION_MAP = {
  'says': 'say',
  'said': 'say',
  'saying': 'say',
  'writes': 'write',
  'wrote': 'write',
  'writing': 'write',
  'written': 'write',
  'goes': 'go',
  'went': 'go',
  'going': 'go',
  'gone': 'go',
  'is': 'be',
  'are': 'be',
  'was': 'be',
  'were': 'be',
  'been': 'be',
  'being': 'be',
  'has': 'have',
  'had': 'have',
  'having': 'have',
  'does': 'do',
  'did': 'do',
  'doing': 'do',
  'done': 'do'
};

/**
 * Normalize transcript text for matching
 * 
 * @param {string} text - Raw transcript text
 * @returns {Object} Normalized text with tokens
 */
export function normalizeTranscript(text) {
  if (!text || typeof text !== 'string') {
    return {
      tokens: [],
      normalizedText: ''
    };
  }
  
  // Step 1: Lowercase
  let normalized = text.toLowerCase();
  
  // Step 2: Strip punctuation (keep spaces)
  normalized = normalized.replace(/[^\w\s]/g, ' ');
  
  // Step 3: Collapse whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();
  
  // Step 4: Tokenize words
  const rawTokens = normalized.split(/\s+/).filter(token => token.length > 0);
  
  // Step 5: Basic lemmatization
  const tokens = rawTokens.map(token => {
    // Check lemmatization map first
    if (LEMMATIZATION_MAP[token]) {
      return LEMMATIZATION_MAP[token];
    }
    
    // Special handling for common Bible-related words
    if (token === 'baptized' || token === 'baptised') {
      return 'baptize';
    }
    if (token === 'sins' || token === 'sin') {
      return 'sin';
    }
    
    // Remove common suffixes (basic stemming)
    // Only stem if word is long enough to avoid false matches
    if (token.endsWith('ing') && token.length > 5) {
      const stemmed = token.slice(0, -3);
      // Don't stem if result is too short (e.g., "sing" → "s" is wrong)
      if (stemmed.length >= 3) {
        return stemmed;
      }
    }
    if (token.endsWith('ed') && token.length > 4) {
      const stemmed = token.slice(0, -2);
      // Special case: "baptized" → "baptize" (not "baptiz")
      if (stemmed === 'baptiz') {
        return 'baptize';
      }
      if (stemmed.length >= 3) {
        return stemmed;
      }
    }
    if (token.endsWith('s') && token.length > 3) {
      const stemmed = token.slice(0, -1);
      // Don't stem if it would create invalid words
      if (stemmed.length >= 2) {
        return stemmed;
      }
    }
    return token;
  });
  
  // Step 6: Convert spoken numbers to integers (in place)
  // This is done during detection, not normalization, to preserve context
  
  return {
    tokens,
    normalizedText: tokens.join(' ')
  };
}

/**
 * Normalize a single word/token
 * 
 * @param {string} word - Word to normalize
 * @returns {string} Normalized word
 */
export function normalizeWord(word) {
  if (!word || typeof word !== 'string') return '';
  
  const lower = word.toLowerCase();
  
  // Apply lemmatization
  if (LEMMATIZATION_MAP[lower]) {
    return LEMMATIZATION_MAP[lower];
  }
  
  // Basic stemming
  if (lower.endsWith('ing') && lower.length > 5) {
    return lower.slice(0, -3);
  }
  if (lower.endsWith('ed') && lower.length > 4) {
    return lower.slice(0, -2);
  }
  if (lower.endsWith('s') && lower.length > 3) {
    return lower.slice(0, -1);
  }
  
  return lower;
}

export default {
  normalizeTranscript,
  normalizeWord
};

