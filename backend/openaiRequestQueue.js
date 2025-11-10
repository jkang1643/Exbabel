/**
 * Global OpenAI Request Queue
 * Coordinates all OpenAI API calls to prevent rate limit bursts
 * 
 * Features:
 * - Single queue for all OpenAI API requests (grammar, translation, etc.)
 * - Tracks approximate token usage to stay under TPM limits
 * - Processes requests in parallel (3-5 concurrent) for multi-session support
 * - Respects rate limits and retries automatically
 * 
 * MULTI-SESSION OPTIMIZATION:
 * - Parallel processing allows multiple sessions to share API capacity fairly
 * - Per-session tracking prevents single session from starving others
 * - Maintains backward compatibility with single-session performance
 */

import { fetchWithRateLimit } from './openaiRateLimiter.js';

class OpenAIRequestQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.activeRequests = 0; // Track concurrent active requests
    this.maxConcurrent = 4; // Process up to 4 requests in parallel (conservative for trial)
    this.lastRequestTime = 0;
    this.minRequestInterval = 50; // Minimum 50ms between requests (preserved for single-session stability)
    this.estimatedTokensUsed = 0;
    this.tokenResetTime = Date.now() + 60000; // Reset tokens every minute
    
    // Per-session tracking for fair-share allocation
    this.sessionRequestCounts = new Map(); // sessionId -> { count, lastRequestTime }
  }

  /**
   * Estimate tokens for a request (rough approximation)
   * @param {string} text - Input text
   * @param {number} maxTokens - Max tokens requested
   * @returns {number} - Estimated total tokens (input + output)
   */
  estimateTokens(text, maxTokens = 800) {
    // Rough estimate: ~4 characters per token
    const inputTokens = Math.ceil((text?.length || 0) / 4);
    // Assume output is similar length to input for partials
    const outputTokens = Math.min(maxTokens, Math.ceil(inputTokens * 1.2));
    return inputTokens + outputTokens;
  }

  /**
   * Reset token counter if a minute has passed
   */
  resetTokenCounterIfNeeded() {
    const now = Date.now();
    if (now >= this.tokenResetTime) {
      this.estimatedTokensUsed = 0;
      this.tokenResetTime = now + 60000; // Reset for next minute
      console.log('[RequestQueue] 🔄 Token counter reset');
    }
  }

  /**
   * Check if we should wait before making a request
   * @param {number} estimatedTokens - Estimated tokens for this request
   * @returns {number} - Milliseconds to wait, or 0 if can proceed
   */
  shouldWait(estimatedTokens) {
    this.resetTokenCounterIfNeeded();
    
    // Conservative TPM limit check (leave 10% buffer)
    const TPM_LIMIT = 180000; // 200k * 0.9 for safety
    if (this.estimatedTokensUsed + estimatedTokens > TPM_LIMIT) {
      const waitTime = this.tokenResetTime - Date.now();
      if (waitTime > 0) {
        console.warn(`[RequestQueue] ⚠️ Approaching TPM limit (${this.estimatedTokensUsed}/${TPM_LIMIT}), waiting ${Math.round(waitTime)}ms`);
        return waitTime;
      }
    }

    // Enforce minimum interval between requests
    const timeSinceLastRequest = Date.now() - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      return this.minRequestInterval - timeSinceLastRequest;
    }

    return 0;
  }

  /**
   * Process a single queue item
   * @private
   */
  async processItem(item) {
    // Estimate tokens
    const estimatedTokens = this.estimateTokens(item.text, item.maxTokens || 800);
    
    // Check if we should wait (respects rate limits and intervals)
    const waitTime = this.shouldWait(estimatedTokens);
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.resetTokenCounterIfNeeded();
    }

    try {
      // Make the request
      this.lastRequestTime = Date.now();
      
      // Update per-session tracking if sessionId provided
      if (item.sessionId) {
        const sessionData = this.sessionRequestCounts.get(item.sessionId) || { count: 0, lastRequestTime: 0 };
        sessionData.count++;
        sessionData.lastRequestTime = Date.now();
        this.sessionRequestCounts.set(item.sessionId, sessionData);
      }
      
      const result = await item.requestFn();
      
      // Update token usage
      this.estimatedTokensUsed += estimatedTokens;
      
      // Resolve the promise
      item.resolve(result);
    } catch (error) {
      // Reject the promise
      item.reject(error);
    } finally {
      this.activeRequests--;
      // Continue processing queue
      this.processQueue();
    }
  }

  /**
   * Process the queue with parallel execution
   * MULTI-SESSION: Processes up to maxConcurrent requests in parallel
   * This allows multiple sessions to share API capacity without blocking each other
   */
  async processQueue() {
    // Don't start new processing if already at max concurrency or queue empty
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    // Start processing flag
    if (!this.processing) {
      this.processing = true;
    }

    // Process items in parallel up to maxConcurrent limit
    while (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
      const item = this.queue.shift();
      this.activeRequests++;
      
      // Process item asynchronously (don't await - allows parallel execution)
      this.processItem(item).catch(err => {
        console.error('[RequestQueue] Error processing item:', err);
      });
    }

    // If queue is empty and no active requests, mark as not processing
    if (this.queue.length === 0 && this.activeRequests === 0) {
      this.processing = false;
    }
  }

  /**
   * Add a request to the queue
   * @param {Function} requestFn - Function that returns a Promise for the API call
   * @param {string} text - Input text (for token estimation)
   * @param {number} maxTokens - Max tokens requested (for token estimation)
   * @param {string} sessionId - Optional session ID for per-session tracking
   * @returns {Promise<any>} - Result of the API call
   */
  async enqueue(requestFn, text = '', maxTokens = 800, sessionId = null) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        requestFn,
        text,
        maxTokens,
        sessionId, // Track which session this request belongs to
        resolve,
        reject,
        timestamp: Date.now()
      });

      // Start processing if not already processing
      this.processQueue();
    });
  }

  /**
   * Wrapper for fetch-based OpenAI API calls with queue management
   * @param {string} url - API endpoint URL
   * @param {Object} fetchOptions - Options for fetch
   * @param {Object} options - Additional options
   * @param {string} options.text - Input text for token estimation
   * @param {number} options.maxTokens - Max tokens for token estimation
   * @returns {Promise<Response>} - Fetch response
   */
  async fetch(url, fetchOptions = {}, options = {}) {
    const { text = '', maxTokens = 800 } = options;
    
    // Extract text from body if not provided
    let requestText = text;
    if (!requestText && fetchOptions.body) {
      try {
        const body = JSON.parse(fetchOptions.body);
        if (body.messages && Array.isArray(body.messages)) {
          requestText = body.messages.map(m => m.content || '').join(' ');
        }
        if (body.max_tokens) {
          maxTokens = body.max_tokens;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    return this.enqueue(
      () => fetchWithRateLimit(url, fetchOptions),
      requestText,
      maxTokens
    );
  }

  /**
   * Get queue status
   * @returns {Object} - Queue status information
   */
  getStatus() {
    // Convert session counts to plain object for JSON serialization
    const sessionStats = {};
    for (const [sessionId, data] of this.sessionRequestCounts.entries()) {
      sessionStats[sessionId] = {
        requestCount: data.count,
        lastRequestTime: data.lastRequestTime
      };
    }

    return {
      queueLength: this.queue.length,
      processing: this.processing,
      activeRequests: this.activeRequests,
      maxConcurrent: this.maxConcurrent,
      estimatedTokensUsed: this.estimatedTokensUsed,
      tokenResetTime: this.tokenResetTime - Date.now(),
      lastRequestTime: Date.now() - this.lastRequestTime,
      sessionStats: sessionStats,
      activeSessions: this.sessionRequestCounts.size
    };
  }

  /**
   * Clear session tracking (for cleanup/testing)
   * @param {string} sessionId - Session ID to clear, or null to clear all
   */
  clearSessionTracking(sessionId = null) {
    if (sessionId) {
      this.sessionRequestCounts.delete(sessionId);
    } else {
      this.sessionRequestCounts.clear();
    }
  }
}

// Export singleton instance
export const openaiRequestQueue = new OpenAIRequestQueue();

