/**
 * Core Engine Orchestrator - Coordinates all extracted engines
 * 
 * PHASE 7: Create unified core engine that wires together all extracted components
 * 
 * This engine coordinates:
 * - RTT Tracker (adaptive lookahead)
 * - Timeline Offset Tracker (sequence IDs)
 * - Partial Tracker (latest/longest partial tracking)
 * - Finalization Engine (finalization timing)
 * - Forced Commit Engine (forced final buffering and recovery)
 * - Bible Reference Engine (Bible verse reference detection)
 * 
 * CRITICAL: This must maintain exact same behavior as current solo mode logic
 */

import { EventEmitter } from 'events';
import { RTTTracker } from './rttTracker.js';
import { TimelineOffsetTracker } from './timelineOffsetTracker.js';
import { PartialTracker } from './partialTracker.js';
import { FinalizationEngine } from './finalizationEngine.js';
import { ForcedCommitEngine } from './forcedCommitEngine.js';
import { RecoveryStreamEngine } from './recoveryStreamEngine.js';
import { BibleReferenceEngine } from './bibleReferenceEngine.js';
import { EVENT_TYPES } from '../events/eventTypes.js';

/**
 * Core Engine class - Main orchestrator for real-time translation pipeline
 */
export class CoreEngine extends EventEmitter {
  /**
   * Create a new CoreEngine instance
   * 
   * @param {Object} options - Configuration options
   * @param {RTTTracker} [options.rttTracker] - Optional RTT tracker instance (creates new if not provided)
   * @param {TimelineOffsetTracker} [options.timelineTracker] - Optional timeline tracker instance
   * @param {PartialTracker} [options.partialTracker] - Optional partial tracker instance
   * @param {FinalizationEngine} [options.finalizationEngine] - Optional finalization engine instance
   * @param {ForcedCommitEngine} [options.forcedCommitEngine] - Optional forced commit engine instance
   * @param {BibleReferenceEngine} [options.bibleReferenceEngine] - Optional Bible reference engine instance
   * @param {Object} [options.bibleConfig] - Bible reference engine configuration
   */
  constructor(options = {}) {
    super();
    
    // Initialize all engines (use provided instances or create new ones)
    this.rttTracker = options.rttTracker || new RTTTracker();
    this.timelineTracker = options.timelineTracker || new TimelineOffsetTracker();
    this.partialTracker = options.partialTracker || new PartialTracker();
    
    // Finalization engine needs partial tracker reference
    this.finalizationEngine = options.finalizationEngine || new FinalizationEngine(this.partialTracker);
    
    // Forced commit engine
    this.forcedCommitEngine = options.forcedCommitEngine || new ForcedCommitEngine();
    
    // Recovery stream engine
    this.recoveryStreamEngine = options.recoveryStreamEngine || new RecoveryStreamEngine();
    
    // Bible reference engine
    this.bibleReferenceEngine = options.bibleReferenceEngine || 
      new BibleReferenceEngine(options.bibleConfig || {});
    
    // State tracking
    this.isInitialized = false;
  }

  /**
   * Initialize the core engine
   * Called once when the engine is ready to process results
   */
  initialize() {
    if (this.isInitialized) {
      console.warn('[CoreEngine] Already initialized');
      return;
    }
    
    this.isInitialized = true;
    this.emit('initialized');
  }

  /**
   * Reset all engine state
   * Useful for session resets or error recovery
   */
  reset() {
    this.rttTracker.reset();
    this.timelineTracker.reset();
    this.partialTracker.reset();
    this.finalizationEngine.clearPendingFinalization();
    this.forcedCommitEngine.clearForcedFinalBuffer();
    this.bibleReferenceEngine.reset();
    this.emit('reset');
  }

  /**
   * Measure RTT from client timestamp
   * 
   * @param {number} clientTimestamp - Timestamp from client
   * @returns {number|null} RTT in milliseconds, or null if invalid
   */
  measureRTT(clientTimestamp) {
    return this.rttTracker.measureRTT(clientTimestamp);
  }

  /**
   * Get adaptive lookahead based on RTT
   * 
   * @returns {number} Adaptive lookahead in milliseconds
   */
  getAdaptiveLookahead() {
    return this.rttTracker.getAdaptiveLookahead();
  }

  /**
   * Get average RTT
   * 
   * @returns {number} Average RTT in milliseconds
   */
  getAverageRTT() {
    return this.rttTracker.getAverageRTT();
  }

  /**
   * Create a sequenced message
   * 
   * @param {Object} messageData - Original message data
   * @param {boolean} isPartial - Whether message is partial
   * @returns {{message: Object, seqId: number}} Sequenced message and sequence ID
   */
  createSequencedMessage(messageData, isPartial = true) {
    return this.timelineTracker.createSequencedMessage(messageData, isPartial);
  }

  /**
   * Get current sequence ID
   * 
   * @returns {number} Current sequence ID
   */
  getCurrentSeqId() {
    return this.timelineTracker.getCurrentSeqId();
  }

  /**
   * Get latest sequence ID
   * 
   * @returns {number} Latest sequence ID
   */
  getLatestSeqId() {
    return this.timelineTracker.getLatestSeqId();
  }

  /**
   * Update partial tracking
   * 
   * @param {string} transcriptText - Partial transcript text
   */
  updatePartial(transcriptText) {
    this.partialTracker.updatePartial(transcriptText);
  }

  /**
   * Get partial tracking snapshot
   * 
   * @returns {Object} Snapshot of partial tracking state
   */
  getPartialSnapshot() {
    return this.partialTracker.getSnapshot();
  }

  /**
   * Check if longest partial extends base text
   * 
   * @param {string} baseText - Base text to check against
   * @param {number} timeWindowMs - Time window for validity
   * @returns {Object|null} Extension info or null
   */
  checkLongestExtends(baseText, timeWindowMs) {
    return this.partialTracker.checkLongestExtends(baseText, timeWindowMs);
  }

  /**
   * Check if latest partial extends base text
   * 
   * @param {string} baseText - Base text to check against
   * @param {number} timeWindowMs - Time window for validity
   * @returns {Object|null} Extension info or null
   */
  checkLatestExtends(baseText, timeWindowMs) {
    return this.partialTracker.checkLatestExtends(baseText, timeWindowMs);
  }

  /**
   * Merge two texts with overlap
   * 
   * @param {string} previousText - Previous text
   * @param {string} currentText - Current text
   * @returns {string|null} Merged text or null
   */
  mergeWithOverlap(previousText, currentText) {
    return this.partialTracker.mergeWithOverlap(previousText, currentText);
  }

  /**
   * Create pending finalization
   * 
   * @param {string} text - Final text
   * @param {number|null} seqId - Sequence ID
   */
  createPendingFinalization(text, seqId) {
    this.finalizationEngine.createPendingFinalization(text, seqId);
  }

  /**
   * Check if there is pending finalization
   * 
   * @returns {boolean} True if finalization is pending
   */
  hasPendingFinalization() {
    return this.finalizationEngine.hasPendingFinalization();
  }

  /**
   * Get pending finalization state
   * 
   * @returns {Object|null} Pending finalization state or null
   */
  getPendingFinalization() {
    return this.finalizationEngine.getPendingFinalization();
  }

  /**
   * Clear pending finalization
   */
  clearPendingFinalization() {
    this.finalizationEngine.clearPendingFinalization();
  }

  /**
   * Set pending finalization timeout
   * 
   * @param {Function} callback - Callback function
   * @param {number} delay - Delay in milliseconds
   */
  setPendingFinalizationTimeout(callback, delay) {
    this.finalizationEngine.setPendingFinalizationTimeout(callback, delay);
  }

  /**
   * Clear pending finalization timeout
   */
  clearPendingFinalizationTimeout() {
    this.finalizationEngine.clearPendingFinalizationTimeout();
  }

  /**
   * Check if forced final buffer exists
   * 
   * @returns {boolean} True if forced final buffer exists
   */
  hasForcedFinalBuffer() {
    return this.forcedCommitEngine.hasForcedFinalBuffer();
  }

  /**
   * Get forced final buffer
   * 
   * @returns {Object|null} Forced final buffer or null
   */
  getForcedFinalBuffer() {
    return this.forcedCommitEngine.getForcedFinalBuffer();
  }

  /**
   * Create forced final buffer
   * 
   * @param {string} text - Forced final text
   * @param {number} timestamp - Timestamp
   */
  createForcedFinalBuffer(text, timestamp) {
    this.forcedCommitEngine.createForcedFinalBuffer(text, timestamp);
  }

  /**
   * Clear forced final buffer
   */
  clearForcedFinalBuffer() {
    this.forcedCommitEngine.clearForcedFinalBuffer();
  }

  /**
   * Set forced final buffer timeout
   * 
   * @param {Function} callback - Callback function
   * @param {number} delay - Delay in milliseconds
   */
  setForcedFinalBufferTimeout(callback, delay) {
    this.forcedCommitEngine.setForcedFinalBufferTimeout(callback, delay);
  }

  /**
   * Clear forced final buffer timeout
   */
  clearForcedFinalBufferTimeout() {
    this.forcedCommitEngine.clearForcedFinalBufferTimeout();
  }

  /**
   * Check if partial extends forced final
   * 
   * @param {string} partialText - Partial text to check
   * @returns {Object|null} Extension info or null
   */
  checkPartialExtendsForcedFinal(partialText) {
    return this.forcedCommitEngine.checkPartialExtendsForcedFinal(partialText);
  }

  /**
   * Detect Bible references in text
   * 
   * @param {string} text - Transcript text to analyze
   * @param {Object} options - Detection options
   * @returns {Promise<Array<Object>>} Array of detected references
   */
  async detectReferences(text, options = {}) {
    return this.bibleReferenceEngine.detectReferences(text, options);
  }

  /**
   * Get current engine state (for debugging)
   * 
   * @returns {Object} Current state of all engines
   */
  getState() {
    return {
      rtt: {
        average: this.rttTracker.getAverageRTT(),
        adaptiveLookahead: this.rttTracker.getAdaptiveLookahead()
      },
      timeline: {
        currentSeqId: this.timelineTracker.getCurrentSeqId(),
        latestSeqId: this.timelineTracker.getLatestSeqId()
      },
      partial: this.partialTracker.getSnapshot(),
      finalization: {
        hasPending: this.finalizationEngine.hasPendingFinalization(),
        pending: this.finalizationEngine.getPendingFinalization()
      },
      forcedCommit: this.forcedCommitEngine.getState(),
      bibleReference: {
        windowSize: this.bibleReferenceEngine.transcriptWindow.length
      }
    };
  }
}

export default CoreEngine;

