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

// MULTI-SESSION OPTIMIZATION: Per-session tracking for fair-share allocation
// Tracks token usage per session to ensure fair distribution across multiple sessions
const sessionTokenUsage = new Map(); // sessionId -> { tokensUsed, windowStart }
const sessionRequestCounts = new Map(); // sessionId -> { count, windowStart }

/**
 * Get active session count (for fair-share allocation)
 * @returns {number} - Number of active sessions
 */
function getActiveSessionCount() {
  const now = Date.now();
  let activeCount = 0;
  
  // Count sessions that have made requests in the last 5 minutes
  for (const [sessionId, data] of sessionRequestCounts.entries()) {
    if (now - data.windowStart < 300000) { // 5 minutes
      activeCount++;
    }
  }
  
  return Math.max(1, activeCount); // At least 1 to avoid division by zero
}

/**
 * Track session request (for fair-share allocation)
 * @param {string} sessionId - Session identifier
 */
function trackSessionRequest(sessionId) {
  if (!sessionId) return;
  
  const now = Date.now();
  const sessionData = sessionRequestCounts.get(sessionId) || { count: 0, windowStart: now };
  
  // Reset if window expired (1 minute)
  if (now - sessionData.windowStart >= 60000) {
    sessionData.count = 0;
    sessionData.windowStart = now;
  }
  
  sessionData.count++;
  sessionRequestCounts.set(sessionId, sessionData);
}

/**
 * Track session token usage (for fair-share allocation)
 * @param {string} sessionId - Session identifier
 * @param {number} tokens - Token count to add
 */
function trackSessionTokens(sessionId, tokens) {
  if (!sessionId) return;
  
  const now = Date.now();
  const sessionData = sessionTokenUsage.get(sessionId) || { tokensUsed: 0, windowStart: now };
  
  // Reset if window expired (1 minute)
  if (now - sessionData.windowStart >= 60000) {
    sessionData.tokensUsed = 0;
    sessionData.windowStart = now;
  }
  
  sessionData.tokensUsed += tokens;
  sessionTokenUsage.set(sessionId, sessionData);
}

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
 * MULTI-SESSION: Implements fair-share allocation when multiple sessions are active
 * @param {Object} fetchOptions - Fetch options
 * @param {string} sessionId - Optional session ID for per-session tracking
 */
function checkPerMinuteLimit(fetchOptions = {}, sessionId = null) {
  const now = Date.now();
  
  // Reset counters if 1 minute has passed
  if (now - globalRequestWindowStart >= 60000) {
    globalRequestCount = 0;
    estimatedTokensUsed = 0;
    globalRequestWindowStart = now;
    tokenWindowStart = now;
    
    // Clean up expired session tracking
    for (const [sid, data] of sessionTokenUsage.entries()) {
      if (now - data.windowStart >= 60000) {
        sessionTokenUsage.delete(sid);
      }
    }
    for (const [sid, data] of sessionRequestCounts.entries()) {
      if (now - data.windowStart >= 60000) {
        sessionRequestCounts.delete(sid);
      }
    }
  }
  
  // Estimate tokens for this request
  const estimatedTokens = estimateTokens(fetchOptions);
  
  // MULTI-SESSION: Fair-share allocation when multiple sessions active
  const activeSessions = getActiveSessionCount();
  const fairShareRPM = Math.floor(MAX_REQUESTS_PER_MINUTE / activeSessions);
  const fairShareTPM = Math.floor(MAX_TOKENS_PER_MINUTE / activeSessions);
  
  // Track session request if sessionId provided
  if (sessionId) {
    trackSessionRequest(sessionId);
    const sessionData = sessionRequestCounts.get(sessionId);
    
    // Check per-session RPM limit (fair-share)
    if (sessionData && sessionData.count > fairShareRPM) {
      const waitTime = 60000 - (now - sessionData.windowStart);
      if (waitTime > 0) {
        console.warn(`[RateLimiter] ⚠️ Session ${sessionId} RPM fair-share limit (${sessionData.count}/${fairShareRPM}), waiting ${Math.round(waitTime)}ms`);
        return waitTime;
      }
    }
    
    // Check per-session TPM limit (fair-share)
    const sessionTokenData = sessionTokenUsage.get(sessionId);
    if (sessionTokenData && sessionTokenData.tokensUsed + estimatedTokens > fairShareTPM) {
      const waitTime = 60000 - (now - sessionTokenData.windowStart);
      if (waitTime > 0) {
        console.warn(`[RateLimiter] ⚠️ Session ${sessionId} TPM fair-share limit (${sessionTokenData.tokensUsed}/${fairShareTPM}), waiting ${Math.round(waitTime)}ms`);
        return waitTime;
      }
    }
  }
  
  // Check global RPM limit (safety check)
  if (globalRequestCount >= MAX_REQUESTS_PER_MINUTE) {
    const waitTime = 60000 - (now - globalRequestWindowStart);
    if (waitTime > 0) {
      console.warn(`[RateLimiter] ⚠️ Global RPM limit reached (${globalRequestCount}/${MAX_REQUESTS_PER_MINUTE}), waiting ${Math.round(waitTime)}ms`);
      return waitTime;
    }
  }
  
  // Check global TPM limit (safety check)
  if (estimatedTokensUsed + estimatedTokens > MAX_TOKENS_PER_MINUTE) {
    const waitTime = 60000 - (now - tokenWindowStart);
    if (waitTime > 0) {
      console.warn(`[RateLimiter] ⚠️ Global TPM limit reached (${estimatedTokensUsed}/${MAX_TOKENS_PER_MINUTE}), waiting ${Math.round(waitTime)}ms`);
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
  // Extract sessionId from fetchOptions if provided (for multi-session tracking)
  const sessionId = fetchOptions.sessionId || null;
  
  // Check per-minute limits BEFORE making request (now we have fetchOptions)
  const perMinuteWait = checkPerMinuteLimit(fetchOptions, sessionId);
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
    
    // Track session token usage if sessionId provided
    if (sessionId) {
      trackSessionTokens(sessionId, estimatedTokens);
    }
    
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
 * MULTI-SESSION: Includes per-session statistics
 */
export function getRequestStats() {
  checkDailyLimit();
  const now = Date.now();
  const requestsInLastMinute = (now - globalRequestWindowStart < 60000) ? globalRequestCount : 0;
  const tokensInLastMinute = (now - tokenWindowStart < 60000) ? estimatedTokensUsed : 0;
  
  // Convert session stats to plain objects
  const sessionStats = {};
  for (const [sessionId, data] of sessionRequestCounts.entries()) {
    if (now - data.windowStart < 60000) {
      const tokenData = sessionTokenUsage.get(sessionId);
      sessionStats[sessionId] = {
        requestsLastMinute: data.count,
        tokensLastMinute: tokenData ? tokenData.tokensUsed : 0,
        fairShareRPM: Math.floor(MAX_REQUESTS_PER_MINUTE / getActiveSessionCount()),
        fairShareTPM: Math.floor(MAX_TOKENS_PER_MINUTE / getActiveSessionCount())
      };
    }
  }
  
  return {
    requestsLastMinute: requestsInLastMinute,
    requestsPerMinuteLimit: MAX_REQUESTS_PER_MINUTE,
    tokensLastMinute: tokensInLastMinute,
    tokensPerMinuteLimit: MAX_TOKENS_PER_MINUTE,
    isRateLimited: isRateLimited,
    activeSessions: getActiveSessionCount(),
    sessionStats: sessionStats
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

