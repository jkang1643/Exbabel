/**
 * Grammar Corrector - Pure JavaScript
 * Lightweight grammar correction using rule-based patterns
 * No external dependencies, no Python, no ML models
 */

export class GrammarCorrector {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.language = options.language || 'en-US';
    
    // Common grammar fixes
    this.fixes = [
      // Subject-verb agreement
      { pattern: /\b(this|that|it)\s+are\b/gi, replacement: '$1 is' },
      { pattern: /\b(these|those)\s+is\b/gi, replacement: '$1 are' },
      { pattern: /\b(they|we|you)\s+(is|was)\b/gi, replacement: '$1 are' },
      { pattern: /\b(he|she|it)\s+(are|were)\b/gi, replacement: '$1 is' },
      
      // Common verb mistakes
      { pattern: /\bwas\s+were\b/gi, replacement: 'was' },
      { pattern: /\bwere\s+was\b/gi, replacement: 'were' },
      { pattern: /\bhave\s+went\b/gi, replacement: 'have gone' },
      { pattern: /\bhas\s+went\b/gi, replacement: 'has gone' },
      
      // Article mistakes
      { pattern: /\ba\s+([aeiouAEIOU])/g, replacement: 'an $1' },
      { pattern: /\ban\s+([bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ])/gi, replacement: 'a $1' },
      
      // Common contractions
      { pattern: /\byou\s+are\b/gi, replacement: 'you\'re' },
      { pattern: /\bwe\s+are\b/gi, replacement: 'we\'re' },
      { pattern: /\bthey\s+are\b/gi, replacement: 'they\'re' },
      { pattern: /\bI\s+am\b/gi, replacement: 'I\'m' },
      { pattern: /\bit\s+is\b/gi, replacement: 'it\'s' },
      { pattern: /\bthat\s+is\b/gi, replacement: 'that\'s' },
      
      // Capitalization of "I"
      { pattern: /\s+i\s+/g, replacement: ' I ' },
      
      // Double spaces
      { pattern: /\s{2,}/g, replacement: ' ' },
      
      // Space before punctuation
      { pattern: /\s+([,.!?;:])/g, replacement: '$1' },
      
      // Missing space after punctuation
      { pattern: /([,.!?;:])([a-zA-Z])/g, replacement: '$1 $2' },
    ];
  }

  /**
   * Capitalize first letter of sentences
   */
  capitalizeSentences(text) {
    if (!text || text.length === 0) return text;
    
    // Split by sentence endings
    const sentences = text.split(/([.!?]\s*)/);
    let result = '';
    let capitalizeNext = true;
    
    for (let i = 0; i < sentences.length; i++) {
      let sentence = sentences[i];
      
      // Check if this is a sentence ending
      if (/^[.!?]\s*$/.test(sentence)) {
        result += sentence;
        capitalizeNext = true;
        continue;
      }
      
      // Capitalize if needed
      if (capitalizeNext && sentence.length > 0) {
        sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
        capitalizeNext = false;
      }
      
      result += sentence;
    }
    
    // Ensure first character is capitalized
    if (result.length > 0) {
      result = result.charAt(0).toUpperCase() + result.slice(1);
    }
    
    return result;
  }

  /**
   * Add proper punctuation if missing at end
   */
  addEndingPunctuation(text) {
    if (!text || text.trim().length === 0) return text;
    
    const trimmed = text.trim();
    const lastChar = trimmed[trimmed.length - 1];
    
    // If already has ending punctuation, return as is
    if (/[.!?]/.test(lastChar)) {
      return text;
    }
    
    // Simple heuristics for question marks
    const questionWords = ['what', 'where', 'when', 'why', 'how', 'who', 'which', 'whose'];
    const lowerText = trimmed.toLowerCase();
    const hasQuestionWord = questionWords.some(word => 
      lowerText.includes(word + ' ') || lowerText.startsWith(word)
    );
    
    // Check for question patterns
    const endsWithQuestion = /\b(what|where|when|why|how|who|which|whose|can|will|would|could|should|do|does|did|is|are|was|were|am)\b/i.test(lowerText);
    
    if (hasQuestionWord || endsWithQuestion) {
      return trimmed + '?';
    }
    
    // Default to period
    return trimmed + '.';
  }

  /**
   * Fix common grammar issues
   */
  applyGrammarFixes(text) {
    if (!text || text.length === 0) return text;
    
    let corrected = text;
    
    // Apply all fixes
    for (const fix of this.fixes) {
      corrected = corrected.replace(fix.pattern, fix.replacement);
    }
    
    return corrected;
  }

  /**
   * Restore punctuation and capitalization
   */
  restorePunctuation(text) {
    if (!text || text.length === 0) return text;
    
    let result = text;
    
    // Fix spacing around punctuation
    result = result.replace(/\s+([,.!?;:])/g, '$1'); // Remove space before
    result = result.replace(/([,.!?;:])([a-zA-Z])/g, '$1 $2'); // Add space after
    
    return result;
  }

  /**
   * Correct grammar in text
   * @param {string} text - Text to correct
   * @param {string} language - Language code (mostly for future use)
   * @returns {Object} { corrected: string, matches: number }
   */
  correct(text, language = null) {
    if (!this.enabled || !text || text.trim().length === 0) {
      return {
        corrected: text || '',
        matches: 0
      };
    }

    try {
      const original = text.trim();
      let corrected = original;
      
      // Step 1: Apply grammar fixes
      corrected = this.applyGrammarFixes(corrected);
      
      // Step 2: Restore punctuation
      corrected = this.restorePunctuation(corrected);
      
      // Step 3: Add ending punctuation if missing
      corrected = this.addEndingPunctuation(corrected);
      
      // Step 4: Capitalize sentences
      corrected = this.capitalizeSentences(corrected);
      
      // Count approximate changes (simple heuristic)
      const matches = corrected !== original ? 1 : 0;
      
      return {
        corrected: corrected.trim(),
        matches
      };
    } catch (error) {
      console.warn('[GrammarCorrector] Error correcting text:', error);
      return {
        corrected: text,
        matches: 0
      };
    }
  }

  /**
   * Check text for issues (placeholder for now)
   * @param {string} text - Text to check
   * @returns {Array} List of detected issues (simplified)
   */
  check(text) {
    // Simple implementation - just returns empty array
    // Can be extended with more sophisticated checking
    return [];
  }
}

// Singleton instance
let correctorInstance = null;

export function getGrammarCorrector() {
  if (!correctorInstance) {
    correctorInstance = new GrammarCorrector();
  }
  return correctorInstance;
}

export default GrammarCorrector;

