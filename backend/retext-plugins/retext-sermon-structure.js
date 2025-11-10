/**
 * Retext Plugin: Normalize Sermon Structure
 * Formats sermon points like "Point number one" → "1."
 * AUTOMATICALLY APPLIES FIXES
 */

import nlp from 'compromise';
import { normalizeSermonStructureLogic } from './logic.js';

export function retextSermonStructure() {
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    
    // Apply sermon structure fixes - AUTOMATICALLY APPLIES ALL FIXES
    const doc = nlp(originalText);
    const fixed = normalizeSermonStructureLogic(originalText, doc);
    
    // CRITICAL: Automatically apply the fix
    if (fixed !== originalText) {
      file.value = fixed;
      // Note: The tree will be automatically updated when retext processes the file
    }
  };
}

