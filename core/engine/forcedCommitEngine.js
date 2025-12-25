/**
 * Forced Commit Engine - Manages forced final buffering and audio recovery coordination
 * 
 * Extracted from soloModeHandler.js (Phase 6)
 * 
 * This component manages forced final buffering, coordinates with partial tracking
 * for extension detection, and coordinates audio recovery operations.
 * 
 * CRITICAL: This logic must match the original implementation exactly to preserve
 * forced final audio recovery behavior.
 */

import { FINALIZATION_CONSTANTS } from '../shared/types/config.js';

/**
 * Forced Commit Engine class
 * Manages forced final buffering and recovery coordination
 */
export class ForcedCommitEngine {
  constructor(options = {}) {
    // Forced final buffer state
    this.forcedFinalBuffer = null; // { text, timestamp, timeout, recoveryInProgress, recoveryPromise }
    
    // Constants
    this.FORCED_FINAL_MAX_WAIT_MS = options.forcedFinalMaxWaitMs || FINALIZATION_CONSTANTS.FORCED_FINAL_MAX_WAIT_MS;
    this.PHASE_1_WAIT_MS = 0; // Phase 1: Start immediately
    this.PHASE_2_WAIT_MS = 1200; // Phase 2: Wait 1200ms to capture POST-final audio
    this.CAPTURE_WINDOW_MS = 2200; // PRE+POST-final audio capture window
    this.LATE_PARTIAL_WINDOW_MS = 5000; // Window for late partials to be considered
  }

  /**
   * Check if forced final buffer exists
   * 
   * @returns {boolean} True if forced final buffer exists
   */
  hasForcedFinalBuffer() {
    return this.forcedFinalBuffer !== null;
  }

  /**
   * Get forced final buffer
   * 
   * @returns {Object|null} Forced final buffer or null
   */
  getForcedFinalBuffer() {
    return this.forcedFinalBuffer;
  }

  /**
   * Create forced final buffer
   * 
   * @param {string} text - Forced final text
   * @param {number} timestamp - Timestamp when forced final occurred
   * @param {string} lastSentFinalText - Last sent final text (grammar-corrected, optional)
   * @param {number} lastSentFinalTime - Last sent final time (optional)
   * @param {string} lastSentOriginalText - Last sent original text (raw transcription, preferred for deduplication, optional)
   * @returns {Object} Forced final buffer object
   */
  createForcedFinalBuffer(text, timestamp = Date.now(), lastSentFinalText = null, lastSentFinalTime = null, lastSentOriginalText = null) {
    this.forcedFinalBuffer = {
      text,
      timestamp,
      timeout: null,
      recoveryInProgress: false,
      recoveryPromise: null,
      committedByRecovery: false,  // Track if recovery already committed this
      lastSentFinalTextBeforeBuffer: lastSentFinalText || null,  // Capture lastSentFinalText at buffer creation for deduplication (fallback)
      lastSentFinalTimeBeforeBuffer: lastSentFinalTime || null,   // Capture lastSentFinalTime at buffer creation for deduplication
      lastSentOriginalTextBeforeBuffer: lastSentOriginalText || null  // Capture lastSentOriginalText (preferred for deduplication)
    };
    return this.forcedFinalBuffer;
  }

  /**
   * Update forced final buffer text
   * 
   * @param {string} text - New text
   */
  updateForcedFinalBufferText(text) {
    if (this.forcedFinalBuffer) {
      this.forcedFinalBuffer.text = text;
    }
  }

  /**
   * Set forced final buffer timeout
   * 
   * @param {Function} callback - Callback to execute when timeout fires
   * @param {number} delayMs - Delay in milliseconds
   */
  setForcedFinalBufferTimeout(callback, delayMs) {
    if (this.forcedFinalBuffer && this.forcedFinalBuffer.timeout) {
      clearTimeout(this.forcedFinalBuffer.timeout);
    }
    if (this.forcedFinalBuffer) {
      this.forcedFinalBuffer.timeout = setTimeout(callback, delayMs);
    }
  }

  /**
   * Clear forced final buffer timeout
   */
  clearForcedFinalBufferTimeout() {
    if (this.forcedFinalBuffer && this.forcedFinalBuffer.timeout) {
      clearTimeout(this.forcedFinalBuffer.timeout);
      this.forcedFinalBuffer.timeout = null;
    }
  }

  /**
   * Clear forced final buffer (reset state)
   */
  clearForcedFinalBuffer() {
    if (this.forcedFinalBuffer && this.forcedFinalBuffer.timeout) {
      clearTimeout(this.forcedFinalBuffer.timeout);
    }
    this.forcedFinalBuffer = null;
  }

  /**
   * Check if a partial extends the forced final
   * 
   * @param {string} partialText - Partial text to check
   * @returns {Object|null} Extension info if partial extends forced final, null otherwise
   */
  checkPartialExtendsForcedFinal(partialText) {
    if (!this.forcedFinalBuffer || !partialText) return null;
    
    const forcedText = this.forcedFinalBuffer.text.trim();
    const partialTextTrimmed = partialText.trim();
    
    // Check if partial extends the forced final (starts with it or has significant overlap)
    const extendsForced = partialTextTrimmed.length > forcedText.length && 
                         (partialTextTrimmed.startsWith(forcedText) || 
                          (forcedText.length > 10 && partialTextTrimmed.substring(0, forcedText.length) === forcedText));
    
    if (extendsForced) {
      return {
        extends: true,
        extendedText: partialTextTrimmed,
        missingWords: partialTextTrimmed.substring(forcedText.length).trim()
      };
    }
    
    return null;
  }

  /**
   * Check if partial is a new segment (doesn't extend forced final)
   * 
   * @param {string} partialText - Partial text to check
   * @returns {boolean} True if partial is a new segment
   */
  isNewSegment(partialText) {
    const extension = this.checkPartialExtendsForcedFinal(partialText);
    return !extension || !extension.extends;
  }

  /**
   * Set recovery in progress flag
   * 
   * @param {boolean} inProgress - Whether recovery is in progress
   * @param {Promise} recoveryPromise - Optional recovery promise
   */
  setRecoveryInProgress(inProgress, recoveryPromise = null) {
    if (this.forcedFinalBuffer) {
      this.forcedFinalBuffer.recoveryInProgress = inProgress;
      this.forcedFinalBuffer.recoveryPromise = recoveryPromise;
    }
  }

  /**
   * Get time since forced final was created
   * 
   * @returns {number} Milliseconds since forced final, or Infinity if none
   */
  getTimeSinceForcedFinal() {
    if (!this.forcedFinalBuffer) return Infinity;
    return Date.now() - this.forcedFinalBuffer.timestamp;
  }

  /**
   * Check if forced final ends with punctuation
   * 
   * @returns {boolean} True if forced final ends with punctuation
   */
  forcedFinalEndsWithPunctuation() {
    if (!this.forcedFinalBuffer) return false;
    return /[.!?…]$/.test(this.forcedFinalBuffer.text.trim());
  }

  /**
   * Reset forced commit engine (for testing or session reset)
   */
  reset() {
    this.clearForcedFinalBuffer();
  }

  /**
   * Get current state (for debugging)
   * 
   * @returns {Object} Current engine state
   */
  getState() {
    return {
      hasBuffer: this.hasForcedFinalBuffer(),
      bufferText: this.forcedFinalBuffer?.text || null,
      bufferTextLength: this.forcedFinalBuffer?.text?.length || 0,
      timeSinceForcedFinal: this.getTimeSinceForcedFinal(),
      recoveryInProgress: this.forcedFinalBuffer?.recoveryInProgress || false
    };
  }
}

export default ForcedCommitEngine;

