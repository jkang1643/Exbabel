/**
 * Retext Plugin: Remove Fillers
 * Removes filler words like "uh", "um", "you know"
 * AUTOMATICALLY APPLIES FIXES by working on full text
 */

import { removeFillersLogic } from './logic.js';

export function retextFillers() {
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    
    // Apply fillers removal - AUTOMATICALLY REMOVES ALL FILLERS
    const fixed = removeFillersLogic(originalText);
    
    // CRITICAL: Automatically apply the fix
    if (fixed !== originalText) {
      file.value = fixed;
      // Note: The tree will be automatically updated when retext processes the file
    }
  };
}

