/**
 * API WebSocket Handler - Secure handler for external clients
 * 
 * Wraps solo mode functionality with security middleware:
 * - Authentication (API key)
 * - Rate limiting (attack-focused)
 * - Input validation
 * 
 * Provides simplified message format with transcript/translation keys
 * (added automatically by soloModeHandler's sendWithSequence function)
 */

import { handleSoloMode } from './soloModeHandler.js';
import apiAuth from './apiAuth.js';
import rateLimiter from './rateLimiter.js';
import inputValidator from './inputValidator.js';
import WebSocket from 'ws';

/**
 * Handle API WebSocket connection with security middleware
 * @param {WebSocket} clientWs - WebSocket connection
 * @param {object} req - HTTP request object
 */
export async function handleAPIConnection(clientWs, req) {
  const connectionId = `api_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const clientIP = inputValidator.getClientIP(req);
  
  console.log(`[API] New connection: ${connectionId} from ${clientIP}`);
  
  // Step 1: Authentication
  const authResult = apiAuth.validateRequest(req);
  if (!authResult.valid) {
    console.warn(`[API] Authentication failed for ${connectionId}: ${authResult.error}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'error',
        code: 'AUTH_FAILED',
        message: authResult.error
      }));
    }
    clientWs.close(1008, 'Authentication failed');
    return;
  }
  
  // Step 2: Rate limiting - check connection limit
  if (!rateLimiter.canConnect(clientIP)) {
    console.warn(`[API] Connection rate limit exceeded for ${clientIP}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'error',
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many connections from this IP address'
      }));
    }
    clientWs.close(1008, 'Rate limit exceeded');
    return;
  }
  
  // Register connection
  rateLimiter.registerConnection(clientIP, connectionId);
  
  // Intercept and validate messages before solo mode processes them
  // We'll capture solo mode's message listener and call it with validated messages
  
  async function processMessage(msg) {
    try {
      // Step 1: Parse and validate message structure
      let message;
      try {
        message = JSON.parse(msg.toString());
      } catch (error) {
        console.warn(`[API] Invalid JSON from ${connectionId}:`, error.message);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'error',
            code: 'VALIDATION_ERROR',
            message: 'Invalid JSON format'
          }));
        }
        return null;
      }
      
      // Step 2: Validate message
      const validation = inputValidator.validateMessage(message);
      if (!validation.valid) {
        console.warn(`[API] Validation failed for ${connectionId}: ${validation.error}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'error',
            code: 'VALIDATION_ERROR',
            message: validation.error
          }));
        }
        return null;
      }
      
      // Step 3: Rate limiting - check message rate
      const messageRateCheck = rateLimiter.checkMessageRate(connectionId);
      if (!messageRateCheck.allowed) {
        console.warn(`[API] Message rate limit exceeded for ${connectionId}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'error',
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Message rate limit exceeded. Please slow down.',
            retryAfter: messageRateCheck.retryAfter
          }));
        }
        return null;
      }
      
      // Step 4: Rate limiting - check audio rate (if audio message)
      if (validation.sanitized.type === 'audio' && validation.sanitized.data) {
        const audioRateCheck = rateLimiter.checkAudioRate(connectionId, validation.sanitized.data.length);
        if (!audioRateCheck.allowed) {
          console.warn(`[API] Audio rate limit exceeded for ${connectionId}`);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'error',
              code: 'RATE_LIMIT_EXCEEDED',
              message: 'Audio data rate limit exceeded. Please slow down.',
              retryAfter: audioRateCheck.retryAfter
            }));
          }
          return null;
        }
      }
      
      // Step 5: Convert audio data format if needed
      // Solo mode expects audioData field, but API accepts 'data'
      if (validation.sanitized.type === 'audio' && validation.sanitized.data) {
        validation.sanitized.audioData = validation.sanitized.data;
        delete validation.sanitized.data;
      }
      
      // Step 6: Return validated message as Buffer
      return Buffer.from(JSON.stringify(validation.sanitized));
      
    } catch (error) {
      console.error(`[API] Error processing message from ${connectionId}:`, error);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'error',
          code: 'INTERNAL_ERROR',
          message: 'Internal server error'
        }));
      }
      return null;
    }
  }
  
  // Set up our message interceptor (runs first, before solo mode)
  // We'll intercept all messages, validate them, then queue them for solo mode
  const originalOn = clientWs.on.bind(clientWs);
  const soloModeListeners = [];
  
  // Override 'on' to capture solo mode's message listener
  clientWs.on = function(event, listener) {
    if (event === 'message') {
      // Store solo mode's message listener
      soloModeListeners.push(listener);
      // Don't add it yet - we'll call it manually after validation
    } else {
      // For other events, use original behavior
      return originalOn.call(clientWs, event, listener);
    }
    return clientWs;
  };
  
  // Set up our validation interceptor
  originalOn.call(clientWs, 'message', async (msg) => {
    const validatedMsg = await processMessage(msg);
    if (validatedMsg) {
      // Call solo mode's message listeners with validated message
      for (const listener of soloModeListeners) {
        try {
          await listener(validatedMsg);
        } catch (error) {
          console.error(`[API] Error in solo mode message handler:`, error);
        }
      }
    }
  });
  
  // Initialize solo mode handler (it will try to add its message listener)
  // Our override above will capture it instead of adding it directly
  handleSoloMode(clientWs);
  
  // Restore original 'on' method
  clientWs.on = originalOn;
  
  // Handle connection close
  clientWs.on('close', () => {
    console.log(`[API] Connection closed: ${connectionId}`);
    rateLimiter.unregisterConnection(connectionId);
  });
  
  // Handle errors
  clientWs.on('error', (error) => {
    console.error(`[API] WebSocket error for ${connectionId}:`, error);
    rateLimiter.unregisterConnection(connectionId);
  });
  
  // Send welcome message
  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify({
      type: 'info',
      message: 'Connected to Exbabel API. Send init message to start.',
      connectionId: connectionId
    }));
  }
}
