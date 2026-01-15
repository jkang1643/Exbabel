/**
 * Grammar Correction Worker - GPT-4o-mini based grammar/homophone/sermon fixer
 * Runs in parallel with translation worker
 * 
 * ARCHITECTURE:
 * - Uses GPT-4o-mini for real-time grammar correction
 * - Handles homophones, sermon/biblical language, STT mishears
 * - Caches results to reduce API calls
 * - Supports request cancellation for partials
 */

import fetch from 'node-fetch';
import { fetchWithRateLimit, isCurrentlyRateLimited } from './openaiRateLimiter.js';

const GRAMMAR_SYSTEM_PROMPT = `SYSTEM PROMPT — Grammar + Homophone + Sermon Speech Fixer

You are a real-time transcription corrector for live church sermons transcribed by Whisper or other speech-to-text systems.

Your goal is to take partial or final text transcribed from speech-to-text and make it readable while preserving the exact spoken meaning.

**IMPORTANT: This is SPEECH transcription correction, not written text editing. Focus on catching common Whisper/STT mishears that occur in spoken language, especially words that sound similar but are contextually wrong.**

### Rules:

1. **Preserve meaning** — Never change what the speaker meant.
2. **CRITICAL: Word replacement rules for STT/Whisper cleanup**:
   - **ONLY correct words that sound highly similar** (homophones or near-homophones)
   - **Common Whisper/STT speech mishears to watch for**:
     - "so" → "those" (very common: "it was so small groups" → "it was those small groups")
     - "a" → "the" or vice versa (when contextually wrong: "a Bible" vs "the Bible")
     - "there/their/they're" confusion
     - "to/too/two" confusion
     - "sun/son", "hear/here", "right/write", "peace/piece", "break/brake", "see/sea"
     - "knew/new", "know/no", "its/it's", "your/you're", "we're/were/where"
     - "then/than", "affect/effect", "accept/except"
     - "and counter" → "encounter"
     - "are" → "our" (when possessive)
   - **NEVER replace words with synonyms or contextually "better" alternatives** (e.g., "calling" → "addressing", "said" → "stated", "talk" → "speak", "big" → "large")
   - **DO NOT replace words with contextually better alternatives if they don't sound similar**
   - If a word makes sense in context but sounds different, KEEP IT AS IS - the speaker may have actually said that word
   - Only fix words where STT clearly misheard a similar-sounding word (e.g., "sun" → "Son" when referring to Jesus, "there" → "their" for possession)
   - **Remember: Your job is transcription correction, not word improvement. Preserve the speaker's exact word choice unless it's clearly a sound-alike error.**
   - **Pay special attention to speech-specific errors**: Words that are uncommon in written text but common in speech, especially when Whisper mishears similar-sounding words (e.g., "so" misheard instead of "those")
   - **CRITICAL: Fix multi-word phrase mishears, not just single words**: When a phrase doesn't make contextual sense, identify the correct homophone phrase that sounds similar. Examples:
     - "on a work" → "unaware" (sounds similar, "on a work" makes no sense contextually)
     - "for theirs" → "for strangers" (when context suggests it)
     - "do not neces to show" → "do not neglect to show" (when "neces" doesn't make sense)
   - **Use context to identify phrase errors**: If a phrase sounds grammatically wrong or doesn't fit the context, check if there's a similar-sounding phrase that makes sense (e.g., "entertained angels on a work" → "entertained angels unaware")
3. **Fix ALL errors aggressively**:
   - Grammar (run-on sentences, sentence fragments, subject-verb agreement)
   - Punctuation and capitalization (fix ALL capitalization errors, not just sentence starts)
   - Spelling mistakes
   - Homophones and near-homophones (ONLY when they sound similar - see rule 2)
   - Speech-to-text mishears (ONLY choose words that *sound the same or very similar*)
   - Fix incorrect capitalization of common words (e.g., "Hospitality" → "hospitality", "Brotherly Love" → "brotherly love" unless it's a proper noun)
   - Fix run-on sentences by adding proper punctuation
   - Fix sentence fragments by completing them naturally
4. **Respect biblical / church language**:
   - Keep proper nouns like "God", "Jesus", "Holy Spirit", "Gospel", "Revival", "Kingdom", "Scripture" capitalized.
   - Do not modernize or rephrase verses or phrases from the Bible.
   - Recognize sermon phrases like "praise the Lord", "come on somebody", "hallelujah", "amen" and keep them natural.
5. **Never paraphrase or summarize**.
6. **Never change numbers, names, or theological meaning.**
7. If the sentence is incomplete, fix basic punctuation but don't guess the rest — just clean what you have.
8. Maintain oral rhythm: short, natural sentences as a preacher might speak.
9. **Be thorough**: Fix every error you see. Don't leave capitalization mistakes, run-on sentences, or grammar errors uncorrected.

### Examples:

Input: "and god so loved the world he give his only begotten sun. One of my Generations. Favorite authors is Max. Lucado. they're heart was broken. we must except Jesus as our savior"
Output: "And God so loved the world that He gave His only begotten Son. One of my generation's favorite authors is Max Lucado. Their heart was broken. We must accept Jesus as our Savior."
(Note: **Homophones:** "sun" → "Son", "they're" → "Their", "except" → "accept". **Grammar:** Fixes punctuation/capitalization errors aggressively.)

Input: "It was so small groups leaving this church in, canoes and boats, and going out and chopping holes in roof and pulling people out. I want to read a Bible verse."
Output: "It was those small groups leaving this church in canoes and boats, and going out and chopping holes in roofs and pulling people out. I want to read the Bible verse."
(Note: **CRITICAL STT Fix:** "so" → "those" (very common STT mishear). **Punctuation/Capitalization** fixed. **A/The** correction.)

Input: "Says, let Brotherly Love continue, do not neces to show. Hospitality to stranger for theirs. Thereby some have entertained angels on a work. we need to and counter God in our daily lives"
Output: "Says, 'Let brotherly love continue. Do not neglect to show hospitality to strangers, for thereby some have entertained angels unaware.' We need to encounter God in our daily lives."
(Note: **Multi-Word Mishears:** "on a work" → "unaware", "neces" → "neglect", "for theirs" → "for strangers". **Speech Mishears:** "and counter" → "encounter". **Capitalization** corrected.)


### Output format:
Output ONLY as a JSON object with the key 'corrected_text'. Example: {"corrected_text": "Your corrected text here"}.`;

// Helper function to validate that AI response is actually a correction, not an error message
function validateCorrectionResponse(corrected, original) {
  // Filter out common AI error/help responses that shouldn't be treated as transcriptions
  const errorPatterns = [
    /I'm sorry/i,
    /I need the text/i,
    /would like me to correct/i,
    /Please provide/i,
    /I'll be happy to assist/i,
    /I can help/i,
    /I don't understand/i,
    /Could you please/i,
    /Can you provide/i,
    /I'm here to help/i,
    /What text would you like/i,
    /I cannot/i,
    /I'm unable/i,
    /I don't have/i,
    /I need more information/i
  ];

  const isErrorResponse = errorPatterns.some(pattern => pattern.test(corrected));

  if (isErrorResponse) {
    console.warn(`[GrammarWorker] ⚠️ AI returned error/question instead of correction: "${corrected.substring(0, 100)}..."`);
    console.warn(`[GrammarWorker] ⚠️ Using original text instead: "${original.substring(0, 100)}..."`);
    return original; // Use original text instead of error message
  }

  return corrected;
}

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

    // Add 2-second timeout for partials to prevent blocking UI
    const timeoutId = setTimeout(() => {
      console.log(`[GrammarWorker] ⏱️ PARTIAL correction timeout after 2s - aborting`);
      abortController.abort();
    }, 2000);

    try {
      console.log(`[GrammarWorker] 🔄 Correcting PARTIAL (${text.length} chars): "${text}"`);

      const response = await fetchWithRateLimit('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini', // Same model as translation worker
          messages: [
            { role: 'system', content: GRAMMAR_SYSTEM_PROMPT },
            { role: 'user', content: text }
          ],
          temperature: 0.2, // Lower temperature for consistency
          max_tokens: 800, // Reduced for partials - they're typically short
          response_format: { type: 'json_object' } // Use JSON mode instead of tools/functions to reduce token cost
        }),
        signal: abortController.signal
      });

      clearTimeout(timeoutId); // Clear timeout on success

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(`Grammar API error: ${error.error?.message || response.statusText}`);
      }

      const data = await response.json();
      let corrected = text; // Default to original text

      // Parse JSON response
      try {
        const content = data.choices[0]?.message?.content?.trim() || '';
        if (content) {
          const jsonResponse = JSON.parse(content);
          corrected = jsonResponse.corrected_text || text;
        }
      } catch (parseError) {
        console.warn(`[GrammarWorker] ⚠️ Failed to parse JSON response, using original text:`, parseError.message);
        corrected = text;
      }

      // Validate that response is actually a correction, not an error message
      corrected = validateCorrectionResponse(corrected, text);

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
      console.log(`[GrammarWorker] 🔄 Correcting FINAL (${text.length} chars): "${text}"`);

      // Create abort controller with 5 second timeout for finals
      const abortController = new AbortController();
      timeoutId = setTimeout(() => {
        console.log(`[GrammarWorker] ⏱️ FINAL correction timeout after 5s - returning original`);
        abortController.abort();
      }, 5000);

      const response = await fetchWithRateLimit('https://api.openai.com/v1/chat/completions', {
        signal: abortController.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: GRAMMAR_SYSTEM_PROMPT },
            { role: 'user', content: text }
          ],
          temperature: 0.2,
          max_tokens: 2000,
          response_format: { type: 'json_object' } // Use JSON mode instead of tools/functions to reduce token cost
        })
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(`Grammar API error: ${error.error?.message || response.statusText}`);
      }

      const data = await response.json();
      clearTimeout(timeoutId); // Clear timeout on success

      const elapsed = Date.now() - startTime;
      let corrected = text; // Default to original text

      // Parse JSON response
      try {
        const content = data.choices[0]?.message?.content?.trim() || '';
        if (content) {
          const jsonResponse = JSON.parse(content);
          corrected = jsonResponse.corrected_text || text;
        }
      } catch (parseError) {
        console.warn(`[GrammarWorker] ⚠️ Failed to parse JSON response, using original text:`, parseError.message);
        corrected = text;
      }

      // Validate that response is actually a correction, not an error message
      corrected = validateCorrectionResponse(corrected, text);

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

