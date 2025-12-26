/**
 * Finality Gate Engine
 * 
 * Enforces finalization dominance rules to prevent async race conditions.
 * 
 * INVARIANT: No final may commit while a recovery promise is unresolved,
 * and recovery candidates always dominate grammar-only candidates.
 * 
 * Priority order (highest to lowest):
 * 1. Recovery (🔴 Highest) - Recovery stream found additional words
 * 2. AsrFinal (🟡 High) - ASR FINAL from Google Speech API
 * 3. Forced Final (🟠) - Timeout-based forced finalization
 * 4. Grammar (🟢 Lowest) - Grammar worker correction only
 */

/**
 * Candidate source priority (higher number = higher priority)
 */
export const CandidateSource = {
  Grammar: 0,
  Forced: 1,
  Recovery: 2,
  AsrFinal: 3
};

/**
 * @typedef {Object} FinalCandidate
 * @property {string} text - The text to commit
 * @property {CandidateSource} source - Source of the candidate
 * @property {string} segmentId - Unique identifier for the segment
 * @property {number} timestamp - When the candidate was created
 * @property {Object} [options] - Additional options (previousFinalTextForDeduplication, etc.)
 */

/**
 * @typedef {Object} SegmentState
 * @property {boolean} recoveryPending - Whether recovery is in progress for this segment
 * @property {boolean} recoveryResolved - Whether recovery has completed for this segment
 * @property {FinalCandidate|null} bestCandidate - Best candidate seen so far (may not be finalized)
 * @property {boolean} finalized - Whether this segment has been finalized
 * @property {string} [segmentId] - Segment identifier
 */

export class FinalityGate {
  constructor() {
    // Map segmentId -> SegmentState
    this.segmentStates = new Map();
    
    // Default segment ID for cases where segment tracking isn't available
    this.defaultSegmentId = 'default';
  }

  /**
   * Register that recovery is in progress for a segment
   * This blocks lower-priority candidates from finalizing
   * 
   * @param {string} [segmentId] - Segment identifier (uses default if not provided)
   */
  markRecoveryPending(segmentId = null) {
    const id = segmentId || this.defaultSegmentId;
    const state = this.getOrCreateSegmentState(id);
    state.recoveryPending = true;
    state.recoveryStartTime = Date.now(); // Track when recovery started
  }

  /**
   * Mark recovery as complete for a segment
   * This allows finalization if a recovery candidate exists.
   * 
   * CRITICAL: After recovery completes, if the segment hasn't been finalized
   * and there's a bestCandidate, we MUST finalize it to ensure liveness.
   * This guarantees that every segment reaches a final state exactly once.
   * 
   * @param {string} [segmentId] - Segment identifier (uses default if not provided)
   * @returns {FinalCandidate|null} The best candidate that should be finalized, or null if already finalized
   */
  markRecoveryComplete(segmentId = null) {
    const id = segmentId || this.defaultSegmentId;
    const state = this.getOrCreateSegmentState(id);
    state.recoveryPending = false;
    state.recoveryResolved = true;

    // CRITICAL FIX: Ensure eventual finalization
    // If recovery completed but segment hasn't been finalized yet, we MUST finalize the best candidate
    // This prevents dropped segments when recovery completes but nothing triggered finalization
    if (!state.finalized && state.bestCandidate) {
      // Return the candidate so the caller can finalize it
      // The caller should call finalizeSegment() to actually finalize
      return state.bestCandidate;
    }

    return null;
  }

  /**
   * Check if a candidate can commit to final
   * Enforces dominance rules:
   * - Recovery and AsrFinal always win (highest priority)
   * - Block Forced candidates if recovery is pending
   * - Block Grammar candidates if recovery is pending (they're lower priority)
   * - Already finalized segments cannot accept new candidates
   * 
   * @param {FinalCandidate} candidate - Candidate to check
   * @returns {boolean} Whether the candidate can commit
   */
  canCommit(candidate) {
    const segmentId = candidate.segmentId || this.defaultSegmentId;
    const state = this.getOrCreateSegmentState(segmentId);

    // Already finalized - no new candidates
    if (state.finalized) {
      console.log(`[FinalityGate] 🔴 Blocking candidate: segment already finalized`, {
        segmentId,
        candidateSource: this._getSourceName(candidate.source),
        candidateLength: candidate.text.length,
        finalized: state.finalized
      });
      return false;
    }

    // Recovery and AsrFinal candidates always win (highest priority)
    if (candidate.source === CandidateSource.Recovery || candidate.source === CandidateSource.AsrFinal) {
      return true;
    }

    // Block lower-priority candidates if recovery is pending
    if (state.recoveryPending) {
      console.log(`[FinalityGate] 🔴 Blocking candidate: recovery pending`, {
        segmentId,
        candidateSource: this._getSourceName(candidate.source),
        candidateLength: candidate.text.length,
        recoveryPending: state.recoveryPending,
        recoveryResolved: state.recoveryResolved,
        bestCandidateSource: state.bestCandidate ? this._getSourceName(state.bestCandidate.source) : null,
        bestCandidateLength: state.bestCandidate ? state.bestCandidate.text.length : null
      });
      return false;
    }

    return true;
  }

  /**
   * Get human-readable source name for logging
   * @private
   */
  _getSourceName(source) {
    if (source === CandidateSource.Recovery) return 'Recovery';
    if (source === CandidateSource.AsrFinal) return 'AsrFinal';
    if (source === CandidateSource.Forced) return 'Forced';
    if (source === CandidateSource.Grammar) return 'Grammar';
    return 'Unknown';
  }

  /**
   * Check if candidate A is better than candidate B
   * Better = higher priority source OR (same priority AND longer text)
   * 
   * @param {FinalCandidate} candidateA - Candidate to compare
   * @param {FinalCandidate|null} candidateB - Candidate to compare against (null if none exists)
   * @returns {boolean} Whether candidateA is better than candidateB
   */
  isBetter(candidateA, candidateB) {
    if (!candidateB) {
      return true; // Any candidate is better than none
    }

    // Higher priority source always wins
    if (candidateA.source > candidateB.source) {
      return true;
    }

    // Same priority - prefer longer text
    if (candidateA.source === candidateB.source) {
      return candidateA.text.length > candidateB.text.length;
    }

    return false;
  }

  /**
   * Submit a candidate for finalization
   * Updates best candidate if this one is better, but doesn't finalize yet
   * Finalization happens only when canCommit returns true AND finalizeSegment is called
   * 
   * @param {FinalCandidate} candidate - Candidate to submit
   * @returns {Object} Result object with canCommit flag and whether candidate was accepted
   */
  submitCandidate(candidate) {
    const segmentId = candidate.segmentId || this.defaultSegmentId;
    const state = this.getOrCreateSegmentState(segmentId);

    const canCommitNow = this.canCommit(candidate);
    const isBetterThanCurrent = this.isBetter(candidate, state.bestCandidate);

    // Update best candidate if this one is better (allows upgrades)
    if (isBetterThanCurrent) {
      state.bestCandidate = {
        ...candidate,
        timestamp: candidate.timestamp || Date.now()
      };
    }

    return {
      canCommit: canCommitNow,
      accepted: isBetterThanCurrent,
      willUpgrade: isBetterThanCurrent && state.bestCandidate !== null,
      currentBest: state.bestCandidate
    };
  }

  /**
   * Finalize a segment with the best candidate
   * This should only be called when canCommit returns true
   * After finalization, the segment cannot accept new candidates
   * 
   * @param {string} [segmentId] - Segment identifier (uses default if not provided)
   * @returns {FinalCandidate|null} The finalized candidate, or null if none exists
   */
  finalizeSegment(segmentId = null) {
    const id = segmentId || this.defaultSegmentId;
    const state = this.getOrCreateSegmentState(id);

    if (!state.bestCandidate) {
      return null;
    }

    // Mark as finalized - no more candidates accepted
    state.finalized = true;
    state.recoveryPending = false; // Clear recovery flag
    state.recoveryResolved = true; // Mark as resolved (recovery may have completed or never started)

    const finalizedCandidate = state.bestCandidate;

    // Clear best candidate after finalization
    state.bestCandidate = null;

    return finalizedCandidate;
  }

  /**
   * Get the current best candidate for a segment (without finalizing)
   * Useful for checking what would be finalized
   * 
   * @param {string} [segmentId] - Segment identifier (uses default if not provided)
   * @returns {FinalCandidate|null} Current best candidate or null
   */
  getBestCandidate(segmentId = null) {
    const id = segmentId || this.defaultSegmentId;
    const state = this.getOrCreateSegmentState(id);
    return state.bestCandidate || null;
  }

  /**
   * Check if a segment is finalized
   * 
   * @param {string} [segmentId] - Segment identifier (uses default if not provided)
   * @returns {boolean} Whether the segment is finalized
   */
  isFinalized(segmentId = null) {
    const id = segmentId || this.defaultSegmentId;
    const state = this.getOrCreateSegmentState(id);
    return state.finalized || false;
  }

  /**
   * Check if recovery is pending for a segment
   * 
   * @param {string} [segmentId] - Segment identifier (uses default if not provided)
   * @returns {boolean} Whether recovery is pending
   */
  isRecoveryPending(segmentId = null) {
    const id = segmentId || this.defaultSegmentId;
    const state = this.segmentStates.get(id);
    return state?.recoveryPending || false;
  }

  /**
   * Reset segment state (useful for new segments or error recovery)
   * 
   * @param {string} [segmentId] - Segment identifier (uses default if not provided)
   */
  resetSegment(segmentId = null) {
    const id = segmentId || this.defaultSegmentId;
    this.segmentStates.delete(id);
  }

  /**
   * Reset all segment states
   */
  reset() {
    this.segmentStates.clear();
  }

  /**
   * Check if recovery has been resolved for a segment
   * 
   * @param {string} [segmentId] - Segment identifier (uses default if not provided)
   * @returns {boolean} Whether recovery has been resolved
   */
  isRecoveryResolved(segmentId = null) {
    const id = segmentId || this.defaultSegmentId;
    const state = this.getOrCreateSegmentState(id);
    return state.recoveryResolved || false;
  }

  /**
   * Close a segment (finalize if needed, clear recovery state)
   * Call this when transitioning to a new segment to prevent recovery state from leaking
   * 
   * @param {string} segmentId - Segment to close
   */
  closeSegment(segmentId) {
    if (!segmentId) {
      return;
    }

    const state = this.segmentStates.get(segmentId);
    if (!state) {
      return; // Segment doesn't exist, nothing to close
    }

    // Don't finalize if recovery is pending for THIS segment
    if (state.recoveryPending) {
      console.log(`[FinalityGate] 🔒 Deferring closeSegment - recovery pending for ${segmentId}`);
      return;
    }

    // If segment has best candidate and isn't finalized, finalize it
    if (!state.finalized && state.bestCandidate) {
      this.finalizeSegment(segmentId);
    }

    // Clear recovery state for this segment to prevent leakage to new segments
    state.recoveryPending = false;
    state.recoveryResolved = true;
  }

  /**
   * Open a new segment (ensures clean state)
   * Optional - mainly for explicit state initialization and clarity
   * 
   * @param {string} segmentId - Segment to open
   */
  openSegment(segmentId) {
    if (!segmentId) {
      return;
    }
    // getOrCreateSegmentState already handles initialization, but explicit call is clearer
    this.getOrCreateSegmentState(segmentId);
  }

  /**
   * Get recovery context (locked segment ID and lock start time)
   * Returns information about any segment that currently has recovery pending
   * 
   * @returns {Object|null} Recovery context with lockedSegmentId and lockStartTime, or null if no recovery pending
   */
  getRecoveryContext() {
    for (const [segmentId, state] of this.segmentStates.entries()) {
      if (state.recoveryPending) {
        return {
          lockedSegmentId: segmentId,
          lockStartTime: state.recoveryStartTime || Date.now()
        };
      }
    }
    return null;
  }

  /**
   * Get or create segment state
   * 
   * @private
   * @param {string} segmentId - Segment identifier
   * @returns {SegmentState} Segment state object
   */
  getOrCreateSegmentState(segmentId) {
    if (!this.segmentStates.has(segmentId)) {
      this.segmentStates.set(segmentId, {
        recoveryPending: false,
        recoveryResolved: false,
        bestCandidate: null,
        finalized: false,
        segmentId
      });
    }
    return this.segmentStates.get(segmentId);
  }
}

export default FinalityGate;

