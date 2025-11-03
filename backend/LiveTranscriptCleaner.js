/**
 * Live Transcript Cleaner
 * 
 * Restores punctuation and capitalization to live partial transcripts from Google Speech-to-Text.
 * Uses Hugging Face model: pszemraj/grammar-synthesis-small (77M parameters)
 * T5-based text2text-generation model for high-quality grammar correction.
 * 
 * Processing strategy:
 * - Interim partials (isPartial=true): Pass through raw for immediate responsive display
 * - Final segments (isPartial=false): Buffer and clean periodically, then update livePartial
 */

import { getGrammarCorrectorModel } from './grammarCorrectorModel.js';

export class LiveTranscriptCleaner {
  constructor(options = {}) {
    const {
      minWordsPerUpdate = 15,
      timeThresholdMs = 3000,
      enabled = process.env.ENABLE_PUNCTUATION_CLEANER !== 'false',
      language = 'en-US'
    } = options;

    this.minWordsPerUpdate = minWordsPerUpdate;
    this.timeThresholdMs = timeThresholdMs;
    this.enabled = enabled;
    this.language = language;

    // Grammar corrector (Hugging Face model)
    this.grammarCorrector = getGrammarCorrectorModel();
    this.grammarCorrector.enabled = enabled;
    this.grammarCorrector.language = language;

    // Start model initialization early (non-blocking)
    if (enabled) {
      console.log('[LiveTranscriptCleaner] 🚀 Starting grammar correction model initialization...');
      this.grammarCorrector.init().catch(err => {
        console.warn('[LiveTranscriptCleaner] ⚠️ Background initialization error:', err.message);
      });
    }

    // Buffering for final transcripts
    this.finalBuffer = '';
    this.cleanedTranscript = '';
    this.lastCleanedText = '';
    this.lastBufferUpdateTime = null;
    this.currentLivePartial = '';
    this.cleanupTimer = null;
  }


  async feed(transcriptText, isPartial) {
    if (!this.enabled) {
      return {
        cleanedSegment: null,
        fullCleanedText: transcriptText,
        shouldUpdate: false
      };
    }
    
    // Log when we receive transcripts for debugging
    if (isPartial) {
      // Partial transcripts - just store, don't process yet
      // console.log(`[LiveTranscriptCleaner] 📝 Partial received (buffering): "${transcriptText.substring(0, 40)}..."`);
    } else {
      console.log(`[LiveTranscriptCleaner] 📝 Final transcript received: "${transcriptText.substring(0, 50)}..."`);
    }

    if (isPartial) {
      // Process partial transcripts through grammar corrector in real-time
      this.currentLivePartial = transcriptText;
      
      // For partials, correct immediately for real-time feedback
      // Don't block if model is still loading
      try {
        // Check if model is ready - if not, return original text immediately
        if (!this.grammarCorrector.pipeline || this.grammarCorrector.initializing) {
          // Model still loading or not available - return original text without blocking
          return {
            cleanedSegment: null,
            fullCleanedText: transcriptText,
            shouldUpdate: false
          };
        }
        
        // Try correction with short timeout - don't block transcription
        const result = await Promise.race([
          this.grammarCorrector.correct(transcriptText, this.language),
          new Promise((resolve) => setTimeout(() => resolve({ corrected: transcriptText, matches: 0 }), 500)) // 500ms timeout for partials
        ]);
        
        const correctedPartial = result.corrected || transcriptText;
        
        if (correctedPartial !== transcriptText) {
          console.log(`[LiveTranscriptCleaner] ✨ Partial corrected (${result.matches} fix(es)): "${correctedPartial.substring(0, 50)}..."`);
        }
        
        return {
          cleanedSegment: null,
          fullCleanedText: correctedPartial,
          shouldUpdate: correctedPartial !== transcriptText
        };
      } catch (error) {
        console.warn('[LiveTranscriptCleaner] Error correcting partial:', error.message);
        // Fallback to original text - don't block transcription
        return {
          cleanedSegment: null,
          fullCleanedText: transcriptText,
          shouldUpdate: false
        };
      }
    } else {
      if (this.finalBuffer.length > 0) {
        this.finalBuffer += ' ' + transcriptText.trim();
      } else {
        this.finalBuffer = transcriptText.trim();
      }
      this.lastBufferUpdateTime = Date.now();

      const wordCount = this.finalBuffer.trim().split(/\s+/).length;
      console.log(`[LiveTranscriptCleaner] 📝 Final transcript added (${wordCount} words)`);

      const shouldTrigger = this._shouldTriggerCleanup();
      if (shouldTrigger) {
        console.log(`[LiveTranscriptCleaner] ✅ Threshold met, processing buffer immediately`);
        return await this._processBuffer();
      } else {
        console.log(`[LiveTranscriptCleaner] ⏳ Threshold not met, scheduling cleanup`);
        this._scheduleCleanup();
      }

      return {
        cleanedSegment: null,
        fullCleanedText: this.cleanedTranscript || transcriptText,
        shouldUpdate: false
      };
    }
  }

  _shouldTriggerCleanup() {
    if (!this.finalBuffer || this.finalBuffer.trim().length === 0) return false;
    const wordCount = this.finalBuffer.trim().split(/\s+/).length;
    const timeSinceUpdate = this.lastBufferUpdateTime 
      ? Date.now() - this.lastBufferUpdateTime 
      : Infinity;
    return wordCount >= this.minWordsPerUpdate || timeSinceUpdate >= this.timeThresholdMs;
  }

  _scheduleCleanup() {
    if (this.cleanupTimer) return;
    const delay = Math.max(100, this.timeThresholdMs - (Date.now() - (this.lastBufferUpdateTime || Date.now())));
    this.cleanupTimer = setTimeout(async () => {
      this.cleanupTimer = null;
      if (this._shouldTriggerCleanup()) {
        await this._processBuffer();
      }
    }, delay);
  }

  async _processBuffer() {
    if (!this.finalBuffer || this.finalBuffer.trim().length === 0) {
      return {
        cleanedSegment: null,
        fullCleanedText: this.cleanedTranscript,
        shouldUpdate: false
      };
    }

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    try {
      const bufferText = this.finalBuffer.trim();
      console.log(`[LiveTranscriptCleaner] 🧹 Processing buffer (${bufferText.split(/\s+/).length} words): "${bufferText.substring(0, 60)}..."`);
      
      // Use Hugging Face model for grammar correction
      // Add timeout to prevent blocking if model isn't ready
      let cleanedBuffer = bufferText;
      
      try {
        // Check if model is ready - skip if not available
        if (!this.grammarCorrector.pipeline || this.grammarCorrector.initializing) {
          console.log('[LiveTranscriptCleaner] ⏳ Model not ready, using original text');
          cleanedBuffer = bufferText;
        } else {
          // Try correction with aggressive timeout - don't block
          try {
            const result = await Promise.race([
              this.grammarCorrector.correct(bufferText, this.language),
              new Promise((resolve) => setTimeout(() => resolve({ corrected: bufferText, matches: 0 }), 2000)) // 2s timeout max
            ]);
            cleanedBuffer = result.corrected || bufferText;
          } catch (error) {
            // Any error - just use original text
            console.warn('[LiveTranscriptCleaner] Grammar correction failed, using original:', error.message);
            cleanedBuffer = bufferText;
          }
        }
      } catch (error) {
        console.warn('[LiveTranscriptCleaner] Grammar correction error, using original:', error.message);
        cleanedBuffer = bufferText;
      }
      
      // Calculate matches only if we got a result
      const matches = cleanedBuffer !== bufferText ? 1 : 0;
      
      if (cleanedBuffer !== bufferText) {
        console.log(`[LiveTranscriptCleaner] ✨ Cleaned (${matches} fix(es)): "${cleanedBuffer.substring(0, 60)}..."`);
      } else {
        console.log(`[LiveTranscriptCleaner] ℹ️ No changes detected`);
      }

      const newSegment = cleanedBuffer.trim();
      if (newSegment.length > 0) {
        this.cleanedTranscript = this.cleanedTranscript 
          ? (this.cleanedTranscript + ' ' + newSegment).trim()
          : newSegment;
      }
      
      this.finalBuffer = '';
      this.lastBufferUpdateTime = null;

      return {
        cleanedSegment: newSegment,
        fullCleanedText: this.cleanedTranscript,
        shouldUpdate: newSegment.length > 0
      };
    } catch (error) {
      console.error('[LiveTranscriptCleaner] ❌ Error processing buffer:', error);
      // Always return something - never leave the buffer hanging
      const rawBuffer = this.finalBuffer ? this.finalBuffer.trim() : '';
      this.finalBuffer = '';
      this.lastBufferUpdateTime = null;
      
      // Update cleaned transcript even on error
      if (rawBuffer.length > 0) {
        this.cleanedTranscript = this.cleanedTranscript 
          ? (this.cleanedTranscript + ' ' + rawBuffer).trim()
          : rawBuffer;
      }
      
      return {
        cleanedSegment: rawBuffer,
        fullCleanedText: this.cleanedTranscript || rawBuffer,
        shouldUpdate: rawBuffer.length > 0
      };
    }
  }

  getFullTranscript() {
    if (!this.enabled) {
      return this.currentLivePartial || this.finalBuffer || '';
    }
    return this.cleanedTranscript.trim();
  }

  getCurrentLivePartial() {
    return this.currentLivePartial;
  }

  reset() {
    this.finalBuffer = '';
    this.cleanedTranscript = '';
    this.lastCleanedText = '';
    this.currentLivePartial = '';
    this.lastBufferUpdateTime = null;
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async flush() {
    return await this._processBuffer();
  }
}
