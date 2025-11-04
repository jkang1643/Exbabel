/**
 * Retext Plugin: Normalize Bible Book Names
 * Fixes all 66 canonical books + mispronunciations
 * AUTOMATICALLY APPLIES FIXES
 */

import nlp from 'compromise';
import { normalizeBibleBookNamesLogic } from './logic.js';

export function retextBibleBooks() {
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    
    // Apply Bible book name fixes - AUTOMATICALLY APPLIES ALL FIXES
    const doc = nlp(originalText);
    const fixed = normalizeBibleBookNamesLogic(originalText, doc);
    
    // CRITICAL: Automatically apply the fix
    if (fixed !== originalText) {
      file.value = fixed;
      // Note: The tree will be automatically updated when retext processes the file
    }
  };
}

