/**
 * WebSocket Handler - Manages connections for hosts and listeners
 */

import WebSocket from 'ws';
import sessionStore from './sessionStore.js';
import translationManager from './translationManager.js';
import { normalizePunctuation } from './transcriptionCleanup.js';
import { getEntitlements } from './entitlements/index.js';

/**
 * Handle host connection
 */
export async function handleHostConnection(clientWs, sessionId) {
  console.log(`[WebSocket] Host connecting to session ${sessionId}`);

  const session = sessionStore.getSession(sessionId);
  if (!session) {
    clientWs.send(JSON.stringify({
      type: 'error',
      message: 'Session not found'
    }));
    clientWs.close();
    return;
  }

  let geminiWs = null;
  let currentSourceLang = 'en';
  let reconnecting = false;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;
  let messageQueue = [];

  // State management for multi-turn streaming
  let isStreamingAudio = false;
  let setupComplete = false;
  let lastAudioTime = null;
  const AUDIO_END_TIMEOUT = 2000;
  let audioEndTimer = null;
  let lastTranscript = '';

  // Function to send audio stream end signal
  const sendAudioStreamEnd = () => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN && isStreamingAudio) {
      console.log('[Host] Sending audioStreamEnd signal');
      geminiWs.send(JSON.stringify({
        realtimeInput: {
          audioStreamEnd: true
        }
      }));
      isStreamingAudio = false;
      lastAudioTime = null;
    }
  };

  // Function to translate and broadcast transcript
  const translateAndBroadcast = async (transcript) => {
    if (!transcript || transcript === lastTranscript) return;
    lastTranscript = transcript;

    console.log(`[Host] New transcript: ${transcript.substring(0, 100)}...`);

    // Get all target languages needed
    const targetLanguages = sessionStore.getSessionLanguages(sessionId);

    if (targetLanguages.length === 0) {
      console.log('[Host] No listeners yet, skipping translation');
      return;
    }

    try {
      // Translate to all needed languages at once
      const translations = await translationManager.translateToMultipleLanguages(
        transcript,
        currentSourceLang,
        targetLanguages,
        process.env.GEMINI_API_KEY
      );

      console.log(`[Host] Translated to ${Object.keys(translations).length} languages`);

      // Broadcast to each language group
      for (const [targetLang, translatedText] of Object.entries(translations)) {
        sessionStore.broadcastToListeners(sessionId, {
          type: 'translation',
          originalText: transcript,
          translatedText: translatedText,
          sourceLang: currentSourceLang,
          targetLang: targetLang,
          timestamp: Date.now()
        }, targetLang);
      }
    } catch (error) {
      console.error('[Host] Translation error:', error);
    }
  };

  // Function to attach Gemini handlers
  const attachGeminiHandlers = (ws) => {
    ws.on('error', (error) => {
      console.error('[Host] Gemini WebSocket error:', error.message || error);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'error',
          message: 'Gemini connection error: ' + (error.message || 'Unknown error')
        }));
      }
    });

    ws.on('message', async (data) => {
      try {
        const response = JSON.parse(data.toString());

        if (response.setupComplete) {
          console.log('[Host] Gemini setup complete');
          setupComplete = true;

          // Notify host
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'gemini_ready',
              message: 'Ready to receive audio'
            }));
          }

          // Process queued messages
          if (messageQueue.length > 0) {
            console.log(`[Host] Processing ${messageQueue.length} queued messages`);
            const queuedMessages = [...messageQueue];
            messageQueue = [];
            queuedMessages.forEach(queued => {
              if (queued.type === 'audio') {
                clientWs.emit('message', JSON.stringify(queued.message));
              }
            });
          }
          return;
        }

        // Process server content (transcription)
        if (response.serverContent) {
          const serverContent = response.serverContent;

          if (serverContent.modelTurn && serverContent.modelTurn.parts) {
            for (const part of serverContent.modelTurn.parts) {
              if (part.text) {
                let transcript = part.text.trim();
                transcript = normalizePunctuation(transcript);

                // Send transcript to host
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({
                    type: 'transcript',
                    text: transcript,
                    timestamp: Date.now()
                  }));
                }

                // Translate and broadcast to listeners
                await translateAndBroadcast(transcript);
              }
            }
          }

          if (serverContent.turnComplete) {
            console.log('[Host] Model turn complete');

            if (audioEndTimer) {
              clearTimeout(audioEndTimer);
              audioEndTimer = null;
            }

            isStreamingAudio = false;
            lastAudioTime = null;

            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'turn_complete',
                timestamp: Date.now()
              }));
            }
          }
        }
      } catch (error) {
        console.error('[Host] Error processing Gemini response:', error);
      }
    });

    ws.on('close', async (code, reason) => {
      console.log(`[Host] Gemini connection closed. Code: ${code}`);

      isStreamingAudio = false;
      setupComplete = false;
      lastAudioTime = null;
      if (audioEndTimer) {
        clearTimeout(audioEndTimer);
        audioEndTimer = null;
      }

      if (code === 1011 && reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[Host] Persistent quota error - stopping reconnection');
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'error',
            message: 'Persistent API error. Please check your billing and API key.',
            persistent: true
          }));
        }
        return;
      }

      if (clientWs.readyState === WebSocket.OPEN && !reconnecting) {
        reconnecting = true;
        const backoffDelay = Math.min(500 * Math.pow(2, reconnectAttempts), 4000);

        try {
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          geminiWs = await connectToGemini();
          attachGeminiHandlers(geminiWs);
          reconnecting = false;
          if (code !== 1011) reconnectAttempts = 0;
        } catch (error) {
          reconnecting = false;
          console.error('[Host] Reconnection failed:', error);
        }
      }
    });
  };

  // Function to connect to Gemini
  const connectToGemini = () => {
    return new Promise((resolve, reject) => {
      console.log('[Host] Connecting to Gemini...');

      const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
      const ws = new WebSocket(geminiWsUrl);

      ws.on('open', () => {
        console.log('[Host] Connected to Gemini');

        const systemInstruction = translationManager.getSystemInstruction(currentSourceLang, 'transcript');

        const setupMessage = {
          setup: {
            model: 'models/gemini-live-2.5-flash-preview',
            generationConfig: {
              responseModalities: ['TEXT']
            },
            systemInstruction: systemInstruction
          }
        };

        ws.send(JSON.stringify(setupMessage));
        resolve(ws);
      });

      ws.on('error', (error) => {
        console.error('[Host] Gemini connection error:', error);
        reject(error);
      });
    });
  };

  // Handle client messages
  clientWs.on('message', (msg) => {
    try {
      const message = JSON.parse(msg.toString());

      switch (message.type) {
        case 'init':
          if (message.sourceLang) {
            currentSourceLang = message.sourceLang;
            sessionStore.updateSourceLanguage(sessionId, currentSourceLang);
          }

          console.log(`[Host] Initialized with source language: ${currentSourceLang}`);

          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'session_ready',
              sessionId: sessionId,
              sessionCode: session.sessionCode,
              role: 'host'
            }));
          }
          break;

        case 'audio':
          if (geminiWs && geminiWs.readyState === WebSocket.OPEN && setupComplete) {
            if (!isStreamingAudio) {
              console.log('[Host] Starting audio stream');
              isStreamingAudio = true;
            }

            const audioMessage = {
              realtimeInput: {
                audio: {
                  mimeType: 'audio/pcm;rate=16000',
                  data: message.audioData
                }
              }
            };

            geminiWs.send(JSON.stringify(audioMessage));
            lastAudioTime = Date.now();

            if (audioEndTimer) clearTimeout(audioEndTimer);
            audioEndTimer = setTimeout(() => {
              sendAudioStreamEnd();
            }, AUDIO_END_TIMEOUT);
          } else if (!setupComplete && messageQueue.length < 10) {
            messageQueue.push({ type: 'audio', message });
          }
          break;

        case 'audio_end':
          if (audioEndTimer) {
            clearTimeout(audioEndTimer);
            audioEndTimer = null;
          }
          sendAudioStreamEnd();
          break;
      }
    } catch (error) {
      console.error('[Host] Error processing message:', error);
    }
  });

  // Handle host disconnect
  clientWs.on('close', () => {
    console.log('[Host] Disconnected from session');

    if (audioEndTimer) {
      clearTimeout(audioEndTimer);
      audioEndTimer = null;
    }

    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }

    sessionStore.closeSession(sessionId);
  });

  // Initialize Gemini connection
  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY not configured');
    }

    geminiWs = await connectToGemini();
    attachGeminiHandlers(geminiWs);
    sessionStore.setHost(sessionId, clientWs, geminiWs);

    // Send initial session stats to host
    if (clientWs.readyState === WebSocket.OPEN) {
      const stats = sessionStore.getSessionStats(sessionId);
      clientWs.send(JSON.stringify({
        type: 'session_stats',
        stats: stats
      }));
    }

    console.log(`[Host] Session ${session.sessionCode} is now active`);
  } catch (error) {
    console.error('[Host] Initialization error:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'error',
        message: `Failed to initialize: ${error.message}`
      }));
    }
  }
}

// TTS Radio Mode: Lease enforcement constants
const TTS_PLAYING_LEASE_SECONDS = 300; // 5 minutes
const TTS_PAUSED_LEASE_SECONDS = 60; // 1 minute

/**
 * Handle listener connection
 */
export function handleListenerConnection(clientWs, sessionId, targetLang, userName) {
  console.log(`[WebSocket] Listener connecting: ${userName} (${targetLang})`);

  const session = sessionStore.getSession(sessionId);
  if (!session) {
    clientWs.send(JSON.stringify({
      type: 'error',
      message: 'Session not found'
    }));
    clientWs.close();
    return;
  }

  // Generate socket ID
  const socketId = `listener_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  try {
    // Add listener to session
    sessionStore.addListener(sessionId, socketId, clientWs, targetLang, userName);

    // Notify host about new listener
    const hostSocket = session.hostSocket;
    if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
      const stats = sessionStore.getSessionStats(sessionId);
      hostSocket.send(JSON.stringify({
        type: 'session_stats',
        stats: stats
      }));
    }

    // Fetch entitlements to send plan info and send welcome message
    // TODO: Use actual orgId from session/auth
    const orgId = 'default';
    getEntitlements(orgId)
      .then(entitlements => {
        const plan = entitlements?.subscription?.planCode || 'starter';
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'session_joined',
            sessionId: session.sessionId,
            sessionCode: session.sessionCode,
            role: 'listener',
            targetLang: targetLang,
            sourceLang: session.sourceLang,
            plan: plan, // Send plan info to frontend
            message: `Connected to session ${session.sessionCode}`
          }));
        }
      })
      .catch(err => {
        console.warn(`[Listener] Failed to fetch plan info: ${err.message}`);
        // Send welcome message without plan
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'session_joined',
            sessionId: session.sessionId,
            sessionCode: session.sessionCode,
            role: 'listener',
            targetLang: targetLang,
            sourceLang: session.sourceLang,
            plan: 'starter', // Fallback default
            message: `Connected to session ${session.sessionCode}`
          }));
        }
      });

    // Send session stats periodically
    const statsInterval = setInterval(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        const stats = sessionStore.getSessionStats(sessionId);
        clientWs.send(JSON.stringify({
          type: 'session_stats',
          stats: stats
        }));
      }
    }, 10000); // Every 10 seconds

    // Handle listener disconnect
    clientWs.on('close', () => {
      console.log(`[Listener] ${userName} disconnected`);
      clearInterval(statsInterval);
      sessionStore.removeListener(sessionId, socketId);

      // Notify host about listener leaving
      const updatedSession = sessionStore.getSession(sessionId);
      if (updatedSession && updatedSession.hostSocket && updatedSession.hostSocket.readyState === WebSocket.OPEN) {
        const stats = sessionStore.getSessionStats(sessionId);
        updatedSession.hostSocket.send(JSON.stringify({
          type: 'session_stats',
          stats: stats
        }));
      }
    });

    // Handle listener messages (if any)
    clientWs.on('message', async (msg) => {
      try {
        const message = JSON.parse(msg.toString());

        // Voice Catalog Commands (PR4) - Feature-flagged
        const VOICE_CATALOG_ENABLED = process.env.TTS_VOICE_CATALOG_ENABLED === 'true';

        if (VOICE_CATALOG_ENABLED) {
          // tts/list_voices: Get available voices for a language
          if (message.type === 'tts/list_voices') {
            console.log(`[Listener] ${userName} requesting voice list for ${message.languageCode}`);

            if (!message.languageCode) {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'tts/error',
                  code: 'INVALID_REQUEST',
                  message: 'Missing required field: languageCode'
                }));
              }
              return;
            }

            try {
              const { getVoicesFor } = await import('./tts/voiceCatalog.js');
              const { getAllowedTiers } = await import('./tts/ttsTierHelper.js');

              const orgId = 'default'; // TODO: Get from session/auth
              const allowedTiers = getAllowedTiers(orgId);

              // Get voices filtered by language and allowed tiers
              const voices = await getVoicesFor({
                languageCode: message.languageCode,
                allowedTiers
              });

              // Transform to client format (hide tier info for disallowed voices)
              const clientVoices = voices.map(v => ({
                tier: v.tier,
                voiceId: v.voiceId,
                voiceName: v.voiceName,
                displayName: v.displayName
              }));

              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'tts/voices',
                  languageCode: message.languageCode,
                  voices: clientVoices
                }));
              }

              console.log(`[Listener] Sent ${clientVoices.length} voices for ${message.languageCode}`);
            } catch (error) {
              console.error('[Listener] Failed to list voices:', error);
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'tts/error',
                  code: 'VOICE_LIST_FAILED',
                  message: `Failed to list voices: ${error.message}`
                }));
              }
            }
            return;
          }

          // tts/get_defaults: Get org voice defaults
          if (message.type === 'tts/get_defaults') {
            console.log(`[Listener] ${userName} requesting voice defaults`);

            try {
              const { getOrgVoiceDefaults } = await import('./tts/defaults/defaultsStore.js');

              const orgId = 'default'; // TODO: Get from session/auth
              const defaults = await getOrgVoiceDefaults(orgId);

              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'tts/defaults',
                  defaultsByLanguage: defaults
                }));
              }

              console.log(`[Listener] Sent voice defaults for ${Object.keys(defaults).length} languages`);
            } catch (error) {
              console.error('[Listener] Failed to get defaults:', error);
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'tts/error',
                  code: 'GET_DEFAULTS_FAILED',
                  message: `Failed to get defaults: ${error.message}`
                }));
              }
            }
            return;
          }

          // tts/set_default: Set org voice default (admin only)
          if (message.type === 'tts/set_default') {
            console.log(`[Listener] ${userName} setting voice default`);

            // Validate required fields
            if (!message.languageCode || !message.tier || !message.voiceName) {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'tts/error',
                  code: 'INVALID_REQUEST',
                  message: 'Missing required fields: languageCode, tier, voiceName'
                }));
              }
              return;
            }

            try {
              const { isOrgAdmin } = await import('./tts/ttsTierHelper.js');
              const { setOrgVoiceDefault } = await import('./tts/defaults/defaultsStore.js');

              const orgId = 'default'; // TODO: Get from session/auth
              const userId = userName || 'anonymous';

              // Check admin permissions
              if (!isOrgAdmin(orgId, userId)) {
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({
                    type: 'tts/error',
                    code: 'NOT_AUTHORIZED',
                    message: 'Admin permissions required to set voice defaults'
                  }));
                }
                return;
              }

              // Set the default (validation happens inside setOrgVoiceDefault)
              await setOrgVoiceDefault(orgId, message.languageCode, message.tier, message.voiceName);

              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'tts/ack',
                  action: 'set_default',
                  success: true
                }));
              }

              console.log(`[Listener] Set voice default for ${message.languageCode}: ${message.tier}/${message.voiceName}`);
            } catch (error) {
              console.error('[Listener] Failed to set default:', error);

              const errorCode = error.message.includes('Invalid voice') ? 'INVALID_VOICE' : 'SET_DEFAULT_FAILED';

              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'tts/error',
                  code: errorCode,
                  message: error.message
                }));
              }
            }
            return;
          }
        }

        // TTS command handlers
        if (message.type === 'tts/start') {
          console.log(`[Listener] ${userName} starting TTS playback`);

          // Store TTS playback state in connection metadata
          if (!clientWs.ttsState) {
            clientWs.ttsState = {};
          }

          clientWs.ttsState.playbackState = 'PLAYING';
          clientWs.ttsState.languageCode = message.languageCode || targetLang;
          clientWs.ttsState.voiceName = message.voiceName || null;
          clientWs.ttsState.tier = message.tier || 'gemini';
          clientWs.ttsState.mode = message.mode || 'unary';
          clientWs.ttsState.ttsLeaseExpiresAt = Date.now() + (TTS_PLAYING_LEASE_SECONDS * 1000);

          // VOICE ROUTING: Update session store with preferred voice
          if (message.voiceId) {
            sessionStore.updateSessionVoice(sessionId, message.languageCode || targetLang, message.voiceId);
            clientWs.ttsState.voiceId = message.voiceId;
          }

          // Store full config for lease validation
          clientWs.ttsState.ttsConfig = {
            languageCode: message.languageCode || targetLang,
            voiceName: message.voiceName,
            voiceId: message.voiceId, // Track voiceId
            tier: message.tier || 'gemini',
            mode: message.mode || 'unary',
            ssmlOptions: message.ssmlOptions,
            promptPresetId: message.promptPresetId,
            ttsPrompt: message.ttsPrompt,
            intensity: message.intensity
          };

          // Send acknowledgment with lease info
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'tts/ack',
              action: 'start',
              state: clientWs.ttsState,
              leaseExpiresAt: clientWs.ttsState.ttsLeaseExpiresAt
            }));
          }

          console.log(`[Listener] ${userName} TTS state:`, clientWs.ttsState);
        }
        else if (message.type === 'tts/pause') {
          console.log(`[Listener] ${userName} pausing TTS playback`);

          // Update playback state and refresh lease with shorter duration
          if (clientWs.ttsState) {
            clientWs.ttsState.playbackState = 'PAUSED';
            clientWs.ttsState.ttsLeaseExpiresAt = Date.now() + (TTS_PAUSED_LEASE_SECONDS * 1000);
          }

          // Send acknowledgment
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'tts/ack',
              action: 'pause',
              leaseExpiresAt: clientWs.ttsState?.ttsLeaseExpiresAt
            }));
          }
        }
        else if (message.type === 'tts/resume') {
          console.log(`[Listener] ${userName} resuming TTS playback`);

          // Update playback state and refresh full lease
          if (clientWs.ttsState) {
            clientWs.ttsState.playbackState = 'PLAYING';
            clientWs.ttsState.ttsLeaseExpiresAt = Date.now() + (TTS_PLAYING_LEASE_SECONDS * 1000);
          }

          // Send acknowledgment
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'tts/ack',
              action: 'resume',
              leaseExpiresAt: clientWs.ttsState?.ttsLeaseExpiresAt
            }));
          }
        }
        else if (message.type === 'tts/stop') {
          console.log(`[Listener] ${userName} stopping TTS playback`);

          // Update playback state and clear lease
          if (clientWs.ttsState) {
            clientWs.ttsState.playbackState = 'STOPPED';
            clientWs.ttsState.ttsLeaseExpiresAt = null;
            clientWs.ttsState.ttsConfig = null;
          }

          // Send acknowledgment
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'tts/ack',
              action: 'stop'
            }));
          }
        }
        else if (message.type === 'tts/synthesize') {
          console.log(`[Listener] ${userName} requesting TTS synthesis`);
          console.log(`[Listener] Incoming message:`, {
            segmentId: message.segmentId,
            text: message.text?.substring(0, 50),
            languageCode: message.languageCode,
            voiceName: message.voiceName,
            tier: message.tier,
            mode: message.mode,
            ssmlOptions: message.ssmlOptions,
            promptPresetId: message.promptPresetId,
            ttsPrompt: message.ttsPrompt ? 'yes' : 'no',
            intensity: message.intensity
          });

          // Validate payload
          if (!message.segmentId || !message.text || !message.languageCode) {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/error',
                code: 'INVALID_REQUEST',
                message: 'Missing required fields: segmentId, text, languageCode',
                details: {
                  segmentId: message.segmentId,
                  hasText: !!message.text,
                  hasLanguageCode: !!message.languageCode
                }
              }));
            }
            return;
          }

          // Radio Mode: Check if playing state is active (lease enforcement)
          if (!clientWs.ttsState || clientWs.ttsState.playbackState !== 'PLAYING') {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/error',
                code: 'TTS_NOT_PLAYING',
                message: 'TTS synthesis requires active playback state. Please start TTS playback first.',
                details: {
                  segmentId: message.segmentId,
                  currentState: clientWs.ttsState?.playbackState || 'STOPPED'
                }
              }));
            }
            return;
          }

          // Radio Mode: Check if lease is still valid
          if (clientWs.ttsState.ttsLeaseExpiresAt && Date.now() > clientWs.ttsState.ttsLeaseExpiresAt) {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/error',
                code: 'TTS_LEASE_EXPIRED',
                message: 'TTS playback lease expired. Please restart playback.',
                details: {
                  segmentId: message.segmentId,
                  leaseExpiredAt: clientWs.ttsState.ttsLeaseExpiresAt,
                  currentTime: Date.now()
                }
              }));
            }
            return;
          }

          // RADIO MODE: Refresh lease on active synthesis
          // This ensures that long-running transcription keeps the lease alive
          if (clientWs.ttsState.playbackState === 'PLAYING') {
            clientWs.ttsState.ttsLeaseExpiresAt = Date.now() + (TTS_PLAYING_LEASE_SECONDS * 1000);
            console.log(`[Listener] ${userName} lease refreshed via synthesis. New expiry: ${new Date(clientWs.ttsState.ttsLeaseExpiresAt).toISOString()}`);
          }

          // Check if streaming mode (not implemented yet)
          if (message.mode === 'streaming') {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/error',
                code: 'TTS_STREAMING_NOT_IMPLEMENTED',
                message: 'TTS streaming mode not implemented yet (future PR)',
                details: {
                  segmentId: message.segmentId
                }
              }));
            }
            return;
          }

          // Import TTS modules
          const { getTtsServiceForProvider } = await import('./tts/ttsService.js');
          const { validateTtsRequest } = await import('./tts/ttsPolicy.js');
          const { canSynthesize } = await import('./tts/ttsQuota.js');
          const { recordUsage } = await import('./tts/ttsUsage.js');

          try {

            // Fix for typo in tier name if it comes from frontend/config
            if (message.tier === 'chirp_hd') {
              message.tier = 'chirp3_hd';
            }

            // PR4: Server-side voice resolution (feature-flagged)
            const VOICE_CATALOG_ENABLED = process.env.TTS_VOICE_CATALOG_ENABLED === 'true';
            let resolvedVoice = null;

            if (VOICE_CATALOG_ENABLED) {
              // Check if voice resolution is needed (missing either voiceId OR tier/voiceName)
              const hasVoiceId = !!message.voiceId;
              const hasTierAndName = !!(message.tier && message.voiceName);
              const needsResolution = !hasVoiceId && !hasTierAndName;

              if (needsResolution) {
                console.log(`[Listener] Missing voice selection, resolving server-side`);

                try {
                  const { resolveVoice } = await import('./tts/voiceResolver.js');
                  const { getAllowedTiers } = await import('./tts/ttsTierHelper.js');

                  const orgId = 'default'; // TODO: Get from session/auth
                  const allowedTiers = getAllowedTiers(orgId);

                  resolvedVoice = await resolveVoice({
                    orgId,
                    userPref: hasVoiceId || hasTierAndName ? {
                      voiceId: message.voiceId,
                      tier: message.tier,
                      voiceName: message.voiceName
                    } : null,
                    languageCode: message.languageCode,
                    allowedTiers
                  });

                  console.log(`[Listener] Resolved voice: ${resolvedVoice.tier}/${resolvedVoice.voiceName} (voiceId: ${resolvedVoice.voiceId}, reason: ${resolvedVoice.reason})`);

                  // Override message with resolved voice
                  message.voiceId = resolvedVoice.voiceId;
                  message.tier = resolvedVoice.tier;
                  message.voiceName = resolvedVoice.voiceName;
                } catch (error) {
                  console.error('[Listener] Voice resolution failed:', error);
                  // Continue with existing routing fallback
                }
              } else {
                // Validate provided voice
                try {
                  const { isVoiceValid } = await import('./tts/voiceCatalog.js');
                  const { getAllowedTiers } = await import('./tts/ttsTierHelper.js');

                  const orgId = 'default';
                  const allowedTiers = getAllowedTiers(orgId);

                  const valid = await isVoiceValid({
                    voiceId: message.voiceId,
                    voiceName: message.voiceName,
                    languageCode: message.languageCode,
                    tier: message.tier
                  });

                  const tierAllowed = allowedTiers.includes(message.tier);

                  if (!valid || !tierAllowed) {
                    console.warn(`[Listener] Invalid or disallowed voice: ${message.tier}/${message.voiceName}, resolving fallback`);

                    const { resolveVoice } = await import('./tts/voiceResolver.js');

                    resolvedVoice = await resolveVoice({
                      orgId,
                      userPref: null, // Don't use invalid preference
                      languageCode: message.languageCode,
                      allowedTiers
                    });

                    console.log(`[Listener] Fallback to: ${resolvedVoice.tier}/${resolvedVoice.voiceName} (reason: ${resolvedVoice.reason})`);

                    message.tier = resolvedVoice.tier;
                    message.voiceName = resolvedVoice.voiceName;
                  }
                } catch (error) {
                  console.error('[Listener] Voice validation failed:', error);
                  // Continue with existing routing fallback
                }
              }
            }

            // 1. Resolve TTS routing (single source of truth)
            const { resolveTtsRoute } = await import('./tts/ttsRouting.js');
            const { getEntitlements } = await import('./entitlements/index.js');

            // Get entitlements for the org
            let userSubscription = {};
            try {
              userSubscription = await getEntitlements('default'); // TODO: Use actual orgId
            } catch (err) {
              console.warn(`[Listener] Failed to fetch entitlements: ${err.message}`);
            }

            const route = await resolveTtsRoute({
              requestedTier: message.tier || (message.engine === 'chirp3_hd' ? 'chirp3_hd' : 'gemini'),
              requestedVoice: message.voiceName,
              languageCode: message.languageCode,
              mode: 'unary',
              orgConfig: {}, // TODO: Pass actual org config
              userSubscription: userSubscription
            });

            // 2. Build TTS request
            console.log(`[Listener] Building TTS request with ssmlOptions:`, message.ssmlOptions);

            const ttsRequest = {
              sessionId: sessionId,
              userId: userName || 'anonymous',
              orgId: 'default', // TODO: Get from session/auth
              text: message.text,
              segmentId: message.segmentId,
              profile: {
                engine: route.engine,
                requestedTier: message.tier || (message.engine === 'chirp3_hd' ? 'chirp3_hd' : 'gemini'),
                languageCode: route.languageCode,
                voiceName: route.voiceName,
                modelName: route.model || message.modelName,
                encoding: route.audioEncoding,
                streaming: message.mode === 'streaming',
                prompt: message.prompt
              },
              ssmlOptions: message.ssmlOptions || null, // CRITICAL: Pass SSML options from frontend
              // Gemini-TTS prompt fields
              promptPresetId: message.promptPresetId || null,
              ttsPrompt: message.ttsPrompt || null,
              intensity: message.intensity || null
            };

            console.log(`[Listener] TTS Request built:`, {
              segmentId: ttsRequest.segmentId,
              text: ttsRequest.text.substring(0, 50),
              voiceName: ttsRequest.profile.voiceName,
              tier: ttsRequest.profile.requestedTier,
              ssmlOptions: ttsRequest.ssmlOptions,
              promptPresetId: ttsRequest.promptPresetId,
              ttsPrompt: ttsRequest.ttsPrompt ? 'yes' : 'no',
              intensity: ttsRequest.intensity
            });

            // 3. Check quota
            const quotaCheck = canSynthesize({
              orgId: ttsRequest.orgId,
              userId: ttsRequest.userId,
              sessionId: ttsRequest.sessionId,
              characters: ttsRequest.text.length
            });

            if (!quotaCheck.allowed) {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'tts/error',
                  code: quotaCheck.error.code,
                  message: quotaCheck.error.message,
                  details: quotaCheck.error.details,
                  segmentId: message.segmentId
                }));
              }

              // Record failed usage
              await recordUsage({
                orgId: ttsRequest.orgId,
                userId: ttsRequest.userId,
                sessionId: ttsRequest.sessionId,
                segmentId: message.segmentId,
                requested: {
                  tier: message.tier || (message.engine === 'chirp3_hd' ? 'chirp3_hd' : 'gemini'),
                  voiceName: message.voiceName,
                  languageCode: message.languageCode
                },
                route: route, // Include even if failed (best effort)
                characters: ttsRequest.text.length,
                audioSeconds: null,
                status: 'failed',
                errorCode: quotaCheck.error.code,
                errorMessage: quotaCheck.error.message
              });

              return;
            }

            // 4. Validate policy
            const policyError = await validateTtsRequest(ttsRequest);
            if (policyError) {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'tts/error',
                  code: policyError.code,
                  message: policyError.message,
                  details: policyError.details,
                  segmentId: message.segmentId
                }));
              }

              // Record failed usage
              await recordUsage({
                orgId: ttsRequest.orgId,
                userId: ttsRequest.userId,
                sessionId: ttsRequest.sessionId,
                segmentId: message.segmentId,
                requested: {
                  tier: message.tier || (message.engine === 'chirp3_hd' ? 'chirp3_hd' : 'gemini'),
                  voiceName: message.voiceName,
                  languageCode: message.languageCode
                },
                route: route,
                characters: ttsRequest.text.length,
                audioSeconds: null,
                status: 'failed',
                errorCode: policyError.code,
                errorMessage: policyError.message
              });

              return;
            }

            // 5. Synthesize audio using the resolved route (provider-based)
            const ttsService = getTtsServiceForProvider(route.provider);
            const response = await ttsService.synthesizeUnary(ttsRequest, route);

            // PR4: Record metering event (feature-flagged)
            if (process.env.TTS_METERING_DEBUG === 'true') {
              try {
                const { recordMeteringEvent } = await import('./tts/ttsMetering.js');
                recordMeteringEvent({
                  orgId: ttsRequest.orgId,
                  userId: ttsRequest.userId,
                  sessionId: ttsRequest.sessionId,
                  segmentId: response.segmentId,
                  tier: route.tier,
                  voiceName: route.voiceName,
                  languageCode: route.languageCode,
                  mode: response.mode,
                  durationMs: response.audio.durationMs,
                  characters: ttsRequest.text.length
                });
              } catch (error) {
                console.error('[Listener] Metering failed:', error);
                // Non-fatal - continue with response
              }
            }

            // Send audio response with resolved routing info (streaming-compatible structure)
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/audio',
                segmentId: response.segmentId,
                audio: {
                  bytesBase64: response.audio.bytesBase64,
                  mimeType: response.audio.mimeType,
                  durationMs: response.audio.durationMs,
                  sampleRateHz: response.audio.sampleRateHz
                },
                mode: response.mode,
                // Include resolved routing for frontend visibility
                resolvedRoute: response.route,
                ssmlOptions: ttsRequest.ssmlOptions || null
              }));
            }

            // Record successful usage with routing details
            await recordUsage({
              orgId: ttsRequest.orgId,
              userId: ttsRequest.userId,
              sessionId: ttsRequest.sessionId,
              segmentId: message.segmentId,
              requested: {
                tier: message.tier || (message.engine === 'chirp3_hd' ? 'chirp3_hd' : 'gemini'),
                voiceName: message.voiceName,
                languageCode: message.languageCode
              },
              route: response.route,
              promptMetadata: response.promptMetadata || null, // Include prompt metadata from synthesis
              characters: ttsRequest.text.length,
              audioSeconds: response.durationMs ? response.durationMs / 1000 : null,
              status: 'success'
            });

            console.log(`[Listener] ${userName} TTS synthesis successful: ${message.segmentId}`);

          } catch (error) {
            console.error(`[Listener] ${userName} TTS synthesis error:`, error);

            // Parse error if it's a JSON string
            let errorCode = 'SYNTHESIS_FAILED';
            let errorMessage = error.message;
            let errorDetails = {};

            try {
              const parsedError = JSON.parse(error.message);
              errorCode = parsedError.code || errorCode;
              errorMessage = parsedError.message || errorMessage;
              errorDetails = parsedError.details || {};
            } catch (e) {
              // Not a JSON error, use as-is
            }

            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/error',
                code: errorCode,
                message: errorMessage,
                details: errorDetails,
                segmentId: message.segmentId
              }));
            }

            // Record failed usage
            await recordUsage({
              orgId: 'default',
              userId: userName || 'anonymous',
              sessionId: sessionId,
              segmentId: message.segmentId,
              requested: {
                tier: message.tier || (message.engine === 'chirp3_hd' ? 'chirp3_hd' : 'gemini'),
                voiceName: message.voiceName,
                languageCode: message.languageCode
              },
              // No resolved route in error case
              route: null,
              characters: message.text.length,
              audioSeconds: null,
              status: 'failed',
              errorCode: errorCode,
              errorMessage: errorMessage
            });
          }
        }
        // Listeners might send language changes
        else if (message.type === 'change_language' && message.targetLang) {
          console.log(`[Listener] ${userName} changing language to ${message.targetLang}`);

          // Update listener's language (removes from old group, adds to new group)
          sessionStore.updateListenerLanguage(sessionId, socketId, message.targetLang);

          // Notify host about language change
          const updatedSession = sessionStore.getSession(sessionId);
          if (updatedSession && updatedSession.hostSocket && updatedSession.hostSocket.readyState === WebSocket.OPEN) {
            const stats = sessionStore.getSessionStats(sessionId);
            updatedSession.hostSocket.send(JSON.stringify({
              type: 'session_stats',
              stats: stats
            }));
          }

          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'language_changed',
              targetLang: message.targetLang
            }));
          }
        }
      } catch (error) {
        console.error('[Listener] Error processing message:', error);
      }
    });

  } catch (error) {
    console.error('[Listener] Error:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'error',
        message: error.message
      }));
    }
    clientWs.close();
  }
}

