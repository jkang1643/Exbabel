/**
 * Partial Translation State Manager
 * 
 * Centralizes state management for partial translations to prevent desynchronization.
 * 
 * CRITICAL RULES:
 * 1. lastTranslation is ONLY updated after successful translation
 * 2. All state updates go through this manager (no direct variable access)
 * 3. State is validated before critical operations
 */

export class PartialTranslationStateManager {
  constructor() {
    // Core state - all updates go through methods
    this._lastTranslation = '';
    this._lastTranslationTime = 0;
    this._pendingTimeout = null;
    this._currentText = '';
    
    // Configuration (documented with reasoning)
    this.GROWTH_THRESHOLD = 2;  // Update every 2 chars (~per word) for responsive UI
    this.MIN_TIME_MS = 150;     // OpenAI API avg: 200-300ms. 150ms prevents queue buildup
    this.MIN_DELAY_MS = 250;    // Delayed path: 250ms to handle rapid partial bursts
    this.ADDITIONAL_DELAY_WHEN_QUEUED = 200; // Extra delay when finals are queued
    
    // Validation
    this._validationEnabled = true;
  }

  /**
   * Get current text being tracked
   */
  getCurrentText() {
    return this._currentText;
  }

  /**
   * Update current text (called when new partial arrives)
   */
  updateCurrentText(text) {
    if (!text || typeof text !== 'string') {
      console.warn('[PartialState] ⚠️ Invalid text update:', text);
      return;
    }
    this._currentText = text;
  }

  /**
   * Get last successfully translated text
   */
  getLastTranslation() {
    return this._lastTranslation;
  }

  /**
   * Get timestamp of last translation
   */
  getLastTranslationTime() {
    return this._lastTranslationTime;
  }

  /**
   * Update state after successful translation
   * CRITICAL: Only call this after translation succeeds
   */
  updateAfterSuccess(translatedText) {
    if (!translatedText || typeof translatedText !== 'string') {
      console.warn('[PartialState] ⚠️ Invalid success update:', translatedText);
      return;
    }
    
    this._lastTranslation = this._currentText; // Store the source text that was translated
    this._lastTranslationTime = Date.now();
    
    if (this._validationEnabled) {
      this._validateState('after success');
    }
  }

  /**
   * Update state after error that should prevent retry (e.g., timeout with fallback)
   * Use this when sending fallback to UI so system doesn't retry
   */
  updateAfterErrorFallback(text) {
    if (!text || typeof text !== 'string') {
      console.warn('[PartialState] ⚠️ Invalid error fallback update:', text);
      return;
    }
    
    this._lastTranslation = text;
    this._lastTranslationTime = Date.now();
    
    if (this._validationEnabled) {
      this._validateState('after error fallback');
    }
  }

  /**
   * Check if translation should happen now (immediate path)
   * Returns: { shouldTranslate: boolean, reason: string }
   */
  shouldTranslateNow() {
    const now = Date.now();
    const timeSinceLastTranslation = now - this._lastTranslationTime;
    const textGrowth = this._currentText.length - this._lastTranslation.length;
    
    const isFirstTranslation = this._lastTranslation.length === 0;
    const textGrewSignificantly = textGrowth >= this.GROWTH_THRESHOLD;
    const enoughTimePassed = timeSinceLastTranslation >= this.MIN_TIME_MS;
    
    const shouldTranslate = isFirstTranslation || (textGrewSignificantly && enoughTimePassed);
    
    let reason = '';
    if (isFirstTranslation) {
      reason = 'first translation';
    } else if (textGrewSignificantly && enoughTimePassed) {
      reason = `growth: ${textGrowth} chars, time: ${timeSinceLastTranslation}ms`;
    } else if (!textGrewSignificantly) {
      reason = `growth too small: ${textGrowth} < ${this.GROWTH_THRESHOLD}`;
    } else {
      reason = `time too short: ${timeSinceLastTranslation} < ${this.MIN_TIME_MS}ms`;
    }
    
    return { shouldTranslate, reason };
  }

  /**
   * Check if text is exact match (skip translation)
   */
  isExactMatch(text) {
    return text === this._lastTranslation;
  }

  /**
   * Calculate delay for delayed translation path
   * @param {number} queuedFinalsCount - Number of finals in queue
   * @returns {number} Delay in milliseconds
   */
  calculateDelayedPathDelay(queuedFinalsCount = 0) {
    const now = Date.now();
    const timeSinceLastTranslation = now - this._lastTranslationTime;
    
    let baseDelay = this.MIN_DELAY_MS;
    if (queuedFinalsCount > 0) {
      baseDelay += this.ADDITIONAL_DELAY_WHEN_QUEUED;
    }
    
    const delay = Math.max(0, baseDelay - timeSinceLastTranslation);
    return delay;
  }

  /**
   * Set pending timeout (for delayed path)
   */
  setPendingTimeout(timeoutHandle) {
    this._pendingTimeout = timeoutHandle;
  }

  /**
   * Get pending timeout
   */
  getPendingTimeout() {
    return this._pendingTimeout;
  }

  /**
   * Clear pending timeout
   */
  clearPendingTimeout() {
    if (this._pendingTimeout) {
      clearTimeout(this._pendingTimeout);
      this._pendingTimeout = null;
    }
  }

  /**
   * Check if text changed during delay (stale check)
   * @param {string} capturedText - Text captured at timeout start
   * @returns {boolean} True if text is stale
   */
  isStale(capturedText) {
    return this._currentText !== capturedText;
  }

  /**
   * Reset state (e.g., on new segment or connection reset)
   */
  reset() {
    this._lastTranslation = '';
    this._lastTranslationTime = 0;
    this.clearPendingTimeout();
    this._currentText = '';
    
    if (this._validationEnabled) {
      this._validateState('after reset');
    }
  }

  /**
   * Get state snapshot for debugging
   */
  getStateSnapshot() {
    return {
      lastTranslation: this._lastTranslation,
      lastTranslationLength: this._lastTranslation.length,
      lastTranslationTime: this._lastTranslationTime,
      currentText: this._currentText,
      currentTextLength: this._currentText.length,
      hasPendingTimeout: this._pendingTimeout !== null,
      timeSinceLastTranslation: Date.now() - this._lastTranslationTime,
      textGrowth: this._currentText.length - this._lastTranslation.length
    };
  }

  /**
   * Validate state integrity
   * @private
   */
  _validateState(context) {
    if (!this._validationEnabled) return;
    
    const issues = [];
    
    // Check: If lastTranslation is set, timestamp should be set
    if (this._lastTranslation && !this._lastTranslationTime) {
      issues.push('lastTranslation set but no timestamp');
    }
    
    // Check: Timestamp should be recent (not from hours ago)
    if (this._lastTranslationTime) {
      const age = Date.now() - this._lastTranslationTime;
      if (age > 3600000) { // 1 hour
        issues.push(`timestamp very old: ${age}ms ago`);
      }
    }
    
    // Check: Current text should not be shorter than last translation (unless reset)
    if (this._lastTranslation && this._currentText.length < this._lastTranslation.length * 0.5) {
      // This might be OK if it's a new segment, but log it
      console.log(`[PartialState] 📝 Text shrunk significantly (${this._lastTranslation.length} → ${this._currentText.length} chars) - might be new segment`);
    }
    
    if (issues.length > 0) {
      console.error(`[PartialState] ❌ State validation failed (${context}):`, issues);
      console.error('[PartialState] State snapshot:', this.getStateSnapshot());
    }
  }

  /**
   * Enable/disable validation (for performance in production)
   */
  setValidationEnabled(enabled) {
    this._validationEnabled = enabled;
  }
}

