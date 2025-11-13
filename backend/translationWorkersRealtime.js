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
 * Realtime Partial Translation Worker - Optimized for speed and low latency
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
    
    // Concurrency limits
    this.MAX_CONCURRENT = 5;
  }

  /**
   * Get or create a WebSocket connection for a language pair
   */
  async getConnection(sourceLang, targetLang, apiKey) {
    const connectionKey = `${sourceLang}:${targetLang}`;
    
    // Return existing connection if available and ready
    if (this.connectionPool.has(connectionKey)) {
      const session = this.connectionPool.get(connectionKey);
      if (session.ws && session.ws.readyState === WebSocket.OPEN && session.setupComplete) {
        return session;
      } else {
        // Connection is dead, remove it
        this.connectionPool.delete(connectionKey);
      }
    }
    
    // Check if setup is already in progress
    if (this.connectionSetupPromises.has(connectionKey)) {
      return await this.connectionSetupPromises.get(connectionKey);
    }
    
    // Create new connection
    const setupPromise = this._createConnection(connectionKey, sourceLang, targetLang, apiKey);
    this.connectionSetupPromises.set(connectionKey, setupPromise);
    
    try {
      const session = await setupPromise;
      this.connectionPool.set(connectionKey, session);
      return session;
    } finally {
      this.connectionSetupPromises.delete(connectionKey);
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
        activeRequestId: null // Track which request has the active response
      };
      
      ws.on('open', () => {
        console.log(`[RealtimePartialWorker] Connection opened for ${sourceLang} → ${targetLang}`);
        
        // Configure session for text-to-text translation
        const translationInstructions = `You are a fast real-time translator. Translate text from ${sourceLangName} to ${targetLangName}.

RULES FOR PARTIAL/INCOMPLETE TEXT:
1. Translate the partial text naturally even if sentence is incomplete
2. Maintain the same tense and context as the partial
3. Do NOT complete or extend the sentence - only translate what's given
4. Keep translation concise and natural in ${targetLangName}
5. No explanations, only the translation`;

        const sessionConfig = {
          type: 'session.update',
          session: {
            modalities: ['text'], // Text-only, no audio
            instructions: translationInstructions,
            temperature: 0.6, // Minimum temperature for realtime API (must be >= 0.6)
            max_response_output_tokens: 16000
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
                resolve(session);
              }
              break;
              
            case 'conversation.item.created':
              // Track conversation item and map to pending request
              if (event.item && event.item.id) {
                console.log(`[RealtimePartialWorker] 📝 Item created: ${event.item.id} for connection ${session.connectionKey}`);
                
                // Find the most recent pending request without an itemId that belongs to THIS session
                // Use connectionKey for comparison since session objects might be different instances
                let matchedRequestId = null;
                for (const [reqId, pending] of this.pendingResponses.entries()) {
                  // Match only if: belongs to this session (by connectionKey), doesn't have itemId yet, and item not already tracked
                  if (pending.connectionKey === session.connectionKey && !pending.itemId && !session.pendingItems.has(event.item.id)) {
                    matchedRequestId = reqId;
                    pending.itemId = event.item.id;
                    console.log(`[RealtimePartialWorker] 🔗 Matched request ${reqId} to item ${event.item.id} (connection: ${pending.connectionKey})`);
                    break;
                  }
                }
                
                if (!matchedRequestId) {
                  console.warn(`[RealtimePartialWorker] ⚠️ No pending request found for item ${event.item.id}`);
                  console.warn(`[RealtimePartialWorker] Available pending requests: ${Array.from(this.pendingResponses.keys()).join(', ')}`);
                  console.warn(`[RealtimePartialWorker] Pending requests for this connection: ${Array.from(this.pendingResponses.entries()).filter(([_, p]) => p.connectionKey === session.connectionKey).map(([id, _]) => id).join(', ')}`);
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
                  isComplete: false
                });
                
                // Check if there's already an active response - wait for it to finish
                if (session.activeResponseId) {
                  console.warn(`[RealtimePartialWorker] ⚠️ Active response ${session.activeResponseId} in progress, queuing item ${event.item.id}`);
                  // Store the item and create response after current one finishes
                  // For now, we'll wait - the response.done handler will clear activeResponseId
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
                    instructions: `Translate text from ${sourceLangName} to ${targetLangName}. Translate the partial text naturally even if sentence is incomplete. Maintain the same tense and context. Do NOT complete or extend the sentence - only translate what's given. Keep translation concise and natural in ${targetLangName}. No explanations, only the translation.`
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
                        console.log(`[RealtimePartialWorker] 🔗 Active response ${partialResponseId} linked to request ${reqId}`);
                        break;
                      }
                    }
                  }
                } else {
                  console.log(`[RealtimePartialWorker] ⚠️ Response created but activeRequestId already set to ${session.activeRequestId}`);
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
                    
                    // CRITICAL: Validate that translation is actually different from original
                    const originalText = pending.originalText || '';
                    if (!translatedText || translatedText.length === 0) {
                      console.error(`[RealtimePartialWorker] ❌ Translation is empty`);
                      if (pending.timeoutId) {
                        clearTimeout(pending.timeoutId);
                      }
                      pending.reject(new Error('Translation API returned empty result'));
                      this.pendingResponses.delete(session.activeRequestId);
                      session.pendingItems.delete(pending.itemId);
                      session.activeRequestId = null;
                      return;
                    }
                    
                    // Check if translation matches original (likely API returned original instead of translating)
                    const isSameAsOriginal = translatedText === originalText || 
                                           translatedText.trim() === originalText.trim() ||
                                           translatedText.toLowerCase() === originalText.toLowerCase();
                    
                    if (isSameAsOriginal && originalText.length > 0) {
                      console.error(`[RealtimePartialWorker] ❌ Translation matches original (likely API error): "${translatedText.substring(0, 60)}..."`);
                      if (pending.timeoutId) {
                        clearTimeout(pending.timeoutId);
                      }
                      pending.reject(new Error('Translation returned same as original - API likely returned original text instead of translating'));
                      this.pendingResponses.delete(session.activeRequestId);
                      session.pendingItems.delete(pending.itemId);
                      session.activeRequestId = null;
                      return;
                    }
                    
                    // Clear timeout
                    if (pending.timeoutId) {
                      clearTimeout(pending.timeoutId);
                    }
                    
                    if (pending.onPartial) {
                      pending.onPartial(translatedText, true);
                    }
                    pending.resolve(translatedText);
                    this.pendingResponses.delete(session.activeRequestId);
                    session.pendingItems.delete(pending.itemId);
                    session.activeRequestId = null;
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
              session.activeResponseId = null; // Clear active response, allow new ones
              session.activeRequestId = null; // Clear active request tracking
              break;
              
            case 'error':
              console.error(`[RealtimePartialWorker] Error for ${session.connectionKey}:`, event.error);
              // Find and reject pending response by item_id
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
   * Translate partial text using Realtime API
   */
  async translatePartial(text, sourceLang, targetLang, apiKey, sessionId = null) {
    if (!text || text.length < 1) {
      throw new Error('Text too short to translate');
    }

    if (!apiKey) {
      throw new Error('No API key provided');
    }

    // Check cache
    const cacheKey = `partial:${sourceLang}:${targetLang}:${text.substring(0, 150)}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.CACHE_TTL) {
        console.log(`[RealtimePartialWorker] ✅ Cache hit`);
        return cached.text;
      }
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

      // Create promise for this request
    return new Promise((resolve, reject) => {
      // Store pending response (itemId will be set when item.created arrives)
      this.pendingResponses.set(requestId, {
        resolve,
        reject,
        onPartial: null,
        itemId: null, // Will be set when item.created event arrives
        session: session, // Track which session this request belongs to
        connectionKey: connectionKey, // Track connection for debugging
        originalText: text // Store original text for validation
      });

      // Create conversation item with text input (no request_id - not supported by API)
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
        // Send item creation event
        console.log(`[RealtimePartialWorker] 📤 Sending item.create for request ${requestId}`);
        session.ws.send(JSON.stringify(createItemEvent));
        console.log(`[RealtimePartialWorker] ✅ Item.create sent, waiting for item.created...`);

        console.log(`[RealtimePartialWorker] ⚡ Translating partial: "${text.substring(0, 40)}..." (${sourceLangName} → ${targetLangName})`);

        // Set timeout for request (15 seconds - realtime should be fast but allow buffer for connection setup)
        const timeoutId = setTimeout(() => {
          if (this.pendingResponses.has(requestId)) {
            const pending = this.pendingResponses.get(requestId);
            console.error(`[RealtimePartialWorker] ⏱️ Translation timeout after 15s for request ${requestId}`);
            console.error(`[RealtimePartialWorker] ItemId: ${pending?.itemId || 'not set'}, Connection: ${session.ws?.readyState === WebSocket.OPEN ? 'OPEN' : 'CLOSED'}`);
            this.pendingResponses.delete(requestId);
            reject(new Error('Translation timeout - realtime API did not respond'));
          }
        }, 15000);
        
        // Store timeout ID so we can clear it if response arrives
        const pending = this.pendingResponses.get(requestId);
        if (pending) {
          pending.timeoutId = timeoutId;
        }
      } catch (error) {
        this.pendingResponses.delete(requestId);
        reject(error);
      }
    }).then((translatedText) => {
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
  }

  /**
   * Get or create a WebSocket connection for a language pair
   */
  async getConnection(sourceLang, targetLang, apiKey) {
    const connectionKey = `${sourceLang}:${targetLang}`;
    
    if (this.connectionPool.has(connectionKey)) {
      const session = this.connectionPool.get(connectionKey);
      if (session.ws && session.ws.readyState === WebSocket.OPEN && session.setupComplete) {
        return session;
      } else {
        this.connectionPool.delete(connectionKey);
      }
    }
    
    if (this.connectionSetupPromises.has(connectionKey)) {
      return await this.connectionSetupPromises.get(connectionKey);
    }
    
    const setupPromise = this._createConnection(connectionKey, sourceLang, targetLang, apiKey);
    this.connectionSetupPromises.set(connectionKey, setupPromise);
    
    try {
      const session = await setupPromise;
      this.connectionPool.set(connectionKey, session);
      return session;
    } finally {
      this.connectionSetupPromises.delete(connectionKey);
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
        activeRequestId: null // Track which request has the active response
      };
      
      ws.on('open', () => {
        console.log(`[RealtimeFinalWorker] Connection opened for ${sourceLang} → ${targetLang}`);
        
        const translationInstructions = `You are a translation API. Your ONLY job is to translate text from ${sourceLangName} to ${targetLangName}.

CRITICAL RULES - YOU MUST FOLLOW THESE:
1. NEVER respond conversationally or answer questions
2. NEVER add explanations, commentary, or notes
3. NEVER include phrases like "The translation is..." or "Here's the translation"
4. ONLY output the direct translation of the input text
5. Do NOT acknowledge the user or respond to their questions
6. Do NOT provide additional information or assistance
7. If the input is a question, translate the question itself - do NOT answer it
8. If the input is a statement, translate the statement - do NOT respond to it
9. Output ONLY the translated text in ${targetLangName}, nothing else

EXAMPLES:
Input: "Can you hear me?"
Output: "¿Puedes oírme?" (NOT "Yes, I can hear you.")

Input: "Is this faster?"
Output: "¿Es esto más rápido?" (NOT "Yes, this is faster.")

Input: "Hello, testing."
Output: "Hola, prueba." (NOT "Hello! I'm here to help with testing.")

Remember: You are a TRANSLATOR, not a conversational assistant. Translate only.`;

        const sessionConfig = {
          type: 'session.update',
          session: {
            modalities: ['text'],
            instructions: translationInstructions,
            temperature: 0.6, // Minimum temperature for realtime API (must be >= 0.6)
            max_response_output_tokens: 16000,
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
                resolve(session);
              }
              break;
              
            case 'conversation.item.created':
              // Track conversation item and map to pending request
              if (event.item && event.item.id) {
                console.log(`[RealtimeFinalWorker] 📝 Item created: ${event.item.id} for connection ${session.connectionKey}`);
                
                // Find the most recent pending request without an itemId that belongs to THIS session
                // Use connectionKey for comparison since session objects might be different instances
                let matchedRequestId = null;
                for (const [reqId, pending] of this.pendingResponses.entries()) {
                  // Match only if: belongs to this session (by connectionKey), doesn't have itemId yet, and item not already tracked
                  if (pending.connectionKey === session.connectionKey && !pending.itemId && !session.pendingItems.has(event.item.id)) {
                    matchedRequestId = reqId;
                    pending.itemId = event.item.id;
                    console.log(`[RealtimeFinalWorker] 🔗 Matched request ${reqId} to item ${event.item.id} (connection: ${pending.connectionKey})`);
                    break;
                  }
                }
                
                if (!matchedRequestId) {
                  console.warn(`[RealtimeFinalWorker] ⚠️ No pending request found for item ${event.item.id}`);
                  console.warn(`[RealtimeFinalWorker] Available pending requests: ${Array.from(this.pendingResponses.keys()).join(', ')}`);
                  console.warn(`[RealtimeFinalWorker] Pending requests for this connection: ${Array.from(this.pendingResponses.entries()).filter(([_, p]) => p.connectionKey === session.connectionKey).map(([id, _]) => id).join(', ')}`);
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
                  isComplete: false
                });
                
                // Check if there's already an active response - wait for it to finish
                if (session.activeResponseId) {
                  console.warn(`[RealtimeFinalWorker] ⚠️ Active response ${session.activeResponseId} in progress, queuing item ${event.item.id}`);
                  // Store the item and create response after current one finishes
                  // For now, we'll wait - the response.done handler will clear activeResponseId
                  return;
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
                    instructions: `Translate text from ${sourceLangName} to ${targetLangName}. Only provide the direct translation - no explanations, no commentary, no responses to questions. Translate questions as questions, statements as statements. Output only the translated text in ${targetLangName}.`
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
                  for (const [reqId, pending] of this.pendingResponses.entries()) {
                    if (pending.connectionKey === session.connectionKey && pending.itemId) {
                      const item = session.pendingItems.get(pending.itemId);
                      if (item && !item.isComplete) {
                        session.activeRequestId = reqId;
                        console.log(`[RealtimeFinalWorker] 🔗 Active response ${finalResponseId} linked to request ${reqId}`);
                        break;
                      }
                    }
                  }
                } else {
                  console.log(`[RealtimeFinalWorker] ⚠️ Response created but activeRequestId already set to ${session.activeRequestId}`);
                }
              }
              break;
              
            case 'response.done':
              console.log(`[RealtimeFinalWorker] ✅ Response done: ${session.activeResponseId}`);
              session.activeResponseId = null; // Clear active response, allow new ones
              session.activeRequestId = null; // Clear active request tracking
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
                    
                    // CRITICAL: Validate that translation is actually different from original
                    const originalText = pending.originalText || '';
                    if (!translatedText || translatedText.length === 0) {
                      console.error(`[RealtimeFinalWorker] ❌ Translation is empty`);
                      if (pending.timeoutId) {
                        clearTimeout(pending.timeoutId);
                      }
                      pending.reject(new Error('Translation API returned empty result'));
                      this.pendingResponses.delete(session.activeRequestId);
                      session.pendingItems.delete(pending.itemId);
                      session.activeRequestId = null;
                      return;
                    }
                    
                    // Check if translation matches original (likely API returned original instead of translating)
                    const isSameAsOriginal = translatedText === originalText || 
                                           translatedText.trim() === originalText.trim() ||
                                           translatedText.toLowerCase() === originalText.toLowerCase();
                    
                    if (isSameAsOriginal && originalText.length > 0) {
                      console.error(`[RealtimeFinalWorker] ❌ Translation matches original (likely API error): "${translatedText.substring(0, 60)}..."`);
                      if (pending.timeoutId) {
                        clearTimeout(pending.timeoutId);
                      }
                      pending.reject(new Error('Translation returned same as original - API likely returned original text instead of translating'));
                      this.pendingResponses.delete(session.activeRequestId);
                      session.pendingItems.delete(pending.itemId);
                      session.activeRequestId = null;
                      return;
                    }
                    
                    // Clear timeout
                    if (pending.timeoutId) {
                      clearTimeout(pending.timeoutId);
                    }
                    
                    pending.resolve(translatedText);
                    this.pendingResponses.delete(session.activeRequestId);
                    session.pendingItems.delete(pending.itemId);
                    session.activeRequestId = null;
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

    const cacheKey = `final:${sourceLang}:${targetLang}:${text.substring(0, 200)}`;
    
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.CACHE_TTL) {
        console.log(`[RealtimeFinalWorker] ✅ Cache hit`);
        return cached.text;
      }
    }

    if (!apiKey) {
      throw new Error('No API key provided');
    }

    const sourceLangName = getLanguageName(sourceLang);
    const targetLangName = getLanguageName(targetLang);

    console.log(`[RealtimeFinalWorker] 🎯 Translating final: "${text.substring(0, 50)}..." (${sourceLangName} → ${targetLangName})`);

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

    return new Promise((resolve, reject) => {
      // Store pending response (itemId will be set when item.created arrives)
      this.pendingResponses.set(requestId, {
        resolve,
        reject,
        itemId: null, // Will be set when item.created event arrives
        session: session, // Track which session this request belongs to
        connectionKey: connectionKey // Track connection for debugging
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
            console.error(`[RealtimeFinalWorker] ⏱️ Translation timeout after 20s for request ${requestId}`);
            console.error(`[RealtimeFinalWorker] ItemId: ${pending?.itemId || 'not set'}, Connection: ${session.ws?.readyState === WebSocket.OPEN ? 'OPEN' : 'CLOSED'}`);
            this.pendingResponses.delete(requestId);
            reject(new Error('Translation timeout - realtime API did not respond'));
          }
        }, 20000); // 20 second timeout for finals
        
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
    }).catch((error) => {
      console.error(`[RealtimeFinalWorker] Translation error:`, error.message);
      throw error;
    });
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
}

// Export singleton instances
export const realtimePartialTranslationWorker = new RealtimePartialTranslationWorker();
export const realtimeFinalTranslationWorker = new RealtimeFinalTranslationWorker();

