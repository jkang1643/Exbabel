/**
 * Separate Translation Workers for Partial vs Final Translations
 * 
 * ARCHITECTURE:
 * - PartialTranslationWorker: Fast, low-latency translations for live updates
 *   - Uses faster/cheaper model (GPT-3.5-turbo or GPT-4o-mini)
 *   - Aggressive caching and debouncing
 *   - Lower temperature for consistency
 *   - Can cancel/abort if new partial arrives
 * 
 * - FinalTranslationWorker: Fast translations for history
 *   - Uses GPT-4o-mini for speed and cost efficiency
 *   - No throttling or cancellation
 *   - Full context and accuracy
 */

import fetch from 'node-fetch';
import { fetchWithRateLimit, isCurrentlyRateLimited } from './openaiRateLimiter.js';

const LANGUAGE_NAMES = {
  'en': 'English',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'it': 'Italian',
  'pt': 'Portuguese',
  'pt-BR': 'Portuguese (Brazil)',
  'ru': 'Russian',
  'ja': 'Japanese',
  'ko': 'Korean',
  'zh': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  'ar': 'Arabic',
  'hi': 'Hindi',
  'nl': 'Dutch',
  'pl': 'Polish',
  'tr': 'Turkish',
  'bn': 'Bengali',
  'vi': 'Vietnamese',
  'th': 'Thai',
  'id': 'Indonesian',
  'sv': 'Swedish',
  'no': 'Norwegian',
  'da': 'Danish',
  'fi': 'Finnish',
  'el': 'Greek',
  'cs': 'Czech',
  'ro': 'Romanian',
  'hu': 'Hungarian',
  'he': 'Hebrew',
  'uk': 'Ukrainian',
  'fa': 'Persian',
  'ur': 'Urdu',
  'ta': 'Tamil',
  'te': 'Telugu',
  'mr': 'Marathi',
  'gu': 'Gujarati',
  'kn': 'Kannada',
  'ml': 'Malayalam',
  'sw': 'Swahili',
  'fil': 'Filipino',
  'ms': 'Malay',
  'ca': 'Catalan',
  'sk': 'Slovak',
  'bg': 'Bulgarian',
  'hr': 'Croatian',
  'sr': 'Serbian',
  'lt': 'Lithuanian',
  'lv': 'Latvian',
  'et': 'Estonian',
  'sl': 'Slovenian',
  'af': 'Afrikaans'
};

/**
 * Partial Translation Worker - Optimized for speed and low latency
 */
export class PartialTranslationWorker {
  constructor() {
    this.cache = new Map();
    this.pendingRequests = new Map(); // Track pending requests for cancellation
    this.MAX_CACHE_SIZE = 200; // Larger cache for partials
    this.CACHE_TTL = 120000; // 2 minutes cache for partials (longer since partials repeat)
    
    // Throttling configuration for partial translations
    this.THROTTLE_MS = 2000; // Throttle to ~1 request every 2 seconds (was 800ms)
    this.GROWTH_THRESHOLD = 25; // Wait until text grows by 25 chars or punctuation appears (was 15)
    this.lastPartialRequestTime = 0;
    this.pendingPartialBuffer = null;
    this.pendingPartialTimeout = null;
    this.pendingPartialResolvers = new Map();
    this.rateLimitDetected = false; // Circuit breaker flag
    this.isFirstTranslation = true; // Track if this is the first translation (instant for first sentence)
    this.rateLimitCooldownUntil = 0; // When to resume after rate limit
  }

  /**
   * Streaming translation for partial text - token-by-token updates
   * Uses GPT-4o-mini with streaming for real-time updates
   * @param {string} text - Text to translate
   * @param {string} sourceLang - Source language code
   * @param {string} targetLang - Target language code
   * @param {string} apiKey - OpenAI API key
   * @param {Function} onChunk - Callback for each token chunk: (chunk: string, isComplete: boolean) => void
   * @param {AbortSignal} signal - Abort signal for cancellation
   * @returns {Promise<string>} - Full translated text
   */
  async translatePartialStream(text, sourceLang, targetLang, apiKey, onChunk, signal) {
    if (!text || text.length < 5) {
      return text; // Too short to translate
    }

    const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
    const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;

    if (!apiKey) {
      console.error('[PartialWorker] ERROR: No API key provided');
      return text;
    }

    try {
      console.log(`[PartialWorker] ⚡ Streaming translation: "${text.substring(0, 40)}..." (${sourceLangName} → ${targetLangName})`);

      const response = await fetchWithRateLimit('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini', // Faster model for partials
          messages: [
            {
              role: 'system',
              content: `You are a fast real-time translator. Translate text from ${sourceLangName} to ${targetLangName}.

RULES FOR PARTIAL/INCOMPLETE TEXT:
1. Translate the partial text naturally even if sentence is incomplete
2. Maintain the same tense and context as the partial
3. Do NOT complete or extend the sentence - only translate what's given
4. Keep translation concise and natural in ${targetLangName}
5. No explanations, only the translation`
            },
            {
              role: 'user',
              content: text
            }
          ],
          temperature: 0.2, // Lower temperature for consistency in partials
          max_tokens: 16000, // Increased significantly to handle very long text passages without truncation
          stream: true // Enable streaming
        }),
        signal: signal
      });

      let fullTranslation = '';
      let buffer = '';

      // node-fetch v3 returns a Node.js Readable stream, not browser ReadableStream
      // Process as a Node.js stream
      return new Promise((resolve, reject) => {
        response.body.on('data', (chunk) => {
          if (signal?.aborted) {
            console.log('[PartialWorker] 🚫 Stream aborted');
            response.body.destroy();
            resolve(fullTranslation.trim() || text);
            return;
          }

          buffer += chunk.toString();
          const lines = buffer.split('\n');
          
          // Keep the last incomplete line in buffer
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            if (trimmedLine.startsWith('data: ')) {
              const data = trimmedLine.slice(6);
              if (data === '[DONE]') {
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                
                if (delta) {
                  fullTranslation += delta;
                  // Call callback with incremental update
                  if (onChunk) {
                    onChunk(fullTranslation, false);
                  }
                }
              } catch (e) {
                // Ignore JSON parse errors for incomplete chunks
              }
            }
          }
        });

        response.body.on('end', () => {
          // Process any remaining buffer
          if (buffer.trim()) {
            const trimmedLine = buffer.trim();
            if (trimmedLine.startsWith('data: ')) {
              const data = trimmedLine.slice(6);
              if (data !== '[DONE]') {
                try {
                  const parsed = JSON.parse(data);
                  const delta = parsed.choices?.[0]?.delta?.content;
                  
                  if (delta) {
                    fullTranslation += delta;
                    if (onChunk) {
                      onChunk(fullTranslation, false);
                    }
                  }
                } catch (e) {
                  // Ignore parse errors
                }
              }
            }
          }

          // Send final complete translation
          if (onChunk && fullTranslation) {
            onChunk(fullTranslation.trim(), true);
          }

          resolve(fullTranslation.trim() || text);
        });

        response.body.on('error', (error) => {
          reject(error);
        });

        // Handle abort signal
        if (signal) {
          signal.addEventListener('abort', () => {
            response.body.destroy();
            resolve(fullTranslation.trim() || text);
          });
        }
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log(`[PartialWorker] 🚫 Streaming translation aborted`);
        return text;
      }

      console.error(`[PartialWorker] Streaming translation error:`, error.message);
      throw error;
    }
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
   * Mark rate limit detected (circuit breaker)
   */
  markRateLimitDetected() {
    this.rateLimitDetected = true;
    this.rateLimitCooldownUntil = Date.now() + 60000; // Cooldown for 1 minute
    console.warn('[PartialWorker] 🚨 Rate limit detected - entering cooldown mode (reduced concurrency)');
    
    // Auto-reset after cooldown
    setTimeout(() => {
      this.rateLimitDetected = false;
      console.log('[PartialWorker] ✅ Rate limit cooldown expired - resuming normal operation');
    }, 60000);
  }

  /**
   * Process batched partial translation (internal method)
   * @param {string} text - Text to translate
   * @param {string} sourceLang - Source language code
   * @param {string} targetLang - Target language code
   * @param {string} apiKey - OpenAI API key
   * @returns {Promise<string>} - Translated text
   */
  async _processPartialTranslation(text, sourceLang, targetLang, apiKey) {
    // REAL-TIME INSTANT: Allow translation of absolute minimum text
    if (!text || text.length < 1) {
      return text; // Too short to translate (minimum 1 char)
    }

    // Check if we're in cooldown mode
    if (this.rateLimitDetected && Date.now() < this.rateLimitCooldownUntil) {
      const waitTime = this.rateLimitCooldownUntil - Date.now();
      console.log(`[PartialWorker] ⏸️ In cooldown mode, waiting ${Math.round(waitTime)}ms before retry`);
      await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 5000))); // Max 5s wait
    }

    // CRITICAL: For long extending text, cache key must include full text length or suffix
    // Otherwise cache hits return old truncated translations when text extends
    // Use full text for cache key for texts > 300 chars to prevent false cache hits
    let cacheKey;
    if (text.length > 300) {
      // For long text, include both prefix AND suffix to catch extensions
      // This prevents cache hits when text extends beyond the cached version
      const prefix = text.substring(0, 200);
      const suffix = text.substring(Math.max(0, text.length - 100));
      const length = text.length;
      cacheKey = `partial:${sourceLang}:${targetLang}:${length}:${prefix}:${suffix}`;
    } else {
      // For short text, use simple prefix-based key
      cacheKey = `partial:${sourceLang}:${targetLang}:${text.substring(0, 150)}`;
    }
    
    // Check cache
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      // CRITICAL: Also check if cached text length matches current text length
      // If text has extended, cache hit is invalid - need new translation
      // ALSO validate that cached text is different from original (prevents English leak)
      const isCachedSameAsOriginal = cached.text === text || 
                                      cached.text.trim() === text.trim() ||
                                      cached.text.toLowerCase() === text.toLowerCase();
      
      if (Date.now() - cached.timestamp < this.CACHE_TTL && 
          cached.text.length >= text.length * 0.9 && 
          !isCachedSameAsOriginal) {
        console.log(`[PartialWorker] ✅ Cache hit for partial`);
        return cached.text;
      } else if (cached.text.length < text.length * 0.9 || isCachedSameAsOriginal) {
        // Text has extended significantly OR cache contains English - remove stale cache entry
        if (isCachedSameAsOriginal) {
          console.log(`[PartialWorker] 🗑️ Cache entry contains English (invalid) - invalidating`);
        } else {
          console.log(`[PartialWorker] 🗑️ Cache entry too short (${cached.text.length} vs ${text.length} chars) - invalidating`);
        }
        this.cache.delete(cacheKey);
      }
    }

    const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
    const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;

    if (!apiKey) {
      console.error('[PartialWorker] ERROR: No API key provided');
      return text;
    }

    // SMART CANCELLATION: Cancel only on resets to allow word-by-word updates
    // For extending text, allow concurrent translations to create smooth word-by-word effect
    // This prevents rapid cancellation that blocks all translations from completing
    const cancelKey = `${sourceLang}:${targetLang}`;
    
    // Find any existing pending request for this language pair
    let existingRequest = null;
    let concurrentCount = 0;
    for (const [key, value] of this.pendingRequests.entries()) {
      if (key.startsWith(cancelKey)) {
        existingRequest = { key, ...value };
        concurrentCount++;
      }
    }
    
    // Reduced concurrency when rate limits detected to prevent bursts
    const MAX_CONCURRENT = this.rateLimitDetected ? 1 : 2; // Reduce to 1 if rate limited, otherwise 2
    
    // Smart cancellation: Only cancel on true resets, not on extensions
    // With MAX_CONCURRENT = 5, we can allow more parallel requests for real-time updates
    let isReset = false;
    if (existingRequest && existingRequest.text) {
      const previousText = existingRequest.text;
      // More lenient reset detection - only cancel if text shrunk significantly (>40% reduction)
      // or completely different start (not just extending)
      isReset = text.length < previousText.length * 0.6 || 
                !text.startsWith(previousText.substring(0, Math.min(previousText.length, 50)));
    }
    
    if (existingRequest) {
      const { abortController, text: previousText } = existingRequest;
      
      // Only cancel on resets OR if we're way over the concurrent limit (safety check)
      // With MAX_CONCURRENT = 5, we rarely hit this, allowing smooth 1-2 char updates
      if (isReset || concurrentCount > MAX_CONCURRENT + 2) {
        abortController.abort();
        this.pendingRequests.delete(existingRequest.key);
        const reason = isReset ? 'reset' : 'too many concurrent';
        console.log(`[PartialWorker] 🚫 Cancelled previous translation (${reason}: ${previousText?.length || 0} → ${text.length} chars)`);
      } else {
        // Text is extending - allow concurrent for real-time word-by-word updates
        // Previous shows earlier part, new shows updated full text
        console.log(`[PartialWorker] ⏳ Text extended (${previousText.length} → ${text.length} chars) - allowing concurrent for word-by-word updates`);
      }
    }

    // Create abort controller for this request
    // Use timestamp in key for extending text to allow concurrent translations
    const uniqueKey = existingRequest && !isReset && concurrentCount < MAX_CONCURRENT 
      ? `${cancelKey}_${Date.now()}` 
      : cancelKey;
    const abortController = new AbortController();
    this.pendingRequests.set(uniqueKey, { abortController, text });

    try {
      console.log(`[PartialWorker] ⚡ Fast translating partial: "${text.substring(0, 40)}..." (${sourceLangName} → ${targetLangName})`);
      console.log(`[PartialWorker] 📝 FULL TEXT INPUT TO API (${text.length} chars): "${text}"`);

      // Use GPT-4o-mini for fast partials (faster and cheaper than GPT-4o)
      const response = await fetchWithRateLimit('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini', // Faster model for partials
          messages: [
            {
              role: 'system',
              content: `You are a fast real-time translator. Translate text from ${sourceLangName} to ${targetLangName}.

RULES FOR PARTIAL/INCOMPLETE TEXT:
1. Translate the partial text naturally even if sentence is incomplete
2. Maintain the same tense and context as the partial
3. Do NOT complete or extend the sentence - only translate what's given
4. Keep translation concise and natural in ${targetLangName}
5. No explanations, only the translation`
            },
            {
              role: 'user',
              content: text
            }
          ],
          temperature: 0.2, // Lower temperature for consistency in partials
          max_tokens: 16000, // Increased significantly to handle very long text passages without truncation
          stream: false // No streaming for partials (simpler)
        }),
        signal: abortController.signal
      });

      // Remove from pending requests (find by abort controller)
      for (const [key, value] of this.pendingRequests.entries()) {
        if (value.abortController === abortController) {
          this.pendingRequests.delete(key);
          break;
        }
      }

      const result = await response.json();
      
      if (!result.choices || result.choices.length === 0) {
        throw new Error('No translation result from OpenAI');
      }

      const rawTranslatedText = result.choices[0].message.content.trim();
      
      // CRITICAL: Never fallback to English - if API returns empty, throw error instead
      if (!rawTranslatedText || rawTranslatedText.length === 0) {
        throw new Error('Translation API returned empty result');
      }
      
      // CRITICAL: Validate that translation is actually different from original (prevents English leak)
      const translatedText = rawTranslatedText;
      const isSameAsOriginal = translatedText === text || 
                               translatedText.trim() === text.trim() ||
                               translatedText.toLowerCase() === text.toLowerCase();
      
      if (isSameAsOriginal) {
        console.warn(`[PartialWorker] ⚠️ Translation matches original (likely English leak): "${translatedText.substring(0, 60)}..."`);
        throw new Error('Translation returned same as original (likely English)');
      }
      
      console.log(`[PartialWorker] ✅ FULL TRANSLATION OUTPUT FROM API (${translatedText.length} chars): "${translatedText}"`);
      
      // CRITICAL: Check if response was truncated
      const finishReason = result.choices[0].finish_reason;
      if (finishReason === 'length') {
        console.error(`[PartialWorker] ❌ TRANSLATION TRUNCATED by token limit!`);
        console.error(`[PartialWorker] Original: ${text.length} chars, Translated: ${translatedText.length} chars`);
        console.error(`[PartialWorker] Original end: "...${text.substring(Math.max(0, text.length - 150))}"`);
        console.error(`[PartialWorker] Translated end: "...${translatedText.substring(Math.max(0, translatedText.length - 150))}"`);
        // CRITICAL: Throw error for truncated translations - caller should wait for longer partial or retry
        throw new Error(`Translation truncated (finish_reason: length) - text too long (${text.length} chars)`);
      } else {
        console.log(`[PartialWorker] ✅ Translation complete (finish_reason: ${finishReason})`);
      }

      // Cache the result
      this.cache.set(cacheKey, {
        text: translatedText,
        timestamp: Date.now()
      });

      // Limit cache size
      if (this.cache.size > this.MAX_CACHE_SIZE) {
        // Remove oldest entry
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }

      return translatedText;
    } catch (error) {
      // Remove from pending requests (find by abort controller)
      for (const [key, value] of this.pendingRequests.entries()) {
        if (value.abortController === abortController) {
          this.pendingRequests.delete(key);
          break;
        }
      }

      if (error.name === 'AbortError') {
        console.log(`[PartialWorker] 🚫 Translation aborted (newer text arrived)`);
        throw error; // Re-throw abort errors - don't return English
      }

      // Check if it's a rate limit error and activate circuit breaker
      if (error.message && (error.message.includes('rate limit') || error.message.includes('TPM') || error.message.includes('RPM'))) {
        this.markRateLimitDetected();
      }

      console.error(`[PartialWorker] Translation error:`, error.message);
      throw error; // Don't return English as fallback - let caller handle error
    }
  }

  /**
   * Fast translation for partial text - optimized for latency with throttling
   * Uses GPT-4o-mini or GPT-3.5-turbo for speed
   */
  async translatePartial(text, sourceLang, targetLang, apiKey) {
    // REAL-TIME INSTANT: Allow translation of absolute minimum text
    if (!text || text.length < 1) {
      throw new Error('Text too short to translate'); // Don't return English
    }

    if (!apiKey) {
      console.error('[PartialWorker] ERROR: No API key provided');
      throw new Error('No API key provided'); // Don't return English
    }

    // Skip API call if rate limited - throw error instead of returning English
    if (isCurrentlyRateLimited()) {
      console.log(`[PartialWorker] ⏸️ Rate limited - skipping translation`);
      throw new Error('Rate limited - cannot translate'); // Don't return English
    }

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastPartialRequestTime;
    const textGrowth = this.pendingPartialBuffer 
      ? text.length - this.pendingPartialBuffer.length 
      : text.length;
    
    // OPTIMIZATION: First sentence gets instant translation (no throttling)
    // This ensures the first words appear immediately, keeping translation in sync with transcription
    const isFirstSentence = this.isFirstTranslation;
    
    // OPTIMIZATION: For short text (< 50 chars), use instant translation with minimal throttling
    // This keeps translation in sync with fast transcription for short phrases
    const isShortText = text.length < 50;
    const SHORT_TEXT_THROTTLE_MS = 100; // Very short throttle for short text (100ms)
    const SHORT_TEXT_GROWTH_THRESHOLD = 5; // Small growth threshold for short text (5 chars)
    
    // Check if we should send immediately:
    // FIRST SENTENCE: Always instant (no throttling) - critical for UX
    // For short text: Use much lower thresholds for instant feel
    // For long text: Use normal throttling to avoid API spam
    const hasPunctuation = this.hasSentencePunctuation(text);
    const throttleMs = isFirstSentence ? 0 : (isShortText ? SHORT_TEXT_THROTTLE_MS : this.THROTTLE_MS);
    const growthThreshold = isFirstSentence ? 1 : (isShortText ? SHORT_TEXT_GROWTH_THRESHOLD : this.GROWTH_THRESHOLD);
    
    const shouldSendImmediately = isFirstSentence || // FIRST SENTENCE: Always instant
                                   timeSinceLastRequest >= throttleMs ||
                                   textGrowth >= growthThreshold ||
                                   hasPunctuation ||
                                   this.rateLimitDetected; // Skip throttling if rate limited (circuit breaker active)

    if (shouldSendImmediately) {
      // Clear any pending timeout
      if (this.pendingPartialTimeout) {
        clearTimeout(this.pendingPartialTimeout);
        this.pendingPartialTimeout = null;
      }

      // Don't cancel pending promises - let them complete naturally
      // The API abort controller handles actual request cancellation
      // Multiple concurrent translations for extending text are fine and improve UX
      // Only the timeout-based throttled promises need clearing (handled above)

      // Update buffer and send request
      this.pendingPartialBuffer = text;
      this.lastPartialRequestTime = now;
      
      // Mark that first translation is complete (after we start processing)
      if (this.isFirstTranslation) {
        this.isFirstTranslation = false;
      }

      // Process the translation
      return await this._processPartialTranslation(text, sourceLang, targetLang, apiKey);
    } else {
      // Throttle: buffer the request and schedule it
      const bufferedText = text;
      const bufferedIsShortText = isShortText; // Capture for closure
      
      // Clear previous timeout if exists
      if (this.pendingPartialTimeout) {
        clearTimeout(this.pendingPartialTimeout);
      }

      // Update buffer to latest text
      this.pendingPartialBuffer = bufferedText;

      // Create a promise that will be resolved when the batch is processed
      return new Promise((resolve, reject) => {
        const requestId = `${bufferedText.length}_${Date.now()}_${Math.random()}`;
        this.pendingPartialResolvers.set(requestId, { resolve, reject });

        // Schedule batch processing after throttle period
        // Use shorter throttle for short text, and instant (0ms) for first sentence
        const isFirstSentenceBuffered = this.isFirstTranslation;
        const throttleDelay = isFirstSentenceBuffered ? 0 : (bufferedIsShortText ? SHORT_TEXT_THROTTLE_MS : this.THROTTLE_MS);
        
        // Mark first translation as complete when we schedule it
        if (isFirstSentenceBuffered) {
          this.isFirstTranslation = false;
        }
        
        this.pendingPartialTimeout = setTimeout(async () => {
          const textToProcess = this.pendingPartialBuffer;
          this.pendingPartialBuffer = null;
          this.pendingPartialTimeout = null;
          this.lastPartialRequestTime = Date.now();

          try {
            const translated = await this._processPartialTranslation(textToProcess, sourceLang, targetLang, apiKey);
            
            // Resolve all pending promises with the translated text
            for (const { resolve } of this.pendingPartialResolvers.values()) {
              resolve(translated);
            }
            this.pendingPartialResolvers.clear();
          } catch (error) {
            // CRITICAL: Don't resolve with English on error - reject instead
            for (const { reject } of this.pendingPartialResolvers.values()) {
              reject(error);
            }
            this.pendingPartialResolvers.clear();
          }
        }, Math.max(0, throttleDelay - timeSinceLastRequest));
      });
    }
  }

  /**
   * Translate to multiple languages (for partials)
   */
  async translateToMultipleLanguages(text, sourceLang, targetLangs, apiKey) {
    if (!text || targetLangs.length === 0) {
      return {};
    }

    const translations = {};

    // If source language is in target languages, include original text
    if (targetLangs.includes(sourceLang)) {
      translations[sourceLang] = text;
    }

    // Filter out source language from targets
    const langsToTranslate = targetLangs.filter(lang => lang !== sourceLang);

    if (langsToTranslate.length === 0) {
      return translations;
    }

    // Translate to each target language in parallel for speed
    const translationPromises = langsToTranslate.map(async (targetLang) => {
      try {
        const translated = await this.translatePartial(text, sourceLang, targetLang, apiKey);
        return { lang: targetLang, text: translated };
      } catch (error) {
        console.error(`[PartialWorker] Failed to translate to ${targetLang}:`, error.message);
        // CRITICAL: Don't return English as fallback - return null to indicate failure
        return { lang: targetLang, text: null };
      }
    });

    const results = await Promise.all(translationPromises);
    
    // Only include successful translations (not null) - prevents English leak
    results.forEach(({ lang, text }) => {
      if (text !== null) {
        translations[lang] = text;
      }
    });

    return translations;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    this.pendingRequests.clear();
    console.log('[PartialWorker] Cache cleared');
  }
}

/**
 * Final Translation Worker - Optimized for quality and accuracy
 */
export class FinalTranslationWorker {
  constructor() {
    this.cache = new Map();
    this.MAX_CACHE_SIZE = 100;
    this.CACHE_TTL = 600000; // 10 minutes cache for finals (longer since they're stable)
  }

  /**
   * Fast translation for final text - optimized for speed
   * Uses GPT-4o-mini for faster, cost-effective translations
   */
  async translateFinal(text, sourceLang, targetLang, apiKey) {
    if (!text || text.trim().length === 0) {
      return text;
    }

    const cacheKey = `final:${sourceLang}:${targetLang}:${text.substring(0, 200)}`;
    
    // Check cache
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.CACHE_TTL) {
        console.log(`[FinalWorker] ✅ Cache hit for final`);
        return cached.text;
      }
    }

    const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
    const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;

    if (!apiKey) {
      console.error('[FinalWorker] ERROR: No API key provided');
      throw new Error('No OpenAI API key provided for translation');
    }

    // Skip API call if rate limited - just return original text
    if (isCurrentlyRateLimited()) {
      console.log(`[FinalWorker] ⏸️ Rate limited - skipping FINAL translation, returning original text`);
      return text;
    }

    console.log(`[FinalWorker] 🎯 High-quality translating final: "${text.substring(0, 50)}..." (${sourceLangName} → ${targetLangName})`);

    try {
      // Use GPT-4o for high-quality final translations
      const response = await fetchWithRateLimit('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini', // Faster model for final translations
          messages: [
            {
              role: 'system',
              content: `You are a professional translator. Translate text from ${sourceLangName} to ${targetLangName}.

CRITICAL RULES:
1. ONLY provide the direct translation - no explanations
2. Do NOT include phrases like "The translation is..." or "Here's the translation"
3. Do NOT add any notes or commentary
4. Preserve the meaning, tone, and context
5. Maintain proper grammar and natural phrasing in ${targetLangName}
6. Keep the same level of formality as the original
7. Ensure complete and accurate translation

Output: Only the translated text in ${targetLangName}.`
            },
            {
              role: 'user',
              content: text
            }
          ],
          temperature: 0.3, // Balanced temperature for quality
          max_tokens: 16000 // Increased significantly to handle very long final translations without truncation
        })
      });

      const result = await response.json();
      
      if (!result.choices || result.choices.length === 0) {
        throw new Error('No translation result from OpenAI');
      }

      const translatedText = result.choices[0].message.content.trim() || text;
      
      // CRITICAL: Check if response was truncated
      const finishReason = result.choices[0].finish_reason;
      if (finishReason === 'length') {
        console.error(`[FinalWorker] ❌ TRANSLATION TRUNCATED by token limit!`);
        console.error(`[FinalWorker] Original: ${text.length} chars, Translated: ${translatedText.length} chars`);
        console.error(`[FinalWorker] Original end: "...${text.substring(Math.max(0, text.length - 150))}"`);
        console.error(`[FinalWorker] Translated end: "...${translatedText.substring(Math.max(0, translatedText.length - 150))}"`);
      }

      // Cache the result
      this.cache.set(cacheKey, {
        text: translatedText,
        timestamp: Date.now()
      });

      // Limit cache size
      if (this.cache.size > this.MAX_CACHE_SIZE) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }

      return translatedText;
    } catch (error) {
      // If it's a skip request error (rate limited), return original text instead of throwing
      if (error.skipRequest) {
        console.log(`[FinalWorker] ⏸️ Translation skipped (rate limited), returning original text`);
        return text;
      }
      console.error(`[FinalWorker] Translation error:`, error.message);
      throw error;
    }
  }

  /**
   * Translate to multiple languages (for finals)
   */
  async translateToMultipleLanguages(text, sourceLang, targetLangs, apiKey) {
    if (!text || targetLangs.length === 0) {
      return {};
    }

    const translations = {};

    // If source language is in target languages, include original text
    if (targetLangs.includes(sourceLang)) {
      translations[sourceLang] = text;
    }

    // Filter out source language from targets
    const langsToTranslate = targetLangs.filter(lang => lang !== sourceLang);

    if (langsToTranslate.length === 0) {
      return translations;
    }

    // Translate to each target language in parallel
    const translationPromises = langsToTranslate.map(async (targetLang) => {
      try {
        const translated = await this.translateFinal(text, sourceLang, targetLang, apiKey);
        return { lang: targetLang, text: translated };
      } catch (error) {
        console.error(`[FinalWorker] Failed to translate to ${targetLang}:`, error.message);
        return { lang: targetLang, text: `[Translation error: ${targetLang}]` };
      }
    });

    const results = await Promise.all(translationPromises);
    
    results.forEach(({ lang, text }) => {
      translations[lang] = text;
    });

    return translations;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    console.log('[FinalWorker] Cache cleared');
  }
}

// Export singleton instances
export const partialTranslationWorker = new PartialTranslationWorker();
export const finalTranslationWorker = new FinalTranslationWorker();

