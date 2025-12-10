/**
 * RTT Tracker - Round-Trip Time measurement and adaptive lookahead calculation
 * 
 * Extracted from soloModeHandler.js (Phase 2)
 * 
 * This component tracks RTT measurements from client timestamps and calculates
 * adaptive lookahead values for finalization timing optimization.
 * 
 * CRITICAL: This logic must match the original implementation exactly to preserve
 * adaptive finalization timing behavior.
 */

import { RTT_CONSTANTS, FINALIZATION_CONSTANTS } from '../shared/types/config.js';

/**
 * RTT Tracker class
 * Tracks RTT measurements and calculates adaptive lookahead
 */
export class RTTTracker {
  constructor(options = {}) {
    // Store recent RTT measurements for adaptive finalization
    this.rttMeasurements = [];
    this.maxSamples = options.maxSamples || RTT_CONSTANTS.MAX_RTT_SAMPLES;
    this.defaultLookahead = options.defaultLookahead || FINALIZATION_CONSTANTS.DEFAULT_LOOKAHEAD_MS;
    this.minRTT = RTT_CONSTANTS.MIN_RTT_MS;
    this.maxRTT = RTT_CONSTANTS.MAX_RTT_MS;
    this.lookaheadMin = RTT_CONSTANTS.LOOKAHEAD_MIN_MS;
    this.lookaheadMax = RTT_CONSTANTS.LOOKAHEAD_MAX_MS;
  }

  /**
   * Calculate RTT from client timestamp
   * Filters out invalid measurements (negative or extremely large values)
   * 
   * @param {number} clientTimestamp - Client timestamp in milliseconds
   * @returns {number|null} RTT in milliseconds, or null if invalid
   */
  measureRTT(clientTimestamp) {
    if (!clientTimestamp) return null;
    const rtt = Date.now() - clientTimestamp;
    
    // Filter out negative RTT (clock sync issues) and extremely large values (bad measurements)
    if (rtt < this.minRTT || rtt > this.maxRTT) {
      console.warn(`[RTTTracker] ⚠️ Invalid RTT measurement: ${rtt}ms (skipping)`);
      return null;
    }
    
    this.rttMeasurements.push(rtt);
    if (this.rttMeasurements.length > this.maxSamples) {
      this.rttMeasurements.shift();
    }
    
    return rtt;
  }

  /**
   * Get adaptive lookahead based on RTT measurements
   * Lookahead = RTT/2, but capped between 200-700ms
   * 
   * @returns {number} Adaptive lookahead in milliseconds
   */
  getAdaptiveLookahead() {
    if (this.rttMeasurements.length === 0) return this.defaultLookahead;
    const avgRTT = this.rttMeasurements.reduce((a, b) => a + b, 0) / this.rttMeasurements.length;
    // Lookahead = RTT/2, but capped between 200-700ms
    return Math.max(this.lookaheadMin, Math.min(this.lookaheadMax, Math.floor(avgRTT / 2)));
  }

  /**
   * Get average RTT from recent measurements
   * 
   * @returns {number|null} Average RTT in milliseconds, or null if no measurements
   */
  getAverageRTT() {
    if (this.rttMeasurements.length === 0) return null;
    return Math.round(this.rttMeasurements.reduce((a, b) => a + b, 0) / this.rttMeasurements.length);
  }

  /**
   * Get current RTT measurements count
   * 
   * @returns {number} Number of RTT measurements stored
   */
  getMeasurementCount() {
    return this.rttMeasurements.length;
  }

  /**
   * Reset RTT measurements (useful for testing or session reset)
   */
  reset() {
    this.rttMeasurements = [];
  }

  /**
   * Get all RTT measurements (for debugging)
   * 
   * @returns {number[]} Array of RTT measurements
   */
  getMeasurements() {
    return [...this.rttMeasurements];
  }
}

export default RTTTracker;

