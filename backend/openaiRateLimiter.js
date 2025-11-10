/**
 * OpenAI Rate Limiter Utility
 * Handles rate limit errors with automatic retry and exponential backoff
 * 
 * Features:
 * - Parses rate limit error messages to extract retry-after time
 * - Implements exponential backoff for retries
 * - Handles both TPM (tokens per minute) and RPM (requests per minute) limits
 * - Global request limiter to prevent hitting daily limits
 * - Circuit breaker for daily request limits (RPD)
 * - Provides a wrapper function for OpenAI API calls
 */

// Global request tracking - Updated for upgraded API plan
let globalRequestCount = 0;
let globalRequestWindowStart = Date.now();
const MAX_REQUESTS_PER_MINUTE = 4500; // 5,000 RPM limit with 10% safety margin
const MAX_TOKENS_PER_MINUTE = 1800000; // 2M TPM limit with 10% safety margin
// No daily request limit - only TPM/RPM limits
let dailyRequestCount = 0;
let dailyResetTime = Date.now() + (24 * 60 * 60 * 1000); // 24 hours from now
let rpdLimitHit = false; // Circuit breaker (not used for daily limits anymore)
let isRateLimited = false; // Track if we're currently rate limited
let estimatedTokensUsed = 0; // Track token usage for TPM limits
let tokenWindowStart = Date.now();

/**
 * Parse rate limit error message to extract retry-after time in milliseconds
 * @param {string} errorMessage - Error message from OpenAI API
 * @returns {number} - Retry-after time in milliseconds, or null if not found
 */
function parseRetryAfter(errorMessage) {
  // Pattern: "Please try again in 41ms" or "Please try again in 1.5s" or "Please try again in 2m"
  const retryAfterMatch = errorMessage.match(/try again in ([\d.]+)(ms|s|m)/i);
  if (retryAfterMatch) {
    const value = parseFloat(retryAfterMatch[1]);
    const unit = retryAfterMatch[2].toLowerCase();
    
    if (unit === 'ms') {
      return value;
    } else if (unit === 's') {
      return value * 1000;
    } else if (unit === 'm') {
      return value * 60 * 1000;
    }
  }
  
  // Fallback: Check for "retry-after" header or default to exponential backoff
  return null;
}

/**
 * Check if error is a rate limit error
 * @param {Error} error - Error object
 * @returns {boolean} - True if it's a rate limit error
 */
function isRateLimitError(error) {
  if (!error || !error.message) {
    return false;
  }
  
  const message = error.message.toLowerCase();
  return message.includes('rate limit') || 
         message.includes('tpm') || 
         message.includes('rpm') ||
         message.includes('rpd') ||
         message.includes('quota');
}

/**
 * Check if we've hit daily request limit (disabled for upgraded plans)
 */
function checkDailyLimit() {
  // No daily request limit for upgraded plans - only TPM/RPM limits
  return false;
}

/**
 * Estimate tokens for a request (rough approximation)
 * @param {Object} fetchOptions - Fetch options containing request body
 * @returns {number} - Estimated tokens
 */
function estimateTokens(fetchOptions) {
  try {
    if (fetchOptions.body) {
      const body = JSON.parse(fetchOptions.body);
      let text = '';
      if (body.messages && Array.isArray(body.messages)) {
        text = body.messages.map(m => m.content || '').join(' ');
      }
      // Rough estimate: ~4 characters per token
      const inputTokens = Math.ceil(text.length / 4);
      const maxTokens = body.max_tokens || 800;
      // Assume output is similar length to input for partials, or max_tokens for finals
      const outputTokens = Math.min(maxTokens, Math.ceil(inputTokens * 1.2));
      return inputTokens + outputTokens;
    }
  } catch (e) {
    // If we can't parse, use conservative estimate
  }
  return 500; // Default estimate
}

/**
 * Check if we're exceeding per-minute rate or token limits
 */
function checkPerMinuteLimit(fetchOptions = {}) {
  const now = Date.now();
  
  // Reset counters if 1 minute has passed
  if (now - globalRequestWindowStart >= 60000) {
    globalRequestCount = 0;
    estimatedTokensUsed = 0;
    globalRequestWindowStart = now;
    tokenWindowStart = now;
  }
  
  // Estimate tokens for this request
  const estimatedTokens = estimateTokens(fetchOptions);
  
  // Check RPM limit
  if (globalRequestCount >= MAX_REQUESTS_PER_MINUTE) {
    const waitTime = 60000 - (now - globalRequestWindowStart);
    if (waitTime > 0) {
      console.warn(`[RateLimiter] ⚠️ RPM limit reached (${globalRequestCount}/${MAX_REQUESTS_PER_MINUTE}), waiting ${Math.round(waitTime)}ms`);
      return waitTime;
    }
  }
  
  // Check TPM limit
  if (estimatedTokensUsed + estimatedTokens > MAX_TOKENS_PER_MINUTE) {
    const waitTime = 60000 - (now - tokenWindowStart);
    if (waitTime > 0) {
      console.warn(`[RateLimiter] ⚠️ TPM limit reached (${estimatedTokensUsed}/${MAX_TOKENS_PER_MINUTE}), waiting ${Math.round(waitTime)}ms`);
      return waitTime;
    }
  }
  
  return 0;
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute OpenAI API call with automatic rate limit handling and retry
 * @param {Function} apiCall - Function that returns a Promise for the API call
 * @param {Object} options - Options for retry behavior
 * @param {number} options.maxRetries - Maximum number of retries (default: 5)
 * @param {number} options.baseDelay - Base delay in milliseconds for exponential backoff (default: 1000)
 * @param {number} options.maxDelay - Maximum delay in milliseconds (default: 60000)
 * @param {Function} options.onRetry - Optional callback called on each retry: (attempt, delay) => void
 * @returns {Promise<any>} - Result of the API call
 */
export async function withRateLimitRetry(apiCall, options = {}) {
  const {
    maxRetries = 5,
    baseDelay = 1000,
    maxDelay = 60000,
    onRetry = null
  } = options;

  // Check daily limit (disabled for upgraded plans)
  if (checkDailyLimit()) {
    const hoursUntilReset = (dailyResetTime - Date.now()) / (60 * 60 * 1000);
    const error = new Error(`Daily request limit reached. Reset in ${hoursUntilReset.toFixed(1)} hours.`);
    error.isDailyLimit = true;
    isRateLimited = true;
    throw error;
  }

  // Note: We can't check per-minute limit here because we don't have fetchOptions yet
  // This will be checked in fetchWithRateLimit where we have access to the request

  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await apiCall();
      return result;
    } catch (error) {
      lastError = error;
      
      // If it's not a rate limit error, throw immediately
      if (!isRateLimitError(error)) {
        throw error;
      }
      
      // Check if it's a daily request limit (RPD) - don't retry, just fail
      if (error.message && error.message.includes('requests per day') || error.message.includes('RPD')) {
        rpdLimitHit = true;
        const hoursUntilReset = (dailyResetTime - Date.now()) / (60 * 60 * 1000);
        console.error(`[RateLimiter] 🚨 DAILY REQUEST LIMIT HIT: ${dailyRequestCount} requests`);
        console.error(`[RateLimiter] ⏸️ Stopping all requests. Reset in ${hoursUntilReset.toFixed(1)} hours`);
        error.isDailyLimit = true;
        throw error;
      }
      
      // If we've exhausted retries, throw the error
      if (attempt >= maxRetries) {
        console.error(`[RateLimiter] ❌ Max retries (${maxRetries}) exceeded for rate limit error`);
        throw error;
      }
      
      // Calculate delay
      let delay = parseRetryAfter(error.message);
      
      // If we couldn't parse retry-after, use exponential backoff
      if (delay === null) {
        delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        // Add jitter to prevent thundering herd
        delay += Math.random() * 1000;
      } else {
        // CRITICAL: When hitting rate limits, wait longer to avoid rapid retries
        // Add a significant buffer to respect the rate limit window
        // For very short delays (< 100ms), add 50% or 50ms minimum (was 10ms)
        // For longer delays, add 20% or 200ms minimum (was 100ms)
        if (delay < 100) {
          delay = Math.max(delay * 1.5, delay + 50); // Increased from 1.1x and +10ms
        } else {
          delay = Math.max(delay * 1.2, delay + 200); // Increased from 1.1x and +100ms
        }
        
        // For TPM (tokens per minute) limits, add extra buffer since window resets every minute
        // If delay is very short (< 500ms), it means we're close to reset - wait longer
        if (delay < 500 && error.message.includes('TPM')) {
          delay = Math.max(delay, 1000); // Wait at least 1 second for TPM limits
          console.warn(`[RateLimiter] 🕐 TPM limit detected, extending wait to ${delay}ms to respect rate limit window`);
        }
      }
      
      // Ensure delay doesn't exceed maxDelay
      delay = Math.min(delay, maxDelay);
      
      console.warn(`[RateLimiter] ⚠️ Rate limit hit (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms`);
      console.warn(`[RateLimiter] Error: ${error.message}`);
      
      if (onRetry) {
        onRetry(attempt + 1, delay);
      }
      
      await sleep(delay);
    }
  }
  
  // Should never reach here, but just in case
  throw lastError || new Error('Unknown error in rate limit retry');
}

/**
 * Wrapper for fetch-based OpenAI API calls with rate limit handling
 * @param {string} url - API endpoint URL
 * @param {Object} fetchOptions - Options for fetch (method, headers, body, signal, etc.)
 * @param {Object} retryOptions - Options for retry behavior (same as withRateLimitRetry)
 * @returns {Promise<Response>} - Fetch response
 */
export async function fetchWithRateLimit(url, fetchOptions = {}, retryOptions = {}) {
  // Check per-minute limits BEFORE making request (now we have fetchOptions)
  const perMinuteWait = checkPerMinuteLimit(fetchOptions);
  if (perMinuteWait > 0) {
    isRateLimited = true;
    // If we have to wait more than 2 seconds, skip the request entirely (return original text)
    // This prevents long waits that would block the UI
    if (perMinuteWait > 2000) {
      console.warn(`[RateLimiter] ⏸️ Rate limit reached, skipping request (would wait ${Math.round(perMinuteWait / 1000)}s)`);
      isRateLimited = true;
      const error = new Error('Rate limit: Request skipped due to rate limit');
      error.skipRequest = true;
      throw error;
    }
    await sleep(perMinuteWait);
    // Counters will reset automatically in next checkPerMinuteLimit call if window expired
    isRateLimited = false;
  } else {
    isRateLimited = false;
  }

  const result = await withRateLimitRetry(async () => {
    // Check limits again (window may have reset after wait) and increment counters
    const now = Date.now();
    if (now - globalRequestWindowStart >= 60000) {
      globalRequestCount = 0;
      estimatedTokensUsed = 0;
      globalRequestWindowStart = now;
      tokenWindowStart = now;
    }
    
    // Increment counters before making request
    globalRequestCount++;
    const estimatedTokens = estimateTokens(fetchOptions);
    estimatedTokensUsed += estimatedTokens;
    
    const response = await fetch(url, fetchOptions);
    
    // If response is not OK, check if it's a rate limit error
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
      const errorMessage = errorData.error?.message || response.statusText;
      
      // Check if it's a rate limit error (429 status or rate limit in message)
      if (response.status === 429 || isRateLimitError({ message: errorMessage })) {
        const error = new Error(`OpenAI API error: ${errorMessage}`);
        error.status = response.status;
        throw error;
      }
      
      // For other errors, throw immediately
      throw new Error(`OpenAI API error: ${errorMessage}`);
    }
    
    return response;
  }, retryOptions);
  
  return result;
}

/**
 * Check if we're currently rate limited
 */
export function isCurrentlyRateLimited() {
  return isRateLimited || rpdLimitHit || checkDailyLimit();
}

/**
 * Get current request statistics
 */
export function getRequestStats() {
  checkDailyLimit();
  const now = Date.now();
  const requestsInLastMinute = (now - globalRequestWindowStart < 60000) ? globalRequestCount : 0;
  const tokensInLastMinute = (now - tokenWindowStart < 60000) ? estimatedTokensUsed : 0;
  
  return {
    requestsLastMinute: requestsInLastMinute,
    requestsPerMinuteLimit: MAX_REQUESTS_PER_MINUTE,
    tokensLastMinute: tokensInLastMinute,
    tokensPerMinuteLimit: MAX_TOKENS_PER_MINUTE,
    isRateLimited: isRateLimited
  };
}

/**
 * Reset daily counter (for testing or manual reset)
 */
export function resetDailyCounter() {
  dailyRequestCount = 0;
  dailyResetTime = Date.now() + (24 * 60 * 60 * 1000);
  rpdLimitHit = false;
  console.log('[RateLimiter] 🔄 Daily counter manually reset');
}

