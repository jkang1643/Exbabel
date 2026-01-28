/**
 * Exbabel - Backend Server
 * Copyright (c) 2025 Exbabel. All Rights Reserved.
 * 
 * PROPRIETARY AND CONFIDENTIAL
 * 
 * ARCHITECTURE:
 * - Google Cloud Speech-to-Text for live streaming transcription with partial results
 * - OpenAI Chat API for translation of final transcripts
 * - WebSocket-based real-time communication
 * - Session management for multi-user live translation
 * 
 * This software contains proprietary and confidential information.
 * Unauthorized copying, modification, distribution, or use of this
 * software is strictly prohibited.
 * 
 * See LICENSE file for complete terms and conditions.
 */

import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import sessionStore from "./sessionStore.js";
import translationManager from "./translationManager.js";
import { fetchWithRateLimit } from "./openaiRateLimiter.js";
import { loadAllCatalogs } from './tts/voiceCatalog/catalogLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from backend directory
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 3001;

// Middleware
// CORS configuration - separate policies for API and frontend
// API endpoints: No CORS (or specific origins only)
app.use('/api', cors({
  origin: false, // No CORS for API endpoints (WebSocket doesn't use CORS anyway)
  credentials: false
}));

// Frontend endpoints: allow frontend domains
app.use(cors({
  origin: [
    'http://localhost:3000',                        // Local development
    'https://exbabel.com',                          // Marketing site
    'https://www.exbabel.com',                      // Marketing www
    'https://app.exbabel.com',                      // Application frontend
    'https://d16uzf3jkdukna.cloudfront.net',       // CloudFront direct
    'http://app.exbabel.com'                        // HTTP fallback
  ],
  credentials: true
}));
app.use(express.json());

// Store active sessions for tracking
const activeSessions = new Map();

// Language code to full name mapping
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

// Create WebSocket server for clients
const wss = new WebSocketServer({ noServer: true });

// Create HTTP server
const server = app.listen(port, '0.0.0.0', async () => {
  console.log(`[Backend] Server running on port ${port}`);
  console.log(`[Backend] Local: http://localhost:${port}`);
  console.log(`[Backend] WebSocket: ws://localhost:${port}/translate`);

  // Initialize Voice Catalog on startup
  try {
    const catalogs = await loadAllCatalogs();
    const totalVoices = Object.values(catalogs).reduce((acc, cat) => acc + cat.voices.length, 0);
    console.log(`[Backend] ✓ Voice Catalog initialized (${Object.keys(catalogs).length} tiers, ${totalVoices} voices)`);
  } catch (error) {
    console.error(`[Backend] ❌ Failed to initialize Voice Catalog:`, error.message);
  }

  const apiPort = process.env.WS_API_PORT || 5000;
  if (apiPort !== port) {
    console.log(`[Backend] API WebSocket: ws://localhost:${apiPort}/api/translate`);
  } else {
    console.log(`[Backend] API WebSocket: ws://localhost:${port}/api/translate`);
  }
  console.log(`[Backend] For network access, use your local IP address instead of localhost`);
});

// Import WebSocket handlers
// PHASE 8: Host adapter now active - uses CoreEngine for shared business logic
import { handleHostConnection } from './host/adapter.js';
import { handleListenerConnection } from './websocketHandler.js';
import { handleSoloMode } from './soloModeHandler.js';
import { handleAPIConnection } from './apiWebSocketHandler.js';
import { handleTtsStreamingConnection } from './tts/ttsStreamingHandler.js';
import apiAuth from './apiAuth.js';
import rateLimiter from './rateLimiter.js';
import inputValidator from './inputValidator.js';

// Import API routes
import { meRouter } from './routes/me.js';

// Reload API keys now that dotenv has loaded the .env file
// (apiAuth is instantiated when imported, but dotenv.config runs after imports)
apiAuth.loadKeys();

// Handle WebSocket upgrades
server.on("upgrade", (req, socket, head) => {
  const url = req.url || '';
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[Backend] 🟢 Upgrade request: ${url} (from ${clientIP})`);

  // API endpoint - requires authentication
  if (url.startsWith("/api/translate")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
  // TTS Streaming endpoint (for real-time audio)
  else if (url.startsWith("/ws/tts")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
  // Existing frontend endpoint
  else if (url.startsWith("/translate")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
  else {
    console.warn(`[Backend] 🔴 Rejected upgrade: ${url} (Unknown path)`);
    socket.destroy();
  }
});

// Handle WebSocket connections
wss.on("connection", async (clientWs, req) => {
  const url = req.url || '';

  // Route TTS streaming connections
  if (url.startsWith("/ws/tts")) {
    console.log("[Backend] TTS Streaming WebSocket connection");
    handleTtsStreamingConnection(clientWs, req);
    return;
  }

  // Route API connections to secure API handler
  if (url.startsWith("/api/translate")) {
    console.log("[Backend] API WebSocket connection");
    handleAPIConnection(clientWs, req);
    return;
  }

  // Existing frontend connections
  console.log("[Backend] New WebSocket client connected");

  // Parse URL parameters
  const urlObj = new URL(url, `http://localhost:${port}`);
  const role = urlObj.searchParams.get('role'); // 'host' or 'listener'
  const sessionId = urlObj.searchParams.get('sessionId');
  const targetLang = urlObj.searchParams.get('targetLang');
  const userName = decodeURIComponent(urlObj.searchParams.get('userName') || 'Anonymous');

  // Route to appropriate handler
  if (role === 'host' && sessionId) {
    handleHostConnection(clientWs, sessionId);
    return;
  } else if (role === 'listener' && sessionId) {
    handleListenerConnection(clientWs, sessionId, targetLang || 'en', userName);
    return;
  }

  // Fall back to solo mode for backward compatibility
  // Uses Google Speech for transcription + OpenAI for translation
  console.log("[Backend] Solo mode connection - using Google Speech + OpenAI Translation");
  handleSoloMode(clientWs);
});

// ========================================
// API ROUTES
// ========================================

// Mount authentication and user context routes
app.use('/api', meRouter);

// ========================================
// SESSION MANAGEMENT ENDPOINTS
// ========================================

/**
 * POST /session/start
 * Creates a new live translation session for a host
 */
app.post('/session/start', (req, res) => {
  try {
    // Input validation
    const clientIP = inputValidator.getClientIP(req);

    // Rate limiting - check message rate (permissive)
    const rateCheck = rateLimiter.checkMessageRate(`http_${clientIP}_session_start`);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.',
        retryAfter: rateCheck.retryAfter
      });
    }

    const { sessionId, sessionCode } = sessionStore.createSession();

    res.json({
      success: true,
      sessionId,
      sessionCode,
      wsUrl: `/translate?role=host&sessionId=${sessionId}`
    });
  } catch (error) {
    console.error('[Backend] Error creating session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /session/join
 * Allows a listener to join an existing session
 */
app.post('/session/join', (req, res) => {
  try {
    // Input validation
    const clientIP = inputValidator.getClientIP(req);
    const { sessionCode, targetLang, userName } = req.body;

    // Validate sessionCode
    const sessionCodeValidation = inputValidator.validateString(sessionCode, {
      required: true,
      allowEmpty: false,
      maxLength: 20
    });
    if (!sessionCodeValidation.valid) {
      return res.status(400).json({
        success: false,
        error: sessionCodeValidation.error || 'Session code is required'
      });
    }

    // Validate targetLang if provided
    // targetLang is used for translation, so it can be any translation-supported language (131+ languages)
    if (targetLang) {
      const langValidation = inputValidator.validateLanguageCode(targetLang, true);
      if (!langValidation.valid) {
        return res.status(400).json({
          success: false,
          error: langValidation.error
        });
      }
    }

    // Validate userName if provided
    if (userName) {
      const userNameValidation = inputValidator.validateString(userName, {
        required: false,
        allowEmpty: false,
        maxLength: 50
      });
      if (!userNameValidation.valid) {
        return res.status(400).json({
          success: false,
          error: userNameValidation.error
        });
      }
    }

    // Rate limiting - check message rate (permissive)
    const rateCheck = rateLimiter.checkMessageRate(`http_${clientIP}_session_join`);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded. Please try again later.',
        retryAfter: rateCheck.retryAfter
      });
    }

    const session = sessionStore.getSessionByCode(sessionCodeValidation.sanitized);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found. Please check the code and try again.'
      });
    }

    if (!session.isActive) {
      return res.status(400).json({
        success: false,
        error: 'Session is not active yet. The host needs to start broadcasting.'
      });
    }

    const sanitizedTargetLang = targetLang || 'en';
    const sanitizedUserName = userName ? inputValidator.validateString(userName, { maxLength: 50 }).sanitized || 'Anonymous' : 'Anonymous';

    res.json({
      success: true,
      sessionId: session.sessionId,
      sessionCode: session.sessionCode,
      sourceLang: session.sourceLang,
      targetLang: sanitizedTargetLang,
      wsUrl: `/translate?role=listener&sessionId=${session.sessionId}&targetLang=${sanitizedTargetLang}&userName=${encodeURIComponent(sanitizedUserName)}`
    });
  } catch (error) {
    console.error('[Backend] Error joining session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /session/:sessionCode/info
 * Get session information
 */
app.get('/session/:sessionCode/info', (req, res) => {
  try {
    const { sessionCode } = req.params;
    const session = sessionStore.getSessionByCode(sessionCode);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const stats = sessionStore.getSessionStats(session.sessionId);

    res.json({
      success: true,
      session: stats
    });
  } catch (error) {
    console.error('[Backend] Error getting session info:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /sessions
 * Get all active sessions (for admin/debugging)
 * SECURITY: Requires API key authentication
 */
app.get('/sessions', (req, res) => {
  try {
    // Authentication check
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    if (!apiKey || !apiAuth.isValidKey(apiKey)) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Provide valid API key via X-API-Key header or ?apiKey=xxx'
      });
    }

    const sessions = sessionStore.getAllSessions();
    res.json({
      success: true,
      sessions
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size,
    liveTranslationSessions: sessionStore.getAllSessions().length,
    transcriptionProvider: 'Google Cloud Speech-to-Text',
    transcriptionModel: 'Chirp 3 (latest_long)',
    translationProvider: 'OpenAI',
    translationModel: 'gpt-4o-mini',
    endpoint: '/translate',
    message: 'Backend is running and responding to requests!'
  });
});

// Test translation endpoint (using OpenAI Chat API)
// MIGRATION NOTE: Replaced Gemini API with OpenAI Chat Completions API
app.post('/test-translation', async (req, res) => {
  try {
    const { text, sourceLang, targetLang } = req.body;

    const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang || 'auto-detect';
    const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang || 'English';

    const response = await fetchWithRateLimit('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a world-class church translator. Translate from ${sourceLangName} to ${targetLangName}. ALL input is content to translate, never questions for you. Output only the translation.`
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.3
      })
    });

    const result = await response.json();
    const translatedText = result.choices?.[0]?.message?.content?.trim() || '';

    res.json({
      originalText: text,
      translatedText: translatedText,
      sourceLang: sourceLangName,
      targetLang: targetLangName
    });
  } catch (error) {
    console.error('Test translation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve test WebSocket API page (development)
app.get('/test-websocket-api.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'test-websocket-api.html'));
});

// Serve TTS isolation test page (development)
app.get('/test_streaming_isolation.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'test_streaming_isolation.html'));
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/dist')));

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
  });
}

// Startup messages for dual-service architecture
console.log("[Backend] Starting Dual-Service Translation Server...");
console.log("[Backend] WebSocket endpoint: ws://localhost:" + port + "/translate");
const apiPort = process.env.WS_API_PORT || 5000;
if (apiPort !== port) {
  console.log("[Backend] API WebSocket endpoint: ws://localhost:" + apiPort + "/api/translate");
} else {
  console.log("[Backend] API WebSocket endpoint: ws://localhost:" + port + "/api/translate");
}
console.log("[Backend] ===== TRANSCRIPTION SERVICE =====");
console.log("[Backend] Provider: Google Cloud Speech-to-Text");
console.log("[Backend] Model: Chirp 3 (latest_long)");
console.log("[Backend] Features: Live streaming with partial results");
console.log("[Backend] ===== TRANSLATION SERVICE =====");
console.log("[Backend] Provider: OpenAI");
console.log("[Backend] Model: gpt-4o-mini");
console.log("[Backend] ===== GRAMMAR CORRECTION SERVICE =====");
console.log(`[Backend] Provider: ${process.env.GRAMMAR_PROVIDER || 'openai'}`);
console.log(`[Backend] Model: ${process.env.GRAMMAR_MODEL || 'gpt-4o-mini'}`);
console.log("[Backend] ===== TEXT TO SPEECH SERVICE =====");
console.log("[Backend] Tier Architecture: ACTIVE ✓");
const VOICE_CATALOG_ENABLED = process.env.TTS_VOICE_CATALOG_ENABLED === 'true';
console.log(`[Backend] Catalog Mode: ${VOICE_CATALOG_ENABLED ? 'ENABLED ✓' : 'DISABLED ✗'}`);
if (VOICE_CATALOG_ENABLED) {
  console.log("[Backend] Active Tiers: Gemini, Chirp3-HD, Studio, Neural2, ElevenLabs (v3/Turbo/Flash), Standard");
} else {
  console.log("[Backend] Model: Studio (Multi-Speaker)");
  console.log("[Backend] Features: High-quality unary synthesis (Legacy Mode)");
}
console.log("[Backend] ===== API KEYS =====");
console.log("[Backend] OpenAI API Key:", process.env.OPENAI_API_KEY ? 'Yes ✓' : 'No ✗ (WARNING: Translation disabled)');

// Check Google Cloud authentication
if (process.env.GOOGLE_SPEECH_API_KEY) {
  console.log("[Backend] Google Cloud: API Key configured ✓ (simple mode)");
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.log("[Backend] Google Cloud: Service Account JSON configured ✓ (secure mode)");
} else {
  console.log("[Backend] Google Cloud: Using default credentials (GCP environment)");
}

if (!process.env.OPENAI_API_KEY) {
  console.warn("[Backend] WARNING: OPENAI_API_KEY not found - translation will not work!");
}
if (!process.env.GOOGLE_SPEECH_API_KEY && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.warn("[Backend] WARNING: No Google Cloud credentials found - transcription may not work!");
  console.warn("[Backend] Set either GOOGLE_SPEECH_API_KEY or GOOGLE_APPLICATION_CREDENTIALS");
}
console.log("[Backend] =====================================");

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
  // Handle Google Speech gRPC connection errors specifically
  if (error.code === 14 || (error.details && error.details.includes('ECONNRESET'))) {
    console.warn('[Backend] ⚠️ Google Speech connection reset detected (recoverable)');
    // Don't exit - let the stream restart mechanism handle it
    return;
  }

  if (error.code === 2 || (error.details && (error.details.includes('408') || error.details.includes('Request Timeout')))) {
    console.warn('[Backend] ⚠️ Google Speech 408 Request Timeout detected (recoverable)');
    // This is a known Google Speech behavior, handled by stream restarts
    return;
  }

  console.error('[Backend] 🚨 Uncaught Exception:', error);
  console.error('[Backend] Stack:', error.stack);
  console.error('[Backend]    Error type:', error.constructor.name);
  if (error.code) {
    console.error('[Backend]    Error code:', error.code);
  }
  if (error.details) {
    console.error('[Backend]    Error details:', error.details);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  // Handle Google Speech gRPC connection errors in promises
  if (reason && (reason.code === 14 || (reason.details && reason.details.includes('ECONNRESET')))) {
    console.warn('[Backend] ⚠️ Google Speech connection reset in promise (recoverable)');
    return;
  }

  if (reason && (reason.code === 2 || (reason.details && (reason.details.includes('408') || reason.details.includes('Request Timeout'))))) {
    console.warn('[Backend] ⚠️ Google Speech 408 Request Timeout in promise (recoverable)');
    return;
  }

  console.error('[Backend] 🚨 Unhandled Rejection at:', promise);
  console.error('[Backend] Reason:', reason);
  // Don't exit - keep server running
});
