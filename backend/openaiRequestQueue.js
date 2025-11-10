/**
 * Global OpenAI Request Queue
 * Coordinates all OpenAI API calls to prevent rate limit bursts
 * 
 * Features:
 * - Single queue for all OpenAI API requests (grammar, translation, etc.)
 * - Tracks approximate token usage to stay under TPM limits
 * - Processes requests sequentially with smart batching
 * - Respects rate limits and retries automatically
 */

import { fetchWithRateLimit } from './openaiRateLimiter.js';

class OpenAIRequestQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.lastRequestTime = 0;
    this.minRequestInterval = 50; // Minimum 50ms between requests
    this.estimatedTokensUsed = 0;
    this.tokenResetTime = Date.now() + 60000; // Reset tokens every minute
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
   * Process the queue
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue[0];
      
      // Estimate tokens
      const estimatedTokens = this.estimateTokens(item.text, item.maxTokens || 800);
      
      // Check if we should wait
      const waitTime = this.shouldWait(estimatedTokens);
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
        this.resetTokenCounterIfNeeded();
      }

      // Remove from queue
      this.queue.shift();

      try {
        // Make the request
        this.lastRequestTime = Date.now();
        const result = await item.requestFn();
        
        // Update token usage
        this.estimatedTokensUsed += estimatedTokens;
        
        // Resolve the promise
        item.resolve(result);
      } catch (error) {
        // Reject the promise
        item.reject(error);
      }
    }

    this.processing = false;
  }

  /**
   * Add a request to the queue
   * @param {Function} requestFn - Function that returns a Promise for the API call
   * @param {string} text - Input text (for token estimation)
   * @param {number} maxTokens - Max tokens requested (for token estimation)
   * @returns {Promise<any>} - Result of the API call
   */
  async enqueue(requestFn, text = '', maxTokens = 800) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        requestFn,
        text,
        maxTokens,
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
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      estimatedTokensUsed: this.estimatedTokensUsed,
      tokenResetTime: this.tokenResetTime - Date.now(),
      lastRequestTime: Date.now() - this.lastRequestTime
    };
  }
}

// Export singleton instance
export const openaiRequestQueue = new OpenAIRequestQueue();

