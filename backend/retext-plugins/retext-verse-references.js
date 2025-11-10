/**
 * Retext Plugin: Normalize Verse References
 * Formats verse references like "Genesis one one" → "Genesis 1:1"
 * AUTOMATICALLY APPLIES FIXES
 */

import nlp from 'compromise';
import { normalizeVerseReferencesLogic } from './logic.js';

export function retextVerseReferences() {
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    
    // Apply verse reference fixes - AUTOMATICALLY APPLIES ALL FIXES
    const doc = nlp(originalText);
    const fixed = normalizeVerseReferencesLogic(originalText, doc);
    
    // CRITICAL: Automatically apply the fix
    if (fixed !== originalText) {
      file.value = fixed;
      // Note: The tree will be automatically updated when retext processes the file
    }
  };
}

