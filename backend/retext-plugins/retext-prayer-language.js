/**
 * Retext Plugin: Normalize Prayer Language
 * Normalizes prayer phrases like "Dear Lord please" → "Dear Lord, please"
 * AUTOMATICALLY APPLIES FIXES
 */

import nlp from 'compromise';
import { normalizePrayerLanguageLogic } from './logic.js';

export function retextPrayerLanguage() {
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    
    // Apply prayer language fixes - AUTOMATICALLY APPLIES ALL FIXES
    const doc = nlp(originalText);
    const fixed = normalizePrayerLanguageLogic(originalText, doc);
    
    // CRITICAL: Automatically apply the fix
    if (fixed !== originalText) {
      file.value = fixed;
      // Note: The tree will be automatically updated when retext processes the file
    }
  };
}

