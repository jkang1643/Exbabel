/**
 * Retext Plugin: Capitalization Fixes
 * Capitalizes sentences, proper nouns, pronouns, acronyms
 * AUTOMATICALLY APPLIES FIXES by mutating the file value
 */

import {
  capitalizeSentencesLogic,
  fixPronounILogic,
  capitalizeProperNounsLogic,
  capitalizeAcronymsLogic
} from './logic.js';

export function retextCapitalization() {
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    
    // Apply capitalization fixes - ALL fixes are automatically applied
    let fixed = originalText;
    fixed = capitalizeSentencesLogic(fixed);
    fixed = fixPronounILogic(fixed);
    fixed = capitalizeProperNounsLogic(fixed);
    fixed = capitalizeAcronymsLogic(fixed);
    
    // CRITICAL: Automatically apply the fix by updating file.value
    if (fixed !== originalText) {
      file.value = fixed;
      // Note: The tree will be automatically updated when retext processes the file
      // The fixed text is now in file.value, so subsequent plugins will see the fixed version
    }
  };
}

