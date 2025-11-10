/**
 * Retext Plugin: Normalize Theology Terms
 * Normalizes terms like "new testament" → "New Testament"
 * AUTOMATICALLY APPLIES FIXES
 */

import { normalizeTheologyTermsLogic } from './logic.js';

export function retextTheologyTerms() {
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    
    // Apply theology term fixes - AUTOMATICALLY APPLIES ALL FIXES
    const fixed = normalizeTheologyTermsLogic(originalText);
    
    // CRITICAL: Automatically apply the fix
    if (fixed !== originalText) {
      file.value = fixed;
      // Note: The tree will be automatically updated when retext processes the file
    }
  };
}

