/**
 * Shared Configuration Types for Exbabel Core Engine
 * 
 * This file defines shared configuration types and constants
 * used across the core engine components.
 * 
 * PHASE 1: Foundation - No behavior changes, just type definitions
 */

/**
 * @typedef {Object} EngineConfig
 * @property {string} sourceLang - Source language code (e.g., 'en')
 * @property {string} targetLang - Target language code (e.g., 'es')
 * @property {'basic' | 'premium'} tier - Translation tier selection
 * @property {Object} [finalization] - Finalization timing configuration
 * @property {number} [finalization.maxWaitMs] - Maximum wait time for finalization (default: 12000)
 * @property {number} [finalization.confirmationWindow] - Confirmation window in ms (default: 300)
 * @property {number} [finalization.minSilenceMs] - Minimum silence before finalization (default: 600)
 * @property {number} [finalization.defaultLookaheadMs] - Default lookahead in ms (default: 200)
 * @property {Object} [rtt] - RTT tracking configuration
 * @property {number} [rtt.maxSamples] - Maximum RTT samples to keep (default: 10)
 */

/**
 * Finalization timing constants
 * These match the current solo mode implementation exactly
 */
export const FINALIZATION_CONSTANTS = {
  MAX_FINALIZATION_WAIT_MS: 12000,        // Maximum 12 seconds - safety net for long sentences
  FINALIZATION_CONFIRMATION_WINDOW: 300,   // 300ms confirmation window
  MIN_SILENCE_MS: 600,                     // Minimum 600ms silence before finalization
  DEFAULT_LOOKAHEAD_MS: 200,               // Default 200ms lookahead
  FORCED_FINAL_MAX_WAIT_MS: 2000,          // Time to wait for continuation before committing forced final
  TRANSLATION_RESTART_COOLDOWN_MS: 400      // Pause realtime translations briefly after stream restart
};

/**
 * RTT tracking constants
 */
export const RTT_CONSTANTS = {
  MAX_RTT_SAMPLES: 10,                      // Store recent RTT measurements
  MIN_RTT_MS: 0,                           // Minimum valid RTT (filter negative values)
  MAX_RTT_MS: 10000,                       // Maximum valid RTT (filter bad measurements)
  LOOKAHEAD_MIN_MS: 200,                   // Minimum lookahead
  LOOKAHEAD_MAX_MS: 700                    // Maximum lookahead
};

/**
 * Partial tracking constants
 */
export const PARTIAL_TRACKING_CONSTANTS = {
  RECENTLY_FINALIZED_WINDOW: 2500,         // 2.5 seconds - window for backpatching
  RECENTLY_FINALIZED_WINDOW_FORCED: 5000,  // 5 seconds for force-committed segments
  MAX_RECENT_FINALS: 4,                    // Keep last 4 finalized segments
  PARTIAL_TRACKING_GRACE_PERIOD: 3000,     // 3 seconds grace period after final
  FINAL_COMMIT_DELAY_NATURAL: 0,           // Natural finalization delay (VAD pause)
  FINAL_COMMIT_DELAY_FORCED: 4000          // Forced commit delay (covers 10 words)
};

/**
 * Audio buffer constants
 */
export const AUDIO_BUFFER_CONSTANTS = {
  BUFFER_DURATION_MS: 2500,                 // 2.5 second rolling window
  FLUSH_DURATION_MS: 600,                  // Flush last 600ms on natural finals
  MAX_CHUNKS: 200                          // Safety limit for chunks
};

/**
 * Create default engine configuration
 * @param {Partial<EngineConfig>} overrides - Configuration overrides
 * @returns {EngineConfig} Complete engine configuration
 */
export function createDefaultConfig(overrides = {}) {
  return {
    sourceLang: 'en',
    targetLang: 'es',
    tier: 'basic',
    finalization: {
      maxWaitMs: FINALIZATION_CONSTANTS.MAX_FINALIZATION_WAIT_MS,
      confirmationWindow: FINALIZATION_CONSTANTS.FINALIZATION_CONFIRMATION_WINDOW,
      minSilenceMs: FINALIZATION_CONSTANTS.MIN_SILENCE_MS,
      defaultLookaheadMs: FINALIZATION_CONSTANTS.DEFAULT_LOOKAHEAD_MS
    },
    rtt: {
      maxSamples: RTT_CONSTANTS.MAX_RTT_SAMPLES
    },
    ...overrides
  };
}

export default {
  FINALIZATION_CONSTANTS,
  RTT_CONSTANTS,
  PARTIAL_TRACKING_CONSTANTS,
  AUDIO_BUFFER_CONSTANTS,
  createDefaultConfig
};

