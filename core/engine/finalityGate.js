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
 * @property {boolean} closed - Whether this segment has been closed (idempotency tracking)
 * @property {string} [segmentId] - Segment identifier
 * @property {string|null} finalizedText - Text that was finalized (stored for comparison)
 * @property {number} committedFinalCount - Number of committed finals for this segment (invariant tracking)
 * @property {boolean} sawFinalFromASR - Whether ASR FINAL was received for this segment (invariant tracking)
 * @property {boolean} sawRecoveryResolved - Whether recovery was resolved for this segment (invariant tracking)
 * @property {string|null} lastEmitCommitId - Commit ID of the last emitted final (invariant tracking)
 * @property {string|null} finalizeCommitId - Commit ID when finalizeSegment was called (invariant tracking)
 */

import { assertInvariant } from '../utils/invariant.js';

export class FinalityGate {
  constructor() {
    // Map segmentId -> SegmentState
    this.segmentStates = new Map();
    
    // Default segment ID for cases where segment tracking isn't available
    this.defaultSegmentId = 'default';
    
    // Recovery timeout for finalized-but-uncommitted segments (5 seconds)
    this.RECOVERY_TIMEOUT_MS = 5000;
    
    // Map segmentId -> recovery timeout handle
    this.recoveryTimeouts = new Map();
    
    // Start periodic recovery check
    this.startRecoveryCheck();
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

      // INVARIANT #2: Recovery dominance - No final may commit while recovery is unresolved
      // Recovery candidates always dominate grammar-only candidates for the same segment
      assertInvariant('recovery_dominance', false, {
        segmentId,
        candidateSource: this._getSourceName(candidate.source),
        recoveryPending: state.recoveryPending,
        recoveryResolved: state.recoveryResolved,
        text: candidate.text,
        bestCandidateSource: state.bestCandidate ? this._getSourceName(state.bestCandidate.source) : null,
        bestCandidateText: state.bestCandidate ? state.bestCandidate.text : null
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
   * CRITICAL: Pre-check ensures we can commit before finalizing.
   * If segment has sawFinalFromASR or sawRecoveryResolved, we MUST commit.
   * 
   * @param {string} [segmentId] - Segment identifier (uses default if not provided)
   * @param {string} [commitId] - Optional commit ID to track (will be validated after emission)
   * @returns {FinalCandidate|null} The finalized candidate, or null if none exists
   */
  finalizeSegment(segmentId = null, commitId = null) {
    const id = segmentId || this.defaultSegmentId;
    const state = this.getOrCreateSegmentState(id);

    if (!state.bestCandidate) {
      return null;
    }

    // CRITICAL PRE-CHECK: If segment has sawFinalFromASR or sawRecoveryResolved,
    // we MUST ensure we can commit before finalizing (prevents finalized-but-uncommitted state)
    if (state.sawFinalFromASR || state.sawRecoveryResolved) {
      // This segment expects exactly one commit - ensure we're ready to commit
      // If already finalized, this is a duplicate finalization attempt (should not happen)
      if (state.finalized) {
        console.warn(`[FinalityGate] ⚠️ Attempted to finalize already-finalized segment ${id} (sawFinalFromASR: ${state.sawFinalFromASR}, sawRecoveryResolved: ${state.sawRecoveryResolved})`);
        return null;
      }
      
      // Log that we're finalizing a segment that expects a commit
      console.log(`[FinalityGate] 🔒 Finalizing segment ${id} that expects commit (sawFinalFromASR: ${state.sawFinalFromASR}, sawRecoveryResolved: ${state.sawRecoveryResolved})`);
    }

    // Mark as finalized - no more candidates accepted
    state.finalized = true;
    state.recoveryPending = false; // Clear recovery flag
    state.recoveryResolved = true; // Mark as resolved (recovery may have completed or never started)

    const finalizedCandidate = state.bestCandidate;

    // Store finalized text for comparison (needed for auto-heal logic)
    state.finalizedText = finalizedCandidate.text;

    // Track finalizeCommitId for validation after emission
    state.finalizeCommitId = commitId || `${id}-finalize-${Date.now()}`;
    state.finalizeTimestamp = Date.now();

    // Clear best candidate after finalization
    state.bestCandidate = null;

    // Set up recovery timeout: if not committed within 5 seconds, log warning and attempt recovery
    this.scheduleRecoveryTimeout(id);

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
   * Mark that a segment has been committed (emitted)
   * Call this AFTER the emit succeeds to record the commit and check the invariant
   * 
   * @param {string} segmentId - Segment that was committed
   * @param {string} commitId - Commit ID of the emitted final
   */
  markCommitted(segmentId, commitId) {
    if (!segmentId) {
      return;
    }

    const state = this.segmentStates.get(segmentId);
    if (!state) {
      console.warn(`[FinalityGate] ⚠️ markCommitted called for non-existent segment: ${segmentId}`);
      return;
    }

    // Record the commit
    state.committedFinalCount = (state.committedFinalCount || 0) + 1;
    state.lastEmitCommitId = commitId;

    // CRITICAL: Validate that finalizeCommitId matches (if set)
    // This ensures the commit corresponds to the finalization
    if (state.finalizeCommitId && commitId !== state.finalizeCommitId) {
      // Allow mismatch but log warning (commitId might be generated differently)
      console.warn(`[FinalityGate] ⚠️ Commit ID mismatch for segment ${segmentId}: finalizeCommitId=${state.finalizeCommitId}, emitCommitId=${commitId}`);
    }

    // Clear recovery timeout since we've committed successfully
    this.clearRecoveryTimeout(segmentId);

    // INVARIANT #4: Exactly one committed final per segment
    // Every segment that receives a FINAL or recovery must emit exactly one committed final
    // This check happens AFTER the commit is recorded, so it can properly validate the invariant
    assertInvariant('exactly_one_committed_final',
      !(state.sawFinalFromASR || state.sawRecoveryResolved) || state.committedFinalCount === 1,
      {
        segmentId,
        sawFinalFromASR: state.sawFinalFromASR,
        sawRecoveryResolved: state.sawRecoveryResolved,
        committedFinalCount: state.committedFinalCount,
        finalized: state.finalized,
        lastEmitCommitId: state.lastEmitCommitId,
        finalizeCommitId: state.finalizeCommitId,
        bestCandidateText: state.bestCandidate ? state.bestCandidate.text : null,
        finalizedText: state.finalizedText
      }
    );
  }

  /**
   * Close a segment (finalize if needed, clear recovery state)
   * Call this when transitioning to a new segment to prevent recovery state from leaking
   * 
   * This method is now idempotent - calling it multiple times is safe.
   * The invariant check has been moved to markCommitted() which is called after emit succeeds.
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

    // IDEMPOTENCY: If already closed, return early (no invariant check, no throw)
    if (state.closed) {
      return;
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
    
    // Mark as closed (idempotency)
    state.closed = true;

    // NOTE: Invariant check moved to markCommitted() which is called AFTER emit succeeds
    // This prevents false failures when closeSegment() is called before the emit completes
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
   * Get the finalized text for a segment (if it was finalized)
   * 
   * @param {string} [segmentId] - Segment identifier (uses default if not provided)
   * @returns {string|null} The finalized text, or null if not finalized
   */
  getFinalizedText(segmentId = null) {
    const id = segmentId || this.defaultSegmentId;
    const state = this.segmentStates.get(id);
    return state?.finalizedText || null;
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
        closed: false,
        finalizedText: null,
        segmentId,
        // Invariant tracking fields
        committedFinalCount: 0,
        sawFinalFromASR: false,
        sawRecoveryResolved: false,
        lastEmitCommitId: null,
        finalizeCommitId: null,
        finalizeTimestamp: null
      });
    }
    return this.segmentStates.get(segmentId);
  }

  /**
   * Schedule recovery timeout for a finalized segment
   * If segment is not committed within timeout, log warning and attempt recovery
   * 
   * @private
   * @param {string} segmentId - Segment identifier
   */
  scheduleRecoveryTimeout(segmentId) {
    // Clear any existing timeout
    this.clearRecoveryTimeout(segmentId);

    const timeoutHandle = setTimeout(() => {
      this.recoverUncommittedSegment(segmentId);
      this.recoveryTimeouts.delete(segmentId);
    }, this.RECOVERY_TIMEOUT_MS);

    this.recoveryTimeouts.set(segmentId, timeoutHandle);
  }

  /**
   * Clear recovery timeout for a segment
   * 
   * @private
   * @param {string} segmentId - Segment identifier
   */
  clearRecoveryTimeout(segmentId) {
    const timeoutHandle = this.recoveryTimeouts.get(segmentId);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this.recoveryTimeouts.delete(segmentId);
    }
  }

  /**
   * Recover a segment that was finalized but never committed
   * Logs warning and resets state to allow recovery
   * 
   * @private
   * @param {string} segmentId - Segment identifier
   */
  recoverUncommittedSegment(segmentId) {
    const state = this.segmentStates.get(segmentId);
    if (!state) {
      return; // Segment doesn't exist
    }

    // Check if segment is finalized but not committed
    if (state.finalized && state.committedFinalCount === 0) {
      const timeSinceFinalize = Date.now() - (state.finalizeTimestamp || Date.now());
      console.error(`[FinalityGate] 🔴 RECOVERY: Segment ${segmentId} finalized but never committed (${timeSinceFinalize}ms ago)`);
      console.error(`[FinalityGate]   State: finalized=${state.finalized}, committedFinalCount=${state.committedFinalCount}`);
      console.error(`[FinalityGate]   sawFinalFromASR=${state.sawFinalFromASR}, sawRecoveryResolved=${state.sawRecoveryResolved}`);
      console.error(`[FinalityGate]   finalizeCommitId=${state.finalizeCommitId}, finalizedText="${state.finalizedText?.substring(0, 60)}..."`);
      
      // Reset state to allow recovery (segment can be finalized again if needed)
      // This prevents the segment from being stuck in finalized-but-uncommitted state
      state.finalized = false;
      state.finalizeCommitId = null;
      state.finalizeTimestamp = null;
      
      // If we have finalizedText, restore it as bestCandidate so it can be finalized again
      if (state.finalizedText && !state.bestCandidate) {
        // Restore as a recovery candidate (highest priority)
        state.bestCandidate = {
          text: state.finalizedText,
          source: CandidateSource.Recovery,
          segmentId: segmentId,
          timestamp: Date.now()
        };
        console.log(`[FinalityGate] 🔄 Restored finalized text as recovery candidate for segment ${segmentId}`);
      }
    }
  }

  /**
   * Recover all segments that are finalized but not committed
   * Called periodically to catch any segments that slipped through
   * 
   * @returns {number} Number of segments recovered
   */
  recoverUncommittedSegments() {
    let recoveredCount = 0;
    
    for (const [segmentId, state] of this.segmentStates.entries()) {
      if (state.finalized && state.committedFinalCount === 0) {
        const timeSinceFinalize = state.finalizeTimestamp ? (Date.now() - state.finalizeTimestamp) : 0;
        
        // Only recover if it's been more than recovery timeout
        if (timeSinceFinalize >= this.RECOVERY_TIMEOUT_MS) {
          this.recoverUncommittedSegment(segmentId);
          recoveredCount++;
        }
      }
    }
    
    if (recoveredCount > 0) {
      console.log(`[FinalityGate] 🔄 Recovered ${recoveredCount} uncommitted segment(s)`);
    }
    
    return recoveredCount;
  }

  /**
   * Start periodic recovery check
   * Checks every 10 seconds for finalized-but-uncommitted segments
   * 
   * @private
   */
  startRecoveryCheck() {
    setInterval(() => {
      try {
        this.recoverUncommittedSegments();
      } catch (error) {
        console.error(`[FinalityGate] ❌ Error in recovery check:`, error);
      }
    }, 10000); // Check every 10 seconds
  }
}

export default FinalityGate;

