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

const GRAMMAR_SYSTEM_PROMPT = `SYSTEM PROMPT — Grammar + Homophone + Sermon Speech Fixer

You are a real-time transcription corrector for live church sermons.

Your goal is to take partial or final text transcribed from speech-to-text and make it readable while preserving the exact spoken meaning.

### Rules:

1. **Preserve meaning** — Never change what the speaker meant.
2. **Fix ALL errors aggressively**:
   - Grammar (run-on sentences, sentence fragments, subject-verb agreement)
   - Punctuation and capitalization (fix ALL capitalization errors, not just sentence starts)
   - Spelling mistakes
   - Homophones ("there/their/they're", "to/too/two", etc.)
   - Speech-to-text mishears (choose the correct word that *sounds the same* and makes contextual sense)
   - Fix incorrect capitalization of common words (e.g., "Hospitality" → "hospitality", "Brotherly Love" → "brotherly love" unless it's a proper noun)
   - Fix run-on sentences by adding proper punctuation
   - Fix sentence fragments by completing them naturally
3. **Respect biblical / church language**:
   - Keep proper nouns like "God", "Jesus", "Holy Spirit", "Gospel", "Revival", "Kingdom", "Scripture" capitalized.
   - Do not modernize or rephrase verses or phrases from the Bible.
   - Recognize sermon phrases like "praise the Lord", "come on somebody", "hallelujah", "amen" and keep them natural.
4. **Never paraphrase or summarize**.
5. **Never change numbers, names, or theological meaning.**
6. If the sentence is incomplete, fix basic punctuation but don't guess the rest — just clean what you have.
7. Maintain oral rhythm: short, natural sentences as a preacher might speak.
8. **Be thorough**: Fix every error you see. Don't leave capitalization mistakes, run-on sentences, or grammar errors uncorrected.

### Examples:

Input: "and god so loved the world he give his only begotten sun"
Output: "And God so loved the world that He gave His only begotten Son."

Input: "come on somebody give him praise"
Output: "Come on, somebody, give Him praise!"

Input: "let's go back to the text it says when david found mephibosheth"
Output: "Let's go back to the text — it says when David found Mephibosheth."

Input: "they're heart was broken"
Output: "Their heart was broken."

Input: "we was praying last night"
Output: "We were praying last night."

Input: "God wants us to show Hospitality the writer of Hebrews. Says, let Brotherly Love continue."
Output: "God wants us to show hospitality. The writer of Hebrews says, 'Let brotherly love continue.'"

Input: "One of my Generations. Favorite authors is Max. Lucado"
Output: "One of my generation's favorite authors is Max Lucado."

### Output format:
Return only the corrected text as a single line, no explanations.`;

export class GrammarWorker {
  constructor() {
    this.cache = new Map();
    this.pendingRequests = new Map(); // Track pending requests for cancellation
    this.MAX_CACHE_SIZE = 200;
    this.CACHE_TTL = 120000; // 2 minutes cache (same as translation worker)
  }

  /**
   * Correct grammar for partial text - optimized for speed and low latency
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

    // Check cache
    const cacheKey = text.toLowerCase().trim();
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`[GrammarWorker] 💾 Using cached PARTIAL result (${text.length} chars)`);
      return cached.result;
    }

    // Cancel previous request if new one arrives (same pattern as translation worker)
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

    const abortController = signal || 
      (existingRequest && !isReset ? existingRequest.abortController : new AbortController());
    
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
      
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
          max_tokens: 800 // Reduced for partials - they're typically short
        }),
        signal: abortController.signal
      });
      
      clearTimeout(timeoutId); // Clear timeout on success

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(`Grammar API error: ${error.error?.message || response.statusText}`);
      }

      const data = await response.json();
      const corrected = data.choices[0]?.message?.content?.trim() || text;
      
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

    // Check cache
    const cacheKey = text.toLowerCase().trim();
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`[GrammarWorker] 💾 Using cached FINAL result (${text.length} chars): "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
      return cached.result;
    }

    try {
      const startTime = Date.now();
      console.log(`[GrammarWorker] 🔄 Correcting FINAL (${text.length} chars): "${text}"`);
      
      // Create abort controller with 5 second timeout for finals
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log(`[GrammarWorker] ⏱️ FINAL correction timeout after 5s - returning original`);
        abortController.abort();
      }, 5000);

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
          max_tokens: 2000
        })
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(`Grammar API error: ${error.error?.message || response.statusText}`);
      }

      const data = await response.json();
      clearTimeout(timeoutId); // Clear timeout on success
      
      const elapsed = Date.now() - startTime;
      const corrected = data.choices[0]?.message?.content?.trim() || text;
      
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
      clearTimeout(timeoutId); // Clear timeout on error
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

