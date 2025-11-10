/**
 * Retext Plugin: Sermon-Specific Context Fixes
 * 
 * Fixes common worship/sermon transcription issues:
 * - Capitalizes divine names and titles
 * - Fixes prayer language formatting
 * - Handles worship phrases correctly
 * - Normalizes religious terminology
 * 
 * AUTOMATICALLY APPLIES FIXES
 */

export function retextSermonContext() {
  return (tree, file) => {
    // Get current text from file
    const originalText = String(file.value || file.toString());
    let result = originalText;
    
    // Fix common worship-specific capitalization and formatting
    const worshipFixes = [
      // Divine names and titles
      { pattern: /\bdear lord\b/gi, replacement: 'Dear Lord' },
      { pattern: /\boh god\b/gi, replacement: 'O God' },
      { pattern: /\boh lord\b/gi, replacement: 'O Lord' },
      { pattern: /\bhallelujah\b/gi, replacement: 'Hallelujah!' },
      { pattern: /\bam[eé]n\b/gi, replacement: 'Amen.' },
      { pattern: /\bjesus\b/gi, replacement: 'Jesus' },
      { pattern: /\bgod\b/gi, replacement: (match, offset) => {
        // Only capitalize if it's referring to deity, not "god" as in "a god"
        const before = result.substring(Math.max(0, offset - 20), offset);
        const after = result.substring(offset + match.length, offset + match.length + 20);
        // Lowercase if preceded by "a" or "an" (indefinite article)
        if (/\b(a|an)\s+god\b/i.test(before + match + after)) {
          return match.toLowerCase();
        }
        // Capitalize if it's clearly referring to the deity
        if (/\b(thank|praise|worship|pray|serve|believe|trust|love|follow|Lord|Father|Son|Spirit)\s+god\b/i.test(before + match + after)) {
          return 'God';
        }
        // Default to capitalized for sermon context
        return 'God';
      }},
      
      // Prayer language formatting
      { pattern: /\bdear lord\s+please\b/gi, replacement: 'Dear Lord, please' },
      { pattern: /\bfather god\s+we\b/gi, replacement: 'Father God, we' },
      { pattern: /\bheavenly father\s+thank\b/gi, replacement: 'Heavenly Father, thank' },
      { pattern: /\bin jesus name\b/gi, replacement: "in Jesus' name" },
      { pattern: /\bin jesus\'?\s*name\s+amen\b/gi, replacement: "in Jesus' name, Amen." },
      
      // Worship phrases
      { pattern: /\bpraise the lord\b/gi, replacement: 'Praise the Lord!' },
      { pattern: /\bthank you lord\b/gi, replacement: 'Thank You, Lord' },
      { pattern: /\bthank you jesus\b/gi, replacement: 'Thank You, Jesus' },
      { pattern: /\bglory to god\b/gi, replacement: 'Glory to God' },
      
      // Common mispronunciations in STT
      { pattern: /\brevelations\b/gi, replacement: 'Revelation' },
      { pattern: /\bsongs of solomon\b/gi, replacement: 'Song of Solomon' },
      
      // Exclamations and responses
      { pattern: /\b(?:yes|yeah|yep)\s+lord\b/gi, replacement: 'Yes, Lord' },
      { pattern: /\bcome lord\b/gi, replacement: 'Come, Lord' },
    ];
    
    worshipFixes.forEach(({ pattern, replacement }) => {
      if (typeof replacement === 'function') {
        result = result.replace(pattern, replacement);
      } else {
        result = result.replace(pattern, replacement);
      }
    });
    
    // Fix capitalization of "I" when referring to self in prayer context
    // "i pray" → "I pray" (already handled by other plugins, but ensure it's applied)
    result = result.replace(/\bi\s+(pray|thank|praise|worship|believe|trust|love|follow|serve)\b/gi, (match) => {
      return match.charAt(0).toUpperCase() + match.slice(1);
    });
    
    // Fix "you" → "You" when addressing deity
    result = result.replace(/\b(thank|praise|worship|love|serve|follow|believe|trust)\s+you\b/gi, (match) => {
      return match.replace(/\byou\b/gi, 'You');
    });
    
    // CRITICAL: Automatically apply the fix
    if (result !== originalText) {
      file.value = result;
    }
  };
}

