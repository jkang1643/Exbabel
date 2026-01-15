/**
 * Spoken Number Parser
 * 
 * Converts spoken numbers (e.g., "thirty eight", "two") to integers
 * and preserves their position in the text.
 */

/**
 * Map of spoken number words to their numeric values
 */
const NUMBER_WORDS = {
  'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
  'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
  'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19,
  'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50,
  'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90,
  'hundred': 100, 'thousand': 1000
};

/**
 * Parse a spoken number phrase into an integer
 * 
 * @param {string} text - Text containing spoken number (e.g., "thirty eight")
 * @param {number} startIndex - Starting index of the number phrase in original text
 * @returns {Object|null} Parsed number info or null if not a valid number
 */
export function parseSpokenNumber(text, startIndex = 0) {
  if (!text || typeof text !== 'string') return null;
  
  const normalized = text.toLowerCase().trim();
  const words = normalized.split(/\s+/);
  
  // Handle single word numbers
  if (words.length === 1) {
    const value = NUMBER_WORDS[words[0]];
    if (value !== undefined) {
      return {
        raw: text,
        value: value,
        indexRange: [startIndex, startIndex + text.length]
      };
    }
  }
  
  // Handle compound numbers (e.g., "thirty eight", "twenty one")
  if (words.length === 2) {
    const first = NUMBER_WORDS[words[0]];
    const second = NUMBER_WORDS[words[1]];
    
    if (first !== undefined && second !== undefined) {
      // Handle tens + ones (e.g., "thirty eight" = 38)
      if (first >= 20 && first < 100 && second < 10) {
        return {
          raw: text,
          value: first + second,
          indexRange: [startIndex, startIndex + text.length]
        };
      }
      // Handle "hundred" or "thousand" (e.g., "one hundred")
      if (first < 10 && (second === 100 || second === 1000)) {
        return {
          raw: text,
          value: first * second,
          indexRange: [startIndex, startIndex + text.length]
        };
      }
    }
  }
  
  // Handle three-word numbers (e.g., "one hundred twenty")
  if (words.length === 3) {
    const first = NUMBER_WORDS[words[0]];
    const second = NUMBER_WORDS[words[1]];
    const third = NUMBER_WORDS[words[2]];
    
    if (first !== undefined && second !== undefined && third !== undefined) {
      if (first < 10 && second === 100 && third >= 20 && third < 100) {
        return {
          raw: text,
          value: first * 100 + third,
          indexRange: [startIndex, startIndex + text.length]
        };
      }
    }
  }
  
  return null;
}

/**
 * Find all spoken numbers in a text string
 * 
 * @param {string} text - Text to search
 * @returns {Array<Object>} Array of parsed number objects
 */
export function findAllSpokenNumbers(text) {
  if (!text || typeof text !== 'string') return [];

  const results = [];
  const words = text.toLowerCase().split(/\s+/);
  const usedIndices = new Set();

  // Try to match 1-3 word sequences as potential numbers
  // Check longer sequences first to prefer compound numbers (e.g., "thirty eight" over "thirty" + "eight")
  for (let i = 0; i < words.length; i++) {
    if (usedIndices.has(i)) continue;
    
    // Try three words first (longest)
    if (i + 2 < words.length) {
      const threeWords = words.slice(i, i + 3).join(' ');
      const three = parseSpokenNumber(threeWords, text.indexOf(threeWords));
      if (three) {
        results.push(three);
        usedIndices.add(i);
        usedIndices.add(i + 1);
        usedIndices.add(i + 2);
        i += 2; // Skip next two words
        continue;
      }
    }
    
    // Try two words (compound numbers like "thirty eight")
    if (i + 1 < words.length) {
      const twoWords = words.slice(i, i + 2).join(' ');
      const two = parseSpokenNumber(twoWords, text.indexOf(twoWords));
      if (two) {
        results.push(two);
        usedIndices.add(i);
        usedIndices.add(i + 1);
        i++; // Skip next word since we used it
        continue;
      }
    }
    
    // Try single word last
    const single = parseSpokenNumber(words[i], text.indexOf(words[i]));
    if (single) {
      results.push(single);
      usedIndices.add(i);
    }
  }

  return results;
}

export default {
  parseSpokenNumber,
  findAllSpokenNumbers
};

