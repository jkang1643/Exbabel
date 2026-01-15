/**
 * Partial Tracker - Tracks partial text updates and handles merging logic
 * 
 * Extracted from soloModeHandler.js (Phase 4)
 * 
 * This component tracks the latest and longest partial text to prevent word loss,
 * calculates token overlaps, and merges partials with finals.
 * 
 * CRITICAL: This logic must match the original implementation exactly to preserve
 * word recovery (longest partial tracking) behavior.
 */

import { PARTIAL_TRACKING_CONSTANTS } from '../shared/types/config.js';

/**
 * Partial Tracker class
 * Tracks latest and longest partial text, handles token overlap and merging
 */
export class PartialTracker {
  constructor(options = {}) {
    // CRITICAL: Track latest partial to prevent word loss
    this.latestPartialText = ''; // Most recent partial text from Google Speech
    this.latestPartialTime = 0; // Timestamp of latest partial
    this.longestPartialText = ''; // Track the longest partial seen in current segment
    this.longestPartialTime = 0; // Timestamp of longest partial
    
    // Track the absolute latest partial to avoid race conditions (for grammar correction)
    this.latestPartialTextForCorrection = '';
    
    // Constants
    this.FINAL_CONTINUATION_WINDOW_MS = options.finalContinuationWindow || 3000; // 3 seconds
  }

  /**
   * Update partial text tracking
   * Updates both latest and longest partial if applicable
   * 
   * @param {string} transcriptText - New partial text
   * @returns {Object} Update result with flags indicating what changed
   */
  updatePartial(transcriptText) {
    if (!transcriptText) return { latestUpdated: false, longestUpdated: false };
    
    const now = Date.now();
    let latestUpdated = false;
    let longestUpdated = false;
    
    // Update latest partial text for correction tracking
    this.latestPartialTextForCorrection = transcriptText;
    
    // Update latest partial (always update if text is longer)
    if (!this.latestPartialText || transcriptText.length > this.latestPartialText.length) {
      this.latestPartialText = transcriptText;
      this.latestPartialTime = now;
      latestUpdated = true;
    }
    
    // Update longest partial (always update if text is longer)
    if (!this.longestPartialText || transcriptText.length > this.longestPartialText.length) {
      this.longestPartialText = transcriptText;
      this.longestPartialTime = now;
      longestUpdated = true;
      if (longestUpdated) {
        console.log(`[PartialTracker] 📏 New longest partial: ${this.longestPartialText.length} chars`);
      }
    }
    
    return { latestUpdated, longestUpdated };
  }

  /**
   * Get latest partial text
   * 
   * @returns {string} Latest partial text
   */
  getLatestPartial() {
    return this.latestPartialText;
  }

  /**
   * Get longest partial text
   * 
   * @returns {string} Longest partial text
   */
  getLongestPartial() {
    return this.longestPartialText;
  }

  /**
   * Get latest partial timestamp
   * 
   * @returns {number} Timestamp of latest partial
   */
  getLatestPartialTime() {
    return this.latestPartialTime;
  }

  /**
   * Get longest partial timestamp
   * 
   * @returns {number} Timestamp of longest partial
   */
  getLongestPartialTime() {
    return this.longestPartialTime;
  }

  /**
   * Get latest partial text for correction (avoids race conditions)
   * 
   * @returns {string} Latest partial text for correction
   */
  getLatestPartialForCorrection() {
    return this.latestPartialTextForCorrection;
  }

  /**
   * Check if longest partial extends a given text
   * 
   * @param {string} text - Text to check against
   * @param {number} maxAgeMs - Maximum age of longest partial to consider (default: 10000ms)
   * @returns {Object|null} Extension info if longest extends text, null otherwise
   */
  checkLongestExtends(text, maxAgeMs = 10000) {
    if (!this.longestPartialText || !text) return null;
    
    const timeSinceLongest = this.longestPartialTime ? (Date.now() - this.longestPartialTime) : Infinity;
    if (timeSinceLongest >= maxAgeMs) return null;
    
    if (this.longestPartialText.length <= text.length) return null;
    
    const longestTrimmed = this.longestPartialText.trim();
    const textTrimmed = text.trim();
    
    // Check if longest extends text
    if (longestTrimmed.startsWith(textTrimmed) || 
        longestTrimmed.toLowerCase().startsWith(textTrimmed.toLowerCase())) {
      const missingWords = this.longestPartialText.substring(text.length).trim();
      return {
        extended: true,
        extendedText: this.longestPartialText,
        missingWords,
        timeSinceLongest
      };
    }
    
    return null;
  }

  /**
   * Check if latest partial extends a given text
   * 
   * @param {string} text - Text to check against
   * @param {number} maxAgeMs - Maximum age of latest partial to consider (default: 5000ms)
   * @returns {Object|null} Extension info if latest extends text, null otherwise
   */
  checkLatestExtends(text, maxAgeMs = 5000) {
    if (!this.latestPartialText || !text) return null;
    
    const timeSinceLatest = this.latestPartialTime ? (Date.now() - this.latestPartialTime) : Infinity;
    if (timeSinceLatest >= maxAgeMs) return null;
    
    if (this.latestPartialText.length <= text.length) return null;
    
    const latestTrimmed = this.latestPartialText.trim();
    const textTrimmed = text.trim();
    
    // Check if latest extends text
    if (latestTrimmed.startsWith(textTrimmed) || 
        latestTrimmed.toLowerCase().startsWith(textTrimmed.toLowerCase())) {
      const missingWords = this.latestPartialText.substring(text.length).trim();
      return {
        extended: true,
        extendedText: this.latestPartialText,
        missingWords,
        timeSinceLatest
      };
    }
    
    return null;
  }

  /**
   * Reset partial tracking (called after finalization)
   */
  reset() {
    this.latestPartialText = '';
    this.longestPartialText = '';
    this.latestPartialTime = 0;
    this.longestPartialTime = 0;
    // Note: latestPartialTextForCorrection is NOT reset (used for grammar correction)
  }

  /**
   * Get snapshot of current partial state (for forced commit recovery)
   * 
   * @returns {Object} Snapshot of partial state
   */
  getSnapshot() {
    return {
      longest: this.longestPartialText,
      latest: this.latestPartialText,
      longestTime: this.longestPartialTime,
      latestTime: this.latestPartialTime
    };
  }

  /**
   * Atomically snapshot and reset partial tracking
   * This prevents race conditions where new partials arrive between snapshot and reset
   * 
   * @returns {Object} Snapshot of partial state before reset
   */
  snapshotAndReset() {
    const snapshot = this.getSnapshot();
    this.reset();
    return snapshot;
  }

  /**
   * Helper function to tokenize text for overlap matching
   * 
   * @param {string} text - Text to tokenize
   * @returns {string[]} Array of tokens (words)
   */
  tokenize(text) {
    return text.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0);
  }

  /**
   * Helper function to calculate token overlap
   * 
   * @param {string[]} tokens1 - First token array
   * @param {string[]} tokens2 - Second token array
   * @returns {Object} Overlap information
   */
  calculateTokenOverlap(tokens1, tokens2) {
    if (tokens1.length === 0 || tokens2.length === 0) {
      return { overlapType: 'none', overlapTokens: 0, similarity: 0 };
    }
    const maxCheck = 6;
    let bestOverlap = 0;
    let bestType = 'none';
    
    // Check if tokens2 starts with end of tokens1
    for (let i = 1; i <= Math.min(tokens1.length, maxCheck); i++) {
      const suffix = tokens1.slice(-i);
      if (tokens2.slice(0, i).join(' ') === suffix.join(' ')) {
        if (i > bestOverlap) {
          bestOverlap = i;
          bestType = 'suffix-prefix';
        }
      }
    }
    
    // Check if tokens2 contains tokens1
    const tokens1Str = tokens1.join(' ');
    const tokens2Str = tokens2.join(' ');
    if (tokens2Str.includes(tokens1Str)) {
      const overlapTokens = tokens1.length;
      if (overlapTokens > bestOverlap) {
        bestOverlap = overlapTokens;
        bestType = 'contains';
      }
    }
    
    const similarity = bestOverlap > 0 ? bestOverlap / Math.max(tokens1.length, tokens2.length) : 0;
    return { overlapType: bestType, overlapTokens: bestOverlap, similarity };
  }

  /**
   * Helper function to merge tokens
   * 
   * @param {string} text1 - First text
   * @param {string} text2 - Second text
   * @returns {string} Merged text
   */
  mergeTokens(text1, text2) {
    const tokens1 = this.tokenize(text1);
    const tokens2 = this.tokenize(text2);
    const overlap = this.calculateTokenOverlap(tokens1, tokens2);
    
    if (overlap.overlapType === 'suffix-prefix') {
      const newTokens = tokens2.slice(overlap.overlapTokens);
      return text1 + ' ' + newTokens.join(' ');
    } else if (overlap.overlapType === 'contains') {
      return text2; // text2 contains text1, use text2
    } else {
      return text1 + ' ' + text2;
    }
  }

  /**
   * Merge text with overlap detection
   * CRITICAL: This is the core merging logic that must match exactly
   * 
   * @param {string} previousText - Previous text
   * @param {string} currentText - Current text
   * @returns {string|null} Merged text, or null if merge should not occur
   */
  mergeWithOverlap(previousText = '', currentText = '') {
    const prev = (previousText || '').trim();
    const curr = (currentText || '').trim();
    if (!prev) return curr;
    if (!curr) return prev;
    if (curr.startsWith(prev)) {
      return curr;
    }
    // CRITICAL: More lenient matching - check if current text starts with previous (case-insensitive, ignoring extra spaces)
    const prevNormalized = prev.replace(/\s+/g, ' ').toLowerCase();
    const currNormalized = curr.replace(/\s+/g, ' ').toLowerCase();
    if (currNormalized.startsWith(prevNormalized)) {
      // Current extends previous (with normalization) - use current
      return curr;
    }
    // CRITICAL: Prevent cross-segment merging
    // If current text is significantly longer and doesn't start with previous, it's likely a different segment
    // Only merge if there's a clear overlap AND the texts are similar in structure
    if (curr.length > prev.length * 1.5) {
      // Current is much longer - check if it contains the previous text in a way that suggests same segment
      const prevWords = prev.split(/\s+/).filter(w => w.length > 2); // Words longer than 2 chars (more lenient)
      const currWords = curr.split(/\s+/).filter(w => w.length > 2);
      // If current doesn't share significant words with previous, don't merge
      const sharedWords = prevWords.filter(w => currWords.includes(w));
      if (sharedWords.length < Math.min(2, prevWords.length * 0.3)) {
        // Not enough shared words - likely different segment
        return null; // Don't merge
      }
    }
    const maxOverlap = Math.min(prev.length, curr.length, 200);
    // More lenient: Require overlap (at least 3 chars) to catch more cases, including short words
    // Also try case-insensitive matching
    for (let overlap = maxOverlap; overlap >= 3; overlap--) {
      const prevSuffix = prev.slice(-overlap).toLowerCase();
      const currPrefix = curr.slice(0, overlap).toLowerCase();
      // Try exact match first
      if (prev.slice(-overlap) === curr.slice(0, overlap)) {
        return (prev + curr.slice(overlap)).trim();
      }
      // Try case-insensitive match
      if (prevSuffix === currPrefix) {
        // Case-insensitive match - use original case from current text
        return (prev + curr.slice(overlap)).trim();
      }
      // Try normalized (ignore extra spaces)
      const prevSuffixNorm = prev.slice(-overlap).replace(/\s+/g, ' ').toLowerCase();
      const currPrefixNorm = curr.slice(0, overlap).replace(/\s+/g, ' ').toLowerCase();
      if (prevSuffixNorm === currPrefixNorm && overlap >= 5) {
        // Normalized match - merge them
        return (prev + curr.slice(overlap)).trim();
      }
    }
    // No significant overlap found - don't merge (return null to indicate failure)
    return null;
  }
}

export default PartialTracker;

