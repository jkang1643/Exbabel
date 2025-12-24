/**
 * Book Name Detector
 * 
 * Detects Bible book names from text tokens and returns canonical book names
 * with confidence scores.
 */

/**
 * Canonical Bible book names (66 books)
 */
const CANONICAL_BOOKS = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy',
  'Joshua', 'Judges', 'Ruth', '1 Samuel', '2 Samuel', '1 Kings', '2 Kings',
  '1 Chronicles', '2 Chronicles', 'Ezra', 'Nehemiah', 'Esther',
  'Job', 'Psalms', 'Proverbs', 'Ecclesiastes', 'Song of Solomon',
  'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel',
  'Hosea', 'Joel', 'Amos', 'Obadiah', 'Jonah', 'Micah', 'Nahum',
  'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah', 'Malachi',
  'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans',
  '1 Corinthians', '2 Corinthians', 'Galatians', 'Ephesians', 'Philippians',
  'Colossians', '1 Thessalonians', '2 Thessalonians', '1 Timothy', '2 Timothy',
  'Titus', 'Philemon', 'Hebrews', 'James', '1 Peter', '2 Peter',
  '1 John', '2 John', '3 John', 'Jude', 'Revelation'
];

/**
 * Book name aliases and variations
 * Maps common spoken/abbreviated forms to canonical names
 */
const BOOK_ALIASES = {
  // Old Testament
  'gen': 'Genesis', 'genesis': 'Genesis',
  'ex': 'Exodus', 'exodus': 'Exodus',
  'lev': 'Leviticus', 'leviticus': 'Leviticus',
  'num': 'Numbers', 'numbers': 'Numbers',
  'deut': 'Deuteronomy', 'deuteronomy': 'Deuteronomy',
  'josh': 'Joshua', 'joshua': 'Joshua',
  'judg': 'Judges', 'judges': 'Judges',
  'ruth': 'Ruth',
  '1 sam': '1 Samuel', 'first samuel': '1 Samuel', '1st samuel': '1 Samuel',
  '2 sam': '2 Samuel', 'second samuel': '2 Samuel', '2nd samuel': '2 Samuel',
  '1 kings': '1 Kings', 'first kings': '1 Kings', '1st kings': '1 Kings',
  '2 kings': '2 Kings', 'second kings': '2 Kings', '2nd kings': '2 Kings',
  '1 chron': '1 Chronicles', 'first chronicles': '1 Chronicles', '1st chronicles': '1 Chronicles',
  '2 chron': '2 Chronicles', 'second chronicles': '2 Chronicles', '2nd chronicles': '2 Chronicles',
  'ezra': 'Ezra',
  'neh': 'Nehemiah', 'nehemiah': 'Nehemiah',
  'esther': 'Esther',
  'job': 'Job',
  'psalm': 'Psalms', 'psalms': 'Psalms', 'ps': 'Psalms',
  'prov': 'Proverbs', 'proverbs': 'Proverbs',
  'eccl': 'Ecclesiastes', 'ecclesiastes': 'Ecclesiastes',
  'song': 'Song of Solomon', 'song of solomon': 'Song of Solomon', 'songs': 'Song of Solomon',
  'isa': 'Isaiah', 'isaiah': 'Isaiah',
  'jer': 'Jeremiah', 'jeremiah': 'Jeremiah',
  'lam': 'Lamentations', 'lamentations': 'Lamentations',
  'ezek': 'Ezekiel', 'ezekiel': 'Ezekiel',
  'dan': 'Daniel', 'daniel': 'Daniel',
  'hos': 'Hosea', 'hosea': 'Hosea',
  'joel': 'Joel',
  'amos': 'Amos',
  'obad': 'Obadiah', 'obadiah': 'Obadiah',
  'jonah': 'Jonah',
  'mic': 'Micah', 'micah': 'Micah',
  'nah': 'Nahum', 'nahum': 'Nahum',
  'hab': 'Habakkuk', 'habakkuk': 'Habakkuk',
  'zeph': 'Zephaniah', 'zephaniah': 'Zephaniah',
  'hag': 'Haggai', 'haggai': 'Haggai',
  'zech': 'Zechariah', 'zechariah': 'Zechariah',
  'mal': 'Malachi', 'malachi': 'Malachi',
  
  // New Testament
  'matt': 'Matthew', 'matthew': 'Matthew', 'mt': 'Matthew',
  'mark': 'Mark', 'mk': 'Mark',
  'luke': 'Luke', 'lk': 'Luke',
  'john': 'John', 'jn': 'John',
  'acts': 'Acts', 'act': 'Acts',
  'rom': 'Romans', 'romans': 'Romans', 'ro': 'Romans',
  '1 cor': '1 Corinthians', 'first corinthians': '1 Corinthians', '1st corinthians': '1 Corinthians',
  '2 cor': '2 Corinthians', 'second corinthians': '2 Corinthians', '2nd corinthians': '2 Corinthians',
  'gal': 'Galatians', 'galatians': 'Galatians',
  'eph': 'Ephesians', 'ephesians': 'Ephesians',
  'phil': 'Philippians', 'philippians': 'Philippians',
  'col': 'Colossians', 'colossians': 'Colossians',
  '1 thess': '1 Thessalonians', 'first thessalonians': '1 Thessalonians', '1st thessalonians': '1 Thessalonians',
  '2 thess': '2 Thessalonians', 'second thessalonians': '2 Thessalonians', '2nd thessalonians': '2 Thessalonians',
  '1 tim': '1 Timothy', 'first timothy': '1 Timothy', '1st timothy': '1 Timothy',
  '2 tim': '2 Timothy', 'second timothy': '2 Timothy', '2nd timothy': '2 Timothy',
  'titus': 'Titus',
  'philem': 'Philemon', 'philemon': 'Philemon',
  'heb': 'Hebrews', 'hebrews': 'Hebrews',
  'james': 'James',
  '1 pet': '1 Peter', 'first peter': '1 Peter', '1st peter': '1 Peter',
  '2 pet': '2 Peter', 'second peter': '2 Peter', '2nd peter': '2 Peter',
  '1 john': '1 John', 'first john': '1 John', '1st john': '1 John',
  '2 john': '2 John', 'second john': '2 John', '2nd john': '2 John',
  '3 john': '3 John', 'third john': '3 John', '3rd john': '3 John',
  'jude': 'Jude',
  'rev': 'Revelation', 'revelation': 'Revelation', 'revelations': 'Revelation'
};

/**
 * Calculate Levenshtein distance (edit distance) between two strings
 * 
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Edit distance
 */
function levenshteinDistance(a, b) {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,      // insertion
        matrix[j - 1][i] + 1,      // deletion
        matrix[j - 1][i - 1] + indicator // substitution
      );
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Calculate similarity score between two strings (0.0 to 1.0)
 * 
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity score (1.0 = identical, 0.0 = completely different)
 */
function calculateSimilarity(str1, str2) {
  if (str1 === str2) return 1.0;
  if (str1.length === 0 || str2.length === 0) return 0.0;
  
  const distance = levenshteinDistance(str1, str2);
  const maxLen = Math.max(str1.length, str2.length);
  return 1.0 - (distance / maxLen);
}

/**
 * Ordinal number words to numbers
 */
const ORDINAL_MAP = {
  'first': 1, '1st': 1, '1': 1,
  'second': 2, '2nd': 2, '2': 2,
  'third': 3, '3rd': 3, '3': 3,
  'fourth': 4, '4th': 4, '4': 4,
  'fifth': 5, '5th': 5, '5': 5
};

/**
 * Detect book name from tokens
 * 
 * @param {Array<string>} tokens - Array of normalized word tokens
 * @param {number} startIndex - Starting index in tokens array
 * @returns {Object|null} Book detection result or null
 */
export function detectBookName(tokens, startIndex = 0) {
  if (!tokens || tokens.length === 0 || startIndex >= tokens.length) return null;
  
  // Try single token
  const single = tokens[startIndex]?.toLowerCase();
  if (single && BOOK_ALIASES[single]) {
    return {
      book: BOOK_ALIASES[single],
      confidence: 0.9,
      tokenCount: 1
    };
  }
  
  // Try two tokens (for books like "1 Samuel", "Song of")
  if (startIndex + 1 < tokens.length) {
    const two = `${tokens[startIndex]} ${tokens[startIndex + 1]}`.toLowerCase();
    if (BOOK_ALIASES[two]) {
      return {
        book: BOOK_ALIASES[two],
        confidence: 0.95,
        tokenCount: 2
      };
    }
    
    // Try with ordinal (e.g., "first samuel")
    const ordinal = ORDINAL_MAP[tokens[startIndex]?.toLowerCase()];
    if (ordinal) {
      const second = tokens[startIndex + 1]?.toLowerCase();
      const ordinalKey = `${ordinal === 1 ? 'first' : ordinal === 2 ? 'second' : ordinal === 3 ? 'third' : ''} ${second}`;
      if (BOOK_ALIASES[ordinalKey]) {
        return {
          book: BOOK_ALIASES[ordinalKey],
          confidence: 0.9,
          tokenCount: 2
        };
      }
    }
  }
  
  // Try three tokens (e.g., "Song of Solomon")
  if (startIndex + 2 < tokens.length) {
    const three = `${tokens[startIndex]} ${tokens[startIndex + 1]} ${tokens[startIndex + 2]}`.toLowerCase();
    if (BOOK_ALIASES[three]) {
      return {
        book: BOOK_ALIASES[three],
        confidence: 0.95,
        tokenCount: 3
      };
    }
  }
  
  // Fuzzy match: check if any token closely matches a book name using Levenshtein distance
  // Only allow very close matches (similarity >= 0.85) to prevent false positives
  // Examples that should pass: "lets" vs "let us" (close variations)
  // Examples that should NOT pass: "thi" vs "first" (substring match, not similar)
  const FUZZY_SIMILARITY_THRESHOLD = 0.85; // Require 85% similarity for fuzzy matches
  
  for (const token of tokens.slice(startIndex, Math.min(startIndex + 3, tokens.length))) {
    const lower = token.toLowerCase();
    
    // Skip very short tokens (less than 3 chars) - too prone to false matches
    if (lower.length < 3) continue;
    
    for (const [alias, canonical] of Object.entries(BOOK_ALIASES)) {
      // Skip if alias is too short (less than 3 chars) - too prone to false matches
      if (alias.length < 3) continue;
      
      // Calculate similarity using Levenshtein distance
      const similarity = calculateSimilarity(lower, alias);
      
      if (similarity >= FUZZY_SIMILARITY_THRESHOLD) {
        return {
          book: canonical,
          confidence: 0.4, // Lower confidence for fuzzy match
          tokenCount: 1
        };
      }
    }
  }
  
  return null;
}

/**
 * Find all book name occurrences in tokens
 * 
 * @param {Array<string>} tokens - Array of normalized word tokens
 * @returns {Array<Object>} Array of book detection results
 */
export function findAllBookNames(tokens) {
  if (!tokens || tokens.length === 0) return [];
  
  const results = [];
  
  for (let i = 0; i < tokens.length; i++) {
    const detection = detectBookName(tokens, i);
    if (detection) {
      results.push({
        ...detection,
        startIndex: i
      });
      // Skip ahead by token count to avoid overlapping matches
      i += detection.tokenCount - 1;
    }
  }
  
  return results;
}

export default {
  detectBookName,
  findAllBookNames,
  CANONICAL_BOOKS,
  BOOK_ALIASES
};

