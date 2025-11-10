/**
 * Retext Plugin: Auto-fix Contractions
 * Mutates AST to automatically fix contractions like "dont" → "don't"
 * AUTOMATICALLY APPLIES FIXES by working on full text
 */

import { fixContractionsLogic } from './logic.js';

export function retextContractionsFix() {
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    
    // Apply contractions fix - AUTOMATICALLY APPLIES ALL FIXES
    const fixed = fixContractionsLogic(originalText);
    
    // CRITICAL: Automatically apply the fix
    if (fixed !== originalText) {
      file.value = fixed;
      // Note: The tree will be automatically updated when retext processes the file
    }
  };
}

