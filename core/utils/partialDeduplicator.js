/**
 * Partial Text Deduplicator - Removes duplicate words from partials that overlap with previous finals
 * 
 * Extracted from soloModeHandler.js and host/adapter.js to eliminate duplication.
 * 
 * This utility detects and removes duplicate words from partial transcripts that
 * overlap with the end of the previous final transcript, preventing word duplication
 * in the output.
 */

import { wordsAreRelated } from '../../backend/utils/recoveryMerge.js';

/**
 * Remove duplicate words from partial text that overlap with previous final
 * 
 * @param {Object} params - Deduplication parameters
 * @param {string} params.partialText - The partial transcript text to deduplicate
 * @param {string} params.lastFinalText - The last sent final text to check against
 * @param {number} params.lastFinalTime - Timestamp when last final was sent
 * @param {string} params.mode - 'SoloMode' or 'HostMode' for logging
 * @param {number} [params.timeWindowMs=5000] - Time window to check for duplicates (default 5 seconds)
 * @param {number} [params.maxWordsToCheck=3] - Maximum number of words to check for overlap (default 3)
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
  maxWordsToCheck = 3
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

  // Normalize texts for comparison
  const lastSentFinalNormalized = lastFinalText.replace(/\s+/g, ' ').toLowerCase();
  const partialNormalized = partialText.replace(/\s+/g, ' ').toLowerCase();

  // Get words from both texts (filter out very short words)
  const lastSentWords = lastSentFinalNormalized.split(/\s+/).filter(w => w.length > 2);
  const partialWords = partialNormalized.split(/\s+/).filter(w => w.length > 2);

  // Check if partial starts with words that are related to the end of previous FINAL
  if (lastSentWords.length > 0 && partialWords.length > 0) {
    const lastWordsFromFinal = lastSentWords.slice(-maxWordsToCheck); // Last N words from FINAL
    const firstWordsFromPartial = partialWords.slice(0, maxWordsToCheck); // First N words from PARTIAL

    // Check if the first word(s) of partial match the last word(s) of final
    // This catches cases like "desires" at end of FINAL followed by "Desires" at start of PARTIAL
    let wordsToSkip = 0;

    // Check backwards: first word of partial vs last word of final, second vs second-to-last, etc.
    for (let i = 0; i < Math.min(firstWordsFromPartial.length, lastWordsFromFinal.length); i++) {
      const partialWord = firstWordsFromPartial[i];
      const finalWord = lastWordsFromFinal[lastWordsFromFinal.length - 1 - i];

      if (wordsAreRelated(partialWord, finalWord)) {
        wordsToSkip++;
        console.log(`[${mode}] ⚠️ Partial word "${partialWord}" (position ${i}) matches final word "${finalWord}" (position ${lastWordsFromFinal.length - 1 - i})`);
      } else {
        // Stop checking once we find a non-match
        break;
      }
    }

    if (wordsToSkip > 0) {
      // Skip the duplicate words
      const partialWordsArray = partialText.split(/\s+/);
      deduplicatedText = partialWordsArray.slice(wordsToSkip).join(' ').trim();
      wordsSkipped = wordsToSkip;
      wasDeduplicated = true;
      
      console.log(`[${mode}] ✂️ Trimmed ${wordsToSkip} duplicate word(s) from partial: "${partialText.substring(0, 50)}..." → "${deduplicatedText.substring(0, 50)}..."`);

      // If nothing left after trimming, return empty string (caller should skip sending)
      if (!deduplicatedText || deduplicatedText.length < 3) {
        console.log(`[${mode}] ⏭️ All words are duplicates of previous FINAL - text would be empty after deduplication`);
        return { deduplicatedText: '', wordsSkipped, wasDeduplicated: true };
      }
    }
  }

  return { deduplicatedText, wordsSkipped, wasDeduplicated };
}

export default { deduplicatePartialText };

