/**
 * Realtime Translation Workers - Using GPT-4o mini Realtime API
 * 
 * ARCHITECTURE:
 * - Uses WebSocket connections to OpenAI Realtime API for text-to-text translation
 * - Persistent connections for low latency (150-300ms)
 * - Streaming partial responses for real-time updates
 * - Connection pooling for multiple concurrent sessions
 * 
 * Model: gpt-realtime-mini (production model with better caching)
 */

import WebSocket from 'ws';
import { getLanguageName } from './languageConfig.js';

/**
 * TEMP: Silence all RealtimePartialWorker console output (log/warn/error)
 * so other subsystems can be debugged without noise. Toggle the flag below
 * to re-enable detailed logging when needed.
 */
const REALTIME_PARTIAL_LOGS_ENABLED = false;

const shouldSuppressRealtimePartialLog = (args) => {
  if (REALTIME_PARTIAL_LOGS_ENABLED) return false;
  const firstArg = args?.[0];
  return typeof firstArg === 'string' && firstArg.startsWith('[RealtimePartialWorker]');
};

['log', 'warn', 'error'].forEach((method) => {
  const originalMethod = console[method].bind(console);
  console[method] = (...args) => {
    if (shouldSuppressRealtimePartialLog(args)) {
      return;
    }
    originalMethod(...args);
  };
});

/**
 * Detect if output is a hallucination (conversational response instead of translation)
 * @param {string} text - Output text to validate
 * @param {string} originalText - Original input text
 * @returns {boolean} - True if hallucination detected
 */
const isHallucinatedResponse = (text, originalText) => {
  if (!text || !originalText) return false;

  const lowerText = text.toLowerCase().trim();
  const lowerOriginal = originalText.toLowerCase().trim();

  // Pattern 1: Conversational phrases that indicate hallucination
  const hallucinationPatterns = [
    /^(i'm sorry|i am sorry|sorry)/i,
    /^(hello|hi|hey)/i,
    /^(i can't|i cannot|i can not)/i,
    /^(yes|no|sure|okay|ok)\b/i,
    /^(i don't|i do not)/i,
    /^(thank you|thanks)/i,
    /^(how are you|how can i help)/i,
    /^(i understand|i see)/i,
    /^(of course|certainly)/i,
    /^(let me|i will|i'll)/i,
    /^i\s+(am|'m)\s+(sorry|apologize|afraid)/i,
    /^i\s+(cannot|can't|don't|cannot)\s+/i,
    /^i\s+can\s+help/i,
    /^let\s+me\s+help/i,
    /^i\s+would\s+be\s+happy/i,
    /^i\s+can\s+assist/i,
    /^here\s+to\s+(help|assist)/i,
    /^respectful\s+and\s+meaningful/i,
    /^i\s+appreciate/i
  ];

  for (const pattern of hallucinationPatterns) {
    if (pattern.test(lowerText)) {
      return true;
    }
  }

  // Pattern 2: Output is identical to input (no translation occurred)
  if (lowerText === lowerOriginal && text.length > 5) {
    return true;
  }

  // Pattern 3: Output is suspiciously short for a long input (likely refused)
  if (originalText.length > 50 && text.length < 10) {
    return true;
  }

  return false;
};

/**
 * Realtime Partial Translation Worker - Optimized for speed and low latency
 *
 * SUB-200MS ARCHITECTURE:
 * - Persistent conversation context (one conversation per language pair)
 * - Uses conversation.item.truncate to update existing items
 * - Single long-lived translation stream that receives incremental updates
 * - Target latency: 150-200ms (vs 300-500ms with item creation per partial)
 */
export class RealtimePartialTranslationWorker {
  constructor() {
    this.cache = new Map();
    this.pendingRequests = new Map(); // Track pending requests for cancellation
    this.MAX_CACHE_SIZE = 200;
    this.CACHE_TTL = 120000; // 2 minutes cache

    // Connection pool for WebSocket sessions
    this.connectionPool = new Map(); // key: `${sourceLang}:${targetLang}`, value: WebSocket session
    this.connectionSetupPromises = new Map(); // Track setup promises to avoid duplicate connections

    // Request tracking
    this.requestCounter = 0;
    this.pendingResponses = new Map(); // Track pending responses by requestId
    this.responseToRequestMap = new Map(); // Track response ID → request ID mapping for cleanup

    // CRITICAL: Request serialization per connection to prevent concurrent API errors
    // This ensures only ONE request is being processed at a time per connection
    this.connectionLocks = new Map(); // key: connectionKey, value: Promise (current request)

    // CRITICAL: NO PERSISTENT CONVERSATION CONTEXT (matching 4o mini pipeline)
    // Conversation context causes performance degradation over time
    // Solution: TRUNCATE conversation items after each response to keep context window small
    // This allows connection reuse WITHOUT accumulating context
    this.CONNECTION_REUSE_ENABLED = false; // Close connections after translation to start fresh

    // Persistent conversation tracking - Track itemIds for truncation
    // Each connection keeps ONE input/output pair - we truncate after each response
    this.sessionConversations = new Map(); // key: baseConnectionKey, value: { inputItemId, outputItemId, lastUsed }

    // Concurrency limits - CRITICAL: Increased to handle rapid transcription updates
    // MAX_CONCURRENT = 1 caused timeouts with frequent transcription requests
    // Increased to 5 (like Chat API) to allow parallel response processing per connection
    this.MAX_CONCURRENT = 5; // INCREASED to 5 like Chat API (was 2, which still serializes)
    this.MAX_PENDING_REQUESTS = 30; // Increased to handle concurrent translations

    // Periodic cleanup to prevent memory leaks
    setInterval(() => this._cleanupStalePendingRequests(), 5000); // Every 5 seconds
  }

  /**
   * Clean up stale pending requests that are stuck (prevents memory leaks)
   */
  _cleanupStalePendingRequests() {
    const now = Date.now();
    const STALE_THRESHOLD = 40000; // 40 seconds - must be >= max timeout (30s for finals) to avoid premature cleanup

    let cleanedCount = 0;
    for (const [requestId, pending] of this.pendingResponses.entries()) {
      // Check if request has been pending for too long (likely stuck)
      const createdAt = parseInt(requestId.split('_')[1]); // Extract timestamp from req_TIMESTAMP_counter
      const age = now - createdAt;

      if (age > STALE_THRESHOLD) {
        console.log(`[RealtimePartialWorker] 🧹 Cleaning up stale request ${requestId} (age: ${age}ms)`);

        // Reject the promise to free up memory
        if (pending.reject) {
          pending.reject(new Error('Request cleaned up - exceeded stale threshold'));
        }

        // Clear timeout
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }

        this.pendingResponses.delete(requestId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[RealtimePartialWorker] 🧹 Cleaned up ${cleanedCount} stale requests (${this.pendingResponses.size} remaining)`);
    }
  }

  /**
   * Get or create a WebSocket connection for a language pair
   * SPEED: Use connection pool (multiple connections per language pair for parallelism)
   */
  async getConnection(sourceLang, targetLang, apiKey) {
    const connectionKey = `${sourceLang}:${targetLang}`;

    // SPEED: Try to find an idle connection (no active response)
    for (const [key, session] of this.connectionPool.entries()) {
      if (key.startsWith(connectionKey) &&
        session.ws &&
        session.ws.readyState === WebSocket.OPEN &&
        session.setupComplete &&
        !session.activeResponseId) { // IDLE - no active response
        console.log(`[RealtimePartialWorker] ♻️ Reusing idle connection: ${key}`);
        return session;
      }
    }

    // No idle connection - create a new one (up to MAX_CONCURRENT per language pair)
    const existingCount = Array.from(this.connectionPool.keys())
      .filter(k => k.startsWith(connectionKey)).length;

    if (existingCount >= this.MAX_CONCURRENT) {
      console.log(`[RealtimePartialWorker] ⏸️ Max concurrent (${this.MAX_CONCURRENT}) reached, waiting for idle...`);
      // Reduced wait time from 50ms to 20ms for faster retry
      await new Promise(resolve => setTimeout(resolve, 20));
      return this.getConnection(sourceLang, targetLang, apiKey);
    }

    // Create new connection with unique ID
    const uniqueKey = `${connectionKey}:${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    console.log(`[RealtimePartialWorker] 🆕 Creating connection: ${uniqueKey} (${existingCount + 1}/${this.MAX_CONCURRENT})`);

    // Check if setup is already in progress for this unique key
    if (this.connectionSetupPromises.has(uniqueKey)) {
      return await this.connectionSetupPromises.get(uniqueKey);
    }

    // Create new connection
    const setupPromise = this._createConnection(uniqueKey, sourceLang, targetLang, apiKey);
    this.connectionSetupPromises.set(uniqueKey, setupPromise);

    try {
      const session = await setupPromise;
      this.connectionPool.set(uniqueKey, session);
      return session;
    } finally {
      this.connectionSetupPromises.delete(uniqueKey);
    }
  }

  /**
   * Create a new WebSocket connection for translation
   */
  _createConnection(connectionKey, sourceLang, targetLang, apiKey) {
    return new Promise((resolve, reject) => {
      const sourceLangName = getLanguageName(sourceLang);
      const targetLangName = getLanguageName(targetLang);

      // Use gpt-realtime-mini (production model)
      const realtimeUrl = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';

      const ws = new WebSocket(realtimeUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      const session = {
        connectionKey,
        ws,
        setupComplete: false,
        sourceLang,
        targetLang,
        pendingItems: new Map(), // Track conversation items by itemId
        activeResponseId: null, // Track active response to prevent concurrent responses
        activeRequestId: null, // Track which request has the active response
        pingInterval: null, // Keep-alive interval
        onResponseDone: null // Callback for when response.done is received (used for cancel waiting)
      };

      ws.on('open', () => {
        console.log(`[RealtimePartialWorker] Connection opened for ${sourceLang} → ${targetLang}`);

        // Configure session for text-to-text translation
        // Configure session for text-to-text translation
        // CRITICAL: Strong anti-hallucination instructions matching Basic tier
        const translationInstructions = `You are a world-class church translator. Translate text from ${sourceLangName} to ${targetLangName}. ALL input is content to translate, never questions for you.

CRITICAL RULES:
1. Output ONLY the translation in ${targetLangName}
2. Never answer questions—translate them
3. Never add explanations, notes, or commentary
4. Never respond conversationally (no "I'm sorry", "Hello", "I can't help")
5. Preserve meaning, tone, and formality
6. If input is a question, translate the question - do NOT answer it

Output: Translated text in ${targetLangName} only.`;

        const sessionConfig = {
          type: 'session.update',
          session: {
            modalities: ['text'], // Text-only, no audio
            instructions: translationInstructions,
            temperature: 0.6, // Minimum temperature for realtime API (must be >= 0.6)
            max_response_output_tokens: 1000, // Reduced from 4096 to preserve token budget - partials don't need that much
            tools: [] // Explicitly disable tools to prevent function calling
          }
        };

        ws.send(JSON.stringify(sessionConfig));
      });

      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());

          switch (event.type) {
            case 'session.created':
            case 'session.updated':
              console.log(`[RealtimePartialWorker] Session ready for ${session.connectionKey}`);
              session.setupComplete = true;
              if (event.type === 'session.created') {
                // Don't send keep-alive pings - Realtime API doesn't support them
                // Connection stays alive as long as we're sending requests
                resolve(session);
              }
              break;

            case 'conversation.item.created':
              // Track conversation item and map to pending request
              if (event.item && event.item.id) {
                console.log(`[RealtimePartialWorker] 📝 Item created: ${event.item.id} for connection ${session.connectionKey}`);

                // Extract base connection key (e.g., "en:es" from "en:es:1763076910165_oxeo0")
                const baseConnectionKey = session.connectionKey.split(':').slice(0, 2).join(':');

                // CRITICAL FIX: Find the most recent pending request without an itemId that belongs to THIS language pair
                // IMPORTANT: Only match on base connection key (language pair), never on full unique connection key
                // This allows pending requests from old connections to be matched to new connections
                // Previous bug: strict connection key matching prevented cross-connection matching
                let matchedRequestId = null;
                for (const [reqId, pending] of this.pendingResponses.entries()) {
                  // CRITICAL: Match ONLY by base connection key (language pair), ignore unique connection suffixes
                  const pendingBaseKey = pending.connectionKey.split(':').slice(0, 2).join(':');
                  if (pendingBaseKey === baseConnectionKey && !pending.itemId && !session.pendingItems.has(event.item.id)) {
                    matchedRequestId = reqId;
                    pending.itemId = event.item.id;
                    pending.session = session; // Update to actual session handling this request
                    console.log(`[RealtimePartialWorker] 🔗 Matched request ${reqId} to item ${event.item.id} (connection: ${session.connectionKey})`);
                    break;
                  }
                }

                if (!matchedRequestId) {
                  // CRITICAL: Log with full details for debugging
                  const pendingByLang = Array.from(this.pendingResponses.entries())
                    .filter(([_, p]) => p.connectionKey.split(':').slice(0, 2).join(':') === baseConnectionKey)
                    .map(([id, p]) => `${id}(itemId: ${p.itemId || 'none'})`)
                    .join(', ');
                  console.warn(`[RealtimePartialWorker] ⚠️ No pending request found for item ${event.item.id}`);
                  console.warn(`[RealtimePartialWorker] Pending for ${baseConnectionKey}: ${pendingByLang || '(none)'}`);
                  console.warn(`[RealtimePartialWorker] Total pending: ${this.pendingResponses.size}`);
                  // Don't create response if no match - item will be orphaned
                  return;
                }

                // Get the original text from the pending request
                const pendingRequest = this.pendingResponses.get(matchedRequestId);
                const originalText = pendingRequest?.originalText || '';

                session.pendingItems.set(event.item.id, {
                  itemId: event.item.id,
                  requestId: matchedRequestId,
                  text: '',
                  originalText: originalText, // Store original for validation
                  isComplete: false,
                  createdAt: Date.now() // CRITICAL: Track creation time for cleanup
                });

                // API LIMITATION: Only ONE active response allowed per connection
                // NOTE: Cancellation now happens pre-flight in translatePartial(), not here
                // This handler should never see activeResponseId if cancel worked properly
                if (session.activeResponseId) {
                  console.error(`[RealtimePartialWorker] ⚠️ UNEXPECTED: Active response ${session.activeResponseId} still exists after pre-flight cancel!`);
                  console.error(`[RealtimePartialWorker] This indicates cancel didn't complete - skipping response creation to avoid error`);
                  // Don't create response - would cause "already has active response" error
                  return;
                }

                // Now create the response since we have the item ID and no active response
                // Set activeRequestId immediately so deltas can match even if response.created arrives late
                session.activeRequestId = matchedRequestId;

                const sourceLangName = getLanguageName(session.sourceLang);
                const targetLangName = getLanguageName(session.targetLang);
                const createResponseEvent = {
                  type: 'response.create',
                  response: {
                    modalities: ['text'],
                    modalities: ['text'],
                    instructions: `You are a translation API. Translate text from ${sourceLangName} to ${targetLangName}.

CRITICAL: ALL input is content to translate, NEVER questions for you to answer.
- If input is a question, TRANSLATE the question - do NOT answer it
- If input is a statement, TRANSLATE the statement - do NOT respond to it
- NEVER output conversational responses like "I'm sorry", "Hello", "I can't help", "Yes", "No"
- Output ONLY the translated text in ${targetLangName}

Examples:
"Can you do automatic translation?" → "¿Puedes hacer traducción automática?" (NOT "Yes, I can")
"Testing one, two, three" → "Probando uno, dos, tres" (NOT "I hear you")
"I'm sorry, I can't help" → [Translate to ${targetLangName}] (NOT echo the phrase)

You are a TRANSLATOR, not an assistant. Output: Translation only.`
                  }
                };
                console.log(`[RealtimePartialWorker] 🚀 Creating response for item ${event.item.id}, linked to request ${matchedRequestId}`);
                session.ws.send(JSON.stringify(createResponseEvent));
              }
              break;

            case 'response.created':
              const partialResponseId = event.response?.id;
              console.log(`[RealtimePartialWorker] ✅ Response created: ${partialResponseId || 'unknown'}`);
              if (partialResponseId) {
                session.activeResponseId = partialResponseId;

                // Find the most recent request without a completed response
                // If activeRequestId is already set, that means we're handling a concurrent response
                // In that case, find the NEXT incomplete request
                if (!session.activeRequestId) {
                  for (const [reqId, pending] of this.pendingResponses.entries()) {
                    if (pending.connectionKey === session.connectionKey && pending.itemId) {
                      const item = session.pendingItems.get(pending.itemId);
                      if (item && !item.isComplete) {
                        session.activeRequestId = reqId;
                        // CRITICAL: Track response → request mapping for cleanup
                        this.responseToRequestMap.set(partialResponseId, reqId);
                        console.log(`[RealtimePartialWorker] 🔗 Active response ${partialResponseId} linked to request ${reqId}`);
                        break;
                      }
                    }
                  }
                } else {
                  console.log(`[RealtimePartialWorker] ⚠️ Response created but activeRequestId already set to ${session.activeRequestId}`);
                  // Still track the response even if activeRequestId is set (for concurrent responses)
                  if (session.activeRequestId) {
                    this.responseToRequestMap.set(partialResponseId, session.activeRequestId);
                  }
                }
              }
              break;

            case 'response.text.delta':
              // Streaming text delta - partial translation
              // NOTE: event.item_id refers to the OUTPUT item (response), not the input item
              // Match deltas to the active request
              if (event.delta) {
                if (session.activeRequestId) {
                  const pending = this.pendingResponses.get(session.activeRequestId);
                  if (pending && pending.itemId) {
                    const item = session.pendingItems.get(pending.itemId);
                    if (item) {
                      item.text += event.delta;
                      console.log(`[RealtimePartialWorker] 📥 Delta: "${event.delta}" (total: "${item.text}")`);

                      // Call partial callback if available
                      if (pending.onPartial) {
                        pending.onPartial(item.text, false);
                      }
                    }
                  } else {
                    console.warn(`[RealtimePartialWorker] ⚠️ Delta received but active request ${session.activeRequestId} not found or missing itemId`);
                  }
                } else {
                  // Fallback: try to find the most recent incomplete request
                  let fallbackRequest = null;
                  for (const [reqId, pending] of this.pendingResponses.entries()) {
                    if (pending.connectionKey === session.connectionKey && pending.itemId) {
                      const item = session.pendingItems.get(pending.itemId);
                      if (item && !item.isComplete) {
                        fallbackRequest = { reqId, pending, item };
                        break;
                      }
                    }
                  }
                  if (fallbackRequest) {
                    fallbackRequest.item.text += event.delta;
                    console.log(`[RealtimePartialWorker] 📥 Delta (fallback): "${event.delta}" (total: "${fallbackRequest.item.text}")`);
                    if (fallbackRequest.pending.onPartial) {
                      fallbackRequest.pending.onPartial(fallbackRequest.item.text, false);
                    }
                    // Set activeRequestId for future deltas
                    session.activeRequestId = fallbackRequest.reqId;
                  } else {
                    console.warn(`[RealtimePartialWorker] ⚠️ Delta received but no active request found and no fallback available`);
                  }
                }
              }
              break;

            case 'response.text.done':
              // Text response complete
              // NOTE: event.item_id refers to the OUTPUT item (response), not the input item
              // Use the active request ID to find the correct request
              if (session.activeRequestId) {
                const pending = this.pendingResponses.get(session.activeRequestId);
                if (pending && pending.itemId) {
                  const item = session.pendingItems.get(pending.itemId);
                  if (item) {
                    item.isComplete = true;
                    const translatedText = item.text.trim();
                    console.log(`[RealtimePartialWorker] ✅ Response done: "${translatedText.substring(0, 50)}..."`);

                    // SPEED: Soften validation - warn instead of reject to avoid retries
                    const originalText = pending.originalText || '';
                    if (!translatedText || translatedText.length === 0) {
                      console.warn(`[RealtimePartialWorker] ⚠️ Empty translation, using original`);
                      if (pending.timeoutId) {
                        clearTimeout(pending.timeoutId);
                      }
                      pending.resolve(originalText); // Use original instead of rejecting
                      this.pendingResponses.delete(session.activeRequestId);
                      session.pendingItems.delete(pending.itemId);
                      session.activeRequestId = null;
                      return;
                    }

                    // CRITICAL: Validate translation is different from original (prevent English leak)
                    // CRITICAL: Validate translation is different from original (prevent English leak)
                    // SMART CHECK: Detect conversational responses like "I'm sorry but I can't assist..." or "Hello"
                    const isConversational = isHallucinatedResponse(translatedText, originalText);

                    if (isConversational) {
                      console.error(`[RealtimePartialWorker] ❌ CONVERSATIONAL RESPONSE DETECTED (not a translation): "${translatedText.substring(0, 80)}..."`);
                      console.error(`[RealtimePartialWorker] Original text was: "${originalText.substring(0, 80)}..."`);

                      // Clear timeout
                      if (pending.timeoutId) {
                        clearTimeout(pending.timeoutId);
                      }

                      // Reject with specific error so caller knows to use original
                      const error = new Error('Model returned conversational response instead of translation');
                      error.conversational = true;
                      pending.reject(error);
                      this.pendingResponses.delete(session.activeRequestId);
                      session.pendingItems.delete(pending.itemId);
                      session.activeRequestId = null;
                      return;
                    }

                    // SPEED: Soften validation - warn instead of reject to avoid retries
                    if (!translatedText || translatedText.length === 0) {
                      console.warn(`[RealtimePartialWorker] ⚠️ Empty translation, using original`);
                      if (pending.timeoutId) {
                        clearTimeout(pending.timeoutId);
                      }
                      pending.resolve(originalText); // Use original instead of rejecting
                      this.pendingResponses.delete(session.activeRequestId);
                      session.pendingItems.delete(pending.itemId);
                      session.activeRequestId = null;
                      return;
                    }

                    // Check for obvious English leak - exact match or >80% word overlap
                    const translationWords = translatedText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                    const originalWords = originalText.toLowerCase().split(/\s+/).filter(w => w.length > 2);

                    if (translationWords.length > 0 && originalWords.length > 0) {
                      const matchingWords = translationWords.filter(w => originalWords.includes(w)).length;
                      const overlapRatio = matchingWords / translationWords.length;

                      // Only reject if >80% of words match (clear English leak)
                      if (overlapRatio > 0.8 && originalText.length > 20) {
                        console.error(`[RealtimePartialWorker] ❌ English leak detected (${Math.round(overlapRatio * 100)}% word overlap): "${translatedText.substring(0, 60)}..."`);

                        // Clear timeout
                        if (pending.timeoutId) {
                          clearTimeout(pending.timeoutId);
                        }

                        // Reject with specific error so caller can retry
                        const error = new Error('Translation matches original - possible English leak');
                        error.englishLeak = true;
                        pending.reject(error);
                        this.pendingResponses.delete(session.activeRequestId);
                        session.pendingItems.delete(pending.itemId);
                        session.activeRequestId = null;
                        return;
                      }
                    }

                    // SIMPLE APPROACH: Resolve immediately when text is done
                    // This matches Chat API behavior - no need to wait for response.done
                    if (pending.timeoutId) {
                      clearTimeout(pending.timeoutId);
                    }

                    if (pending.onPartial) {
                      pending.onPartial(translatedText, true);
                    }

                    // Resolve the request - we have the complete text
                    pending.resolve(translatedText);
                    this.pendingResponses.delete(session.activeRequestId);
                    session.pendingItems.delete(pending.itemId);
                    session.activeRequestId = null;

                    // CRITICAL: Close connection immediately after each partial to prevent context accumulation
                    // This is THE FIX for the 2-line limitation - context window fills up with accumulated items
                    // By closing immediately, next partial gets a fresh connection with empty conversation
                    console.log(`[RealtimePartialWorker] 🔌 Closing connection after partial to prevent context accumulation`);
                    try {
                      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.close();
                      }
                    } catch (err) {
                      console.warn(`[RealtimePartialWorker] Error closing connection: ${err.message}`);
                    }
                    // Remove from pool immediately
                    for (const [key, sess] of this.connectionPool.entries()) {
                      if (sess === session) {
                        this.connectionPool.delete(key);
                        break;
                      }
                    }
                  }
                } else {
                  console.warn(`[RealtimePartialWorker] ⚠️ Response done but active request not found`);
                }
              } else {
                console.warn(`[RealtimePartialWorker] ⚠️ Response done but no active request ID`);
              }
              break;

            case 'response.done':
              console.log(`[RealtimePartialWorker] ✅ Response done: ${session.activeResponseId}`);

              // Clean up the response mapping (request should already be resolved by response.text.done)
              if (session.activeResponseId) {
                this.responseToRequestMap.delete(session.activeResponseId);
              }

              // CRITICAL FIX: Call onResponseDone callback if it exists (for cancel waiting)
              const responseIdBeforeClear = session.activeResponseId;
              if (responseIdBeforeClear && session.onResponseDone) {
                try {
                  session.onResponseDone(responseIdBeforeClear);
                } catch (error) {
                  console.warn(`[RealtimePartialWorker] ⚠️ Error in onResponseDone callback: ${error.message}`);
                }
              }

              session.activeResponseId = null; // Clear active response, allow new ones
              session.activeRequestId = null; // Clear active request tracking

              // CRITICAL: Close connection after response to prevent conversation context accumulation
              // This matches the 4o mini pipeline behavior (no persistent context)
              // Each new translation gets a fresh connection, preventing performance degradation
              // NOTE: Close connection ASYNCHRONOUSLY to prevent blocking the response handler
              if (!this.CONNECTION_REUSE_ENABLED) {
                // Close connection in background (don't block the response handler)
                setImmediate(() => {
                  console.log(`[RealtimePartialWorker] 🔌 Closing connection ${session.connectionKey} (no context reuse)`);
                  try {
                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                      session.ws.close();
                    }
                  } catch (err) {
                    console.warn(`[RealtimePartialWorker] Error closing connection: ${err.message}`);
                  }
                  // Remove from pool so a new connection will be created next request
                  for (const [key, sess] of this.connectionPool.entries()) {
                    if (sess === session) {
                      this.connectionPool.delete(key);
                      break;
                    }
                  }
                });
              }
              break;

            case 'error':
              console.error(`[RealtimePartialWorker] Error for ${session.connectionKey}:`, event.error);
              const errorInfo = event.error || {};
              const realtimeError = new Error(errorInfo.message || 'Realtime API error');
              if (errorInfo.code) {
                realtimeError.code = errorInfo.code;
              }
              const isActiveResponseConflict = errorInfo.code === 'conversation_already_has_active_response';

              // Find and reject pending response by item_id
              if (event.item_id) {
                const item = session.pendingItems.get(event.item_id);
                if (item && item.requestId) {
                  const pendingResponse = this.pendingResponses.get(item.requestId);
                  if (pendingResponse) {
                    pendingResponse.reject(realtimeError);
                    this.pendingResponses.delete(item.requestId);
                  }
                  session.pendingItems.delete(event.item_id);
                } else {
                  // If no requestId mapped, find by searching pending responses
                  for (const [reqId, pending] of this.pendingResponses.entries()) {
                    if (pending.itemId === event.item_id) {
                      pending.reject(realtimeError);
                      this.pendingResponses.delete(reqId);
                      break;
                    }
                  }
                  session.pendingItems.delete(event.item_id);
                }
              } else if (isActiveResponseConflict) {
                // When the server reports active response conflicts without item reference, reject everything on this session
                for (const [reqId, pending] of this.pendingResponses.entries()) {
                  if (pending.session === session) {
                    pending.reject(realtimeError);
                    this.pendingResponses.delete(reqId);
                  }
                }
              }

              if (isActiveResponseConflict) {
                this._resetSession(session, 'server reported active response in progress');
              }
              break;
          }
        } catch (error) {
          console.error(`[RealtimePartialWorker] Message parsing error:`, error);
        }
      });

      ws.on('error', (error) => {
        console.error(`[RealtimePartialWorker] WebSocket error for ${session.connectionKey}:`, error.message);
        if (!session.setupComplete) {
          reject(error);
        }
      });

      ws.on('close', () => {
        console.log(`[RealtimePartialWorker] Connection closed for ${session.connectionKey}`);
        session.setupComplete = false;
        this.connectionPool.delete(session.connectionKey);
      });

      // Timeout for connection setup
      setTimeout(() => {
        if (!session.setupComplete) {
          reject(new Error('Connection setup timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Forcefully reset a realtime session (close socket, clear state, reject pending requests).
   * Use when the server reports an unrecoverable error (e.g., active response conflicts).
   *
   * IMPORTANT: Only reject requests that belong to THIS specific session.
   * Don't use language pair matching - that rejects too many requests.
   */
  _resetSession(session, reason = 'session reset') {
    if (!session) {
      return;
    }

    console.warn(`[RealtimePartialWorker] 🔁 Resetting session ${session.connectionKey}: ${reason}`);

    try {
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.close();
      }
    } catch (error) {
      console.warn(`[RealtimePartialWorker] ⚠️ Error closing session ${session.connectionKey}: ${error.message}`);
    }

    session.setupComplete = false;
    session.activeResponseId = null;
    session.activeRequestId = null;
    session.pendingItems.clear();

    // Remove from connection pool
    for (const [key, pooledSession] of this.connectionPool.entries()) {
      if (pooledSession === session) {
        this.connectionPool.delete(key);
        break;
      }
    }

    // CRITICAL FIX: Only reject pending requests DIRECTLY tied to THIS session
    // Do NOT use language pair matching - that kills too many requests
    // Only reject requests where pending.session === session (exact match)
    const requestsToReject = [];

    for (const [requestId, pending] of this.pendingResponses.entries()) {
      // Only reject if this request is directly tied to the failing session
      if (pending.session === session) {
        requestsToReject.push({ requestId, pending });
      }
    }

    // Reject only the matched requests
    for (const { requestId, pending } of requestsToReject) {
      console.warn(`[RealtimePartialWorker] 🧹 Rejecting pending request ${requestId} due to session reset: ${reason}`);
      if (pending.reject) {
        pending.reject(new Error(`Realtime session reset: ${reason}`));
      }
      this.pendingResponses.delete(requestId);
    }

    if (requestsToReject.length > 0) {
      console.log(`[RealtimePartialWorker] 🧹 Cleaned up ${requestsToReject.length} pending requests from session reset`);
    }
  }

  /**
   * Translate partial text using Realtime API with OPTIMIZED CONCURRENCY
   * Uses per-connection pooling to handle rapid updates efficiently
   * @param {function} onPartialCallback - Called with each delta for real-time updates
   */
  async translatePartial(text, sourceLang, targetLang, apiKey, sessionId = null, onPartialCallback = null) {
    if (!text || text.length < 1) {
      throw new Error('Text too short to translate');
    }

    if (!apiKey) {
      throw new Error('No API key provided');
    }

    const sourceLangName = getLanguageName(sourceLang);
    const targetLangName = getLanguageName(targetLang);

    // Get or create connection
    const connectionKey = `${sourceLang}:${targetLang}`;
    let session;
    try {
      session = await this.getConnection(sourceLang, targetLang, apiKey);
    } catch (error) {
      console.error(`[RealtimePartialWorker] Connection error:`, error);
      throw error;
    }

    // Generate unique request ID
    const requestId = `req_${Date.now()}_${++this.requestCounter}`;

    return new Promise(async (resolve, reject) => {
      // CRITICAL: Clean up any orphaned pending requests from same connection BEFORE adding new one
      // This prevents accumulation of unmatchable requests
      const baseConnectionKey = connectionKey.split(':').slice(0, 2).join(':');
      for (const [key, value] of this.pendingResponses.entries()) {
        const pendingBaseKey = value.connectionKey.split(':').slice(0, 2).join(':');
        if (pendingBaseKey === baseConnectionKey && !value.itemId && Date.now() - (value._createdAt || 0) > 1000) {
          // This request has been pending for >1s without getting an itemId - it's orphaned
          console.log(`[RealtimePartialWorker] 🧹 Cleaning orphaned pending request before new one: ${key}`);
          value.reject(new Error('Replaced by newer request'));
          this.pendingResponses.delete(key);
        }
      }

      const pendingRecord = {
        resolve,
        reject,
        onPartial: onPartialCallback,
        itemId: null, // Will be set when item.created arrives
        session: session,
        connectionKey: connectionKey,
        originalText: text,
        _createdAt: Date.now() // Track creation time for orphan detection
      };

      // Store pending response
      this.pendingResponses.set(requestId, pendingRecord);

      try {
        // CRITICAL: Cancel active response and WAIT for response.done event
        if (session.activeResponseId) {
          const activeId = session.activeResponseId;
          console.log(`[RealtimePartialWorker] 🚫 Cancelling active response ${activeId}`);

          // Create promise that ACTUALLY waits for response.done event
          // Track when THIS response specifically completes
          const cancelPromise = new Promise((resolve) => {
            const originalResponseDone = session.onResponseDone;
            session.onResponseDone = (responderId) => {
              if (responderId === activeId) {
                console.log(`[RealtimePartialWorker] ✅ Cancelled response ${activeId} completed`);
                // Restore original handler
                session.onResponseDone = originalResponseDone;
                resolve();
              }
              // Call original handler if it exists
              if (originalResponseDone) {
                originalResponseDone(responderId);
              }
            };
          });

          // Send cancel event
          const cancelEvent = { type: 'response.cancel' };
          session.ws.send(JSON.stringify(cancelEvent));

          // Wait for response.done with longer timeout (1 second - API may take time)
          const CANCEL_TIMEOUT_MS = 1000;
          const cancelCompleted = await Promise.race([
            cancelPromise,
            new Promise(resolve => setTimeout(() => resolve(false), CANCEL_TIMEOUT_MS))
          ]);

          if (!cancelCompleted || session.activeResponseId === activeId) {
            console.warn(`[RealtimePartialWorker] ⚠️ Cancel timeout after ${CANCEL_TIMEOUT_MS}ms for ${session.connectionKey} (response ${activeId})`);
            console.warn(`[RealtimePartialWorker] ⚠️ Forcing session reset due to stuck response`);
            // Force clear the stuck response
            session.activeResponseId = null;
            session.activeRequestId = null;
            // Remove pending entry temporarily so reset doesn't reject this new request
            const pendingCopy = pendingRecord;
            this.pendingResponses.delete(requestId);
            this._resetSession(session, 'cancel timeout (partial)');
            // Acquire a fresh session
            session = await this.getConnection(sourceLang, targetLang, apiKey);
            // Update the stored pending record to use the new session
            pendingCopy.session = session;
            this.pendingResponses.set(requestId, pendingCopy);
          }
        }

        // CRITICAL FIX: Clean up orphaned items from previous requests
        // This prevents "conversation already has active response" errors
        // Keep items map small to prevent memory leaks
        // Aggressive threshold: trigger cleanup at 3 items to prevent accumulation
        // With MAX_CONCURRENT=2, items should never exceed 5-10 in normal operation
        const MAX_ITEMS = 3;
        if (session.pendingItems.size > MAX_ITEMS) {
          console.log(`[RealtimePartialWorker] 🧹 Cleaning up old items (${session.pendingItems.size} → ${MAX_ITEMS})`);
          let cleaned = 0;
          const now = Date.now();
          for (const [itemId, item] of session.pendingItems.entries()) {
            // Only delete if item is complete and old enough (use createdAt, not itemId which is a string)
            const itemAge = now - (item.createdAt || 0);
            if (item.isComplete && itemAge > 5000) {
              console.log(`[RealtimePartialWorker] Deleting old item ${itemId} (age: ${itemAge}ms)`);
              session.pendingItems.delete(itemId);
              cleaned++;
              if (session.pendingItems.size <= MAX_ITEMS) break;
            }
          }
          if (cleaned > 0) {
            console.log(`[RealtimePartialWorker] 🧹 Cleaned up ${cleaned} items`);
          }
        }

        // Create a new conversation item for this translation
        // Since we close connections after each response, we always start fresh
        const createItemEvent = {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: text
              }
            ]
          }
        };
        session.ws.send(JSON.stringify(createItemEvent));
        console.log(`[RealtimePartialWorker] ⚡ Translating partial: "${text.substring(0, 40)}..." (${sourceLangName} → ${targetLangName})`);

        // Set timeout for request - CRITICAL: Realtime API can take 10-20s for Spanish text
        // Increased from 15s to 30s to allow for slower API responses and network delays
        const PARTIAL_TIMEOUT_MS = 30000; // 30 seconds (allows for slow API + network delays)
        const timeoutId = setTimeout(() => {
          if (this.pendingResponses.has(requestId)) {
            const pending = this.pendingResponses.get(requestId);
            const item = pending.itemId ? session.pendingItems.get(pending.itemId) : null;
            const receivedSoFar = item ? item.text : '';

            console.error(`[RealtimePartialWorker] ⏱️ Translation timeout after ${PARTIAL_TIMEOUT_MS / 1000}s for request ${requestId}`);
            console.error(`[RealtimePartialWorker] ⚠️ Received so far: "${receivedSoFar.substring(0, 100)}..."`);

            // CRITICAL: Fallback - use what we've received so far if we have anything
            if (receivedSoFar && receivedSoFar.length > 0) {
              console.warn(`[RealtimePartialWorker] 📦 Using partial result (${receivedSoFar.length} chars) due to timeout`);
              if (pending.resolve) {
                pending.resolve(receivedSoFar.trim());
              }
              this.pendingResponses.delete(requestId);
              if (pending.itemId && session.pendingItems.has(pending.itemId)) {
                session.pendingItems.delete(pending.itemId);
              }
              session.activeRequestId = null;
            } else {
              // No partial received - reject with timeout error
              this.pendingResponses.delete(requestId);
              if (pending.reject) {
                pending.reject(new Error(`Translation timeout - realtime API did not respond after ${PARTIAL_TIMEOUT_MS / 1000}s`));
              }
            }
          }
        }, PARTIAL_TIMEOUT_MS);

        // Store timeout ID
        const pending = this.pendingResponses.get(requestId);
        if (pending) {
          pending.timeoutId = timeoutId;
        }
      } catch (error) {
        this.pendingResponses.delete(requestId);
        reject(error);
      }
    }).then((translatedText) => {
      // Cache with simple hash key - no fancy prefix+suffix
      const textHash = text.split('').reduce((hash, char) => {
        return ((hash << 5) - hash) + char.charCodeAt(0);
      }, 0).toString(36);
      const cacheKey = `partial:${sourceLang}:${targetLang}:${textHash}`;

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
    }).catch((error) => {
      console.error(`[RealtimePartialWorker] Translation error:`, error.message);
      throw error;
    });
  }

  /**
   * Translate to multiple languages (for partials)
   */
  async translateToMultipleLanguages(text, sourceLang, targetLangs, apiKey, sessionId = null) {
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
        const translated = await this.translatePartial(text, sourceLang, targetLang, apiKey, sessionId);
        return { lang: targetLang, text: translated };
      } catch (error) {
        console.error(`[RealtimePartialWorker] Failed to translate to ${targetLang}:`, error.message);
        return { lang: targetLang, text: null };
      }
    });

    const results = await Promise.all(translationPromises);

    // Only include successful translations (not null)
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
    console.log('[RealtimePartialWorker] Cache cleared');
  }

  /**
   * Close all connections
   */
  destroy() {
    console.log('[RealtimePartialWorker] Destroying all connections...');
    for (const [key, session] of this.connectionPool.entries()) {
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.close();
      }
    }
    this.connectionPool.clear();
    this.connectionSetupPromises.clear();
    this.pendingResponses.clear();
  }

  /**
   * Close connections for a specific language pair to reset context
   * CRITICAL: Prevents conversation items from accumulating and blocking new translations
   * MODIFIED: Only close connections with NO pending requests to avoid dropping requests
   * Call this after final translations to clear session state
   */
  closeConnectionsForLanguagePair(sourceLang, targetLang) {
    const baseKey = `${sourceLang}:${targetLang}`;
    console.log(`[RealtimePartialWorker] 🔄 Closing connections for ${baseKey} to reset context...`);

    let closedCount = 0;
    for (const [key, session] of this.connectionPool.entries()) {
      if (key.startsWith(baseKey)) {
        // CRITICAL: Only close if there are NO pending requests on this connection
        // This prevents dropping requests that are still in flight
        let hasPendingRequests = false;
        for (const [requestId, pending] of this.pendingResponses.entries()) {
          if (pending.connectionKey === key || pending.connectionKey.startsWith(baseKey)) {
            hasPendingRequests = true;
            break;
          }
        }

        if (!hasPendingRequests) {
          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.close();
            console.log(`[RealtimePartialWorker] ✅ Closed idle connection: ${key}`);
          }
          this.connectionPool.delete(key);
          closedCount++;
        } else {
          console.log(`[RealtimePartialWorker] ⏭️ Skipping close for ${key} - has pending requests`);
        }
      }
    }
    if (closedCount === 0) {
      console.log(`[RealtimePartialWorker] ℹ️ No idle connections to close for ${baseKey}`);
    }
  }
}

/**
 * Realtime Final Translation Worker - Optimized for quality
 */
export class RealtimeFinalTranslationWorker {
  constructor() {
    this.cache = new Map();
    this.MAX_CACHE_SIZE = 100;
    this.CACHE_TTL = 600000; // 10 minutes cache

    // Connection pool (shared with partial worker for efficiency)
    this.connectionPool = new Map();
    this.connectionSetupPromises = new Map();
    this.requestCounter = 0;
    this.pendingResponses = new Map();
    this.responseToRequestMap = new Map(); // Track response ID → request ID mapping for cleanup
    this.MAX_CONCURRENT = 1; // CRITICAL: Must be 1 to prevent "conversation_already_has_active_response" errors

    // CRITICAL: NO PERSISTENT CONVERSATION CONTEXT (matching 4o mini pipeline)
    // Conversation context causes performance degradation over time
    // Solution: Close connections immediately after use, don't reuse
    // This forces each translation to start with fresh context (like REST API calls)
    this.CONNECTION_REUSE_ENABLED = false; // Disable connection reuse to prevent context accumulation
  }

  /**
   * Get or create a WebSocket connection for a language pair
   * SPEED: Use connection pool (multiple connections per language pair for parallelism)
   */
  async getConnection(sourceLang, targetLang, apiKey) {
    const connectionKey = `${sourceLang}:${targetLang}`;

    // SPEED: Try to find an idle connection (no active response)
    for (const [key, session] of this.connectionPool.entries()) {
      if (key.startsWith(connectionKey) &&
        session.ws &&
        session.ws.readyState === WebSocket.OPEN &&
        session.setupComplete &&
        !session.activeResponseId) { // IDLE - no active response
        console.log(`[RealtimeFinalWorker] ♻️ Reusing idle connection: ${key}`);
        return session;
      }
    }

    // No idle connection - create a new one (up to MAX_CONCURRENT per language pair)
    const existingCount = Array.from(this.connectionPool.keys())
      .filter(k => k.startsWith(connectionKey)).length;

    if (existingCount >= this.MAX_CONCURRENT) {
      console.log(`[RealtimeFinalWorker] ⏸️ Max concurrent (${this.MAX_CONCURRENT}) reached, waiting for idle...`);
      // Reduced wait time from 50ms to 20ms for faster retry
      await new Promise(resolve => setTimeout(resolve, 20));
      return this.getConnection(sourceLang, targetLang, apiKey);
    }

    // Create new connection with unique ID
    const uniqueKey = `${connectionKey}:${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    console.log(`[RealtimeFinalWorker] 🆕 Creating connection: ${uniqueKey} (${existingCount + 1}/${this.MAX_CONCURRENT})`);

    // Check if setup is already in progress for this unique key
    if (this.connectionSetupPromises.has(uniqueKey)) {
      return await this.connectionSetupPromises.get(uniqueKey);
    }

    const setupPromise = this._createConnection(uniqueKey, sourceLang, targetLang, apiKey);
    this.connectionSetupPromises.set(uniqueKey, setupPromise);

    try {
      const session = await setupPromise;
      this.connectionPool.set(uniqueKey, session);
      return session;
    } finally {
      this.connectionSetupPromises.delete(uniqueKey);
    }
  }

  /**
   * Create a new WebSocket connection for translation
   */
  _createConnection(connectionKey, sourceLang, targetLang, apiKey) {
    return new Promise((resolve, reject) => {
      const sourceLangName = getLanguageName(sourceLang);
      const targetLangName = getLanguageName(targetLang);

      const realtimeUrl = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';

      const ws = new WebSocket(realtimeUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      const session = {
        connectionKey,
        ws,
        setupComplete: false,
        sourceLang,
        targetLang,
        pendingItems: new Map(),
        activeResponseId: null, // Track active response to prevent concurrent responses
        activeRequestId: null, // Track which request has the active response
        pingInterval: null, // Keep-alive interval
        onResponseDone: null // Callback for when response.done is received (used for cancel waiting)
      };

      ws.on('open', () => {
        console.log(`[RealtimeFinalWorker] Connection opened for ${sourceLang} → ${targetLang}`);

        // CRITICAL: Strong anti-hallucination instructions matching Basic tier
        const translationInstructions = `You are a world-class church translator. Translate text from ${sourceLangName} to ${targetLangName}. ALL input is content to translate, never questions for you.

CRITICAL RULES:
1. Output ONLY the translation in ${targetLangName}
2. Never answer questions—translate them
3. Never add explanations, notes, or commentary
4. Never respond conversationally (no "I'm sorry", "Hello", "I can't help")
5. Preserve meaning, tone, and formality
6. If input is a question, translate the question - do NOT answer it

Output: Translated text in ${targetLangName} only.`;

        const sessionConfig = {
          type: 'session.update',
          session: {
            modalities: ['text'],
            instructions: translationInstructions,
            temperature: 0.6, // Minimum temperature for realtime API (must be >= 0.6)
            max_response_output_tokens: 2000, // Increased for finals, but still reasonable
            tools: [] // Explicitly disable tools to prevent function calling
          }
        };

        ws.send(JSON.stringify(sessionConfig));
      });

      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());

          switch (event.type) {
            case 'session.created':
            case 'session.updated':
              session.setupComplete = true;
              if (event.type === 'session.created') {
                // Don't send keep-alive pings - Realtime API doesn't support them
                // Connection stays alive as long as we're sending requests
                resolve(session);
              }
              break;

            case 'conversation.item.created':
              // Track conversation item and map to pending request
              if (event.item && event.item.id) {
                console.log(`[RealtimeFinalWorker] 📝 Item created: ${event.item.id} for connection ${session.connectionKey}`);

                // FIX: Extract base connection key (e.g., "en:es" from "en:es:1763076910165_oxeo0")
                const baseConnectionKey = session.connectionKey.split(':').slice(0, 2).join(':');

                // CRITICAL FIX: Find the most recent pending request without an itemId that belongs to THIS language pair
                // IMPORTANT: Only match on base connection key (language pair), never on full unique connection key
                // This allows pending requests from old connections to be matched to new connections
                // Previous bug: strict connection key matching prevented cross-connection matching
                let matchedRequestId = null;
                for (const [reqId, pending] of this.pendingResponses.entries()) {
                  // CRITICAL: Match ONLY by base connection key (language pair), ignore unique connection suffixes
                  const pendingBaseKey = pending.connectionKey.split(':').slice(0, 2).join(':');
                  if (pendingBaseKey === baseConnectionKey && !pending.itemId && !session.pendingItems.has(event.item.id)) {
                    matchedRequestId = reqId;
                    pending.itemId = event.item.id;
                    pending.session = session; // Update to actual session handling this request
                    console.log(`[RealtimeFinalWorker] 🔗 Matched request ${reqId} to item ${event.item.id} (connection: ${session.connectionKey})`);
                    break;
                  }
                }

                if (!matchedRequestId) {
                  // CRITICAL: Log with full details for debugging
                  const pendingByLang = Array.from(this.pendingResponses.entries())
                    .filter(([_, p]) => p.connectionKey.split(':').slice(0, 2).join(':') === baseConnectionKey)
                    .map(([id, p]) => `${id}(itemId: ${p.itemId || 'none'})`)
                    .join(', ');
                  console.warn(`[RealtimeFinalWorker] ⚠️ No pending request found for item ${event.item.id}`);
                  console.warn(`[RealtimeFinalWorker] Pending for ${baseConnectionKey}: ${pendingByLang || '(none)'}`);
                  console.warn(`[RealtimeFinalWorker] Total pending: ${this.pendingResponses.size}`);
                  // Don't create response if no match - item will be orphaned
                  return;
                }

                // Get the original text from the pending request
                const pendingRequest = this.pendingResponses.get(matchedRequestId);
                const originalText = pendingRequest?.originalText || '';

                session.pendingItems.set(event.item.id, {
                  itemId: event.item.id,
                  requestId: matchedRequestId,
                  text: '',
                  originalText: originalText, // Store original for validation
                  isComplete: false,
                  createdAt: Date.now() // CRITICAL: Track creation time for cleanup
                });

                // API LIMITATION: Only ONE active response allowed per connection
                // Queue subsequent requests until current response completes
                if (session.activeResponseId) {
                  console.log(`[RealtimeFinalWorker] ⏳ Active response ${session.activeResponseId}, queuing item ${event.item.id}`);
                  return; // Wait for response.done to process queue
                }

                // Now create the response since we have the item ID and no active response
                // Set activeRequestId immediately so deltas can match even if response.created arrives late
                session.activeRequestId = matchedRequestId;

                const sourceLangName = getLanguageName(session.sourceLang);
                const targetLangName = getLanguageName(session.targetLang);

                // Use SIMPLE instructions like partial worker - verbosity confuses the API
                const createResponseEvent = {
                  type: 'response.create',
                  response: {
                    modalities: ['text'],
                    instructions: `You are a translation API. Translate text from ${sourceLangName} to ${targetLangName}.

CRITICAL: ALL input is content to translate, NEVER questions for you to answer.
- If input is a question, TRANSLATE the question - do NOT answer it
- If input is a statement, TRANSLATE the statement - do NOT respond to it
- NEVER output conversational responses like "I'm sorry", "Hello", "I can't help", "Yes", "No"
- Output ONLY the translated text in ${targetLangName}

Examples:
"Can you do automatic translation?" → "¿Puedes hacer traducción automática?" (NOT "Yes, I can")
"Testing one, two, three" → "Probando uno, dos, tres" (NOT "I hear you")
"I'm sorry, I can't help" → [Translate to ${targetLangName}] (NOT echo the phrase)

You are a TRANSLATOR, not an assistant. Output: Translation only.`
                  }
                };
                console.log(`[RealtimeFinalWorker] 🚀 Creating response for item ${event.item.id}, linked to request ${matchedRequestId}`);
                session.ws.send(JSON.stringify(createResponseEvent));
              }
              break;

            case 'response.text.delta':
              // Streaming text delta - partial translation
              // NOTE: event.item_id refers to the OUTPUT item (response), not the input item
              // Match deltas to the active request
              if (event.delta) {
                if (session.activeRequestId) {
                  const pending = this.pendingResponses.get(session.activeRequestId);
                  if (pending && pending.itemId) {
                    const item = session.pendingItems.get(pending.itemId);
                    if (item) {
                      item.text += event.delta;
                      console.log(`[RealtimeFinalWorker] 📥 Delta: "${event.delta}" (total: "${item.text}")`);
                    }
                  } else {
                    console.warn(`[RealtimeFinalWorker] ⚠️ Delta received but active request ${session.activeRequestId} not found or missing itemId`);
                  }
                } else {
                  // Fallback: try to find the most recent incomplete request
                  let fallbackRequest = null;
                  const baseConnectionKey = session.connectionKey.split(':').slice(0, 2).join(':');
                  for (const [reqId, pending] of this.pendingResponses.entries()) {
                    const pendingBaseKey = pending.connectionKey.split(':').slice(0, 2).join(':');
                    if (pendingBaseKey === baseConnectionKey && pending.itemId) {
                      const item = session.pendingItems.get(pending.itemId);
                      if (item && !item.isComplete) {
                        fallbackRequest = { reqId, pending, item };
                        break;
                      }
                    }
                  }
                  if (fallbackRequest) {
                    fallbackRequest.item.text += event.delta;
                    console.log(`[RealtimeFinalWorker] 📥 Delta (fallback): "${event.delta}" (total: "${fallbackRequest.item.text}")`);
                    // Set activeRequestId for future deltas
                    session.activeRequestId = fallbackRequest.reqId;
                  } else {
                    console.warn(`[RealtimeFinalWorker] ⚠️ Delta received but no active request found and no fallback available`);
                  }
                }
              }
              break;

            case 'response.created':
              const finalResponseId = event.response?.id;
              console.log(`[RealtimeFinalWorker] ✅ Response created: ${finalResponseId || 'unknown'}`);
              if (finalResponseId) {
                session.activeResponseId = finalResponseId;
                // Find the most recent request without a completed response
                // If activeRequestId is already set, that means we're handling a concurrent response
                // In that case, find the NEXT incomplete request
                if (!session.activeRequestId) {
                  const baseConnectionKey = session.connectionKey.split(':').slice(0, 2).join(':');
                  for (const [reqId, pending] of this.pendingResponses.entries()) {
                    const pendingBaseKey = pending.connectionKey.split(':').slice(0, 2).join(':');
                    if (pendingBaseKey === baseConnectionKey && pending.itemId) {
                      const item = session.pendingItems.get(pending.itemId);
                      if (item && !item.isComplete) {
                        session.activeRequestId = reqId;
                        // CRITICAL: Track response → request mapping for cleanup
                        this.responseToRequestMap.set(finalResponseId, reqId);
                        console.log(`[RealtimeFinalWorker] 🔗 Active response ${finalResponseId} linked to request ${reqId}`);
                        break;
                      }
                    }
                  }
                } else {
                  console.log(`[RealtimeFinalWorker] ⚠️ Response created but activeRequestId already set to ${session.activeRequestId}`);
                  // Still track the response even if activeRequestId is set (for concurrent responses)
                  if (session.activeRequestId) {
                    this.responseToRequestMap.set(finalResponseId, session.activeRequestId);
                  }
                }
              }
              break;

            case 'response.done':
              console.log(`[RealtimeFinalWorker] ✅ Response done: ${session.activeResponseId}`);

              // Clean up the response mapping (request should already be resolved by response.text.done)
              if (session.activeResponseId) {
                this.responseToRequestMap.delete(session.activeResponseId);
              }

              // CRITICAL FIX: Call onResponseDone callback if it exists (for cancel waiting)
              const finalResponseIdBeforeClear = session.activeResponseId;
              if (finalResponseIdBeforeClear && session.onResponseDone) {
                try {
                  session.onResponseDone(finalResponseIdBeforeClear);
                } catch (error) {
                  console.warn(`[RealtimeFinalWorker] ⚠️ Error in onResponseDone callback: ${error.message}`);
                }
              }

              session.activeResponseId = null; // Clear active response, allow new ones
              session.activeRequestId = null; // Clear active request tracking

              // CRITICAL: Close connection after response to prevent conversation context accumulation
              // This matches the 4o mini pipeline behavior (no persistent context)
              // Each new translation gets a fresh connection, preventing performance degradation
              // NOTE: Close connection ASYNCHRONOUSLY to prevent blocking the response handler
              if (!this.CONNECTION_REUSE_ENABLED) {
                // Close connection in background (don't block the response handler)
                setImmediate(() => {
                  console.log(`[RealtimeFinalWorker] 🔌 Closing connection ${session.connectionKey} (no context reuse)`);
                  try {
                    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                      session.ws.close();
                    }
                  } catch (err) {
                    console.warn(`[RealtimeFinalWorker] Error closing connection: ${err.message}`);
                  }
                  // Remove from pool so a new connection will be created next request
                  for (const [key, sess] of this.connectionPool.entries()) {
                    if (sess === session) {
                      this.connectionPool.delete(key);
                      break;
                    }
                  }
                });
              }
              break;

            case 'response.text.done':
              // Text response complete
              // NOTE: event.item_id refers to the OUTPUT item (response), not the input item
              // Use the active request ID to find the correct request
              if (session.activeRequestId) {
                const pending = this.pendingResponses.get(session.activeRequestId);
                if (pending && pending.itemId) {
                  const item = session.pendingItems.get(pending.itemId);
                  if (item) {
                    item.isComplete = true;
                    const translatedText = item.text.trim();
                    console.log(`[RealtimeFinalWorker] ✅ Response done: "${translatedText.substring(0, 50)}..."`);

                    // SPEED: Soften validation - warn instead of reject to avoid retries
                    const originalText = pending.originalText || '';

                    // CRITICAL: Check for hallucinations immediately
                    if (isHallucinatedResponse(translatedText, originalText)) {
                      console.error(`[RealtimeFinalWorker] ❌ CONVERSATIONAL RESPONSE DETECTED (hallucination): "${translatedText.substring(0, 80)}..."`);
                      console.error(`[RealtimeFinalWorker] Original text was: "${originalText.substring(0, 80)}..."`);

                      if (pending.timeoutId) {
                        clearTimeout(pending.timeoutId);
                      }

                      // Reject with specific error
                      const error = new Error('Model returned conversational response instead of translation');
                      error.conversational = true;
                      pending.reject(error);

                      this.pendingResponses.delete(session.activeRequestId);
                      session.pendingItems.delete(pending.itemId);
                      session.activeRequestId = null;
                      return;
                    }

                    if (!translatedText || translatedText.length === 0) {
                      console.warn(`[RealtimeFinalWorker] ⚠️ Empty translation, using original`);
                      if (pending.timeoutId) {
                        clearTimeout(pending.timeoutId);
                      }
                      pending.resolve(originalText); // Use original instead of rejecting
                      this.pendingResponses.delete(session.activeRequestId);
                      session.pendingItems.delete(pending.itemId);
                      session.activeRequestId = null;
                      return;
                    }

                    // CRITICAL: Validate translation is different from original (prevent English leak)
                    // More lenient check - allow if only case differs or has minor punctuation
                    const normalizedTranslation = translatedText.toLowerCase().replace(/[.,!?;:]/g, '').trim();
                    const normalizedOriginal = originalText.toLowerCase().replace(/[.,!?;:]/g, '').trim();
                    const isSameAsOriginal = normalizedTranslation === normalizedOriginal;

                    if (isSameAsOriginal && originalText.length > 0) {
                      console.error(`[RealtimeFinalWorker] ❌ Translation matches original (English leak): "${translatedText.substring(0, 60)}..."`);
                      console.error(`[RealtimeFinalWorker] Rejecting and using original as fallback`);

                      // Clear timeout
                      if (pending.timeoutId) {
                        clearTimeout(pending.timeoutId);
                      }

                      // For finals, we can't retry easily, so use original text as fallback
                      pending.resolve(originalText);
                      this.pendingResponses.delete(session.activeRequestId);
                      session.pendingItems.delete(pending.itemId);
                      session.activeRequestId = null;
                      return;
                    }

                    // Clear timeout
                    if (pending.timeoutId) {
                      clearTimeout(pending.timeoutId);
                    }

                    // SIMPLE APPROACH: Resolve immediately when text is done
                    // This matches Chat API behavior - no need to wait for response.done
                    if (pending.onPartial) {
                      // Finals don't have streaming callbacks, but keep this for consistency
                    }

                    // Resolve the request - we have the complete text
                    pending.resolve(translatedText);
                    this.pendingResponses.delete(session.activeRequestId);
                    session.pendingItems.delete(pending.itemId);
                    session.activeRequestId = null;

                    // CRITICAL: Close connection immediately after final to prevent context accumulation
                    // This ensures next translation gets a fresh connection with empty conversation
                    console.log(`[RealtimeFinalWorker] 🔌 Closing connection after final to prevent context accumulation`);
                    try {
                      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                        session.ws.close();
                      }
                    } catch (err) {
                      console.warn(`[RealtimeFinalWorker] Error closing connection: ${err.message}`);
                    }
                    // Remove from pool immediately
                    for (const [key, sess] of this.connectionPool.entries()) {
                      if (sess === session) {
                        this.connectionPool.delete(key);
                        break;
                      }
                    }
                  }
                } else {
                  console.warn(`[RealtimeFinalWorker] ⚠️ Response done but active request not found`);
                }
              } else {
                console.warn(`[RealtimeFinalWorker] ⚠️ Response done but no active request ID`);
              }
              break;

            case 'error':
              console.error(`[RealtimeFinalWorker] Error for ${session.connectionKey}:`, event.error);
              if (event.item_id) {
                const item = session.pendingItems.get(event.item_id);
                if (item && item.requestId) {
                  const pendingResponse = this.pendingResponses.get(item.requestId);
                  if (pendingResponse) {
                    pendingResponse.reject(new Error(event.error.message || 'Realtime API error'));
                    this.pendingResponses.delete(item.requestId);
                  }
                  session.pendingItems.delete(event.item_id);
                } else {
                  // If no requestId mapped, find by searching pending responses
                  for (const [reqId, pending] of this.pendingResponses.entries()) {
                    if (pending.itemId === event.item_id) {
                      pending.reject(new Error(event.error.message || 'Realtime API error'));
                      this.pendingResponses.delete(reqId);
                      break;
                    }
                  }
                  session.pendingItems.delete(event.item_id);
                }
              }
              break;
          }
        } catch (error) {
          console.error(`[RealtimeFinalWorker] Message parsing error:`, error);
        }
      });

      ws.on('error', (error) => {
        console.error(`[RealtimeFinalWorker] WebSocket error for ${session.connectionKey}:`, error.message);
        if (!session.setupComplete) {
          reject(error);
        }
      });

      ws.on('close', () => {
        console.log(`[RealtimeFinalWorker] Connection closed for ${session.connectionKey}`);
        session.setupComplete = false;
        this.connectionPool.delete(session.connectionKey);
      });

      setTimeout(() => {
        if (!session.setupComplete) {
          reject(new Error('Connection setup timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Translate final text using Realtime API
   */
  async translateFinal(text, sourceLang, targetLang, apiKey, sessionId = null) {
    if (!text || text.trim().length === 0) {
      return text;
    }

    if (!apiKey) {
      throw new Error('No API key provided');
    }

    const sourceLangName = getLanguageName(sourceLang);
    const targetLangName = getLanguageName(targetLang);

    console.log(`[RealtimeFinalWorker] 🎯 Translating final: "${text.substring(0, 50)}..." (${sourceLangName} → ${targetLangName})`);

    // Simple cache key with hash
    const textHash = text.split('').reduce((hash, char) => {
      return ((hash << 5) - hash) + char.charCodeAt(0);
    }, 0).toString(36);
    const cacheKey = `final:${sourceLang}:${targetLang}:${textHash}`;

    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.CACHE_TTL) {
        console.log(`[RealtimeFinalWorker] ✅ Cache hit`);
        return cached.text;
      }
    }

    // RETRY LOGIC
    const MAX_RETRIES = 2;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[RealtimeFinalWorker] 🔄 Retry attempt ${attempt}/${MAX_RETRIES} for: "${text.substring(0, 30)}..."`);
        }

        // Get or create connection
        const connectionKey = `${sourceLang}:${targetLang}`;
        let session;
        try {
          session = await this.getConnection(sourceLang, targetLang, apiKey);
        } catch (error) {
          console.error(`[RealtimeFinalWorker] Connection error:`, error);
          throw error;
        }

        const requestId = `req_${Date.now()}_${++this.requestCounter}`;

        const translatedText = await new Promise((resolve, reject) => {
          // CRITICAL FIX: Clean up orphaned items from previous requests
          // This prevents "conversation already has active response" errors
          // Aggressive threshold: trigger cleanup at 3 items to prevent accumulation
          // With MAX_CONCURRENT=1, items should never exceed 5-10 in normal operation
          const MAX_ITEMS = 3;
          if (session.pendingItems.size > MAX_ITEMS) {
            console.log(`[RealtimeFinalWorker] 🧹 Cleaning up old items (${session.pendingItems.size} → ${MAX_ITEMS})`);
            let cleaned = 0;
            const now = Date.now();
            for (const [itemId, item] of session.pendingItems.entries()) {
              // Only delete if item is complete and old enough
              const itemAge = now - (item.createdAt || 0);
              if (item.isComplete && itemAge > 5000) {
                console.log(`[RealtimeFinalWorker] Deleting old item ${itemId} (age: ${itemAge}ms)`);
                session.pendingItems.delete(itemId);
                cleaned++;
                if (session.pendingItems.size <= MAX_ITEMS) break;
              }
            }
            if (cleaned > 0) {
              console.log(`[RealtimeFinalWorker] 🧹 Cleaned up ${cleaned} items`);
            }
          }

          // CRITICAL: Clean up any orphaned pending requests from same connection BEFORE adding new one
          // This prevents accumulation of unmatchable requests
          const baseConnectionKey = connectionKey.split(':').slice(0, 2).join(':');
          for (const [key, value] of this.pendingResponses.entries()) {
            const pendingBaseKey = value.connectionKey.split(':').slice(0, 2).join(':');
            if (pendingBaseKey === baseConnectionKey && !value.itemId && Date.now() - (value._createdAt || 0) > 1000) {
              // This request has been pending for >1s without getting an itemId - it's orphaned
              console.log(`[RealtimeFinalWorker] 🧹 Cleaning orphaned pending request before new one: ${key}`);
              value.reject(new Error('Replaced by newer request'));
              this.pendingResponses.delete(key);
            }
          }

          // Store pending response (itemId will be set when item.created arrives)
          this.pendingResponses.set(requestId, {
            resolve,
            reject,
            itemId: null, // Will be set when item.created event arrives
            session: session, // Track which session this request belongs to
            connectionKey: connectionKey, // Track connection for debugging
            originalText: text, // Store original for validation
            _createdAt: Date.now() // Track creation time for orphan detection
          });

          const createItemEvent = {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: text
                }
              ]
            }
          };

          try {
            // Send item creation event (response will be created when item.created arrives)
            console.log(`[RealtimeFinalWorker] 📤 Sending item.create for request ${requestId}`);
            session.ws.send(JSON.stringify(createItemEvent));
            console.log(`[RealtimeFinalWorker] ✅ Item.create sent, waiting for item.created...`);

            const timeoutId = setTimeout(() => {
              if (this.pendingResponses.has(requestId)) {
                const pending = this.pendingResponses.get(requestId);
                console.error(`[RealtimeFinalWorker] ⏱️ Translation timeout after 30s for request ${requestId}`);
                console.error(`[RealtimeFinalWorker] ItemId: ${pending?.itemId || 'not set'}, Connection: ${session.ws?.readyState === WebSocket.OPEN ? 'OPEN' : 'CLOSED'}`);
                this.pendingResponses.delete(requestId);
                if (pending && pending.reject) {
                  pending.reject(new Error('Translation timeout - realtime API did not respond'));
                }
              }
            }, 30000); // 30 second timeout for finals (increased from 20s)

            // Store timeout ID
            const pending = this.pendingResponses.get(requestId);
            if (pending) {
              pending.timeoutId = timeoutId;
            }
          } catch (error) {
            this.pendingResponses.delete(requestId);
            reject(error);
          }
        });

        // Cache the result
        this.cache.set(cacheKey, {
          text: translatedText,
          timestamp: Date.now()
        });

        if (this.cache.size > this.MAX_CACHE_SIZE) {
          const firstKey = this.cache.keys().next().value;
          this.cache.delete(firstKey);
        }

        return translatedText;

      } catch (error) {
        lastError = error;
        console.error(`[RealtimeFinalWorker] Translation error (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`, error.message);

        // Check if we should retry (hallucination or english leak)
        if (error.conversational || error.englishLeak) {
          console.warn(`[RealtimeFinalWorker] ⚠️ Retryable error detected. resetting context...`);

          // Close connections for this language pair to reset context
          this.closeConnectionsForLanguagePair(sourceLang, targetLang);

          // Wait before retry
          if (attempt < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 300));
            continue;
          }
        }

        // If not retryable or max retries reached, throw
        throw error;
      }
    }

    throw lastError || new Error('Translation failed');
  }

  /**
   * Translate to multiple languages (for finals)
   */
  async translateToMultipleLanguages(text, sourceLang, targetLangs, apiKey, sessionId = null) {
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
        const translated = await this.translateFinal(text, sourceLang, targetLang, apiKey, sessionId);
        return { lang: targetLang, text: translated };
      } catch (error) {
        console.error(`[RealtimeFinalWorker] Failed to translate to ${targetLang}:`, error.message);
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
    console.log('[RealtimeFinalWorker] Cache cleared');
  }

  /**
   * Close all connections
   */
  destroy() {
    console.log('[RealtimeFinalWorker] Destroying all connections...');
    for (const [key, session] of this.connectionPool.entries()) {
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.close();
      }
    }
    this.connectionPool.clear();
    this.connectionSetupPromises.clear();
    this.pendingResponses.clear();
  }

  /**
   * Close connections for a specific language pair to reset context
   * CRITICAL: Prevents conversation items from accumulating and blocking new translations
   * MODIFIED: Only close connections with NO pending requests to avoid dropping requests
   * Call this after final translations to clear session state
   */
  closeConnectionsForLanguagePair(sourceLang, targetLang) {
    const baseKey = `${sourceLang}:${targetLang}`;
    console.log(`[RealtimeFinalWorker] 🔄 Closing connections for ${baseKey} to reset context...`);

    let closedCount = 0;
    for (const [key, session] of this.connectionPool.entries()) {
      if (key.startsWith(baseKey)) {
        // CRITICAL: Only close if there are NO pending requests on this connection
        // This prevents dropping requests that are still in flight
        let hasPendingRequests = false;
        for (const [requestId, pending] of this.pendingResponses.entries()) {
          if (pending.connectionKey === key || pending.connectionKey.startsWith(baseKey)) {
            hasPendingRequests = true;
            break;
          }
        }

        if (!hasPendingRequests) {
          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.close();
            console.log(`[RealtimeFinalWorker] ✅ Closed idle connection: ${key}`);
          }
          this.connectionPool.delete(key);
          closedCount++;
        } else {
          console.log(`[RealtimeFinalWorker] ⏭️ Skipping close for ${key} - has pending requests`);
        }
      }
    }
    if (closedCount === 0) {
      console.log(`[RealtimeFinalWorker] ℹ️ No idle connections to close for ${baseKey}`);
    }
  }
}

// Export singleton instances
export const realtimePartialTranslationWorker = new RealtimePartialTranslationWorker();
export const realtimeFinalTranslationWorker = new RealtimeFinalTranslationWorker();

