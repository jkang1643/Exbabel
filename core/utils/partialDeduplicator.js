/**
 * Partial Text Deduplicator - Removes duplicate words from partials that overlap with previous finals
 * 
 * Extracted from soloModeHandler.js and host/adapter.js to eliminate duplication.
 * 
 * This utility detects and removes duplicate words from partial transcripts that
 * overlap with the end of the previous final transcript, preventing word duplication
 * in the output.
 */

import { wordsAreRelated, detectCompoundWord, isCompoundWordSuffix } from '../../backend/utils/recoveryMerge.js';

/**
 * Extract words from text, preserving original word boundaries and case
 * Handles punctuation by stripping it for comparison but preserving word structure
 * @param {string} text - Text to extract words from
 * @returns {Array<{original: string, clean: string, hasPunctuation: boolean, isCompound: boolean}>} Array of word objects
 */
function extractWords(text) {
  if (!text) return [];
  
  // Split by whitespace (including tabs, newlines)
  const words = text.trim().split(/\s+/);
  const result = [];
  
  for (const word of words) {
    if (word.length === 0) continue;
    
    // Clean word for comparison (remove punctuation, lowercase)
    // Strip punctuation marks but preserve the word structure
    // Special characters like @#$ are kept in original but stripped for matching
    const clean = word.toLowerCase().replace(/[.,!?;:\-'"()@#$%^&*+=<>[\]{}|\\\/`~]/g, '');
    
    // Check if word has punctuation (but not special chars like @#$)
    const hasPunctuation = /[.,!?;:'"()]/.test(word);
    
    // Check if word is compound (has hyphen)
    const isCompound = detectCompoundWord(word);
    
    // Always include pure numbers as words (they won't match text words, but will be preserved)
    // Check this first to ensure numbers are always included
    if (/^\d+$/.test(word)) {
      result.push({
        original: word,
        clean: word, // Numbers match exactly
        hasPunctuation: false,
        isCompound: false
      });
    }
    // Include words that have at least 1 character after cleaning
    // This includes single-letter words like "I", "a", etc.
    else if (clean.length >= 1) {
      result.push({
        original: word,
        clean: clean,
        hasPunctuation: hasPunctuation,
        isCompound: isCompound
      });
    }
  }
  
  return result;
}

/**
 * Check if a word is part of a compound word
 * @param {string} word - Word to check
 * @param {Object} compoundWord - Compound word object
 * @returns {boolean} - True if word is part of the compound word
 */
function isWordPartOfCompound(word, compoundWord) {
  if (!word || !compoundWord || !compoundWord.isCompound) return false;
  
  const wordClean = word.clean || word.toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
  const compoundClean = compoundWord.clean;
  
  // Split compound word by hyphen
  const parts = compoundWord.original.toLowerCase().split('-');
  
  // Check if the word matches any part of the compound word
  for (const part of parts) {
    const partClean = part.replace(/[.,!?;:\-'"()]/g, '');
    if (partClean === wordClean && partClean.length >= 2) {
      // Only consider it a match if the compound word is significantly longer
      // This prevents false positives for short compound words like "co-op"
      return compoundClean.length > wordClean.length + 3;
    }
  }
  
  return false;
}

/**
 * Check if two word objects match (considering compound words and punctuation)
 * @param {Object} word1 - First word object (from final)
 * @param {Object} word2 - Second word object (from partial)
 * @param {Array} finalWords - All final words (for compound word context checking)
 * @returns {boolean} - True if words match
 */
function wordsMatch(word1, word2, finalWords = []) {
  if (!word1 || !word2) return false;
  
  // If both are compound words, they must match exactly (no partial matching)
  if (word1.isCompound && word2.isCompound) {
    return word1.clean === word2.clean;
  }
  
  // CRITICAL: If word1 (from final) is compound and word2 (from partial) is not,
  // check if word2 matches a part of word1
  if (word1.isCompound && !word2.isCompound) {
    // Split compound word and check if word2 matches any part
    const compoundParts = word1.original.toLowerCase().split('-');
    const firstPart = compoundParts[0].replace(/[.,!?;:\-'"()]/g, '');
    const lastPart = compoundParts[compoundParts.length - 1].replace(/[.,!?;:\-'"()]/g, '');
    
    // Allow match if word2 matches the FIRST part of compound word
    // Example: "are-gathered" matches "are" (first part) - this is valid
    if (firstPart === word2.clean && firstPart.length >= 2) {
      return true; // Match - word2 is the first part of compound word1
    }
    
    // Prevent match if word2 matches the LAST part (suffix) of compound word
    // Example: "self-centered" should NOT match "centered" (last part) - they're different words
    // This prevents false matches where a standalone word matches just the suffix of a compound
    if (lastPart === word2.clean && lastPart.length >= 2 && compoundParts.length > 1) {
      // Always prevent - word2 is just the suffix, not the same word
      return false; // Don't match - word2 is just the suffix of compound word1
    }
    
    // Also check suffix protection (for cases like "self-centered" vs "centered")
    if (isCompoundWordSuffix(word1.original, word2.original)) {
      return false;
    }
  }
  
  // CRITICAL: If word2 (from partial) is compound and word1 (from final) is not,
  // check if word1 matches a part of word2
  if (!word1.isCompound && word2.isCompound) {
    // Split compound word and check if word1 matches any part
    const compoundParts = word2.original.toLowerCase().split('-');
    const firstPart = compoundParts[0].replace(/[.,!?;:\-'"()]/g, '');
    const lastPart = compoundParts[compoundParts.length - 1].replace(/[.,!?;:\-'"()]/g, '');
    
    // CRITICAL: Prevent matching standalone words with compound words in most cases
    // Only allow matching if the compound word is clearly a continuation (like "are-gathered")
    // But prevent matching when the standalone word appears in a different context
    // Example: "self" (standalone) should NOT match "self-centered" (compound) - they're different words
    // Example: "are" (standalone) CAN match "are-gathered" (compound) - it's a continuation
    
    // Check if word1 matches the FIRST part of compound word
    // Only allow if the compound word is clearly a continuation pattern
    // Common continuation patterns: verb + past participle (are-gathered, is-going)
    // But NOT: adjective + past participle (self-centered, well-known) - these are different words
    if (firstPart === word1.clean && firstPart.length >= 2) {
      // Check if this is a continuation pattern (verb + past participle)
      // Common verbs that form continuations: be, have, do, will, can, etc.
      const continuationVerbs = ['are', 'is', 'was', 'were', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could'];
      if (continuationVerbs.includes(firstPart)) {
        return true; // Match - word1 is a continuation verb forming a compound
      }
      // For other cases, be more conservative - don't match standalone with compound
      // This prevents "self" matching "self-centered", "well" matching "well-known", etc.
      return false; // Don't match - standalone word with compound word in different context
    }
    
    // Prevent match if word1 matches the LAST part (suffix) of compound word
    // Example: "centered" should NOT match "self-centered" (last part) - they're different words
    if (lastPart === word1.clean && lastPart.length >= 2 && compoundParts.length > 1) {
      return false; // Don't match - word1 is just the suffix of compound word2
    }
    
    // Also check suffix protection
    if (isCompoundWordSuffix(word2.original, word1.original)) {
      return false;
    }
  }
  
  // CRITICAL: Check if word2 (from partial) is part of a compound word elsewhere in final
  // If so, don't match word1 with word2 unless word1 is also compound
  // This prevents matching "person" (from final) with "person" (from partial) when
  // "centered" (from partial) is preceded by "self-centered" (from final)
  // Example: "self-centered person" (final) vs "centered person" (partial)
  // We should NOT match "person" with "person" because "centered" would be incorrectly skipped
  if (!word2.isCompound && finalWords.length > 0) {
    // Check if word2 matches a suffix part of any compound word in the final
    for (const finalWord of finalWords) {
      if (finalWord.isCompound && finalWord !== word1) {
        const compoundParts = finalWord.original.toLowerCase().split('-');
        const lastPart = compoundParts[compoundParts.length - 1].replace(/[.,!?;:\-'"()]/g, '');
        
        // If word2 matches the suffix of a compound word in final, and word1 is not compound,
        // this might be a false match context
        // But we need to be careful - we only want to prevent if word2 is actually the suffix
        // For now, let's be more specific: only prevent if word1 is the word after the compound
        if (lastPart.length >= 2 && compoundParts.length > 1) {
          // Check if word1 is the word immediately after the compound word in final
          const finalWordIndex = finalWords.indexOf(finalWord);
          if (finalWordIndex >= 0 && finalWordIndex < finalWords.length - 1) {
            const nextFinalWord = finalWords[finalWordIndex + 1];
            if (nextFinalWord && nextFinalWord === word1 && word2.clean === lastPart) {
              // word1 is right after compound word, and word2 matches the suffix
              // This is likely a false match - don't match
              return false;
            }
          }
        }
      }
    }
  }
  
  // CRITICAL: Check if word1 (from final) is part of a compound word elsewhere in final
  // If so, don't match it with word2 (from partial) unless word2 is also compound
  // This prevents matching "centered" (standalone) with "centered" (from "self-centered")
  if (!word1.isCompound && finalWords.length > 0) {
    // Check if word1 is part of any compound word in the final
    for (const finalWord of finalWords) {
      if (finalWord.isCompound && finalWord !== word1) {
        // Split the compound word and check if word1 matches the LAST part (suffix)
        // We allow matching the FIRST part (like "are" from "are-gathered")
        const compoundParts = finalWord.original.toLowerCase().split('-');
        const lastPart = compoundParts[compoundParts.length - 1].replace(/[.,!?;:\-'"()]/g, '');
        
        // Only prevent if word1 matches the LAST part (suffix) of the compound word
        // This prevents "centered" from matching "self-centered"
        if (lastPart === word1.clean && lastPart.length >= 2 && compoundParts.length > 1) {
          return false; // Don't match - word1 is just the suffix of compound word in final
        }
      }
    }
  }
  
  // CRITICAL: Check if word2 (from partial) matches the suffix of any compound word in final
  // If so, don't match it with word1 (from final) - they're different words
  // Example: "self-centered person" (final) vs "centered person" (partial)
  // "centered" from partial should NOT match "centered" standalone in final if "self-centered" exists
  if (!word2.isCompound && finalWords.length > 0) {
    // Check if word2 matches the suffix of any compound word in the final
    for (const finalWord of finalWords) {
      if (finalWord.isCompound) {
        const compoundParts = finalWord.original.toLowerCase().split('-');
        const lastPart = compoundParts[compoundParts.length - 1].replace(/[.,!?;:\-'"()]/g, '');
        
        // If word2 matches the suffix of a compound word, don't match it
        // This prevents "centered" (standalone) from matching "centered" (suffix of "self-centered")
        if (lastPart === word2.clean && lastPart.length >= 2 && compoundParts.length > 1) {
          return false; // Don't match - word2 is just the suffix of a compound word in final
        }
      }
    }
  }
  
  // CRITICAL: Check if word1 (from final) is part of a compound word
  // If word1 is the suffix of a compound word in final, don't match it with word2 (from partial)
  // Example: "self-centered person" (final) vs "centered person" (partial)
  // "centered" from partial should NOT match "centered" from "self-centered" in final
  if (!word1.isCompound && finalWords.length > 0) {
    // Check if word1 is the suffix of any compound word in the final
    for (const finalWord of finalWords) {
      if (finalWord.isCompound && finalWord.clean.includes(word1.clean)) {
        const compoundParts = finalWord.original.toLowerCase().split('-');
        const lastPart = compoundParts[compoundParts.length - 1].replace(/[.,!?;:\-'"()]/g, '');
        
        // If word1 matches the suffix of a compound word, don't match it
        // This prevents "centered" (from partial) from matching "centered" (suffix of "self-centered")
        if (lastPart === word1.clean && lastPart.length >= 2 && compoundParts.length > 1) {
          return false; // Don't match - word1 is just the suffix of a compound word in final
        }
      }
    }
  }
  
  // Don't match numbers with text words
  // Numbers should only match other numbers, and only if they're the same
  if (/^\d+$/.test(word1.clean) || /^\d+$/.test(word2.clean)) {
    // If one is a number and the other is not, they don't match
    if (/^\d+$/.test(word1.clean) !== /^\d+$/.test(word2.clean)) {
      return false;
    }
    // If both are numbers, they must match exactly
    if (/^\d+$/.test(word1.clean) && /^\d+$/.test(word2.clean)) {
      return word1.clean === word2.clean;
    }
  }
  
  // Don't match if words are too different in context
  // For example, "sentence" in "the end of sentence" vs "sentence" in "new sentence starts"
  // These are different contexts and shouldn't match
  // But this is hard to detect without more context, so we'll rely on phrase matching
  // to prevent false positives (single word matches when there's no phrase match)
  
  // Before using wordsAreRelated, check if one word is a substring of the other
  // and if that would cause a false match with compound words
  // Example: "centered" should NOT match "self-centered" even though "self-centered" contains "centered"
  const w1 = word1.clean;
  const w2 = word2.clean;
  
  // If one word contains the other, check if it's a compound word issue
  if (w1.includes(w2) || w2.includes(w1)) {
    const shorter = w1.length < w2.length ? w1 : w2;
    const longer = w1.length >= w2.length ? w1 : w2;
    
    // If the longer word is compound and shorter is not, and shorter matches a suffix of longer,
    // this is likely a false match (e.g., "centered" vs "self-centered")
    if (word1.isCompound && !word2.isCompound && word1.original.toLowerCase().includes('-')) {
      const compoundParts = word1.original.toLowerCase().split('-');
      const lastPart = compoundParts[compoundParts.length - 1].replace(/[.,!?;:\-'"()]/g, '');
      if (lastPart === shorter && compoundParts.length > 1) {
        return false; // Don't match - shorter is just the suffix of compound word
      }
    }
    if (word2.isCompound && !word1.isCompound && word2.original.toLowerCase().includes('-')) {
      const compoundParts = word2.original.toLowerCase().split('-');
      const lastPart = compoundParts[compoundParts.length - 1].replace(/[.,!?;:\-'"()]/g, '');
      if (lastPart === shorter && compoundParts.length > 1) {
        return false; // Don't match - shorter is just the suffix of compound word
      }
    }
  }
  
  // For final-to-final deduplication, use stricter matching
  // Only match exact words (case-insensitive, punctuation removed)
  // Do NOT use stem matching (e.g., "testing" should NOT match "test")
  // This prevents false matches where one word is just a substring/stem of another
  const clean1 = word1.clean;
  const clean2 = word2.clean;
  
  // Exact match only (case-insensitive, punctuation already removed in .clean)
  // This allows "Our" to match "our" but prevents "testing" from matching "test"
  return clean1 === clean2;
}

/**
 * Find phrase-level overlap between final and partial words (with detailed info)
 * @param {Array} finalWords - Words from final text (last N words)
 * @param {Array} partialWords - Words from partial text
 * @param {number} maxPhraseLen - Maximum phrase length to check
 * @param {Array} allFinalWords - All final words (for compound word context)
 * @returns {Object|null} - { phraseLen: number, partialStart: number, skipCount: number } or null if no match
 */
function findPhraseOverlapWithInfo(finalWords, partialWords, maxPhraseLen = 5, allFinalWords = []) {
  if (finalWords.length === 0 || partialWords.length === 0) return null;
  
  const maxLen = Math.min(maxPhraseLen, finalWords.length, partialWords.length);
  let bestMatch = null;
  
  // Try phrases of decreasing length, starting from longest
  // This ensures we find the longest matching phrase first
  for (let phraseLen = maxLen; phraseLen >= 1; phraseLen--) {
    const finalPhrase = finalWords.slice(-phraseLen);
    
    // Try all possible starting positions in partial
    for (let partialStart = 0; partialStart <= partialWords.length - phraseLen; partialStart++) {
      const partialPhrase = partialWords.slice(partialStart, partialStart + phraseLen);
      
      // Check if all words in phrase match (in order)
      // Special case: Allow matching when numbers differ (e.g., "sentence 123" vs "sentence 456")
      // But only match the non-number words, stop at the number mismatch
      let allMatch = true;
      let numberMismatchIndex = -1;
      let effectivePhraseLen = phraseLen;
      
      for (let i = 0; i < phraseLen; i++) {
        const finalWord = finalPhrase[i];
        const partialWord = partialPhrase[i];
        const finalIsNumber = /^\d+$/.test(finalWord.clean);
        const partialIsNumber = /^\d+$/.test(partialWord.clean);
        
        // If both are numbers, they must match exactly
        if (finalIsNumber && partialIsNumber) {
          if (finalWord.clean !== partialWord.clean) {
            // Numbers differ - stop matching here, but allow match up to this point
            numberMismatchIndex = i;
            break;
          }
        }
        // If one is a number and the other is not, stop matching here
        else if (finalIsNumber !== partialIsNumber) {
          numberMismatchIndex = i;
          break;
        }
        
        // Pass all final words for compound word context checking
        if (!wordsMatch(finalWord, partialWord, allFinalWords)) {
          allMatch = false;
          break;
        }
      }
      
      // If we hit a number mismatch, only match if all words before it matched
      if (numberMismatchIndex >= 0) {
        if (numberMismatchIndex === 0) {
          // Number mismatch at first position - no match
          allMatch = false;
        } else {
          // Number mismatch after some matches - only match up to that point
          effectivePhraseLen = numberMismatchIndex;
          // Note: finalPhrase and partialPhrase are const, but we've already matched up to effectivePhraseLen
          // The matching logic will use effectivePhraseLen for skipCount calculation
        }
      }
      
      // Additional check: If phrase match succeeded, verify that preceding words don't create
      // a compound word mismatch context
      // Example 1: "self-centered person" (final) vs "centered person" (partial)
      // Example 2: "centered person" (final) vs "self-centered person" (partial)
      // We shouldn't match "person" with "person" if the preceding word is a compound suffix mismatch
      if (allMatch && partialStart > 0) {
        // There's a word before the match in partial - check if it's a compound suffix mismatch
        const wordBeforePartial = partialWords[partialStart - 1];
        if (wordBeforePartial) {
          // Check both directions: wordBeforePartial vs compound in final, and compound in partial vs word in final
          
          // Direction 1: wordBeforePartial is suffix of compound word in final
          if (!wordBeforePartial.isCompound) {
            for (const finalWord of allFinalWords) {
              if (finalWord.isCompound) {
                const compoundParts = finalWord.original.toLowerCase().split('-');
                const lastPart = compoundParts[compoundParts.length - 1].replace(/[.,!?;:\-'"()]/g, '');
                if (lastPart === wordBeforePartial.clean && compoundParts.length > 1) {
                  const finalWordIndex = allFinalWords.indexOf(finalWord);
                  const finalPhraseStartIndex = allFinalWords.length - finalWords.length;
                  if (finalWordIndex >= finalPhraseStartIndex - 1 && finalWordIndex < finalPhraseStartIndex + finalWords.length) {
                    allMatch = false;
                    break;
                  }
                }
              }
            }
          }
          
          // Direction 2: wordBeforePartial is compound, and its suffix matches a word in final
          // Example: "self-centered person" (partial) vs "centered person" (final)
          // "self-centered" is compound, its suffix "centered" matches "centered" in final
          // We should NOT match "person" with "person" because "centered" would be incorrectly skipped
          if (wordBeforePartial.isCompound && allMatch) {
            const compoundParts = wordBeforePartial.original.toLowerCase().split('-');
            const lastPart = compoundParts[compoundParts.length - 1].replace(/[.,!?;:\-'"()]/g, '');
            if (compoundParts.length > 1 && lastPart.length >= 2) {
              // Check if lastPart matches any word in final phrase (not compound)
              // Also check words just before the final phrase
              const finalPhraseStartIndex = allFinalWords.length - finalWords.length;
              for (let i = Math.max(0, finalPhraseStartIndex - 1); i < finalPhraseStartIndex + finalWords.length; i++) {
                if (i < allFinalWords.length) {
                  const finalWord = allFinalWords[i];
                  if (!finalWord.isCompound && finalWord.clean === lastPart) {
                    // The suffix of the compound word in partial matches a word in final
                    // This is a compound suffix mismatch - prevent the match
                    allMatch = false;
                    break;
                  }
                }
              }
            }
          }
        }
      }
      
      if (allMatch) {
        // skipCount = number of words to skip from start of partial
        // If match is at start (partialStart === 0), skip just the phrase
        // If match is later (partialStart > 0), skip everything up to and including the phrase
        // Use effectivePhraseLen (may be shorter if number mismatch occurred)
        const skipCount = partialStart + effectivePhraseLen;
        
        // Prefer longer phrases first (more reliable)
        // If same length, prefer matches at start (position 0) to minimize false positives
        // For single-word matches, require them to be at position 0 to avoid false positives
        // Exception: Allow single-word matches not at position 0 only if they're part of a longer phrase context
        // Use effectivePhraseLen (may be shorter if number mismatch occurred)
        if (!bestMatch || effectivePhraseLen > bestMatch.phraseLen) {
          bestMatch = { phraseLen: effectivePhraseLen, partialStart, skipCount };
        } else if (effectivePhraseLen === bestMatch.phraseLen) {
          // Same length - prefer match at position 0 (start of partial) to avoid false positives
          // For single-word matches (effectivePhraseLen === 1), strongly prefer position 0
          if (effectivePhraseLen === 1) {
            // Single-word match - only accept if at position 0, or if bestMatch is also not at 0 and this is earlier
            if (partialStart === 0) {
              bestMatch = { phraseLen, partialStart, skipCount };
            } else if (bestMatch.partialStart > 0 && partialStart < bestMatch.partialStart) {
              // Both not at start, prefer earlier
              bestMatch = { phraseLen, partialStart, skipCount };
            }
            // If bestMatch is at start and new match is not, keep bestMatch (don't update)
          } else {
            // Multi-word match - prefer position 0 or earlier position
            if (partialStart === 0 || (bestMatch.partialStart > 0 && partialStart < bestMatch.partialStart)) {
              bestMatch = { phraseLen, partialStart, skipCount };
            }
          }
        }
      }
    }
  }
  
  // Final check: If bestMatch is a single-word match not at position 0, verify context
  // Example: "the end of sentence" vs "new sentence starts" - don't match "sentence" at position 1
  // But allow: "three are" vs "our are" - "our" is just an extra word, allow "are" to match
  if (bestMatch && bestMatch.phraseLen === 1 && bestMatch.partialStart > 0) {
    const wordBeforePartial = partialWords[bestMatch.partialStart - 1];
    
    // Check if wordBeforePartial matches any word in final
    let wordBeforePartialMatchesFinal = false;
    let matchedIndex = -1;
    for (let i = 0; i < allFinalWords.length; i++) {
      if (wordsMatch(allFinalWords[i], wordBeforePartial, allFinalWords)) {
        wordBeforePartialMatchesFinal = true;
        matchedIndex = i;
        break;
      }
    }
    
    if (wordBeforePartialMatchesFinal) {
      // wordBeforePartial matches a word in final
      // If it matches a word that's NOT right before the match, reject (different context)
      if (matchedIndex < allFinalWords.length - 2) {
        return null;
      }
      // If it matches the word right before, that's OK (might be correction)
    } else {
      // wordBeforePartial doesn't match anything in final
      // If there's a word before the match in final, and they're completely unrelated,
      // this suggests different context - reject the match
      if (finalWords.length > 1) {
        const wordBeforeFinal = finalWords[finalWords.length - 2];
        // Reject if wordBeforePartial is a common word that suggests new context
        // (e.g., "new" in "new sentence" vs "end of sentence")
        const contextWords = ['new', 'next', 'another', 'different', 'this', 'that'];
        if (contextWords.includes(wordBeforePartial.clean)) {
          return null;
        }
      }
    }
  }
  
  return bestMatch;
}

/**
 * Find phrase-level overlap between final and partial words
 * Returns the number of words to skip from the start of partial
 * @param {Array} finalWords - Words from final text (last N words)
 * @param {Array} partialWords - Words from partial text
 * @param {number} maxPhraseLen - Maximum phrase length to check
 * @param {Array} allFinalWords - All final words (for compound word context)
 * @returns {number} - Number of words to skip (0 if no overlap found)
 */
function findPhraseOverlap(finalWords, partialWords, maxPhraseLen = 5, allFinalWords = []) {
  if (finalWords.length === 0 || partialWords.length === 0) return 0;
  
  // Try phrases of decreasing length, starting from the longest possible
  // This ensures we find the longest matching phrase first
  const maxLen = Math.min(maxPhraseLen, finalWords.length, partialWords.length);
  
  // Track the best match (longest phrase, prefer start of partial)
  let bestMatch = { phraseLen: 0, partialStart: -1, skipCount: 0 };
  
  for (let phraseLen = maxLen; phraseLen >= 1; phraseLen--) {
    // Get last N words from final
    const finalPhrase = finalWords.slice(-phraseLen);
    
    // Try all possible starting positions in partial
    // Prefer matches that start at position 0 (overlap at start of partial)
    for (let partialStart = 0; partialStart <= partialWords.length - phraseLen; partialStart++) {
      const partialPhrase = partialWords.slice(partialStart, partialStart + phraseLen);
      
      // Check if all words in phrase match (in order: first word of final phrase with first word of partial phrase, etc.)
      let allMatch = true;
      for (let i = 0; i < phraseLen; i++) {
        // Pass all final words for compound word context checking
        if (!wordsMatch(finalPhrase[i], partialPhrase[i], allFinalWords)) {
          allMatch = false;
          break;
        }
      }
      
      if (allMatch) {
        // Found a match!
        // If match is at start (partialStart === 0), skip the overlapping words
        // If match is in middle (partialStart > 0), we need to handle it differently
        const skipCount = partialStart === 0 ? phraseLen : partialStart + phraseLen;
        
        // Prefer longer phrases, and if same length, prefer matches at start (position 0)
        if (phraseLen > bestMatch.phraseLen) {
          bestMatch = { phraseLen, partialStart, skipCount };
        } else if (phraseLen === bestMatch.phraseLen) {
          // Same length - prefer match at position 0 (start of partial)
          if (partialStart === 0 || (bestMatch.partialStart > 0 && partialStart < bestMatch.partialStart)) {
            bestMatch = { phraseLen, partialStart, skipCount };
          }
        }
      }
    }
  }
  
  // Return skipCount for backward compatibility, but we'll need to handle middle overlaps differently
  return bestMatch.skipCount;
}

/**
 * Remove duplicate words from partial text that overlap with previous final
 * 
 * @param {Object} params - Deduplication parameters
 * @param {string} params.partialText - The partial transcript text to deduplicate
 * @param {string} params.lastFinalText - The last sent final text to check against
 * @param {number} params.lastFinalTime - Timestamp when last final was sent
 * @param {string} params.mode - 'SoloMode' or 'HostMode' for logging
 * @param {number} [params.timeWindowMs=5000] - Time window to check for duplicates (default 5 seconds)
 * @param {number} [params.maxWordsToCheck=5] - Maximum number of words to check for overlap (default 5)
 * @returns {Object} Deduplication result
 * @returns {string} result.deduplicatedText - The deduplicated partial text
 * @returns {number} result.wordsSkipped - Number of words that were skipped
 * @returns {boolean} result.wasDeduplicated - Whether any deduplication occurred
 */
export function deduplicatePartialText({
  partialText,
  lastFinalText,
  lastFinalTime,
  mode = 'UnknownMode',
  timeWindowMs = 5000,
  maxWordsToCheck = 5
}) {
  // Default result: no deduplication
  let deduplicatedText = partialText;
  let wordsSkipped = 0;
  let wasDeduplicated = false;

  // Check if we have the required inputs
  if (!partialText || !lastFinalText || !lastFinalTime) {
    return { deduplicatedText, wordsSkipped, wasDeduplicated };
  }

  // Only check if FINAL was sent recently (within time window)
  const timeSinceLastFinal = Date.now() - lastFinalTime;
  if (timeSinceLastFinal >= timeWindowMs) {
    return { deduplicatedText, wordsSkipped, wasDeduplicated };
  }

  // CRITICAL FIX: Check if partial is clearly a new segment before deduplicating
  // But don't be too aggressive - still allow phrase matching to run
  const finalTrimmed = lastFinalText.trim();
  const partialTrimmed = partialText.trim();
  const finalEndsWithPunctuation = /[.!?]$/.test(finalTrimmed);
  const partialStartsWithCapital = /^[A-Z]/.test(partialTrimmed);
  const finalLower = finalTrimmed.toLowerCase();
  const partialLower = partialTrimmed.toLowerCase();
  
  // Check if partial extends the final (is a continuation)
  // If partial is longer and starts with final text, it's a continuation - proceed with deduplication
  const partialExtendsFinal = partialTrimmed.length > finalTrimmed.length && 
                               (partialLower.startsWith(finalLower) || 
                                (finalTrimmed.length > 10 && partialLower.substring(0, finalTrimmed.length) === finalLower));
  
  // If partial doesn't extend final and starts with a capital letter (new sentence),
  // check if first word or any words match - but still allow phrase matching to run
  // Only skip if we're VERY certain it's a completely new segment
  let likelyNewSegment = false;
  if (!partialExtendsFinal && partialStartsWithCapital && finalEndsWithPunctuation) {
    const finalWordsList = finalTrimmed.split(/\s+/).map(w => w.toLowerCase().replace(/[.!?,]/g, ''));
    const partialFirstWord = partialTrimmed.split(/\s+/)[0]?.toLowerCase().replace(/[.!?,]/g, '');
    
    // Check if first word appears anywhere in final (exact match or as part of a word)
    let firstWordMatches = false;
    if (partialFirstWord) {
      // Exact match
      if (finalWordsList.includes(partialFirstWord)) {
        firstWordMatches = true;
      } else {
        // Check if first word is a stem of any word in final (e.g., "gather" matches "gathered")
        // Or if any word in final contains the first word as a stem
        for (const finalWord of finalWordsList) {
          if (finalWord.startsWith(partialFirstWord) || partialFirstWord.startsWith(finalWord)) {
            firstWordMatches = true;
            break;
          }
        }
      }
    }
    
    // Only skip if first word doesn't match AND partial doesn't start with any part of final
    // This is a conservative check - we'll still run phrase matching below
    if (partialFirstWord && !firstWordMatches && !partialLower.startsWith(finalLower.substring(0, Math.min(30, finalLower.length)))) {
      likelyNewSegment = true;
      // Don't return early - still allow phrase matching to run
    }
  }

  // Extract words with metadata (preserving original case and structure)
  const finalWords = extractWords(lastFinalText);
  const partialWords = extractWords(partialText);

  if (finalWords.length === 0 || partialWords.length === 0) {
    return { deduplicatedText, wordsSkipped, wasDeduplicated };
  }

  // Get last N words from final (for phrase matching)
  // But check ALL final words for compound word context (not just last N)
  const lastWordsFromFinal = finalWords.slice(-maxWordsToCheck);
  
  // Find phrase-level overlap (handles multiple word overlaps and extra words before overlap)
  // Pass ALL final words (not just last N) for compound word context checking
  // This ensures we check compound words even if they're not in the last N words
  let overlapInfo = findPhraseOverlapWithInfo(lastWordsFromFinal, partialWords, maxWordsToCheck, finalWords);
  
  // CRITICAL: General pattern matching - check windows of words at end of previous and start of new
  // Algorithm:
  // 1. Check last 5 words of previous final
  // 2. Check first 5 words of next segment
  // 3. Find ANY matching word (not requiring consecutive from start)
  // 4. When a matching word is found, deduplicate all words from start up to and including the match
  // CRITICAL FIX: If final ends with punctuation and partial starts with capital, be more conservative
  // - Require multiple word matches OR match at end of previous final (not just any position)
  // - This prevents false deduplication when new sentences start with common words like "You", "I", "The"
  if (!overlapInfo && partialWords.length > 0) {
    // Define windows: check last 5 words of previous and first 5 words of new
    const WINDOW_SIZE_PREVIOUS = Math.min(5, finalWords.length); // Check last 5 words of previous
    const WINDOW_SIZE_NEW = Math.min(5, partialWords.length); // Check first 5 words of new
    
    const previousWindow = finalWords.slice(-WINDOW_SIZE_PREVIOUS);
    const newWindow = partialWords.slice(0, WINDOW_SIZE_NEW);
    
    console.log(`[${mode}] 🔍 WORD-BY-WORD MATCHING (fallback strategy):`);
    console.log(`[${mode}]   Previous window (last ${WINDOW_SIZE_PREVIOUS} words): ${previousWindow.map(w => `"${w.original}"`).join(', ')}`);
    console.log(`[${mode}]   New window (first ${WINDOW_SIZE_NEW} words): ${newWindow.map(w => `"${w.original}"`).join(', ')}`);
    console.log(`[${mode}]   Strategy: Find ALL matching words, then deduplicate up to LAST match`);
    
    // Strategy: Find ALL matching words in the new window, then deduplicate up to the LAST match
    // This handles cases like "Our desires" where both "Our" and "desires" match
    // We want to deduplicate all words from start up to and including the LAST matching word
    let lastMatchingIndex = -1;
    let matchedWords = [];
    
    // Check each word in the new window (from start to end)
    // We need to find ALL matches, then use the LAST (rightmost) one
    for (let newIdx = 0; newIdx < newWindow.length; newIdx++) {
      const newWord = newWindow[newIdx];
      
      // Check if this word matches any word in the previous window
      // Check from end of previous window (most recent words first)
      for (let prevIdx = previousWindow.length - 1; prevIdx >= 0; prevIdx--) {
        const prevWord = previousWindow[prevIdx];
        
        if (wordsMatch(prevWord, newWord, finalWords)) {
          // Found a match! Track it (we want the LAST match, so keep updating)
          lastMatchingIndex = newIdx;
          matchedWords.push({
            newIndex: newIdx,
            newWord: newWord,
            prevIndex: prevIdx,
            prevWord: prevWord,
            // Track if match is at the end of previous final (most reliable indicator of continuation)
            isAtEndOfPrevious: prevIdx === previousWindow.length - 1
          });
          console.log(`[${mode}]   ✅ Match found: "${newWord.original}" (position ${newIdx} in new) matches "${prevWord.original}" (position ${prevIdx} in previous)`);
          break; // Found match for this word, move to next
        }
      }
    }
    
    // If we found matching words, check if we should deduplicate
    if (lastMatchingIndex >= 0) {
      // CRITICAL: If final ends with punctuation and partial starts with capital,
      // require either:
      // 1. Multiple word matches (2+), OR
      // 2. Single match at position 0 that matches the LAST word of previous final
      // This prevents false deduplication when new sentences start with common words
      const isLikelyNewSentence = finalEndsWithPunctuation && partialStartsWithCapital;
      const isSingleWordMatchAtStart = matchedWords.length === 1 && lastMatchingIndex === 0;
      const matchIsAtEndOfPrevious = matchedWords.some(m => m.isAtEndOfPrevious);
      
      if (isLikelyNewSentence && isSingleWordMatchAtStart && !matchIsAtEndOfPrevious) {
        // This is likely a new sentence starting with a common word - don't deduplicate
        console.log(`[${mode}]   ⚠️ Skipping deduplication: New sentence likely starts with common word "${matchedWords[0].newWord.original}" (not a continuation)`);
        overlapInfo = null; // Don't deduplicate
      } else {
        // skipCount = number of words to skip from start (lastMatchingIndex + 1 because index is 0-based)
        const skipCount = lastMatchingIndex + 1;
        
        overlapInfo = {
          phraseLen: matchedWords.length, // Number of matching words found
          partialStart: 0,
          skipCount: skipCount
        };
        
        const matchedWordsStr = matchedWords.map(m => `"${m.newWord.original}"`).join(', ');
        const matchedPreviousWordsStr = matchedWords.map(m => `"${m.prevWord.original}"`).join(', ');
        console.log(`[${mode}] 🔍 WORD MATCHING RESULT:`);
        console.log(`[${mode}]   Found ${matchedWords.length} word match(es) in first 5 words of new segment`);
        console.log(`[${mode}]   Matched words in new: ${matchedWordsStr}`);
        console.log(`[${mode}]   Matched words in previous: ${matchedPreviousWordsStr}`);
        console.log(`[${mode}]   Last matching word position in new: ${lastMatchingIndex} (0-based)`);
        console.log(`[${mode}]   Will skip ${skipCount} word(s) from start (all words up to and including last match)`);
        console.log(`[${mode}]   Algorithm: Check last 5 words of previous → Check first 5 words of new → Find ALL matches → Deduplicate up to LAST match`);
      }
    }
  }
  
  const wordsToSkip = overlapInfo ? overlapInfo.skipCount : 0;

  if (wordsToSkip > 0 && overlapInfo) {
      // Reconstruct deduplicated text by removing overlapping words
      // Preserve original case and spacing
      const partialWordsArray = partialText.trim().split(/\s+/);
      
      // Determine handling based on match position and phrase length
      // Rule: If match is at position 0, always skip from start
      // If match is not at position 0:
      //   - For short phrases (2-3 words) with words before AND after: preserve words before (middle overlap)
      //   - For single-word matches or long phrases: skip words before (they're likely transcription errors)
      const hasWordsBefore = overlapInfo.partialStart > 0;
      const hasWordsAfter = overlapInfo.partialStart + overlapInfo.phraseLen < partialWordsArray.length;
      const isShortPhrase = overlapInfo.phraseLen >= 2 && overlapInfo.phraseLen <= 3;
      const isMiddleOverlap = hasWordsBefore && hasWordsAfter && isShortPhrase;
      
      if (isMiddleOverlap) {
        // Overlap is in the middle with short phrase - keep words before and after, remove only the overlapping phrase
        // Example: "words the end of continues" -> keep "words", remove "the end of", keep "continues"
        const beforeOverlap = partialWordsArray.slice(0, overlapInfo.partialStart);
        const afterOverlap = partialWordsArray.slice(overlapInfo.partialStart + overlapInfo.phraseLen);
        deduplicatedText = [...beforeOverlap, ...afterOverlap].join(' ').trim();
        wordsSkipped = overlapInfo.phraseLen;
      } else {
        // Overlap is at start OR single-word match OR long phrase match OR match extends to end
        // Use skipCount which includes words before match
        // This handles cases like:
        // - "our are gathered" where "are" (1 word) matches at position 1 -> skip "our are"
        // - "some words the end of the sentence continues" where long phrase matches -> skip everything before
        const remainingWords = partialWordsArray.slice(overlapInfo.skipCount);
        deduplicatedText = remainingWords.join(' ').trim();
        wordsSkipped = overlapInfo.skipCount;
      }
      
      wasDeduplicated = true;
      
      console.log(`[${mode}] ✂️ Trimmed ${wordsSkipped} duplicate word(s) from partial: "${partialText.substring(0, 50)}..." → "${deduplicatedText.substring(0, 50)}..."`);

      // If nothing left after trimming, return empty string (caller should skip sending)
      if (!deduplicatedText || deduplicatedText.length === 0) {
        console.log(`[${mode}] ⏭️ All words are duplicates of previous FINAL - text would be empty after deduplication`);
        return { deduplicatedText: '', wordsSkipped, wasDeduplicated: true };
      }
  }

  return { deduplicatedText, wordsSkipped, wasDeduplicated };
}
