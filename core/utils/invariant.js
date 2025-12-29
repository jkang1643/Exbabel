/**
 * Runtime Invariant Assertion Helper
 *
 * Provides guard rails for critical system invariants with structured logging.
 * Logs red, structured errors with segmentId/seqId/candidate source/state snapshots.
 * Optionally throws in dev mode. Increments counter for grep-able "INVARIANT FAILED".
 */

// Global invariant failure counter
let invariantFailureCount = 0;

// Global per-segment debug state for invariant checking
const segmentDebugState = new Map();

/**
 * Asserts a runtime invariant with structured logging and optional dev-mode throwing
 *
 * @param {string} name - Invariant name (e.g., "atomic_finalize_emit", "recovery_dominance")
 * @param {boolean} condition - The invariant condition to check
 * @param {Object} context - Context object with segmentId, seqId, state snapshot, etc.
 * @param {boolean} throwOnFail - Whether to throw in development mode (default: true)
 */
export function assertInvariant(name, condition, context = {}, throwOnFail = true) {
  if (condition) {
    return; // Invariant holds, nothing to do
  }

  // Increment global failure counter
  invariantFailureCount++;

  // Build structured error context
  const errorContext = {
    invariantName: name,
    timestamp: Date.now(),
    failureCount: invariantFailureCount,
    segmentId: context.segmentId || 'unknown',
    seqId: context.seqId || null,
    candidateSource: context.candidateSource || null,
    recoveryPending: context.recoveryPending || false,
    recoveryResolved: context.recoveryResolved || false,
    finalized: context.finalized || false,
    bestCandidate: context.bestCandidate || null,
    committedFinalCount: context.committedFinalCount || 0,
    sawFinalFromASR: context.sawFinalFromASR || false,
    sawRecoveryResolved: context.sawRecoveryResolved || false,
    lastEmitCommitId: context.lastEmitCommitId || null,
    finalizeCommitId: context.finalizeCommitId || null,
    text: context.text ? context.text.substring(0, 60) + (context.text.length > 60 ? '...' : '') : null,
    ...context // Include any additional context
  };

  // Log structured red error
  console.error('\x1b[31m%s\x1b[0m', '🚨 INVARIANT FAILED:', name);
  console.error('\x1b[31m%s\x1b[0m', '   Failure #' + invariantFailureCount);
  console.error('\x1b[31m%s\x1b[0m', '   Segment ID:', errorContext.segmentId);
  if (errorContext.seqId) {
    console.error('\x1b[31m%s\x1b[0m', '   Sequence ID:', errorContext.seqId);
  }
  if (errorContext.candidateSource) {
    console.error('\x1b[31m%s\x1b[0m', '   Candidate Source:', errorContext.candidateSource);
  }
  if (errorContext.text) {
    console.error('\x1b[31m%s\x1b[0m', '   Text:', `"${errorContext.text}"`);
  }
  console.error('\x1b[31m%s\x1b[0m', '   Recovery State:', {
    pending: errorContext.recoveryPending,
    resolved: errorContext.recoveryResolved
  });
  console.error('\x1b[31m%s\x1b[0m', '   Finalization State:', {
    finalized: errorContext.finalized,
    committedFinalCount: errorContext.committedFinalCount,
    sawFinalFromASR: errorContext.sawFinalFromASR,
    sawRecoveryResolved: errorContext.sawRecoveryResolved
  });
  console.error('\x1b[31m%s\x1b[0m', '   Commit IDs:', {
    lastEmitCommitId: errorContext.lastEmitCommitId,
    finalizeCommitId: errorContext.finalizeCommitId
  });
  console.error('\x1b[31m%s\x1b[0m', '   Additional Context:', JSON.stringify(context, null, 2));

  // Throw in development mode to catch failures immediately during development
  if (throwOnFail && (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev')) {
    const error = new Error(`Invariant "${name}" failed - see console for details`);
    error.invariantContext = errorContext;
    throw error;
  }
}

/**
 * Gets the current invariant failure count
 * @returns {number} Number of invariant failures since startup
 */
export function getInvariantFailureCount() {
  return invariantFailureCount;
}

/**
 * Resets the invariant failure counter (useful for testing)
 */
export function resetInvariantFailureCount() {
  invariantFailureCount = 0;
}

/**
 * Gets debug state for a specific segment
 * @param {string} segmentId - Segment identifier
 * @returns {Object|null} Debug state for the segment, or null if not found
 */
export function getSegmentDebugState(segmentId) {
  return segmentDebugState.get(segmentId) || null;
}

/**
 * Sets debug state for a specific segment
 * @param {string} segmentId - Segment identifier
 * @param {Object} state - Debug state to set
 */
export function setSegmentDebugState(segmentId, state) {
  segmentDebugState.set(segmentId, {
    ...state,
    lastUpdated: Date.now()
  });
}

/**
 * Updates debug state for a specific segment (merges with existing state)
 * @param {string} segmentId - Segment identifier
 * @param {Object} updates - Partial state updates
 */
export function updateSegmentDebugState(segmentId, updates) {
  const existing = segmentDebugState.get(segmentId) || {};
  segmentDebugState.set(segmentId, {
    ...existing,
    ...updates,
    lastUpdated: Date.now()
  });
}

/**
 * Clears debug state for a specific segment
 * @param {string} segmentId - Segment identifier
 */
export function clearSegmentDebugState(segmentId) {
  segmentDebugState.delete(segmentId);
}

/**
 * Gets all segment debug states (useful for debugging)
 * @returns {Map} Map of segmentId -> debug state
 */
export function getAllSegmentDebugStates() {
  return new Map(segmentDebugState);
}
