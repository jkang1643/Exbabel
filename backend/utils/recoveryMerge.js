/**
 * Recovery Text Merge Utility
 * 
 * Handles merging recovered text from recovery streams with buffered text,
 * including overlap detection, deduplication, and compound word protection.
 */

/**
 * Normalize text for merging by removing trailing punctuation and normalizing spacing
 * @param {string} text - Text to normalize
 * @returns {string} - Normalized text
 */
function normalizeTextForMerge(text) {
  if (!text) return '';
  
  // Remove trailing punctuation (periods, commas, semicolons, etc.)
  // But preserve hyphens in compound words
  let normalized = text.trim();
  
  // Remove trailing sentence-ending punctuation
  normalized = normalized.replace(/[.,!?;:]+$/g, '');
  
  // Normalize multiple spaces to single space
  normalized = normalized.replace(/\s+/g, ' ');
  
  return normalized.trim();
}

/**
 * Check if a word is a compound word (contains hyphen)
 * @param {string} word - Word to check
 * @returns {boolean} - True if compound word
 */
function detectCompoundWord(word) {
  if (!word) return false;
  return word.includes('-') && word.length > 1;
}

/**
 * Check if a standalone word is just a suffix of a compound word
 * This prevents matching "centered" (from "self-centered") with standalone "centered"
 * @param {string} compoundWord - The compound word (e.g., "self-centered")
 * @param {string} standaloneWord - The standalone word to check (e.g., "centered")
 * @returns {boolean} - True if standalone is just a suffix of compound
 */
function isCompoundWordSuffix(compoundWord, standaloneWord) {
  if (!detectCompoundWord(compoundWord)) return false;
  if (!standaloneWord) return false;
  
  const compoundClean = compoundWord.toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
  const standaloneClean = standaloneWord.toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
  
  // Split compound word by hyphen
  const parts = compoundWord.toLowerCase().split('-');
  const lastPart = parts[parts.length - 1].replace(/[.,!?;:\-'"()]/g, '');
  
  // Check if standalone word matches the last part of compound
  if (lastPart === standaloneClean) {
    // Only consider it a suffix match if the compound word is significantly longer
    // This prevents false positives for short compound words
    return compoundClean.length > standaloneClean.length + 3;
  }
  
  return false;
}

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} - Edit distance
 */
function levenshteinDistance(a, b) {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Check if two words are related (variations, stems, etc.)
 * @param {string} word1 - First word
 * @param {string} word2 - Second word
 * @returns {boolean} - True if words are related
 */
function wordsAreRelated(word1, word2) {
  const w1 = word1.toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
  const w2 = word2.toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
  
  if (w1 === w2) return true;
  
  if (w1.includes(w2) || w2.includes(w1)) {
    const shorter = w1.length < w2.length ? w1 : w2;
    const longer = w1.length >= w2.length ? w1 : w2;
    
    // Stem matching: check if longer word starts with shorter (common suffixes)
    if (longer.startsWith(shorter) && shorter.length >= 3) {
      const remaining = longer.substring(shorter.length);
      // Common suffixes: ing, ed, er, s, es, ly, d
      if (['ing', 'ed', 'er', 's', 'es', 'ly', 'd'].includes(remaining)) {
        return true;
      }
    }
    
    // Check for transcription errors using Levenshtein distance
    const lev = levenshteinDistance(w1, w2);
    const maxLen = Math.max(w1.length, w2.length);
    const similarity = 1 - (lev / maxLen);
    // If words are very similar (>= 85%), likely transcription error
    if (similarity >= 0.85 && maxLen >= 4) {
      return true;
    }
  }
  
  return false;
}

/**
 * Find phrase-level overlap (2-4 words) between buffered and recovered text
 * @param {string[]} bufferedWords - Words from buffered text
 * @param {string[]} recoveredWords - Words from recovered text
 * @returns {Object} - { matched: boolean, matchIndex: number, phraseLen: number }
 */
function findPhraseOverlap(bufferedWords, recoveredWords) {
  // Try phrases of length 2-4, starting from the end of buffered text
  const maxPhraseLen = Math.min(4, Math.min(bufferedWords.length, recoveredWords.length));
  
  for (let phraseLen = maxPhraseLen; phraseLen >= 2; phraseLen--) {
    // Check last phraseLen words of buffered text
    const startIdx = Math.max(0, bufferedWords.length - phraseLen);
    const bufferedPhrase = bufferedWords.slice(startIdx).map(w => 
      w.toLowerCase().replace(/[.,!?;:\-'"()]/g, '')
    );
    const bufferedPhraseStr = bufferedPhrase.join(' ');
    
    // Look for this phrase in recovered text
    for (let i = 0; i <= recoveredWords.length - phraseLen; i++) {
      const recoveredPhrase = recoveredWords.slice(i, i + phraseLen).map(w => 
        w.toLowerCase().replace(/[.,!?;:\-'"()]/g, '')
      );
      const recoveredPhraseStr = recoveredPhrase.join(' ');
      
      // Exact match
      if (bufferedPhraseStr === recoveredPhraseStr) {
        return { matched: true, matchIndex: i, phraseLen, phrase: bufferedPhraseStr };
      }
      
      // Check if words are related (handles variations)
      let allRelated = true;
      for (let j = 0; j < phraseLen; j++) {
        if (!wordsAreRelated(bufferedPhrase[j], recoveredPhrase[j])) {
          allRelated = false;
          break;
        }
      }
      if (allRelated) {
        return { matched: true, matchIndex: i, phraseLen, phrase: bufferedPhraseStr };
      }
    }
  }
  
  return { matched: false };
}

/**
 * Find single-word overlap with compound word protection
 * @param {string[]} bufferedWords - Words from buffered text
 * @param {string[]} recoveredWords - Words from recovered text
 * @returns {Object} - { matched: boolean, matchIndex: number, matchedWord: string }
 */
function findWordOverlap(bufferedWords, recoveredWords) {
  // Scan from END of buffered words, look for first match in recovery
  let matchIndex = -1;
  let matchedWord = null;
  
  for (let i = bufferedWords.length - 1; i >= 0; i--) {
    const bufferedWordOriginal = bufferedWords[i];
    const bufferedWordClean = bufferedWordOriginal.toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
    
    // Look for this word anywhere in recovery
    for (let j = 0; j < recoveredWords.length; j++) {
      const recoveredWordOriginal = recoveredWords[j];
      const recoveredWordClean = recoveredWordOriginal.toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
      
      // Exact match
      if (bufferedWordClean === recoveredWordClean && bufferedWordClean.length > 0) {
        // Check for compound word suffix issue
        // If buffered word is compound and recovered word is just the suffix, don't match
        if (detectCompoundWord(bufferedWordOriginal)) {
          if (isCompoundWordSuffix(bufferedWordOriginal, recoveredWordOriginal)) {
            continue; // Skip this match - it's a false positive
          }
        }
        // If recovered word is compound and buffered word is just the suffix, don't match
        if (detectCompoundWord(recoveredWordOriginal)) {
          if (isCompoundWordSuffix(recoveredWordOriginal, bufferedWordOriginal)) {
            continue; // Skip this match - it's a false positive
          }
        }
        
        matchIndex = j;
        matchedWord = bufferedWordOriginal;
        break;
      }
      
      // Related words match (with compound word protection)
      if (wordsAreRelated(bufferedWordOriginal, recoveredWordOriginal)) {
        // Additional check: don't match if one is compound suffix of the other
        if (detectCompoundWord(bufferedWordOriginal) && 
            isCompoundWordSuffix(bufferedWordOriginal, recoveredWordOriginal)) {
          continue;
        }
        if (detectCompoundWord(recoveredWordOriginal) && 
            isCompoundWordSuffix(recoveredWordOriginal, bufferedWordOriginal)) {
          continue;
        }
        
        matchIndex = j;
        matchedWord = bufferedWordOriginal;
        break;
      }
    }
    
    if (matchIndex !== -1) {
      break; // Found the last overlapping word
    }
  }
  
  return { matched: matchIndex !== -1, matchIndex, matchedWord };
}

/**
 * Deduplicate tail words against next partial/final text
 * Removes words from tail that already appear in next text
 * @param {string[]} tailWords - Words to check for duplicates
 * @param {string[]} nextTexts - Array of next text strings to check against
 * @returns {string[]} - Deduplicated tail words
 */
function deduplicateTail(tailWords, nextTexts) {
  if (!tailWords || tailWords.length === 0) return [];
  if (!nextTexts || nextTexts.length === 0) return tailWords;
  
  // Combine all next texts into one check
  const allNextWords = [];
  for (const nextText of nextTexts) {
    if (nextText && nextText.trim()) {
      const words = nextText.trim().toLowerCase().split(/\s+/);
      allNextWords.push(...words);
    }
  }
  
  if (allNextWords.length === 0) return tailWords;
  
  // Check for phrase-level overlaps first (2-4 words)
  let phraseOverlap = null;
  for (let phraseLen = Math.min(4, tailWords.length); phraseLen >= 2; phraseLen--) {
    const tailPhrase = tailWords.slice(-phraseLen).map(w => 
      w.toLowerCase().replace(/[.,!?;:\-'"()]/g, '')
    );
    const tailPhraseStr = tailPhrase.join(' ');
    
    // Check first 6 words of next texts for phrase match
    const nextWordsSlice = allNextWords.slice(0, 6);
    
    for (let start = 0; start <= Math.min(2, nextWordsSlice.length - phraseLen); start++) {
      const nextPhrase = nextWordsSlice.slice(start, start + phraseLen).map(w => 
        w.replace(/[.,!?;:\-'"()]/g, '')
      );
      const nextPhraseStr = nextPhrase.join(' ');
      
      if (tailPhraseStr === nextPhraseStr) {
        phraseOverlap = { phraseLen, start };
        break;
      }
      
      // Check if words are related
      let allRelated = true;
      for (let i = 0; i < phraseLen; i++) {
        if (!wordsAreRelated(tailPhrase[i], nextPhrase[i])) {
          allRelated = false;
          break;
        }
      }
      if (allRelated) {
        phraseOverlap = { phraseLen, start };
        break;
      }
    }
    
    if (phraseOverlap) break;
  }
  
  if (phraseOverlap) {
    const wordsToKeep = tailWords.length - phraseOverlap.phraseLen;
    if (wordsToKeep > 0) {
      return tailWords.slice(0, wordsToKeep);
    } else {
      return []; // All words already in next text
    }
  }
  
  // No phrase overlap - check word-by-word with compound word protection
  let overlapCount = 0;
  
  // Check from the END of tail backwards
  for (let i = tailWords.length - 1; i >= 0; i--) {
    const tailWordOriginal = tailWords[i].toLowerCase();
    const tailWordClean = tailWordOriginal.replace(/[.,!?;:\-'"()]/g, '');
    
    // Check first 5 words of next texts
    const checkWordsSlice = allNextWords.slice(0, 5);
    
    const matches = checkWordsSlice.some(nextWord => {
      const nextWordOriginal = nextWord.toLowerCase();
      const nextWordClean = nextWordOriginal.replace(/[.,!?;:\-'"()]/g, '');
      
      // Exact match
      if (tailWordOriginal === nextWordOriginal || tailWordClean === nextWordClean) {
        // Compound word protection
        const tailHasHyphen = tailWordOriginal.includes('-');
        const nextHasHyphen = nextWordOriginal.includes('-');
        
        // If tail is compound and next is not, check if next is just the suffix
        if (tailHasHyphen && !nextHasHyphen) {
          if (isCompoundWordSuffix(tailWords[i], nextWord)) {
            return false; // Don't match - they're different words
          }
        }
        
        // If next is compound and tail is not, check if tail is just the suffix
        if (nextHasHyphen && !tailHasHyphen) {
          if (isCompoundWordSuffix(nextWord, tailWords[i])) {
            return false; // Don't match - they're different words
          }
        }
        
        return true;
      }
      
      // Related words
      if (wordsAreRelated(tailWordOriginal, nextWordOriginal)) {
        // Compound word protection
        if (detectCompoundWord(tailWords[i]) && 
            isCompoundWordSuffix(tailWords[i], nextWord)) {
          return false;
        }
        if (detectCompoundWord(nextWord) && 
            isCompoundWordSuffix(nextWord, tailWords[i])) {
          return false;
        }
        return true;
      }
      
      return false;
    });
    
    if (matches) {
      overlapCount = tailWords.length - i; // Count from this position to end
      break;
    }
  }
  
  if (overlapCount > 0) {
    const wordsToKeep = tailWords.length - overlapCount;
    if (wordsToKeep > 0) {
      return tailWords.slice(0, wordsToKeep);
    } else {
      return []; // All words already in next text
    }
  }
  
  // No overlap found - return original tail
  return tailWords;
}

/**
 * Merge recovered text with buffered text, handling overlaps and deduplication
 * @param {string} bufferedText - The buffered/finalized text
 * @param {string} recoveredText - The text recovered from recovery stream
 * @param {Object} options - Merge options
 * @param {string} options.nextPartialText - Next partial text (for deduplication)
 * @param {string} options.nextFinalText - Next final text (for deduplication)
 * @param {string} options.mode - Mode identifier for logging (e.g., "SoloMode", "HostMode")
 * @returns {Object} - { merged: boolean, mergedText: string, reason: string }
 */
function mergeRecoveryText(bufferedText, recoveredText, options = {}) {
  const { nextPartialText, nextFinalText, mode = 'Recovery' } = options;
  
  // Normalize inputs
  const bufferedNormalized = normalizeTextForMerge(bufferedText);
  const recoveredNormalized = normalizeTextForMerge(recoveredText);
  
  if (!bufferedNormalized) {
    return { merged: false, mergedText: recoveredNormalized, reason: 'No buffered text' };
  }
  
  if (!recoveredNormalized) {
    return { merged: false, mergedText: bufferedNormalized, reason: 'No recovered text' };
  }
  
  const bufferedWords = bufferedNormalized.split(/\s+/).filter(w => w.length > 0);
  const recoveredWords = recoveredNormalized.split(/\s+/).filter(w => w.length > 0);
  
  if (bufferedWords.length === 0) {
    return { merged: false, mergedText: recoveredNormalized, reason: 'Empty buffered text' };
  }
  
  if (recoveredWords.length === 0) {
    return { merged: false, mergedText: bufferedNormalized, reason: 'Empty recovered text' };
  }
  
  console.log(`[${mode}] 🔍 Attempting smart merge:`);
  console.log(`[${mode}]   Buffered (${bufferedWords.length} words): "${bufferedNormalized.substring(Math.max(0, bufferedNormalized.length - 60))}"`);
  console.log(`[${mode}]   Recovered (${recoveredWords.length} words): "${recoveredNormalized}"`);
  
  // Step 0: Check for prefix overlap (buffered text is a suffix of recovered text)
  // This handles cases where words are missing at the START of the phrase
  // Example: buffered="are gathered together", recovered="Where two or three are gathered together"
  // We need to detect that buffered is a suffix of recovered and prepend the missing prefix
  let prefixWords = [];
  let hasPrefixOverlap = false;
  
  // Check if buffered text (normalized) is a suffix of recovered text (normalized)
  const bufferedNormalizedLower = bufferedNormalized.toLowerCase();
  const recoveredNormalizedLower = recoveredNormalized.toLowerCase();
  
  // Try to find where buffered text starts in recovered text
  const suffixIndex = recoveredNormalizedLower.indexOf(bufferedNormalizedLower);
  if (suffixIndex === 0) {
    // Exact match - no prefix missing
    hasPrefixOverlap = false;
  } else if (suffixIndex > 0) {
    // Buffered text found at suffixIndex - there are prefix words before it
    // Extract the prefix part before the buffered text
    const prefixText = recoveredNormalized.substring(0, suffixIndex).trim();
    if (prefixText.length > 0) {
      // Check if it's a valid word boundary (starts with space or is at start)
      // Also ensure the prefix doesn't overlap with buffered text
      const prefixWordsTemp = prefixText.split(/\s+/).filter(w => w.length > 0);
      
      // Verify that buffered words match the suffix of recovered words
      const recoveredWordsLower = recoveredWords.map(w => w.toLowerCase().replace(/[.,!?;:\-'"()]/g, ''));
      const bufferedWordsLower = bufferedWords.map(w => w.toLowerCase().replace(/[.,!?;:\-'"()]/g, ''));
      
      // Check if the last N words of recovered match buffered words (where N = bufferedWords.length)
      if (recoveredWordsLower.length >= bufferedWordsLower.length) {
        const recoveredSuffix = recoveredWordsLower.slice(-bufferedWordsLower.length);
        const matches = recoveredSuffix.every((word, idx) => word === bufferedWordsLower[idx]);
        
        if (matches) {
          // Buffered text is indeed a suffix - extract prefix words
          prefixWords = recoveredWords.slice(0, recoveredWords.length - bufferedWords.length);
          hasPrefixOverlap = prefixWords.length > 0;
          
          if (hasPrefixOverlap) {
            console.log(`[${mode}] 🔍 Found prefix overlap: buffered text is a suffix of recovered text`);
            console.log(`[${mode}]   Missing prefix words: "${prefixWords.join(' ')}"`);
          }
        }
      }
    }
  } else {
    // Not found as substring - check if buffered words match end of recovered words
    // This handles cases with punctuation differences
    if (recoveredWords.length > bufferedWords.length) {
      const recoveredWordsLower = recoveredWords.map(w => w.toLowerCase().replace(/[.,!?;:\-'"()]/g, ''));
      const bufferedWordsLower = bufferedWords.map(w => w.toLowerCase().replace(/[.,!?;:\-'"()]/g, ''));
      
      // Check if last N words of recovered match buffered (where N = bufferedWords.length)
      if (recoveredWordsLower.length >= bufferedWordsLower.length) {
        const recoveredSuffix = recoveredWordsLower.slice(-bufferedWordsLower.length);
        const matches = recoveredSuffix.every((word, idx) => word === bufferedWordsLower[idx]);
        
        if (matches) {
          // Buffered text is a suffix - extract prefix words
          prefixWords = recoveredWords.slice(0, recoveredWords.length - bufferedWords.length);
          hasPrefixOverlap = prefixWords.length > 0;
          
          if (hasPrefixOverlap) {
            console.log(`[${mode}] 🔍 Found prefix overlap (word-level match): buffered text is a suffix of recovered text`);
            console.log(`[${mode}]   Missing prefix words: "${prefixWords.join(' ')}"`);
          }
        }
      }
    }
  }
  
  // If we found prefix overlap, use the full recovered text (or prepend prefix to buffered)
  if (hasPrefixOverlap) {
    const mergedText = recoveredNormalized; // Use the complete recovered text
    console.log(`[${mode}] 🎯 Prefix merge successful`);
    console.log(`[${mode}]   Prefix words to prepend: "${prefixWords.join(' ')}"`);
    console.log(`[${mode}]   Before: "${bufferedNormalized.substring(Math.max(0, bufferedNormalized.length - 60))}"`);
    console.log(`[${mode}]   After:  "${mergedText.substring(Math.max(0, mergedText.length - 60))}"`);
    
    return {
      merged: true,
      mergedText: mergedText.trim(),
      reason: `prefix overlap - prepended ${prefixWords.length} word(s)`
    };
  }
  
  // Step 1: Try phrase-level overlap (most reliable)
  const phraseOverlap = findPhraseOverlap(bufferedWords, recoveredWords);
  
  let tail = [];
  let matchInfo = null;
  
  if (phraseOverlap.matched) {
    // Found phrase overlap - extract tail after the phrase
    tail = recoveredWords.slice(phraseOverlap.matchIndex + phraseOverlap.phraseLen);
    matchInfo = {
      type: 'phrase',
      phrase: phraseOverlap.phrase,
      matchIndex: phraseOverlap.matchIndex
    };
    console.log(`[${mode}] 🔍 Found phrase overlap: "${phraseOverlap.phrase}" (${phraseOverlap.phraseLen} words)`);
    
    // CRITICAL: If no tail but recovered text is longer, check if buffered is a suffix
    // This handles prefix overlap cases that might have been detected as phrase overlap
    if (tail.length === 0 && recoveredWords.length > bufferedWords.length) {
      // Check if buffered words match the end of recovered words
      const recoveredWordsLower = recoveredWords.map(w => w.toLowerCase().replace(/[.,!?;:\-'"()]/g, ''));
      const bufferedWordsLower = bufferedWords.map(w => w.toLowerCase().replace(/[.,!?;:\-'"()]/g, ''));
      
      if (recoveredWordsLower.length >= bufferedWordsLower.length) {
        const recoveredSuffix = recoveredWordsLower.slice(-bufferedWordsLower.length);
        const matches = recoveredSuffix.every((word, idx) => word === bufferedWordsLower[idx]);
        
        if (matches) {
          // Buffered text is a suffix - this is actually a prefix overlap case
          // Use the complete recovered text instead
          const mergedText = recoveredNormalized;
          console.log(`[${mode}] 🎯 Prefix overlap detected via phrase match - using complete recovered text`);
          console.log(`[${mode}]   Before: "${bufferedNormalized.substring(Math.max(0, bufferedNormalized.length - 60))}"`);
          console.log(`[${mode}]   After:  "${mergedText.substring(Math.max(0, mergedText.length - 60))}"`);
          
          return {
            merged: true,
            mergedText: mergedText.trim(),
            reason: `prefix overlap (detected via phrase match) - using complete recovered text`
          };
        }
      }
    }
  } else {
    // Step 2: Try single-word overlap with compound word protection
    const wordOverlap = findWordOverlap(bufferedWords, recoveredWords);
    
    if (wordOverlap.matched) {
      tail = recoveredWords.slice(wordOverlap.matchIndex + 1);
      matchInfo = {
        type: 'word',
        word: wordOverlap.matchedWord,
        matchIndex: wordOverlap.matchIndex
      };
      console.log(`[${mode}] 🔍 Found word overlap: "${wordOverlap.matchedWord}"`);
    } else {
      // Step 3: Try fuzzy matching as fallback
      console.log(`[${mode}] ⚠️ No exact overlap found - trying fuzzy matching...`);
      
      const FUZZY_THRESHOLD = 0.72;
      let bestMatch = { score: 0, finalWord: null, recoveryIndex: -1 };
      
      // Check last 6 words from buffered
      const startIdx = Math.max(0, bufferedWords.length - 6);
      for (let i = bufferedWords.length - 1; i >= startIdx; i--) {
        const fw = bufferedWords[i].toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
        if (fw.length < 2) continue;
        
        for (let j = 0; j < recoveredWords.length; j++) {
          const rw = recoveredWords[j].toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
          if (rw.length < 2) continue;
          
          const lev = levenshteinDistance(fw, rw);
          const maxLen = Math.max(fw.length, rw.length);
          const similarity = 1 - (lev / maxLen);
          
          if (similarity > bestMatch.score) {
            bestMatch = {
              score: similarity,
              finalWord: bufferedWords[i],
              recoveryWord: recoveredWords[j],
              recoveryIndex: j
            };
          }
        }
      }
      
      if (bestMatch.score >= FUZZY_THRESHOLD) {
        tail = recoveredWords.slice(bestMatch.recoveryIndex + 1);
        matchInfo = {
          type: 'fuzzy',
          word: bestMatch.finalWord,
          recoveryWord: bestMatch.recoveryWord,
          score: bestMatch.score,
          matchIndex: bestMatch.recoveryIndex
        };
        console.log(`[${mode}] 🔍 Found fuzzy match: "${bestMatch.finalWord}" ≈ "${bestMatch.recoveryWord}" (${(bestMatch.score * 100).toFixed(0)}% similar)`);
      } else {
        // Step 4: No overlap at all - append entire recovery (prevents word loss)
        console.log(`[${mode}] ⚠️ No overlap found (best fuzzy: ${(bestMatch.score * 100).toFixed(0)}% < ${FUZZY_THRESHOLD * 100}%)`);
        console.log(`[${mode}] 📎 Appending entire recovery to prevent word loss`);
        
        // Deduplicate recovered words against next partial/final before appending
        const nextTexts = [];
        if (nextFinalText) nextTexts.push(nextFinalText);
        if (nextPartialText) nextTexts.push(nextPartialText);
        
        let recoveredWordsToAppend = recoveredWords;
        if (nextTexts.length > 0) {
          const originalRecoveredLength = recoveredWords.length;
          recoveredWordsToAppend = deduplicateTail(recoveredWords, nextTexts);
          
          if (recoveredWordsToAppend.length < originalRecoveredLength) {
            console.log(`[${mode}] ✂️ Deduplicated ${originalRecoveredLength - recoveredWordsToAppend.length} word(s) from recovery. Keeping: "${recoveredWordsToAppend.join(' ')}"`);
          }
        }
        
        // Build merged text with deduplicated recovery
        const recoveredTextToAppend = recoveredWordsToAppend.length > 0 
          ? recoveredWordsToAppend.join(' ')
          : '';
        
        if (recoveredTextToAppend) {
          const mergedText = bufferedNormalized + ' ' + recoveredTextToAppend;
          return {
            merged: true,
            mergedText: mergedText.trim(),
            reason: 'No overlap - full append (deduplicated)'
          };
        } else {
          // All recovered words were duplicates
          console.log(`[${mode}] ✅ All recovered words already in next text - no append needed`);
          return {
            merged: true,
            mergedText: bufferedNormalized,
            reason: 'No overlap - all recovery words duplicated in next text'
          };
        }
      }
    }
  }
  
  // Step 5: Deduplicate tail against next partial/final
  if (tail.length > 0) {
    const nextTexts = [];
    if (nextFinalText) nextTexts.push(nextFinalText);
    if (nextPartialText) nextTexts.push(nextPartialText);
    
    const originalTailLength = tail.length;
    tail = deduplicateTail(tail, nextTexts);
    
    if (tail.length < originalTailLength) {
      console.log(`[${mode}] ✂️ Deduplicated ${originalTailLength - tail.length} word(s) from tail. Keeping: "${tail.join(' ')}"`);
    }
  }
  
  // Step 6: Merge
  if (tail.length > 0) {
    const mergedText = bufferedNormalized + ' ' + tail.join(' ');
    console.log(`[${mode}] 🎯 Merge successful (${matchInfo.type} match)`);
    console.log(`[${mode}]   New words to append: "${tail.join(' ')}"`);
    console.log(`[${mode}]   Before: "${bufferedNormalized.substring(Math.max(0, bufferedNormalized.length - 60))}"`);
    console.log(`[${mode}]   After:  "${mergedText.substring(Math.max(0, mergedText.length - 60))}"`);
    
    return {
      merged: true,
      mergedText: mergedText.trim(),
      reason: `${matchInfo.type} match - appended ${tail.length} word(s)`
    };
  } else {
    // Recovery only confirms what we have
    console.log(`[${mode}] ✅ Recovery confirms buffered ending (no new words to append)`);
    return {
      merged: true,
      mergedText: bufferedNormalized,
      reason: 'Recovery confirms buffered text'
    };
  }
}

export {
  mergeRecoveryText,
  normalizeTextForMerge,
  detectCompoundWord,
  isCompoundWordSuffix,
  findPhraseOverlap,
  findWordOverlap,
  deduplicateTail,
  wordsAreRelated,
  levenshteinDistance
};

