/**
 * Timeline Offset Tracker - Sequence ID tracking and message sequencing
 * 
 * Extracted from soloModeHandler.js (Phase 3)
 * 
 * This component tracks sequence IDs for ordering events and creates
 * sequenced messages with proper metadata (seqId, serverTimestamp, isPartial).
 * 
 * CRITICAL: This logic must match the original implementation exactly to preserve
 * sequence ordering and message structure.
 */

/**
 * Timeline Offset Tracker class
 * Tracks sequence IDs and creates sequenced messages
 */
export class TimelineOffsetTracker {
  constructor() {
    // Sequence tracking
    this.sequenceCounter = 0;
    this.latestSeqId = -1;
  }

  /**
   * Get the next sequence ID and increment counter
   * 
   * @returns {number} Next sequence ID
   */
  getNextSeqId() {
    const seqId = this.sequenceCounter++;
    this.latestSeqId = Math.max(this.latestSeqId, seqId);
    return seqId;
  }

  /**
   * Update the latest sequence ID (used when receiving external seqIds)
   * 
   * @param {number} seqId - Sequence ID to compare
   */
  updateLatestSeqId(seqId) {
    this.latestSeqId = Math.max(this.latestSeqId, seqId);
  }

  /**
   * Get the current latest sequence ID
   * 
   * @returns {number} Latest sequence ID
   */
  getLatestSeqId() {
    return this.latestSeqId;
  }

  /**
   * Get the current sequence counter value (without incrementing)
   * 
   * @returns {number} Current sequence counter
   */
  getCurrentSeqId() {
    return this.sequenceCounter;
  }

  /**
   * Create a sequenced message with seqId, serverTimestamp, and isPartial
   * This prepares the message structure but does NOT send it
   * 
   * @param {Object} messageData - Base message data
   * @param {boolean} isPartial - Whether this is a partial message (default: true)
   * @returns {Object} Message object with seqId, serverTimestamp, isPartial added
   */
  createSequencedMessage(messageData, isPartial = true) {
    const seqId = this.getNextSeqId();
    
    const message = {
      ...messageData,
      seqId,
      serverTimestamp: Date.now(),
      isPartial,
      type: isPartial ? 'translation' : 'translation'
    };
    
    return { message, seqId };
  }

  /**
   * Reset sequence tracking (useful for testing or session reset)
   */
  reset() {
    this.sequenceCounter = 0;
    this.latestSeqId = -1;
  }

  /**
   * Get current state (for debugging)
   * 
   * @returns {Object} Current tracker state
   */
  getState() {
    return {
      sequenceCounter: this.sequenceCounter,
      latestSeqId: this.latestSeqId
    };
  }
}

export default TimelineOffsetTracker;

