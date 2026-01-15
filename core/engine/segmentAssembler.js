/**
 * Segment Assembler Engine
 * 
 * Assembles ASR partials and finals into stable, complete segments BEFORE finalization.
 * 
 * CRITICAL INVARIANTS:
 * 1. Segment Identity Stability: Segments identified by normalized prefix (first 10-15 tokens)
 * 2. FINAL ≠ CLOSE: Google FINAL flags mark tokens as stable but don't close segments
 * 3. Monotonic Growth: Segment text only grows (appending tokens, minor rewrites in tail)
 * 4. Structural Finalization Only: Segments finalize on new segment start or hard boundaries
 * 
 * This runs BEFORE FinalityGate, which only prevents duplicate emissions.
 */

/**
 * @typedef {Object} OpenSegment
 * @property {string} segmentId - Unique identifier for this segment
 * @property {string} text - Current assembled text
 * @property {string} normalizedPrefix - Normalized prefix for identity matching (first 10-15 tokens)
 * @property {number} createdAt - Timestamp when segment was created
 * @property {number} lastUpdatedAt - Timestamp of last update
 * @property {boolean} hasStableTokens - Whether any FINAL tokens have been received
 * @property {string|null} lastFinalText - Last FINAL text received (for tracking)
 * @property {number} finalCount - Number of FINAL events received for this segment
 */

/**
 * @typedef {Object} AssembledSegment
 * @property {string} segmentId - Segment identifier
 * @property {string} text - Complete segment text
 * @property {boolean} isComplete - Whether segment is complete (ready for finalization)
 * @property {string} reason - Reason for completion ('new_segment', 'hard_boundary', 'explicit_boundary')
 */

export class SegmentAssembler {
  constructor() {
    // Map segmentId -> OpenSegment
    this.openSegments = new Map();
    
    // Track the most recent segment ID for boundary detection
    this.mostRecentSegmentId = null;
    
    // Configuration
    this.PREFIX_TOKEN_COUNT = 12; // Use first 12 tokens for prefix matching
    this.MIN_PREFIX_LENGTH = 20; // Minimum characters for prefix matching
    this.MAX_SEGMENT_AGE_MS = 30000; // Max age for open segments (30 seconds)
    
    // Cleanup interval for stale segments
    this.startCleanupInterval();
  }

  /**
   * Normalize text for prefix matching
   * @private
   */
  _normalizePrefix(text) {
    if (!text || text.length === 0) return '';
    
    // Normalize: lowercase, collapse whitespace, remove punctuation
    const normalized = text
      .toLowerCase()
      .replace(/[.,!?;:…]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Extract first N tokens
    const tokens = normalized.split(/\s+/).filter(t => t.length > 0);
    const prefixTokens = tokens.slice(0, this.PREFIX_TOKEN_COUNT);
    
    return prefixTokens.join(' ');
  }

  /**
   * Check if two texts share a normalized prefix (same segment identity)
   * @private
   */
  _sharesPrefix(text1, text2) {
    const prefix1 = this._normalizePrefix(text1);
    const prefix2 = this._normalizePrefix(text2);
    
    if (prefix1.length < this.MIN_PREFIX_LENGTH || prefix2.length < this.MIN_PREFIX_LENGTH) {
      return false; // Too short to match reliably
    }
    
    // Check if one prefix starts with the other (or vice versa)
    const minLen = Math.min(prefix1.length, prefix2.length);
    const overlap = Math.min(minLen, Math.max(prefix1.length, prefix2.length) * 0.7); // 70% overlap threshold
    
    return prefix1.substring(0, overlap) === prefix2.substring(0, overlap);
  }

  /**
   * Find existing open segment that matches this text (by prefix)
   * @private
   */
  _findMatchingSegment(text) {
    const textPrefix = this._normalizePrefix(text);
    
    if (textPrefix.length < this.MIN_PREFIX_LENGTH) {
      return null; // Too short to match
    }
    
    for (const [segmentId, segment] of this.openSegments.entries()) {
      if (this._sharesPrefix(text, segment.text)) {
        return segment;
      }
    }
    
    return null;
  }

  /**
   * Merge new text into existing segment text
   * Handles appending and minor rewrites in unstable tail
   * @private
   */
  _mergeText(existingText, newText) {
    const existingTrimmed = existingText.trim();
    const newTrimmed = newText.trim();
    
    // Exact match or new text is shorter - use existing
    if (newTrimmed === existingTrimmed || newTrimmed.length <= existingTrimmed.length) {
      return existingTrimmed;
    }
    
    // Check if new text extends existing (common case)
    const existingLower = existingTrimmed.toLowerCase();
    const newLower = newTrimmed.toLowerCase();
    
    if (newLower.startsWith(existingLower)) {
      // Simple extension - new text is longer and starts with existing
      return newTrimmed;
    }
    
    // Check for overlap (handles cases where ASR rewrites tail)
    const overlap = this._findOverlap(existingTrimmed, newTrimmed);
    if (overlap > 0) {
      // Merge: existing + new part after overlap
      const newPart = newTrimmed.substring(overlap).trim();
      if (newPart) {
        return existingTrimmed + ' ' + newPart;
      }
      return existingTrimmed; // No new part
    }
    
    // No clear relationship - prefer longer text (ASR may have rewritten)
    return newTrimmed.length > existingTrimmed.length ? newTrimmed : existingTrimmed;
  }

  /**
   * Find overlap between two texts (for merging)
   * @private
   */
  _findOverlap(text1, text2) {
    const t1 = text1.toLowerCase();
    const t2 = text2.toLowerCase();
    
    // Try progressively smaller suffixes to find overlap
    const maxCheck = Math.min(t1.length, t2.length, 100);
    for (let i = Math.min(maxCheck, 50); i >= 10; i--) {
      const suffix = t1.substring(t1.length - i).trim();
      if (t2.startsWith(suffix)) {
        return t1.length - i; // Return position where overlap starts
      }
    }
    
    return 0; // No overlap found
  }

  /**
   * Create a new open segment
   * @private
   */
  _createSegment(text, isFinal = false) {
    const segmentId = `seg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const normalizedPrefix = this._normalizePrefix(text);
    
    const segment = {
      segmentId,
      text: text.trim(),
      normalizedPrefix,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      hasStableTokens: isFinal,
      lastFinalText: isFinal ? text.trim() : null,
      finalCount: isFinal ? 1 : 0
    };
    
    this.openSegments.set(segmentId, segment);
    this.mostRecentSegmentId = segmentId;
    
    console.log(`[SegmentAssembler] 🆕 Created new segment ${segmentId} (prefix: "${normalizedPrefix.substring(0, 50)}...")`);
    
    return segment;
  }

  /**
   * Process an ASR result (partial or final)
   * 
   * @param {string} text - Text from ASR
   * @param {boolean} isFinal - Whether this is a FINAL result from Google
   * @param {Object} [meta] - Additional metadata
   * @returns {AssembledSegment[]} Array of complete segments ready for finalization (may be empty)
   */
  processAsrResult(text, isFinal = false, meta = {}) {
    if (!text || text.trim().length === 0) {
      return []; // Ignore empty text
    }
    
    const trimmedText = text.trim();
    const now = Date.now();
    
    // Find matching segment or create new one
    let segment = this._findMatchingSegment(trimmedText);
    
    if (!segment) {
      // No matching segment - check if this is a new segment or continuation
      // If we have a recent segment and this doesn't share prefix, it's a new segment
      if (this.mostRecentSegmentId) {
        const recentSegment = this.openSegments.get(this.mostRecentSegmentId);
        if (recentSegment && !this._sharesPrefix(trimmedText, recentSegment.text)) {
          // New segment detected - finalize previous segment
          const completed = this._finalizeSegment(this.mostRecentSegmentId, 'new_segment');
          if (completed) {
            // Create new segment for this text
            segment = this._createSegment(trimmedText, isFinal);
            return [completed];
          }
        }
      }
      
      // Create new segment
      segment = this._createSegment(trimmedText, isFinal);
      return []; // New segment, not complete yet
    }
    
    // Merge text into existing segment
    const mergedText = this._mergeText(segment.text, trimmedText);
    const textGrew = mergedText.length > segment.text.length;
    
    // INVARIANT CHECK: Monotonic growth
    if (mergedText.length < segment.text.length) {
      console.error(`[SegmentAssembler] 🔴 INVARIANT VIOLATION: Segment ${segment.segmentId} text shrank!`);
      console.error(`[SegmentAssembler]   Old: "${segment.text.substring(0, 80)}..."`);
      console.error(`[SegmentAssembler]   New: "${mergedText.substring(0, 80)}..."`);
      // Use longer text to maintain monotonic growth
      return [];
    }
    
    // Update segment
    segment.text = mergedText;
    segment.lastUpdatedAt = now;
    
    if (isFinal) {
      segment.hasStableTokens = true;
      segment.lastFinalText = trimmedText;
      segment.finalCount++;
      
      console.log(`[SegmentAssembler] 📝 FINAL merged into segment ${segment.segmentId} (finalCount: ${segment.finalCount})`);
      console.log(`[SegmentAssembler]   Text: "${mergedText.substring(0, 80)}..."`);
    } else {
      console.log(`[SegmentAssembler] 📝 PARTIAL merged into segment ${segment.segmentId}${textGrew ? ' (grew)' : ''}`);
      console.log(`[SegmentAssembler]   Text: "${mergedText.substring(0, 80)}..."`);
    }
    
    // CRITICAL: FINAL ≠ CLOSE
    // Google FINAL flags mark tokens as stable but don't close the segment
    // Segment only closes on structural boundaries (new segment start, hard silence, etc.)
    
    return []; // Segment still open, not complete yet
  }

  /**
   * Finalize a segment (mark as complete)
   * Called when a structural boundary is detected
   * @private
   */
  _finalizeSegment(segmentId, reason) {
    const segment = this.openSegments.get(segmentId);
    if (!segment) {
      return null;
    }
    
    // Only finalize if segment has content
    if (!segment.text || segment.text.trim().length === 0) {
      this.openSegments.delete(segmentId);
      return null;
    }
    
    const assembled = {
      segmentId: segment.segmentId,
      text: segment.text.trim(),
      isComplete: true,
      reason
    };
    
    // Remove from open segments
    this.openSegments.delete(segmentId);
    
    console.log(`[SegmentAssembler] ✅ Finalized segment ${segmentId} (reason: ${reason})`);
    console.log(`[SegmentAssembler]   Text: "${assembled.text.substring(0, 80)}..."`);
    console.log(`[SegmentAssembler]   FinalCount: ${segment.finalCount}, HasStableTokens: ${segment.hasStableTokens}`);
    
    return assembled;
  }

  /**
   * Signal a hard boundary (silence gap, speaker change, etc.)
   * Finalizes the current segment
   * 
   * @param {string} [segmentId] - Specific segment to finalize, or null for most recent
   * @returns {AssembledSegment|null} Finalized segment, or null if none
   */
  signalHardBoundary(segmentId = null) {
    const targetId = segmentId || this.mostRecentSegmentId;
    if (!targetId) {
      return null;
    }
    
    return this._finalizeSegment(targetId, 'hard_boundary');
  }

  /**
   * Signal an explicit boundary (speaker change, utterance boundary, etc.)
   * Finalizes the current segment
   * 
   * @param {string} [segmentId] - Specific segment to finalize, or null for most recent
   * @returns {AssembledSegment|null} Finalized segment, or null if none
   */
  signalExplicitBoundary(segmentId = null) {
    const targetId = segmentId || this.mostRecentSegmentId;
    if (!targetId) {
      return null;
    }
    
    return this._finalizeSegment(targetId, 'explicit_boundary');
  }

  /**
   * Get current open segment
   * 
   * @param {string} [segmentId] - Specific segment ID, or null for most recent
   * @returns {OpenSegment|null} Open segment, or null if not found
   */
  getOpenSegment(segmentId = null) {
    const targetId = segmentId || this.mostRecentSegmentId;
    if (!targetId) {
      return null;
    }
    
    return this.openSegments.get(targetId) || null;
  }

  /**
   * Get all open segments
   * 
   * @returns {OpenSegment[]} Array of open segments
   */
  getAllOpenSegments() {
    return Array.from(this.openSegments.values());
  }

  /**
   * Cleanup stale segments (older than MAX_SEGMENT_AGE_MS)
   * @private
   */
  _cleanupStaleSegments() {
    const now = Date.now();
    const staleIds = [];
    
    for (const [segmentId, segment] of this.openSegments.entries()) {
      const age = now - segment.lastUpdatedAt;
      if (age > this.MAX_SEGMENT_AGE_MS) {
        staleIds.push(segmentId);
      }
    }
    
    for (const segmentId of staleIds) {
      console.log(`[SegmentAssembler] 🧹 Cleaning up stale segment ${segmentId}`);
      this.openSegments.delete(segmentId);
    }
    
    if (staleIds.length > 0) {
      console.log(`[SegmentAssembler] 🧹 Cleaned up ${staleIds.length} stale segment(s)`);
    }
  }

  /**
   * Start periodic cleanup interval
   * @private
   */
  startCleanupInterval() {
    setInterval(() => {
      try {
        this._cleanupStaleSegments();
      } catch (error) {
        console.error(`[SegmentAssembler] ❌ Error in cleanup:`, error);
      }
    }, 10000); // Check every 10 seconds
  }

  /**
   * Reset all state (for testing or error recovery)
   */
  reset() {
    this.openSegments.clear();
    this.mostRecentSegmentId = null;
  }
}

export default SegmentAssembler;

