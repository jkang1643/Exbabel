/**
 * Finalization Engine - Manages finalization state and timing logic
 * 
 * Extracted from soloModeHandler.js (Phase 5)
 * 
 * This component manages the pendingFinalization state, timing decisions,
 * and sentence completion detection for adaptive finalization.
 * 
 * CRITICAL: This logic must match the original implementation exactly to preserve
 * adaptive finalization timing behavior.
 */

import { FINALIZATION_CONSTANTS } from '../shared/types/config.js';

/**
 * Finalization Engine class
 * Manages finalization state and timing decisions
 */
export class FinalizationEngine {
  constructor(options = {}) {
    // Finalization state
    this.pendingFinalization = null; // { seqId, text, timestamp, timeout, maxWaitTimestamp }
    
    // Constants
    this.MAX_FINALIZATION_WAIT_MS = options.maxWaitMs || FINALIZATION_CONSTANTS.MAX_FINALIZATION_WAIT_MS;
    this.FINALIZATION_CONFIRMATION_WINDOW = options.confirmationWindow || FINALIZATION_CONSTANTS.FINALIZATION_CONFIRMATION_WINDOW;
    this.MIN_SILENCE_MS = options.minSilenceMs || FINALIZATION_CONSTANTS.MIN_SILENCE_MS;
    this.DEFAULT_LOOKAHEAD_MS = options.defaultLookaheadMs || FINALIZATION_CONSTANTS.DEFAULT_LOOKAHEAD_MS;
  }

  /**
   * Check if text ends with a complete sentence
   * A complete sentence ends with sentence-ending punctuation (. ! ?) followed by optional quotes/closing punctuation
   * 
   * @param {string} text - Text to check
   * @returns {boolean} True if text ends with complete sentence
   */
  endsWithCompleteSentence(text) {
    if (!text || text.length === 0) return false;
    const trimmed = text.trim();
    // Ends with sentence-ending punctuation (period, exclamation, question mark, ellipsis)
    // May be followed by closing quotes, parentheses, or other closing punctuation
    if (/[.!?…]["')]*\s*$/.test(trimmed)) return true;
    // Also check for common sentence-ending patterns
    if (/[.!?…]\s*$/.test(trimmed)) return true;
    return false;
  }

  /**
   * Create pending finalization state
   * 
   * @param {string} text - Final text to finalize
   * @param {number} seqId - Optional sequence ID
   * @returns {Object} Pending finalization state
   */
  createPendingFinalization(text, seqId = null) {
    this.pendingFinalization = {
      seqId,
      text,
      timestamp: Date.now(),
      maxWaitTimestamp: Date.now(), // Track when FINAL was first received
      timeout: null
    };
    return this.pendingFinalization;
  }

  /**
   * Get current pending finalization
   * 
   * @returns {Object|null} Pending finalization state or null
   */
  getPendingFinalization() {
    return this.pendingFinalization;
  }

  /**
   * Update pending finalization text
   * 
   * @param {string} text - New text
   */
  updatePendingFinalizationText(text) {
    if (this.pendingFinalization) {
      this.pendingFinalization.text = text;
      this.pendingFinalization.timestamp = Date.now(); // Reset timestamp to give more time
    }
  }

  /**
   * Set pending finalization timeout
   * 
   * @param {Function} callback - Callback to execute when timeout fires
   * @param {number} delayMs - Delay in milliseconds
   */
  setPendingFinalizationTimeout(callback, delayMs) {
    if (this.pendingFinalization && this.pendingFinalization.timeout) {
      clearTimeout(this.pendingFinalization.timeout);
    }
    if (this.pendingFinalization) {
      this.pendingFinalization.timeout = setTimeout(callback, delayMs);
    }
  }

  /**
   * Clear pending finalization timeout
   */
  clearPendingFinalizationTimeout() {
    if (this.pendingFinalization && this.pendingFinalization.timeout) {
      clearTimeout(this.pendingFinalization.timeout);
      this.pendingFinalization.timeout = null;
    }
  }

  /**
   * Clear pending finalization (reset state)
   */
  clearPendingFinalization() {
    if (this.pendingFinalization && this.pendingFinalization.timeout) {
      clearTimeout(this.pendingFinalization.timeout);
    }
    this.pendingFinalization = null;
  }

  /**
   * Check if pending finalization exists
   * 
   * @returns {boolean} True if pending finalization exists
   */
  hasPendingFinalization() {
    return this.pendingFinalization !== null;
  }

  /**
   * Get time since finalization was created
   * 
   * @returns {number} Milliseconds since finalization was created, or Infinity if none
   */
  getTimeSinceFinalization() {
    if (!this.pendingFinalization) return Infinity;
    return Date.now() - this.pendingFinalization.timestamp;
  }

  /**
   * Get time since max wait timestamp
   * 
   * @returns {number} Milliseconds since max wait timestamp, or Infinity if none
   */
  getTimeSinceMaxWait() {
    if (!this.pendingFinalization) return Infinity;
    return Date.now() - this.pendingFinalization.maxWaitTimestamp;
  }

  /**
   * Check if max wait time has been exceeded
   * 
   * @returns {boolean} True if max wait time exceeded
   */
  hasExceededMaxWait() {
    return this.getTimeSinceMaxWait() >= this.MAX_FINALIZATION_WAIT_MS;
  }

  /**
   * Calculate wait time for finalization based on sentence completion
   * 
   * @param {string} text - Text to finalize
   * @param {number} baseWaitMs - Base wait time in milliseconds
   * @returns {number} Calculated wait time
   */
  calculateWaitTime(text, baseWaitMs) {
    let waitTime = baseWaitMs;
    
    // CRITICAL: Sentence-aware finalization - wait for complete sentences
    // If FINAL doesn't end with a complete sentence, wait longer for continuation
    const finalEndsWithCompleteSentence = this.endsWithCompleteSentence(text);
    if (!finalEndsWithCompleteSentence) {
      // FINAL doesn't end with complete sentence - wait longer for continuation
      // Reduced from 4-8 seconds to 1.5-3 seconds to prevent excessive delays
      const SENTENCE_WAIT_MS = Math.max(1500, Math.min(3000, text.length * 10)); // 1.5-3 seconds based on length
      waitTime = Math.max(waitTime, SENTENCE_WAIT_MS);
    }
    
    return waitTime;
  }

  /**
   * Check if finalization should wait longer (sentence incomplete)
   * 
   * @param {string} text - Text to check
   * @returns {boolean} True if should wait longer
   */
  shouldWaitLonger(text) {
    if (!this.pendingFinalization) return false;
    
    const finalEndsWithCompleteSentence = this.endsWithCompleteSentence(text);
    const timeSinceMaxWait = this.getTimeSinceMaxWait();
    
    // Wait longer if sentence incomplete and haven't exceeded max wait
    return !finalEndsWithCompleteSentence && timeSinceMaxWait < this.MAX_FINALIZATION_WAIT_MS - 2000;
  }

  /**
   * Get remaining wait time before max wait is exceeded
   * 
   * @returns {number} Remaining wait time in milliseconds
   */
  getRemainingWaitTime() {
    if (!this.pendingFinalization) return 0;
    const timeSinceMaxWait = this.getTimeSinceMaxWait();
    return Math.max(0, this.MAX_FINALIZATION_WAIT_MS - timeSinceMaxWait);
  }

  /**
   * Reset finalization engine (for testing or session reset)
   */
  reset() {
    this.clearPendingFinalization();
  }

  /**
   * Get current state (for debugging)
   * 
   * @returns {Object} Current engine state
   */
  getState() {
    return {
      hasPending: this.hasPendingFinalization(),
      timeSinceFinalization: this.getTimeSinceFinalization(),
      timeSinceMaxWait: this.getTimeSinceMaxWait(),
      hasExceededMaxWait: this.hasExceededMaxWait(),
      pendingText: this.pendingFinalization?.text || null,
      pendingTextLength: this.pendingFinalization?.text?.length || 0
    };
  }
}

export default FinalizationEngine;

