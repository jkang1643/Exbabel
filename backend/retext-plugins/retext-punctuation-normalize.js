/**
 * Retext Plugin: Comprehensive Punctuation Normalization
 * 
 * Fixes common STT punctuation issues:
 * - Removes duplicated punctuation (.., !!, ??)
 * - Removes excessive commas mid-sentence
 * - Adds missing periods at sentence boundaries
 * - Fixes punctuation spacing issues
 * - Handles fillers and pauses correctly
 * 
 * AUTOMATICALLY APPLIES FIXES
 */

import { visit } from 'unist-util-visit';
import nlp from 'compromise';

export function retextPunctuationNormalize(options = {}) {
  const { isPartial = false } = options;
  
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    let result = originalText;
    
    // Rule 1: Remove duplicated punctuation (multiple periods, commas, etc.)
    // "hello.." → "hello." but keep "..." for ellipsis
    result = result.replace(/([.!?])\1{2,}/g, '...'); // Keep ellipsis
    result = result.replace(/([.!?])\1{2,}/g, '$1'); // Remove excess duplicates
    result = result.replace(/([,;:])\1+/g, '$1'); // Remove duplicate commas/semicolons
    
    // Rule 2: Remove excessive commas mid-sentence (common STT error)
    // "we were, talking about faith" → "we were talking about faith"
    // But keep commas after introductory phrases and in lists
    const doc = nlp(result);
    
    // Simple pattern: comma between two lowercase words that aren't in a list
    // Only remove if it's clearly a pause artifact, not grammatical
    result = result.replace(/\b([a-z]+),\s+([a-z]{3,})\s+(about|with|to|from|for|in|on|at|the|a|an)\b/gi, (match, before, word, next) => {
      // Keep comma if it's part of a list pattern
      if (/^(and|or|but|nor|so|yet)\s+/i.test(word)) {
        return match; // Keep comma before conjunction
      }
      
      // Keep comma after common introductory words
      const introWords = ['after', 'before', 'during', 'while', 'although', 'because', 'if', 'when', 'since', 'until', 'although', 'though'];
      if (introWords.includes(before.toLowerCase())) {
        return match; // Keep comma after introductory phrase
      }
      
      // Remove comma if it's clearly a pause artifact
      // Pattern: lowercase word, comma, lowercase word, preposition/article
      return `${before} ${word} ${next}`;
    });
    
    // Rule 3: Add missing periods at sentence boundaries
    // Only for final transcripts (not partials)
    if (!isPartial) {
      // Split by sentence boundaries
      const sentencePattern = /([.!?])\s+([A-Z])|([.!?])\s*$/;
      const sentences = result.split(/([.!?]+\s*)/);
      
      // Check each sentence for proper ending
      let fixedSentences = [];
      for (let i = 0; i < sentences.length; i++) {
        let sentence = sentences[i];
        if (!sentence || sentence.trim().length === 0) continue;
        
        // Skip if already has ending punctuation
        if (/[.!?]$/.test(sentence.trim())) {
          fixedSentences.push(sentence);
          continue;
        }
        
        // Check if sentence is complete (has subject and verb)
        const sentenceDoc = nlp(sentence);
        const hasSubject = sentenceDoc.match('#Noun').length > 0 || sentenceDoc.match('#Pronoun').length > 0;
        const hasVerb = sentenceDoc.match('#Verb').length > 0;
        
        // Only add period if sentence seems complete
        if (hasSubject && hasVerb && sentence.trim().length > 10) {
          // Check if next sentence starts with capital (indicates sentence break)
          const nextSentence = sentences[i + 1];
          if (nextSentence && /^[A-Z]/.test(nextSentence.trim())) {
            sentence = sentence.trim() + '.';
          }
        }
        
        fixedSentences.push(sentence);
      }
      
      result = fixedSentences.join(' ');
    }
    
    // Rule 4: Fix punctuation spacing
    // "word,word" → "word, word"
    result = result.replace(/([,.!?;:])([a-zA-Z])/g, '$1 $2');
    // "word  , word" → "word, word"
    result = result.replace(/\s+([,.!?;:])/g, '$1');
    
    // Rule 5: Handle fillers and pauses
    // "uh," "um," "you know," should be followed by proper spacing
    const fillerPatterns = [
      /\buh\s*,?\s*/gi,
      /\bum\s*,?\s*/gi,
      /\ber\s*,?\s*/gi,
      /\buhm\s*,?\s*/gi
    ];
    
    fillerPatterns.forEach(pattern => {
      result = result.replace(pattern, (match, offset) => {
        // Check if followed by capital letter (new sentence) or lowercase
        const after = result.substring(offset + match.length);
        if (/^[A-Z]/.test(after)) {
          return ''; // Remove filler before new sentence
        }
        return match.replace(/,\s*$/, ' '); // Remove comma, keep space
      });
    });
    
    // Rule 6: Fix incorrect punctuation from pauses
    // "we were, talking" → "we were talking" (if comma is from pause, not grammar)
    // This is more aggressive - only remove if comma is clearly wrong
    result = result.replace(/\b([a-z]+),\s+([a-z]{2,})\s+(about|with|to|from|for|in|on|at)\b/gi, (match, before, word, prep) => {
      // Check if comma is grammatically necessary
      const beforeDoc = nlp(before);
      const isObject = beforeDoc.match('#Noun').length > 0;
      const isList = /^(and|or|but)\s+/.test(word);
      
      // Remove comma if it's clearly a pause artifact
      if (!isObject && !isList) {
        return `${before} ${word} ${prep}`;
      }
      return match;
    });
    
    // Final cleanup: normalize whitespace
    result = result.replace(/\s+/g, ' ').trim();
    
    // CRITICAL: Automatically apply the fix
    if (result !== originalText) {
      file.value = result;
    }
  };
}

