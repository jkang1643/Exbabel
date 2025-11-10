/**
 * Retext Plugin: Restore Punctuation
 * Adds punctuation at sentence boundaries using NLP-based detection
 * AUTOMATICALLY APPLIES FIXES by mutating the file value
 */

import { visit } from 'unist-util-visit';
import nlp from 'compromise';
import { restorePunctuationLogic } from './logic.js';

export function retextPunctuation(options = {}) {
  const { isPartial = false } = options;
  
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    
    // Apply punctuation restoration logic
    const doc = nlp(originalText);
    const fixed = restorePunctuationLogic(originalText, isPartial, doc);
    
    // CRITICAL: Automatically apply the fix by updating file.value
    if (fixed !== originalText) {
      file.value = fixed;
      // Note: The tree will be automatically updated when retext processes the file
      // The fixed text is now in file.value, so subsequent plugins will see the fixed version
    }
  };
}

