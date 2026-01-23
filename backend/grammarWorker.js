/**
 * Grammar Correction Worker - GPT-4o-mini based grammar/homophone/sermon fixer
 * Runs in parallel with translation worker
 * 
 * ARCHITECTURE:
 * - Uses GPT-4o-mini for real-time grammar correction
 * - Handles homophones, sermon/biblical language, STT mishears
 * - Caches results to reduce API calls
 * - Supports request cancellation for partials
 * - MODULARIZED: Uses GrammarProviderFactory to support multiple LLM backends
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { isCurrentlyRateLimited } from './openaiRateLimiter.js';
import { GrammarProviderFactory } from './providers/grammar/GrammarProviderFactory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

export class GrammarWorker {
  constructor() {
    this.cache = new Map();
    this.pendingRequests = new Map(); // Track pending requests for cancellation
    this.MAX_CACHE_SIZE = 200;
    this.CACHE_TTL = 120000; // 2 minutes cache (same as translation worker)

    // Throttling configuration for partial corrections
    this.THROTTLE_MS = 2000; // Throttle to ~1 request every 2 seconds (was 700ms)
    this.GROWTH_THRESHOLD = 20; // Wait until text grows by 20 chars or punctuation appears (was 10)
    this.lastPartialRequestTime = 0;
    this.pendingPartialBuffer = null;
    this.pendingPartialTimeout = null;
    this.pendingPartialResolvers = new Map(); // Track promises waiting for batched results

    // Initialize Provider
    // In the future, this could come from process.env or a config file
    // Defaulting to OpenAI for now
    const providerType = process.env.GRAMMAR_PROVIDER || 'openai';
    const providerModel = process.env.GRAMMAR_MODEL || 'gpt-4o-mini';

    this.provider = GrammarProviderFactory.createProvider(providerType, {
      model: providerModel
    });

    // Log initialization in a visible format to match Server/Translation logs
    console.log('[GrammarWorker] ===== GRAMMAR CORRECTION SERVICE =====');
    console.log(`[GrammarWorker] Provider Name: ${this.provider.name}`);
    console.log(`[GrammarWorker] Model Config:  ${this.provider.model || 'Default'}`);
    console.log(`[GrammarWorker] Class Instance: ${this.provider.constructor.name}`);
    console.log('[GrammarWorker] ======================================');
  }

  /**
   * Check if text has sentence-ending punctuation (indicates natural pause)
   * @param {string} text - Text to check
   * @returns {boolean} - True if text ends with sentence punctuation
   */
  hasSentencePunctuation(text) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    const lastChar = trimmed[trimmed.length - 1];
    return lastChar === '.' || lastChar === '!' || lastChar === '?' || lastChar === ';';
  }

  /**
   * Process batched partial correction
   * @param {string} text - Text to correct
   * @param {string} apiKey - OpenAI API key
   * @returns {Promise<string>} - Corrected text
   */
  async _processPartialCorrection(text, apiKey) {
    if (!text || text.trim().length < 8) {
      return text; // Too short to correct
    }

    // Additional validation: ensure text doesn't look like an error message
    const trimmed = text.trim();
    if (trimmed.length < 10 || /^(I'm sorry|I need|Please provide|I can help|I'll be happy)/i.test(trimmed)) {
      console.warn(`[GrammarWorker] ⚠️ Skipping correction - text looks like error message: "${trimmed.substring(0, 50)}..."`);
      return text; // Return as-is, don't send to API
    }

    // Check cache
    const cacheKey = text.toLowerCase().trim();
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`[GrammarWorker] 💾 Using cached PARTIAL result (${text.length} chars)`);
      return cached.result;
    }

    // Cancel previous request if new one arrives
    const cancelKey = 'grammar';
    const existingRequest = this.pendingRequests.get(cancelKey);

    // Check if new text is a reset (much shorter or completely different start)
    let isReset = false;
    if (existingRequest && existingRequest.text) {
      const previousText = existingRequest.text;
      isReset = text.length < previousText.length * 0.6 ||
        !text.startsWith(previousText.substring(0, Math.min(previousText.length, 100)));
    }

    if (existingRequest && isReset) {
      existingRequest.abortController.abort();
      this.pendingRequests.delete(cancelKey);
    }

    const abortController = existingRequest && !isReset
      ? existingRequest.abortController
      : new AbortController();

    this.pendingRequests.set(cancelKey, {
      abortController,
      text
    });

    // Add timeout for partials to prevent blocking UI
    // Use 10s for reasoning models (o1, o3, gpt-5), 2s for standard models
    const isReasoningModel = this.provider.model?.startsWith('o1') || this.provider.model?.startsWith('o3') || this.provider.model?.startsWith('gpt-5');
    const timeoutMs = isReasoningModel ? 10000 : 2000;
    const timeoutId = setTimeout(() => {
      console.log(`[GrammarWorker] ⏱️ PARTIAL correction timeout after ${timeoutMs}ms - aborting`);
      abortController.abort();
    }, timeoutMs);

    try {
      // Delegate to the provider
      const corrected = await this.provider.correctPartial(text, {
        apiKey,
        signal: abortController.signal
      });

      clearTimeout(timeoutId); // Clear timeout on success

      if (corrected !== text) {
        // Show full diff for better visibility
        console.log(`[GrammarWorker] ✨ CORRECTED (PARTIAL, ${text.length} → ${corrected.length} chars):`);
        console.log(`[GrammarWorker]   BEFORE: "${text}"`);
        console.log(`[GrammarWorker]   AFTER:  "${corrected}"`);
      } else {
        console.log(`[GrammarWorker] ✓ No changes needed (PARTIAL, ${text.length} chars): "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
      }

      // Cache result
      if (this.cache.size >= this.MAX_CACHE_SIZE) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(cacheKey, { result: corrected, timestamp: Date.now() });

      this.pendingRequests.delete(cancelKey);
      return corrected;

    } catch (error) {
      clearTimeout(timeoutId); // Clear timeout on error
      this.pendingRequests.delete(cancelKey);
      if (error.name === 'AbortError') {
        console.log(`[GrammarWorker] 🚫 Grammar correction aborted (timeout or newer text)`);
        throw error; // Re-throw abort errors
      }
      console.error(`[GrammarWorker] ❌ Error (${text.length} chars):`, error.message);
      return text; // Fallback to original text on error
    }
  }

  /**
   * Correct grammar for partial text - optimized for speed and low latency with throttling
   * @param {string} text - Text to correct
   * @param {string} apiKey - OpenAI API key
   * @param {AbortSignal} signal - Optional abort signal for cancellation
   * @returns {Promise<string>} - Corrected text
   */
  async correctPartial(text, apiKey, signal = null) {
    if (!text || text.trim().length < 8) {
      return text; // Too short to correct (8 chars minimum - short words don't need grammar)
    }

    if (!apiKey) {
      console.error('[GrammarWorker] ERROR: No API key provided');
      return text;
    }

    // Skip API call if rate limited - just return original text
    if (isCurrentlyRateLimited()) {
      console.log(`[GrammarWorker] ⏸️ Rate limited - skipping correction, returning original text`);
      return text;
    }

    // Check cache first (before throttling)
    const cacheKey = text.toLowerCase().trim();
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`[GrammarWorker] 💾 Using cached PARTIAL result (${text.length} chars)`);
      return cached.result;
    }

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastPartialRequestTime;
    const textGrowth = this.pendingPartialBuffer
      ? text.length - this.pendingPartialBuffer.length
      : text.length;

    // Check if we should send immediately:
    // 1. Enough time has passed (throttle period)
    // 2. Text has grown significantly (growth threshold)
    // 3. Sentence punctuation detected (natural pause)
    const hasPunctuation = this.hasSentencePunctuation(text);
    const shouldSendImmediately = timeSinceLastRequest >= this.THROTTLE_MS ||
      textGrowth >= this.GROWTH_THRESHOLD ||
      hasPunctuation;

    if (shouldSendImmediately) {
      // Clear any pending timeout
      if (this.pendingPartialTimeout) {
        clearTimeout(this.pendingPartialTimeout);
        this.pendingPartialTimeout = null;
      }

      // Resolve any pending promises with the buffered text (if any)
      // Use the latest text for all pending requests
      if (this.pendingPartialResolvers.size > 0) {
        for (const resolver of this.pendingPartialResolvers.values()) {
          resolver(text); // Return latest text for pending requests
        }
        this.pendingPartialResolvers.clear();
      }

      // Update buffer and send request
      this.pendingPartialBuffer = text;
      this.lastPartialRequestTime = now;

      // Process the correction
      return await this._processPartialCorrection(text, apiKey);
    } else {
      // Throttle: buffer the request and schedule it
      const bufferedText = text;

      // Clear previous timeout if exists
      if (this.pendingPartialTimeout) {
        clearTimeout(this.pendingPartialTimeout);
      }

      // Update buffer to latest text
      this.pendingPartialBuffer = bufferedText;

      // Create a promise that will be resolved when the batch is processed
      return new Promise((resolve) => {
        // Store resolver (use a unique key to track this specific request)
        const requestId = `${bufferedText.length}_${Date.now()}_${Math.random()}`;
        this.pendingPartialResolvers.set(requestId, resolve);

        // Schedule batch processing after throttle period
        this.pendingPartialTimeout = setTimeout(async () => {
          const textToProcess = this.pendingPartialBuffer;
          this.pendingPartialBuffer = null;
          this.pendingPartialTimeout = null;
          this.lastPartialRequestTime = Date.now();

          try {
            const corrected = await this._processPartialCorrection(textToProcess, apiKey);

            // Resolve all pending promises with the corrected text
            // (they're all waiting for the same batch)
            for (const resolver of this.pendingPartialResolvers.values()) {
              resolver(corrected);
            }
            this.pendingPartialResolvers.clear();
          } catch (error) {
            // On error, resolve with latest buffered text
            for (const resolver of this.pendingPartialResolvers.values()) {
              resolver(textToProcess);
            }
            this.pendingPartialResolvers.clear();
          }
        }, Math.max(0, this.THROTTLE_MS - timeSinceLastRequest));
      });
    }
  }

  /**
   * Correct grammar for final text - no cancellation, full context
   * @param {string} text - Text to correct
   * @param {string} apiKey - OpenAI API key
   * @returns {Promise<string>} - Corrected text
   */
  async correctFinal(text, apiKey) {
    if (!text || text.trim().length < 3) {
      return text;
    }

    if (!apiKey) {
      console.error('[GrammarWorker] ERROR: No API key provided');
      return text;
    }

    // Skip API call if rate limited - just return original text
    if (isCurrentlyRateLimited()) {
      console.log(`[GrammarWorker] ⏸️ Rate limited - skipping FINAL correction, returning original text`);
      return text;
    }

    // Check cache
    const cacheKey = text.toLowerCase().trim();
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`[GrammarWorker] 💾 Using cached FINAL result (${text.length} chars): "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
      return cached.result;
    }

    let timeoutId = null;
    try {
      const startTime = Date.now();

      const isReasoningModel = this.provider.model?.startsWith('o1') || this.provider.model?.startsWith('o3') || this.provider.model?.startsWith('gpt-5');
      const timeoutMs = isReasoningModel ? 15000 : 5000;

      // Create abort controller with dynamic timeout for finals
      const abortController = new AbortController();
      timeoutId = setTimeout(() => {
        console.log(`[GrammarWorker] ⏱️ FINAL correction timeout after ${timeoutMs}ms - returning original`);
        abortController.abort();
      }, timeoutMs);

      // Delegate to Provider
      const corrected = await this.provider.correctFinal(text, {
        apiKey,
        signal: abortController.signal
      });

      clearTimeout(timeoutId); // Clear timeout on success

      const elapsed = Date.now() - startTime;

      if (corrected !== text) {
        // Show full diff for better visibility
        console.log(`[GrammarWorker] ✨ CORRECTED (FINAL, ${text.length} → ${corrected.length} chars, ${elapsed}ms):`);
        console.log(`[GrammarWorker]   BEFORE: "${text}"`);
        console.log(`[GrammarWorker]   AFTER:  "${corrected}"`);
      } else {
        console.log(`[GrammarWorker] ✓ No changes needed (FINAL, ${text.length} chars, ${elapsed}ms): "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
      }

      // Cache result
      if (this.cache.size >= this.MAX_CACHE_SIZE) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(cacheKey, { result: corrected, timestamp: Date.now() });

      return corrected;

    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId); // Clear timeout on error
      }
      if (error.name === 'AbortError') {
        console.log(`[GrammarWorker] ⏱️ FINAL correction aborted (timeout)`);
        return text; // Return original on timeout
      }
      console.error(`[GrammarWorker] ❌ Final correction error (${text.length} chars):`, error.message);
      return text; // Fallback to original text on error
    }
  }
}

export const grammarWorker = new GrammarWorker();
