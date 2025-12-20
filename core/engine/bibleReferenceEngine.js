/**
 * Bible Reference Engine
 * 
 * Main orchestrator for Bible reference detection.
 * Coordinates detection strategies and returns structured verse references.
 * 
 * Similar pattern to finalizationEngine.js - mode-agnostic core component.
 */

import { EventEmitter } from 'events';
import { BibleReferenceDetector } from '../services/bibleReferenceDetector.js';

/**
 * Bible Reference Engine class
 */
export class BibleReferenceEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.config = {
      confidenceThreshold: options.confidenceThreshold || 0.85,
      aiFallbackThreshold: options.aiFallbackThreshold || 0.70,
      enableLLMConfirmation: options.enableLLMConfirmation !== false,
      llmModel: options.llmModel || 'gpt-4o-mini',
      openaiApiKey: options.openaiApiKey,
      transcriptWindowSeconds: options.transcriptWindowSeconds || 10,
      ...options
    };
    
    // Initialize detector
    this.detector = new BibleReferenceDetector(this.config);
    
    // Transcript window for sliding window matching
    this.transcriptWindow = [];
    this.windowSize = this.config.transcriptWindowSeconds * 10; // Approximate words per second
  }
  
  /**
   * Detect Bible references in text
   * 
   * @param {string} text - Transcript text to analyze
   * @param {Object} options - Detection options
   * @param {string} [options.sourceLang] - Source language
   * @param {string} [options.targetLang] - Target language
   * @param {number} [options.seqId] - Sequence ID for ordering
   * @returns {Promise<Array<Object>>} Array of detected references
   */
  async detectReferences(text, options = {}) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return [];
    }
    
    try {
      // Add to transcript window
      this.addToWindow(text);
      
      // Get window text for matching
      const windowText = this.getWindowText();
      
      // Run detection
      const references = await this.detector.detectReferences(windowText, options);
      
      // Emit internal event for monitoring
      if (references.length > 0) {
        for (const ref of references) {
          this.emit('referenceDetected', {
            reference: ref,
            confidence: ref.confidence,
            method: ref.method,
            timestamp: Date.now()
          });
        }
      }
      
      return references;
      
    } catch (error) {
      console.error('[BibleReferenceEngine] Detection error:', error);
      this.emit('error', error);
      return []; // Fail silently - don't break transcript delivery
    }
  }
  
  /**
   * Add text to transcript window
   * 
   * @param {string} text - Text to add
   */
  addToWindow(text) {
    const words = text.split(/\s+/);
    this.transcriptWindow.push(...words);
    
    // Trim window to size
    if (this.transcriptWindow.length > this.windowSize) {
      this.transcriptWindow = this.transcriptWindow.slice(-this.windowSize);
    }
  }
  
  /**
   * Get current window text
   * 
   * @returns {string} Window text
   */
  getWindowText() {
    return this.transcriptWindow.join(' ');
  }
  
  /**
   * Clear transcript window
   */
  clearWindow() {
    this.transcriptWindow = [];
  }
  
  /**
   * Reset engine state
   */
  reset() {
    this.clearWindow();
    this.emit('reset');
  }
  
  /**
   * Update configuration
   * 
   * @param {Object} newConfig - New configuration options
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.detector = new BibleReferenceDetector(this.config);
  }
}

export default {
  BibleReferenceEngine
};

