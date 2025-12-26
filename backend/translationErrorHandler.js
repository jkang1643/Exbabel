/**
 * Unified Translation Error Handler
 * 
 * Centralizes error handling logic to ensure state is always updated correctly.
 * Prevents state desynchronization from inconsistent error handling.
 */

export class TranslationErrorHandler {
  constructor(stateManager, sendWithSequence) {
    this.stateManager = stateManager;
    this.sendWithSequence = sendWithSequence;
  }

  /**
   * Handle translation error and update state appropriately
   * @param {Error} error - The error object
   * @param {string} originalText - Original text that failed to translate
   * @param {string} workerType - 'CHAT' or 'REALTIME'
   * @param {boolean} isDelayed - Whether this is from delayed path
   * @returns {boolean} True if error was handled (state updated), false if should retry
   */
  handleError(error, originalText, workerType = 'CHAT', isDelayed = false) {
    const prefix = isDelayed ? '[Delayed] ' : '';
    
    // AbortError: Request was cancelled - don't update state, newer request will handle
    if (error.name === 'AbortError') {
      console.log(`[TranslationError] ⏭️ ${prefix}Translation cancelled (newer request took priority)`);
      return false; // Don't update state - allow retry
    }

    // Cancelled: Explicit cancellation message
    if (error.message && error.message.includes('cancelled')) {
      console.log(`[TranslationError] ⏭️ ${prefix}Translation cancelled (newer request took priority)`);
      return false; // Don't update state - allow retry
    }

    // Conversational: Model returned chat response instead of translation
    if (error.conversational) {
      console.warn(`[TranslationError] ⚠️ ${prefix}Model returned conversational response instead of translation - using original text`);
      this._sendFallback(originalText, 'conversational', isDelayed);
      return true; // State updated with fallback
    }

    // English leak: Translation matched original (likely English)
    if (error.englishLeak) {
      console.log(`[TranslationError] ⏭️ ${prefix}English leak detected - skipping (${originalText.length} chars)`);
      return false; // Don't update state - allow retry with next partial
    }

    // Truncated: Translation was cut off by token limit
    if (error.message && error.message.includes('truncated')) {
      console.warn(`[TranslationError] ⚠️ ${prefix}Translation truncated (${originalText.length} chars) - waiting for longer partial`);
      return false; // Don't update state - wait for longer partial
    }

    // Timeout: API request timed out
    if (error.message && error.message.includes('timeout')) {
      console.warn(`[TranslationError] ⚠️ ${prefix}${workerType} API timeout - sending original text as fallback`);
      this._sendFallback(originalText, 'timeout', isDelayed);
      return true; // State updated with fallback
    }

    // Rate limit: API rate limited
    if (error.message && (error.message.includes('rate limit') || 
                          error.message.includes('TPM') || 
                          error.message.includes('RPM'))) {
      console.warn(`[TranslationError] ⚠️ ${prefix}${workerType} API rate limited - sending original text as fallback`);
      this._sendFallback(originalText, 'rate_limit', isDelayed);
      return true; // State updated with fallback
    }

    // Unknown error: Send fallback to keep UI responsive
    console.error(`[TranslationError] ❌ ${prefix}Translation error (${workerType} API, ${originalText.length} chars):`, error.message);
    console.warn(`[TranslationError] ⚠️ ${prefix}Sending original text as fallback due to translation error`);
    this._sendFallback(originalText, 'unknown_error', isDelayed);
    return true; // State updated with fallback
  }

  /**
   * Send fallback message to UI and update state
   * @private
   */
  _sendFallback(originalText, errorType, isDelayed) {
    // Update state so system doesn't retry
    this.stateManager.updateAfterErrorFallback(originalText);
    
    // Send fallback to UI
    this.sendWithSequence({
      type: 'translation',
      originalText: originalText,
      translatedText: originalText, // Use original as fallback
      timestamp: Date.now(),
      isTranscriptionOnly: false,
      hasTranslation: false, // Flag that translation failed
      hasCorrection: false,
      translationError: true,
      errorType: errorType
    }, true);
  }

  /**
   * Handle successful translation
   * @param {string} originalText - Original text that was translated
   * @param {string} translatedText - Translated text from API
   * @param {boolean} hasCorrection - Whether grammar correction was applied
   * @param {string} correctedText - Grammar-corrected text (if applicable)
   */
  handleSuccess(originalText, translatedText, hasCorrection = false, correctedText = null) {
    // Validate translation result
    if (!translatedText || translatedText.trim().length === 0) {
      console.warn(`[TranslationError] ⚠️ Translation returned empty for ${originalText.length} char text`);
      return false; // Don't update state - allow retry
    }

    // Validate that translation is different from original (prevent English leak)
    const isSameAsOriginal = translatedText === originalText || 
                             translatedText.trim() === originalText.trim() ||
                             translatedText.toLowerCase() === originalText.toLowerCase();
    
    if (isSameAsOriginal) {
      console.warn(`[TranslationError] ⚠️ Translation matches original (English leak detected): "${translatedText.substring(0, 60)}..."`);
      return false; // Don't update state - allow retry
    }

    // Update state after successful translation
    this.stateManager.updateAfterSuccess(originalText);
    
    // Send translation to UI
    this.sendWithSequence({
      type: 'translation',
      originalText: originalText,
      translatedText: translatedText,
      correctedText: correctedText || originalText,
      timestamp: Date.now(),
      isTranscriptionOnly: false,
      hasTranslation: true,
      hasCorrection: hasCorrection
    }, true);
    
    return true; // Success
  }
}

