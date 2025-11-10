/**
 * Retext Plugin: Capitalize Divine Pronouns
 * Capitalizes "He", "Him", "Your" when referring to God/Christ
 * AUTOMATICALLY APPLIES FIXES
 */

import nlp from 'compromise';
import { capitalizeDivinePronounsLogic } from './logic.js';

export function retextDivinePronouns() {
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    
    // Apply divine pronoun capitalization - AUTOMATICALLY APPLIES ALL FIXES
    const doc = nlp(originalText);
    const fixed = capitalizeDivinePronounsLogic(originalText, doc);
    
    // CRITICAL: Automatically apply the fix
    if (fixed !== originalText) {
      file.value = fixed;
      // Note: The tree will be automatically updated when retext processes the file
    }
  };
}

