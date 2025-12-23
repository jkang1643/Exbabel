/**
 * Final Text Deduplicator - Removes duplicate words from new finals that overlap with previous finals
 * 
 * This utility detects and removes duplicate words from new final transcripts that
 * overlap with the end of the previous final transcript, preventing word duplication
 * in the output.
 * 
 * Similar to partialDeduplicator but specifically for final-to-final deduplication.
 */

import { deduplicatePartialText } from './partialDeduplicator.js';

/**
 * Remove duplicate words from new final text that overlap with previous final
 * 
 * @param {Object} params - Deduplication parameters
 * @param {string} params.newFinalText - The new final transcript text to deduplicate
 * @param {string} params.previousFinalText - The previous final text to check against
 * @param {number} params.previousFinalTime - Timestamp when previous final was sent
 * @param {string} params.mode - 'SoloMode' or 'HostMode' for logging
 * @param {number} [params.timeWindowMs=5000] - Time window to check for duplicates (default 5 seconds)
 * @param {number} [params.maxWordsToCheck=5] - Maximum number of words to check for overlap (default 5)
 * @returns {Object} Deduplication result
 * @returns {string} result.deduplicatedText - The deduplicated final text
 * @returns {number} result.wordsSkipped - Number of words that were skipped
 * @returns {boolean} result.wasDeduplicated - Whether any deduplication occurred
 */
export function deduplicateFinalText({
  newFinalText,
  previousFinalText,
  previousFinalTime,
  mode = 'UnknownMode',
  timeWindowMs = 5000,
  maxWordsToCheck = 5
}) {
  // Reuse the partial deduplication logic - it works the same way
  // The new final text is like a "partial" that needs to be deduplicated against the previous final
  return deduplicatePartialText({
    partialText: newFinalText,
    lastFinalText: previousFinalText,
    lastFinalTime: previousFinalTime,
    mode: mode,
    timeWindowMs: timeWindowMs,
    maxWordsToCheck: maxWordsToCheck
  });
}

export default { deduplicateFinalText };

