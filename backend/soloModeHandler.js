/**
 * Solo Mode Handler - Uses Google Cloud Speech for transcription + OpenAI for translation
 * 
 * ARCHITECTURE:
 * - Google Cloud Speech-to-Text for streaming transcription with live partials
 * - OpenAI Chat API for translation of final transcripts
 * - Live partial results shown immediately for responsive UX
 * - Final results translated and displayed
 */

import { GoogleSpeechStream } from './googleSpeechStream.js';
import WebSocket from 'ws';
import translationManager from './translationManager.js';
import { grammarWorker } from './grammarWorker.js';
import { partialTranslationWorker, finalTranslationWorker } from './translationWorkers.js';
import { realtimePartialTranslationWorker, realtimeFinalTranslationWorker } from './translationWorkersRealtime.js';
import { normalizePunctuation } from './transcriptionCleanup.js';
import { CoreEngine } from '../core/engine/coreEngine.js';
import { mergeRecoveryText, wordsAreRelated } from './utils/recoveryMerge.js';
import { deduplicatePartialText } from '../core/utils/partialDeduplicator.js';
import { shouldEmitPartial, shouldEmitFinal, setLastEmittedText, clearLastEmittedText, hasAlphaNumeric } from '../core/utils/emitGuards.js';
import { onCommittedSegment, cleanupSession } from './tts/TtsStreamingOrchestrator.js';
import { resolveVoice } from './tts/voiceResolver.js';
import { isStreamingEnabled } from './tts/ttsStreamingConfig.js';
import { resolveModel, getAllowedTtsTiers } from './entitlements/index.js';
import { recordUsageEvent } from './usage/recordUsage.js';
import { startSessionSpan, heartbeatSessionSpan, stopSessionSpan } from './usage/sessionSpans.js';
import { checkQuotaLimit, createQuotaEvent } from './usage/quotaEnforcement.js';
import { supabaseAdmin } from './supabaseAdmin.js';
import crypto from 'crypto';
// PHASE 7: Using CoreEngine which coordinates all extracted engines
// Individual engines are still accessible via coreEngine properties if needed

export async function handleSoloMode(clientWs) {
  console.log("[SoloMode] ⚡ Connection using Google Speech + OpenAI Translation");

  let speechStream = null;
  let currentSourceLang = 'en';
  let currentTargetLang = 'es';
  let usePremiumTier = false; // Tier selection: false = basic (Chat API), true = premium (Realtime API)
  let legacySessionId = `session_${Date.now()}`;
  let currentVoiceId = null; // Track selected voice ID
  let currentTtsMode = 'unary'; // Track TTS mode: 'streaming' or 'unary' (default unary to prevent duplicates)

  // MULTI-SESSION OPTIMIZATION: Track this session for fair-share allocation
  // This allows the rate limiter to distribute capacity fairly across sessions
  let sessionId = legacySessionId;

  // SESSION-LEVEL USAGE TRACKING: Count total transcribed characters for aggregate STT metering
  let totalTranscribedCharacters = 0;
  const sessionStartTime = Date.now();

  // SESSION SPAN TRACKING: Track streaming time for quota enforcement (solo mode)
  let sessionSpanStarted = false;
  let sessionSpanHeartbeatInterval = null;
  const SESSION_SPAN_HEARTBEAT_MS = 30000; // 30 seconds

  // QUOTA ENFORCEMENT: Track if warning has been sent this session
  let quotaWarningSent = false;
  let quotaExceeded = false;

  // SESSION TRACKING UUID: Ensure we have a valid UUID for DB relationships (Foreign Keys)
  let trackingSessionId = null;
  let sessionSpanStartPromise = null;

  // Helper to ensure a valid DB session exists for metering
  const ensureTrackingSession = async (churchId) => {
    // If we already have a tracking ID, use it
    if (trackingSessionId) return trackingSessionId;

    // Use a local candidate ID first - DO NOT assign global trackingSessionId until success
    const candidateId = crypto.randomUUID();
    // Use 6-char alphanumeric code to satisfy database constraints (matching SessionStore format)
    // Start with 'S' to distinguish Solo mode, followed by 5 random chars
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let sessionCode = 'S';
    for (let i = 0; i < 5; i++) {
      sessionCode += chars.charAt(crypto.randomInt(0, chars.length));
    }

    try {
      // console.log(`[SoloMode] Creating metering session ${candidateId} (church: ${churchId})`);
      const { error } = await supabaseAdmin.from('sessions').insert({
        id: candidateId,
        church_id: churchId,
        status: 'active',
        source_lang: currentSourceLang,
        session_code: sessionCode,
        metadata: {
          mode: 'solo',
          client_session_id: sessionId // Link back to client ID
        }
      });

      if (error) {
        console.error(`[SoloMode] ⚠️ Failed to create metering session: ${error.message}`);
        // If we can't create the session, session_spans will likely fail with FK violation
        // preventing meaningful usage tracking.
        return null;
      }

      // SUCCESS - now we can safely use this as our tracking ID
      trackingSessionId = candidateId;
      return trackingSessionId;
    } catch (err) {
      console.error(`[SoloMode] ⚠️ Error creating metering session:`, err);
      return null;
    }
  };

  // Helper to ensure session span is active (called on both JSON 'audio' and binary messages)
  const ensureSessionActive = () => {
    // START SESSION SPAN on first audio (active streaming time only)
    // CRITICAL: Fire-and-forget pattern - DO NOT BLOCK audio processing
    if (!sessionSpanStarted) {
      sessionSpanStarted = true; // Mark as started immediately to prevent duplicate calls
      const meteringChurchId = clientWs.churchId || process.env.TEST_CHURCH_ID;

      if (meteringChurchId) {
        // Non-blocking: start span in background, tracked via promise
        sessionSpanStartPromise = (async () => {
          // Ensure we have a valid session row in DB first (calls to session_spans require FK)
          const validSessionId = await ensureTrackingSession(meteringChurchId);

          if (!validSessionId) {
            console.log(`[SoloMode] ⚠️ Skipping session span start (no valid DB session)`);
            sessionSpanStarted = false; // Reset to allow retry
            return;
          }

          startSessionSpan({
            sessionId: validSessionId,
            churchId: meteringChurchId,
            metadata: { sourceLang: currentSourceLang, targetLang: currentTargetLang, mode: 'solo' }
          }).then(spanResult => {
            console.log(`[SoloMode] 🎙️ Start span result:`, JSON.stringify(spanResult));
            if (spanResult.alreadyActive) {
              console.log(`[SoloMode] 🎙️ Session span already active (resuming)`);
            } else {
              console.log(`[SoloMode] 🎙️ Started session span on first audio (church: ${meteringChurchId})`);
            }

            // Start heartbeat interval (only after successful span start)
            if (!sessionSpanHeartbeatInterval) {
              sessionSpanHeartbeatInterval = setInterval(async () => {
                try {
                  await heartbeatSessionSpan({ sessionId: validSessionId });

                  // Check quota limits alongside heartbeat
                  const churchId = clientWs.churchId || process.env.TEST_CHURCH_ID;
                  if (churchId && !quotaExceeded) {
                    const quotaResult = await checkQuotaLimit(churchId, 'solo');

                    if (quotaResult.action === 'lock') {
                      quotaExceeded = true;
                      const event = createQuotaEvent(quotaResult);
                      if (clientWs.readyState === WebSocket.OPEN && event) {
                        clientWs.send(JSON.stringify(event));
                        console.log(`[SoloMode] 🚫 QUOTA EXCEEDED - sent quota_exceeded event`);
                      }
                    } else if (quotaResult.action === 'warn' && !quotaWarningSent) {
                      quotaWarningSent = true;
                      const event = createQuotaEvent(quotaResult);
                      if (clientWs.readyState === WebSocket.OPEN && event) {
                        clientWs.send(JSON.stringify(event));
                        console.log(`[SoloMode] ⚠️ Quota warning sent: ${quotaResult.message}`);
                      }
                    }
                  }
                } catch (err) {
                  // Silent heartbeat/quota check failures
                }
              }, SESSION_SPAN_HEARTBEAT_MS);
            }
          }).catch(err => {
            console.error(`[SoloMode] ✗ Failed to start session span:`, err.message);
            // CRITICAL: Reset flag so we can try again on next audio chunk
            sessionSpanStarted = false;
          });
        })();
      }
    }
  };

  // PHASE 1: Extract entitlements from WS connection (attached by server.js)
  const entitlements = clientWs.entitlements || null;
  let translateModel = 'gpt-4o-mini'; // Default if no entitlements

  if (entitlements) {
    try {
      const translateRouting = resolveModel(entitlements, 'translate');
      translateModel = translateRouting.model;
      console.log(`[SoloMode] ✓ Using resolved translate model: ${translateModel}`);
    } catch (err) {
      console.warn(`[SoloMode] Failed to resolve translate model, using default: ${err.message}`);
    }
  } else {
    console.log(`[SoloMode] No entitlements - using default translate model: ${translateModel}`);
  }

  // PHASE 7: Core Engine Orchestrator - coordinates all extracted engines
  // Initialize core engine (replaces individual engine instances)
  const coreEngine = new CoreEngine({
    bibleConfig: {
      confidenceThreshold: 0.85,
      aiFallbackThreshold: 0.70,
      enableLLMConfirmation: true,
      llmModel: 'gpt-4o-mini',
      openaiApiKey: process.env.OPENAI_API_KEY,
      transcriptWindowSeconds: 10
    }
  });
  coreEngine.initialize();

  // PHASE 7: Access individual engines via coreEngine for backward compatibility
  const timelineTracker = coreEngine.timelineTracker;
  const rttTracker = coreEngine.rttTracker;
  const partialTracker = coreEngine.partialTracker;
  const finalizationEngine = coreEngine.finalizationEngine;
  const forcedCommitEngine = coreEngine.forcedCommitEngine;

  const DEFAULT_LOOKAHEAD_MS = 200; // Default 200ms lookahead (used by RTT tracker)

  // PHASE 7: Constants now from core engine (for backward compatibility)
  const MAX_FINALIZATION_WAIT_MS = finalizationEngine.MAX_FINALIZATION_WAIT_MS;
  const FINALIZATION_CONFIRMATION_WINDOW = finalizationEngine.FINALIZATION_CONFIRMATION_WINDOW;
  const MIN_SILENCE_MS = finalizationEngine.MIN_SILENCE_MS;
  const FORCED_FINAL_MAX_WAIT_MS = forcedCommitEngine.FORCED_FINAL_MAX_WAIT_MS;
  const TRANSLATION_RESTART_COOLDOWN_MS = 400; // Pause realtime translations briefly after stream restart

  // PHASE 6: Compatibility layer - forcedFinalBuffer variable synced with engine
  let forcedFinalBuffer = null;

  // Helper to sync forcedFinalBuffer from engine (call after engine operations)
  const syncForcedFinalBuffer = () => {
    forcedFinalBuffer = forcedCommitEngine.getForcedFinalBuffer();
  };

  // PHASE 5: Compatibility layer - pendingFinalization variable synced with engine
  // This allows existing code to continue working with minimal changes
  let pendingFinalization = null;

  // Helper to sync pendingFinalization from engine (call after engine operations)
  const syncPendingFinalization = () => {
    pendingFinalization = finalizationEngine.getPendingFinalization();
  };

  // Helper to update engine from pendingFinalization (call before engine operations)
  const updateEngineFromPending = () => {
    if (pendingFinalization && !finalizationEngine.hasPendingFinalization()) {
      finalizationEngine.createPendingFinalization(pendingFinalization.text, pendingFinalization.seqId);
      if (pendingFinalization.timestamp) {
        finalizationEngine.pendingFinalization.timestamp = pendingFinalization.timestamp;
      }
      if (pendingFinalization.maxWaitTimestamp) {
        finalizationEngine.pendingFinalization.maxWaitTimestamp = pendingFinalization.maxWaitTimestamp;
      }
    } else if (pendingFinalization && finalizationEngine.hasPendingFinalization()) {
      finalizationEngine.updatePendingFinalizationText(pendingFinalization.text);
    }
  };

  // Last audio timestamp for silence detection
  let lastAudioTimestamp = null;
  let silenceStartTime = null;
  // PHASE 6: forcedFinalBuffer is now managed by forcedCommitEngine (see compatibility layer above)
  let realtimeTranslationCooldownUntil = 0;

  // Track next final that arrives after recovery starts (to prevent word duplication)
  let nextFinalAfterRecovery = null;
  let recoveryStartTime = 0;

  // PHASE 2: RTT functions now delegate to RTT tracker
  // Helper: Calculate RTT from client timestamp (delegates to RTT tracker)
  const measureRTT = (clientTimestamp) => {
    return rttTracker.measureRTT(clientTimestamp);
  };

  // Helper: Get adaptive lookahead based on RTT (delegates to RTT tracker)
  const getAdaptiveLookahead = () => {
    return rttTracker.getAdaptiveLookahead();
  };

  // PHASE 3: Send message with sequence info (uses Timeline Offset Tracker)
  // Helper: Send message with sequence info
  const sendWithSequence = (messageData, isPartial = true) => {
    // OPTIMIZATION: If seqId is provided in messageData (for updates), use it; otherwise generate new one
    let seqId;
    let message;

    if (messageData.seqId !== undefined) {
      // Reuse existing seqId for updates (e.g., grammar/translation updates for forced finals)
      seqId = messageData.seqId;
      const { seqId: _, ...dataWithoutSeqId } = messageData; // Extract seqId to avoid duplication
      message = {
        ...dataWithoutSeqId,
        seqId, // Add seqId back explicitly
        serverTimestamp: Date.now(),
        isPartial,
        type: messageData.type || 'translation',
        targetLang: messageData.targetLang || currentTargetLang // Inject targetLang context
      };
    } else {
      // Generate new seqId for new messages
      // Inject targetLang if missing
      const dataWithLang = {
        ...messageData,
        targetLang: messageData.targetLang || currentTargetLang
      };
      const sequenced = timelineTracker.createSequencedMessage(dataWithLang, isPartial);
      message = sequenced.message;
      seqId = sequenced.seqId;
    }

    // Add transcript and translation keys for API compatibility
    if (message.type === 'translation') {
      // transcript = originalText or correctedText (prefer corrected)
      message.transcript = message.correctedText || message.originalText || '';

      // translation = translatedText or transcript (if transcription-only)
      message.translation = message.translatedText ||
        (message.isTranscriptionOnly ? message.transcript : '') ||
        '';
    }

    // DEBUG: Log sequence ID for verification (Phase 3)
    const updateType = message.updateType ? ` (${message.updateType} update)` : '';
    console.log(`[SoloMode] 📤 Sending message (seq: ${seqId}, isPartial: ${isPartial}${updateType})`);

    // DEBUG: Log if correctedText is present
    if (message.correctedText && message.originalText !== message.correctedText) {
      console.log(`[SoloMode]   CORRECTION: originalText: "${message.originalText?.substring(0, 60)}${(message.originalText?.length || 0) > 60 ? '...' : ''}"`);
      console.log(`[SoloMode]   CORRECTION: correctedText: "${message.correctedText?.substring(0, 60)}${(message.correctedText?.length || 0) > 60 ? '...' : ''}"`);
      console.log(`[SoloMode]   hasCorrection: ${message.hasCorrection}`);
    }

    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(message));
    }

    return seqId;
  };

  // Helper: Trigger TTS streaming for committed segments
  const triggerTtsStreaming = async (seqId, text, targetLang, voiceId = null) => {
    // Only trigger for non-empty text
    if (!text || text.trim().length === 0) return;
    // CRITICAL: Check if streaming is enabled based on frontend's ttsMode setting
    if (!isStreamingEnabled({ ttsMode: currentTtsMode })) {
      console.log(`[SoloMode] Skipping backend TTS - ttsMode is '${currentTtsMode}' (frontend handles unary)`);
      return;
    }

    // DEBUG: Log voice selection state before resolution
    console.log(`[SoloMode] Resolving voice for TTS - targetLang: ${targetLang || currentTargetLang}`);
    console.log(`[SoloMode]   Specific voiceId arg: ${voiceId}`);
    console.log(`[SoloMode]   Persisted currentVoiceId: ${currentVoiceId}`);

    // Resolve voice using authoritative catalog
    // We use sessionId as orgId for solo mode for now
    // We allow all tiers that might support streaming

    // Extract tier from voiceId URN if present (e.g. google_cloud_tts:chirp3_hd:...)
    let voiceIdToUse = voiceId || currentVoiceId;
    let tierToUse = null;

    if (voiceIdToUse) {
      if (voiceIdToUse.includes(':')) {
        const parts = voiceIdToUse.split(':');
        if (parts.length >= 2) {
          // Map URN tier 'gemini_tts' to 'gemini' for the resolver check
          tierToUse = parts[1] === 'gemini_tts' ? 'gemini' : parts[1];
        }
      } else if (voiceIdToUse.startsWith('elevenlabs')) {
        tierToUse = 'elevenlabs';
      }
    }

    // Get allowed TTS tiers from entitlements (defaults to all if no entitlements)
    const allowedTiers = entitlements
      ? getAllowedTtsTiers(entitlements.limits.ttsTier)
      : ['gemini', 'chirp3_hd', 'neural2', 'elevenlabs_v3', 'elevenlabs_turbo', 'elevenlabs_flash', 'elevenlabs', 'studio', 'standard'];

    // If no tiers allowed, TTS is disabled for this subscription
    if (allowedTiers.length === 0) {
      console.warn(`[SoloMode] TTS disabled - no allowed tiers for this subscription`);
      return;
    }

    const resolved = await resolveVoice({
      orgId: sessionId,
      userPref: voiceIdToUse ? { voiceId: voiceIdToUse, tier: tierToUse } : null,
      languageCode: targetLang || currentTargetLang,
      allowedTiers
    });

    console.log(`[SoloMode]   -> Resolved to: ${resolved.voiceId} (tier: ${resolved.tier})`);

    console.log(`[SoloMode] Triggering TTS: voiceId=${resolved.voiceId}, tier=${resolved.tier}, reason=${resolved.reason}`);

    onCommittedSegment(sessionId, {
      seqId,
      text: text.trim(),
      lang: targetLang || currentTargetLang,
      voiceId: resolved.voiceId,
      isFinal: true
    }, clientWs.churchId);
  };

  // Handle client messages
  clientWs.on("message", async (msg, isBinary) => {
    // Phase 7: Handle binary messages (raw audio)
    // ONLY trust the isBinary flag from the websocket library
    // Do NOT check Buffer.isBuffer(msg) because ws returns Buffers for text frames too
    if (isBinary) {
      // QUOTA GATE: Silently drop audio if quota exceeded
      if (quotaExceeded) return;

      if (speechStream) {
        ensureSessionActive();
        speechStream.write(msg);
      } else {
        // Debug: received binary but stream not ready
        // This might happen if audio starts before 'init'
      }
      return;
    }


    try {
      const message = JSON.parse(msg.toString());
      // Filter out noisy audio message logs
      if (message.type !== 'audio') {
        console.log("[SoloMode] RAW MSG RECEIVED:", message.type);
        console.log("[SoloMode] Client message:", message.type);
      }

      switch (message.type) {
        case 'ping':
          // Respond to keep-alive ping with pong
          if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'pong',
              timestamp: message.timestamp || Date.now()
            }))
          }
          return; // Don't log ping messages
        case 'pong':
          // Keep-alive pong received (frontend confirms connection alive)
          return; // Don't log pong messages
        case 'init':
          // QUOTA GATE: Check before allowing session to initialize
          {
            const initChurchId = clientWs.churchId || process.env.TEST_CHURCH_ID;
            if (initChurchId) {
              try {
                const initQuota = await checkQuotaLimit(initChurchId, 'solo');
                if (initQuota.action === 'lock') {
                  quotaExceeded = true;
                  const event = createQuotaEvent(initQuota);
                  if (clientWs.readyState === WebSocket.OPEN && event) {
                    clientWs.send(JSON.stringify(event));
                  }
                  console.log(`[SoloMode] 🚫 INIT BLOCKED - quota exceeded for church ${initChurchId}`);
                  break; // Do not initialize speech stream
                } else if (initQuota.action === 'warn' && !quotaWarningSent) {
                  quotaWarningSent = true;
                  const event = createQuotaEvent(initQuota);
                  if (clientWs.readyState === WebSocket.OPEN && event) {
                    clientWs.send(JSON.stringify(event));
                  }
                  console.log(`[SoloMode] ⚠️ Quota warning sent on init: ${initQuota.message}`);
                }
              } catch (err) {
                console.error(`[SoloMode] ⚠️ Init quota check failed (allowing session):`, err.message);
                // Fail-open: allow session if quota check errors
              }
            }
          }

          // Update language preferences and tier
          const prevSourceLang = currentSourceLang;
          const prevTargetLang = currentTargetLang;

          console.log(`[SoloMode] Init received - sourceLang: ${message.sourceLang}, targetLang: ${message.targetLang}, tier: ${message.tier || 'basic'}`);

          currentSourceLang = message.sourceLang || 'en';
          currentTargetLang = message.targetLang || 'es';
          usePremiumTier = message.tier === 'premium';

          // Update voice preference if provided
          if (message.voiceId) {
            currentVoiceId = message.voiceId;
            console.log(`[SoloMode] 🎙️ Voice updated to: ${currentVoiceId}`);
          }

          if (message.sessionId) {
            sessionId = message.sessionId;
            console.log(`[SoloMode] 🔗 Synced session ID: ${sessionId}`);
          }

          if (message.sourceLang) {
            currentSourceLang = message.sourceLang;
          }
          if (message.targetLang) {
            currentTargetLang = message.targetLang;
          }
          // Update TTS mode if provided (streaming or unary)
          if (message.ttsMode) {
            currentTtsMode = message.ttsMode;
            console.log(`[SoloMode] 🔊 TTS mode set to: ${currentTtsMode}`);
          }
          if (message.tier !== undefined) {
            let newTier = message.tier === 'premium' || message.tier === true;

            // PHASE 7: Tier Gating - Only Unlimited plan can use Premium (GPT Realtime) tier
            if (newTier && entitlements && entitlements.subscription.planCode !== 'unlimited') {
              console.warn(`[SoloMode] 🚫 TIER GATING: Plan '${entitlements.subscription.planCode}' rejected premium tier request. Falling back to basic.`);

              // Only send warning if they explicitly requested premium
              if (message.tier === 'premium' || message.tier === true) {
                clientWs.send(JSON.stringify({
                  type: 'warning',
                  message: 'Your current plan does not support Premium (Realtime) mode. Falling back to Basic.',
                  plan: entitlements.subscription.planCode
                }));
              }
              newTier = false;
            }

            const tierChanged = newTier !== usePremiumTier;
            usePremiumTier = newTier;

            if (tierChanged) {
              console.log(`[SoloMode] 🔄 TIER SWITCHED: ${usePremiumTier ? 'BASIC → PREMIUM' : 'PREMIUM → BASIC'}`);
              console.log(`[SoloMode] 📊 New Tier: ${usePremiumTier ? 'PREMIUM (gpt-realtime-mini)' : 'BASIC (gpt-4o-mini Chat API)'}`);
              console.log(`[SoloMode] ⚡ Expected Latency: ${usePremiumTier ? '150-300ms' : '400-1500ms'}`);
              console.log(`[SoloMode] 💰 Cost Multiplier: ${usePremiumTier ? '3-4x' : '1x'}`);
            } else {
              console.log(`[SoloMode] Tier: ${usePremiumTier ? 'PREMIUM (Realtime API)' : 'BASIC (Chat API)'}`);
            }
          }

          const isTranscription = currentSourceLang === currentTargetLang;
          console.log(`[SoloMode] Languages: ${currentSourceLang} → ${currentTargetLang} (${isTranscription ? 'TRANSCRIPTION' : 'TRANSLATION'} mode)`);

          // Reinitialize stream if source language changed
          const languagesChanged = (prevSourceLang !== currentSourceLang);
          if (languagesChanged && speechStream) {
            console.log('[SoloMode] 🔄 Source language changed! Destroying old stream...');
            speechStream.destroy();
            speechStream = null;
            await new Promise(resolve => setTimeout(resolve, 200));
          }

          // Initialize Google Speech stream if needed
          if (!speechStream) {
            try {
              console.log(`[SoloMode] 🚀 Creating Google Speech stream for ${currentSourceLang}...`);
              speechStream = new GoogleSpeechStream();

              // Initialize with source language and dynamic options from init message
              await speechStream.initialize(currentSourceLang, {
                encoding: message.encoding,
                sampleRateHertz: message.sampleRateHertz,
                disablePunctuation: false,
                enableMultiLanguage: message.enableMultiLanguage,
                alternativeLanguageCodes: message.alternativeLanguageCodes,
                enableSpeakerDiarization: message.enableSpeakerDiarization,
                minSpeakers: message.minSpeakers,
                maxSpeakers: message.maxSpeakers,
                entitlements: entitlements // PHASE 7: Pass entitlements for STT version routing
              });

              const isTranscriptionOnly = currentSourceLang === currentTargetLang;

              // Set up error callback
              speechStream.onError((error) => {
                console.error('[SoloMode] Speech stream error:', error);
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({
                    type: 'warning',
                    message: 'Transcription service restarting...',
                    code: error.code
                  }));
                }
              });

              // Translation throttling for partials
              let lastPartialTranslation = '';
              let lastPartialTranslationTime = 0;
              let pendingPartialTranslation = null;
              let currentPartialText = ''; // Track current partial text for delayed translations

              // PHASE 7: Partial Tracker now accessed via CoreEngine
              // Use the partial tracker from coreEngine (already initialized)
              const partialTracker = coreEngine.partialTracker;

              // PHASE 4: Helper getters for backward compatibility (delegate to tracker)
              // These allow existing code to continue working with minimal changes
              const getLatestPartialText = () => partialTracker.getLatestPartial();
              const getLongestPartialText = () => partialTracker.getLongestPartial();
              const getLatestPartialTime = () => partialTracker.getLatestPartialTime();
              const getLongestPartialTime = () => partialTracker.getLongestPartialTime();
              const getLatestPartialTextForCorrection = () => partialTracker.getLatestPartialForCorrection();

              // PHASE 4: Compatibility layer - variables that reference tracker (for closures/timeouts)
              // These are kept in sync via getter functions
              let latestPartialText = '';
              let longestPartialText = '';
              let latestPartialTime = 0;
              let longestPartialTime = 0;
              let latestPartialTextForCorrection = '';

              // Helper to sync variables from tracker (call after updatePartial)
              const syncPartialVariables = () => {
                latestPartialText = getLatestPartialText();
                longestPartialText = getLongestPartialText();
                latestPartialTime = getLatestPartialTime();
                longestPartialTime = getLongestPartialTime();
                latestPartialTextForCorrection = getLatestPartialTextForCorrection();
              };

              // CRITICAL: Track last sent FINAL to merge consecutive continuations
              let lastSentFinalText = ''; // Last FINAL text that was sent to client
              let segmentStartTime = null; // Track segment start time for grace window
              let lastSentFinalTime = 0; // Timestamp when last FINAL was sent
              let lastSentOriginalText = ''; // Track original text to prevent grammar correction duplicates
              const FINAL_CONTINUATION_WINDOW_MS = 3000; // 3 seconds - if new FINAL arrives within this window and continues last, merge them

              // PHASE 4: Helper functions now delegate to Partial Tracker
              // Helper function to tokenize text for overlap matching (delegates to tracker)
              const tokenize = (text) => {
                return partialTracker.tokenize(text);
              };

              // Helper function to calculate token overlap (delegates to tracker)
              const calculateTokenOverlap = (tokens1, tokens2) => {
                return partialTracker.calculateTokenOverlap(tokens1, tokens2);
              };

              // Helper function to merge tokens (delegates to tracker)
              const mergeTokens = (text1, text2) => {
                return partialTracker.mergeTokens(text1, text2);
              };

              // Persist grammar corrections so we can reapply them to extending partials
              const grammarCorrectionCache = new Map();
              const MAX_GRAMMAR_CACHE_ENTRIES = 20;
              const MIN_GRAMMAR_CACHE_LENGTH = 5;
              const MAX_LENGTH_MULTIPLIER = 3; // Prevent runaway replacements

              const rememberGrammarCorrection = (originalText, correctedText) => {
                if (!originalText || !correctedText) return;
                if (originalText === correctedText) return;
                if (originalText.length < MIN_GRAMMAR_CACHE_LENGTH) return;
                const lengthRatio = correctedText.length / originalText.length;
                if (lengthRatio > MAX_LENGTH_MULTIPLIER) {
                  // Skip caching corrections that balloon in size - usually hallucinations
                  return;
                }
                grammarCorrectionCache.set(originalText, {
                  original: originalText,
                  corrected: correctedText,
                  timestamp: Date.now()
                });
                while (grammarCorrectionCache.size > MAX_GRAMMAR_CACHE_ENTRIES) {
                  const oldestKey = grammarCorrectionCache.keys().next().value;
                  if (!oldestKey) break;
                  grammarCorrectionCache.delete(oldestKey);
                }
              };

              const applyCachedCorrections = (text) => {
                if (!text || grammarCorrectionCache.size === 0) {
                  return text;
                }
                let updated = text;
                const cacheEntries = Array.from(grammarCorrectionCache.values())
                  .sort((a, b) => b.original.length - a.original.length);
                for (const { original, corrected } of cacheEntries) {
                  if (!original || original === corrected) continue;
                  if (updated === original) {
                    updated = corrected;
                    break;
                  }
                  if (updated.startsWith(original)) {
                    updated = corrected + updated.substring(original.length);
                    break; // Apply only the most specific correction
                  }
                }
                return updated;
              };

              // PHASE 4: mergeWithOverlap now delegates to Partial Tracker
              const mergeWithOverlap = (previousText = '', currentText = '') => {
                return partialTracker.mergeWithOverlap(previousText, currentText);
              };

              // Helper: Check if text ends with a complete word (not mid-word)
              const endsWithCompleteWord = (text) => {
                if (!text || text.length === 0) return true;
                const trimmed = text.trim();
                // Ends with punctuation, space, or is empty
                if (/[.!?…,;:\s]$/.test(trimmed)) return true;
                // Check if last "word" is actually complete (has word boundary after it in partials)
                // This is a heuristic - if text doesn't end with space/punctuation, it might be mid-word
                return false;
              };

              // PHASE 5: endsWithCompleteSentence now delegates to Finalization Engine
              // Helper: Check if text ends with a complete sentence
              // A complete sentence ends with sentence-ending punctuation (. ! ?) followed by optional quotes/closing punctuation
              const endsWithCompleteSentence = (text) => {
                // Delegate to finalization engine (which has the same logic)
                return finalizationEngine.endsWithCompleteSentence(text);
                // Original logic preserved in FinalizationEngine.endsWithCompleteSentence():
                // - Checks for sentence-ending punctuation (. ! ? …)
                // - Handles closing quotes/parentheses
                // - Returns true if ends with punctuation/space
              };

              // Keep original logic comment for reference:
              /*
              Original logic:
                if (!text || text.length === 0) return false;
                const trimmed = text.trim();
                // Ends with sentence-ending punctuation (period, exclamation, question mark, ellipsis)
                // May be followed by closing quotes, parentheses, or other closing punctuation
                if (/[.!?…]["')]*\s*$/.test(trimmed)) return true;
                // Also check for common sentence-ending patterns
                if (/[.!?…]\s*$/.test(trimmed)) return true;
                return false;
              */

              // SIMPLE FIX: Just use the longest partial we've seen - no complex delays

              // Ultra-low throttle for real-time feel - updates every 1-2 chars
              const THROTTLE_MS = 0; // No throttle - instant translation on every character

              // Helper function to check for partials that extend a just-sent FINAL
              // This should ALWAYS be called after a FINAL is sent to catch any partials that arrived
              const checkForExtendingPartialsAfterFinal = (sentFinalText) => {
                if (!sentFinalText) return;

                const sentFinalTrimmed = sentFinalText.trim();
                const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;

                // Check if any partials extend the just-sent FINAL
                let foundExtension = false;

                if (longestPartialText && longestPartialText.length > sentFinalTrimmed.length && timeSinceLongest < 5000) {
                  const longestTrimmed = longestPartialText.trim();
                  const sentNormalized = sentFinalTrimmed.replace(/\s+/g, ' ').toLowerCase();
                  const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
                  const extendsFinal = longestNormalized.startsWith(sentNormalized) ||
                    (sentFinalTrimmed.length > 5 && longestNormalized.substring(0, sentNormalized.length) === sentNormalized) ||
                    longestTrimmed.startsWith(sentFinalTrimmed) ||
                    (sentFinalTrimmed.length > 5 && longestTrimmed.substring(0, sentFinalTrimmed.length) === sentFinalTrimmed);

                  if (extendsFinal) {
                    const missingWords = longestPartialText.substring(sentFinalTrimmed.length).trim();
                    console.log(`[SoloMode] ⚠️ Partial extends just-sent FINAL - likely continuation (FINAL: "${sentFinalTrimmed.substring(Math.max(0, sentFinalTrimmed.length - 50))}", partial extends by: "${missingWords.substring(0, 50)}...")`);
                    foundExtension = true;
                  } else {
                    // Check for overlap
                    const merged = mergeWithOverlap(sentFinalTrimmed, longestTrimmed);
                    if (merged && merged.length > sentFinalTrimmed.length + 3) {
                      const missingWords = merged.substring(sentFinalTrimmed.length).trim();
                      console.log(`[SoloMode] ⚠️ Partial extends just-sent FINAL via overlap - likely continuation (FINAL: "${sentFinalTrimmed.substring(Math.max(0, sentFinalTrimmed.length - 50))}", partial extends by: "${missingWords.substring(0, 50)}...")`);
                      foundExtension = true;
                    }
                  }
                } else if (latestPartialText && latestPartialText.length > sentFinalTrimmed.length && timeSinceLatest < 5000) {
                  const latestTrimmed = latestPartialText.trim();
                  const sentNormalized = sentFinalTrimmed.replace(/\s+/g, ' ').toLowerCase();
                  const latestNormalized = latestTrimmed.replace(/\s+/g, ' ').toLowerCase();
                  const extendsFinal = latestNormalized.startsWith(sentNormalized) ||
                    (sentFinalTrimmed.length > 5 && latestNormalized.substring(0, sentNormalized.length) === sentNormalized) ||
                    latestTrimmed.startsWith(sentFinalTrimmed) ||
                    (sentFinalTrimmed.length > 5 && latestTrimmed.substring(0, sentFinalTrimmed.length) === sentFinalTrimmed);

                  if (extendsFinal) {
                    const missingWords = latestPartialText.substring(sentFinalTrimmed.length).trim();
                    console.log(`[SoloMode] ⚠️ Partial extends just-sent FINAL - likely continuation (FINAL: "${sentFinalTrimmed.substring(Math.max(0, sentFinalTrimmed.length - 50))}", partial extends by: "${missingWords.substring(0, 50)}...")`);
                    foundExtension = true;
                  } else {
                    // Check for overlap
                    const merged = mergeWithOverlap(sentFinalTrimmed, latestTrimmed);
                    if (merged && merged.length > sentFinalTrimmed.length + 3) {
                      const missingWords = merged.substring(sentFinalTrimmed.length).trim();
                      console.log(`[SoloMode] ⚠️ Partial extends just-sent FINAL via overlap - likely continuation (FINAL: "${sentFinalTrimmed.substring(Math.max(0, sentFinalTrimmed.length - 50))}", partial extends by: "${missingWords.substring(0, 50)}...")`);
                      foundExtension = true;
                    }
                  }
                }

                if (!foundExtension) {
                  // Still log that we checked (for debugging)
                  const finalEndsWithCompleteSentence = endsWithCompleteSentence(sentFinalTrimmed);
                  if (!finalEndsWithCompleteSentence) {
                    console.log(`[SoloMode] ✓ Checked for extending partials after FINAL (none found): "${sentFinalTrimmed.substring(Math.max(0, sentFinalTrimmed.length - 50))}"`);
                  }
                }
              };

              // Flag to prevent concurrent final processing
              let isProcessingFinal = false;
              // Queue for finals that arrive while another is being processed
              const finalProcessingQueue = [];

              // Helper function to process final text (defined here so it can access closure variables)
              const processFinalText = (textToProcess, options = {}) => {
                // If already processing, queue this final instead of processing immediately
                if (isProcessingFinal) {
                  console.log(`[SoloMode] ⏳ Final already being processed, queuing: "${textToProcess.substring(0, 60)}..."`);
                  finalProcessingQueue.push({ textToProcess, options });
                  return; // Queue instead of process immediately
                }

                // Process immediately
                (async () => {
                  try {
                    // Set flag to prevent concurrent processing
                    isProcessingFinal = true;
                    // CRITICAL: Duplicate prevention - check against both original and corrected text
                    // This prevents sending grammar-corrected version of same original text twice
                    const trimmedText = textToProcess.trim();
                    const textNormalized = trimmedText.replace(/\s+/g, ' ').toLowerCase();

                    // SESSION USAGE TRACKING: Count transcribed characters (after duplicate check)
                    // This runs before duplicate detection returns, so we count all unique finals
                    totalTranscribedCharacters += trimmedText.length;

                    // Always check for duplicates if we have tracking data (not just within time window)
                    // This catches duplicates even if they arrive outside the continuation window
                    if (lastSentOriginalText) {
                      const lastSentOriginalNormalized = lastSentOriginalText.replace(/\s+/g, ' ').toLowerCase();
                      const lastSentFinalNormalized = lastSentFinalText.replace(/\s+/g, ' ').toLowerCase();
                      const timeSinceLastFinal = Date.now() - lastSentFinalTime;

                      // Check if this is the same original text (even if grammar correction would change it)
                      // Use stricter matching for very recent commits (within 5 seconds)
                      if (textNormalized === lastSentOriginalNormalized) {
                        if (timeSinceLastFinal < 5000) {
                          console.log(`[SoloMode] ⚠️ Duplicate final detected (same original text, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..."`);
                          return; // Skip processing duplicate
                        }
                      }

                      // Also check if corrected text matches what we already sent
                      // Use stricter matching for very recent commits
                      if (timeSinceLastFinal < 5000) {
                        if (textNormalized === lastSentFinalNormalized) {
                          console.log(`[SoloMode] ⚠️ Duplicate final detected (same corrected text, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                          return; // Skip processing duplicate
                        }

                        // Check for near-exact matches (very similar text within 5 seconds)
                        if (textNormalized.length > 10 && lastSentFinalNormalized.length > 10) {
                          const lengthDiff = Math.abs(textNormalized.length - lastSentFinalNormalized.length);
                          const similarity = textNormalized.includes(lastSentFinalNormalized) || lastSentFinalNormalized.includes(textNormalized);

                          // If texts are very similar (one contains the other) and length difference is small
                          if (similarity && lengthDiff < 10 && lengthDiff < Math.min(textNormalized.length, lastSentFinalNormalized.length) * 0.1) {
                            console.log(`[SoloMode] ⚠️ Duplicate final detected (very similar text, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                            return; // Skip processing duplicate
                          }

                          // CRITICAL: Also check for high word overlap (catches cases with punctuation/capitalization differences)
                          // Split into words and compare word-by-word similarity using wordsAreRelated for stem matching
                          const textWords = textNormalized.split(/\s+/).filter(w => w.length > 2); // Words longer than 2 chars
                          const lastSentWords = lastSentFinalNormalized.split(/\s+/).filter(w => w.length > 2);

                          if (textWords.length > 3 && lastSentWords.length > 3) {
                            // Count matching words using wordsAreRelated (handles punctuation and stem variations like gather/gathered)
                            const matchingWords = textWords.filter(w =>
                              lastSentWords.some(lw => wordsAreRelated(w, lw))
                            );
                            const wordOverlapRatio = matchingWords.length / Math.min(textWords.length, lastSentWords.length);

                            // If 80%+ words match and texts are similar length, it's likely a duplicate
                            if (wordOverlapRatio >= 0.8 && lengthDiff < 20) {
                              console.log(`[SoloMode] ⚠️ Duplicate final detected (high word overlap ${(wordOverlapRatio * 100).toFixed(0)}%, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                              return; // Skip processing duplicate
                            }
                          }
                        }
                      } else if (timeSinceLastFinal < FINAL_CONTINUATION_WINDOW_MS) {
                        // Within continuation window but not very recent - use original logic
                        if (textNormalized === lastSentFinalNormalized ||
                          (textNormalized.length > 10 && lastSentFinalNormalized.length > 10 &&
                            (textNormalized.includes(lastSentFinalNormalized) || lastSentFinalNormalized.includes(textNormalized)) &&
                            Math.abs(textNormalized.length - lastSentFinalNormalized.length) < 5)) {
                          console.log(`[SoloMode] ⚠️ Duplicate final detected (same corrected text), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                          return; // Skip processing duplicate
                        }

                        // Also check word overlap for continuation window (catches punctuation/capitalization differences)
                        if (textNormalized.length > 10 && lastSentFinalNormalized.length > 10) {
                          const textWords = textNormalized.split(/\s+/).filter(w => w.length > 2);
                          const lastSentWords = lastSentFinalNormalized.split(/\s+/).filter(w => w.length > 2);

                          if (textWords.length > 3 && lastSentWords.length > 3) {
                            // Use wordsAreRelated for stem matching (handles gather/gathered, punctuation, etc.)
                            const matchingWords = textWords.filter(w =>
                              lastSentWords.some(lw => wordsAreRelated(w, lw))
                            );
                            const wordOverlapRatio = matchingWords.length / Math.min(textWords.length, lastSentWords.length);
                            const lengthDiff = Math.abs(textNormalized.length - lastSentFinalNormalized.length);

                            // If 85%+ words match and texts are similar length, it's likely a duplicate
                            if (wordOverlapRatio >= 0.85 && lengthDiff < 15) {
                              console.log(`[SoloMode] ⚠️ Duplicate final detected (high word overlap ${(wordOverlapRatio * 100).toFixed(0)}% in continuation window), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                              return; // Skip processing duplicate
                            }
                          }
                        }
                      } else {
                        // Outside continuation window - still check for very high word overlap (90%+) to catch obvious duplicates
                        // This catches duplicates that arrive later but are clearly the same text
                        if (textNormalized.length > 15 && lastSentFinalNormalized.length > 15) {
                          const textWords = textNormalized.split(/\s+/).filter(w => w.length > 2);
                          const lastSentWords = lastSentFinalNormalized.split(/\s+/).filter(w => w.length > 2);

                          if (textWords.length > 5 && lastSentWords.length > 5) {
                            // Use wordsAreRelated for stem matching (handles gather/gathered, punctuation, etc.)
                            const matchingWords = textWords.filter(w =>
                              lastSentWords.some(lw => wordsAreRelated(w, lw))
                            );
                            const wordOverlapRatio = matchingWords.length / Math.min(textWords.length, lastSentWords.length);
                            const lengthDiff = Math.abs(textNormalized.length - lastSentFinalNormalized.length);

                            // If 90%+ words match and texts are very similar length, it's likely a duplicate even outside time window
                            if (wordOverlapRatio >= 0.9 && lengthDiff < 25) {
                              console.log(`[SoloMode] ⚠️ Duplicate final detected (very high word overlap ${(wordOverlapRatio * 100).toFixed(0)}% outside time window, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                              return; // Skip processing duplicate
                            }
                          }
                        }
                      }
                    }

                    // Bible reference detection (non-blocking, runs in parallel)
                    coreEngine.detectReferences(textToProcess, {
                      sourceLang: currentSourceLang,
                      targetLang: currentTargetLang,
                      seqId: timelineTracker.getCurrentSeqId(),
                      openaiApiKey: process.env.OPENAI_API_KEY
                    }).then(references => {
                      if (references && references.length > 0) {
                        // Send scripture detected events
                        for (const ref of references) {
                          const seqId = sendWithSequence({
                            type: 'scriptureDetected',
                            reference: {
                              book: ref.book,
                              chapter: ref.chapter,
                              verse: ref.verse
                            },
                            displayText: ref.displayText,
                            confidence: ref.confidence,
                            method: ref.method,
                            timestamp: Date.now()
                          }, false);
                          console.log(`[SoloMode] 📜 Scripture detected: ${ref.displayText} (confidence: ${ref.confidence.toFixed(2)}, method: ${ref.method})`);
                        }
                      }
                    }).catch(err => {
                      console.error('[SoloMode] Bible reference detection error:', err);
                      // Fail silently - don't block transcript delivery
                    });

                    // OPTIMIZATION: For forced finals, send immediately without waiting for grammar/translation
                    // Then update asynchronously when ready (reduces commit latency from 4-5s to ~1-1.5s)
                    const isForcedFinal = !!options.forceFinal;

                    if (isForcedFinal) {
                      // Send forced final immediately with original text only
                      console.log(`[SoloMode] ⚡ FORCED FINAL: Sending immediately (no grammar/translation wait)`);
                      const immediateSeqId = sendWithSequence({
                        type: 'translation',
                        originalText: textToProcess,
                        correctedText: textToProcess, // Will be updated asynchronously
                        translatedText: isTranscriptionOnly ? textToProcess : textToProcess, // Will be updated asynchronously
                        timestamp: Date.now(),
                        hasTranslation: false, // Will be updated asynchronously
                        hasCorrection: false, // Will be updated asynchronously
                        isTranscriptionOnly: isTranscriptionOnly,
                        forceFinal: true
                      }, false);

                      // Update tracking immediately
                      lastSentOriginalText = textToProcess;
                      lastSentFinalText = textToProcess;
                      lastSentFinalTime = Date.now();

                      // Check for extending partials
                      checkForExtendingPartialsAfterFinal(textToProcess);

                      // Asynchronously process grammar/translation and send updates
                      (async () => {
                        try {
                          if (isTranscriptionOnly) {
                            // Transcription mode - only grammar correction needed
                            if (currentSourceLang === 'en') {
                              try {
                                const correctedText = await grammarWorker.correctFinal(textToProcess, process.env.OPENAI_API_KEY);
                                if (correctedText !== textToProcess) {
                                  // Send grammar update with same seqId
                                  sendWithSequence({
                                    type: 'translation',
                                    originalText: textToProcess,
                                    correctedText: correctedText,
                                    translatedText: correctedText,
                                    timestamp: Date.now(),
                                    hasCorrection: true,
                                    isTranscriptionOnly: true,
                                    forceFinal: true,
                                    updateType: 'grammar',
                                    seqId: immediateSeqId // Use same seqId for update
                                  }, false);
                                  lastSentFinalText = correctedText;
                                }
                              } catch (error) {
                                console.error('[SoloMode] Grammar correction error (async):', error);
                              }
                            }
                          } else {
                            // Translation mode - grammar correction first, then translation
                            let correctedText = textToProcess;

                            // Grammar correction (English only)
                            if (currentSourceLang === 'en') {
                              try {
                                correctedText = await grammarWorker.correctFinal(textToProcess, process.env.OPENAI_API_KEY);
                                rememberGrammarCorrection(textToProcess, correctedText);

                                if (correctedText !== textToProcess) {
                                  // Send grammar update with same seqId
                                  sendWithSequence({
                                    type: 'translation',
                                    originalText: textToProcess,
                                    correctedText: correctedText,
                                    translatedText: textToProcess, // Translation not ready yet
                                    timestamp: Date.now(),
                                    hasCorrection: true,
                                    isTranscriptionOnly: false,
                                    forceFinal: true,
                                    updateType: 'grammar',
                                    seqId: immediateSeqId // Use same seqId for update
                                  }, false);
                                }
                              } catch (grammarError) {
                                console.warn(`[SoloMode] Grammar correction failed (async):`, grammarError.message);
                              }
                            }

                            // Translation
                            const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                            try {
                              const finalWorker = usePremiumTier
                                ? realtimeFinalTranslationWorker
                                : finalTranslationWorker;

                              // CRITICAL FIX: Ensure model compatibility with worker type
                              // If using Basic tier (Chat API) but plan has Realtime model, fallback to chat model
                              let effectiveModel = translateModel;
                              if (!usePremiumTier && translateModel.includes('realtime')) {
                                console.log(`[SoloMode] ⚠️ Model '${translateModel}' incompatible with Basic/Chat tier. Fallback to 'gpt-4o-mini'`);
                                effectiveModel = 'gpt-4o-mini';
                              }

                              console.log(`[SoloMode] 🔀 Using ${workerType} API for forced final translation (async, ${correctedText.length} chars)`);
                              const translatedText = await finalWorker.translateFinal(
                                correctedText,
                                currentSourceLang,
                                currentTargetLang,
                                process.env.OPENAI_API_KEY,
                                sessionId,
                                { model: effectiveModel } // Use resolved model from entitlements
                              );

                              // Send translation update with same seqId
                              sendWithSequence({
                                type: 'translation',
                                originalText: textToProcess,
                                correctedText: correctedText,
                                translatedText: translatedText,
                                timestamp: Date.now(),
                                hasTranslation: translatedText && !translatedText.startsWith('[Translation error'),
                                hasCorrection: correctedText !== textToProcess,
                                isTranscriptionOnly: false,
                                forceFinal: true,
                                updateType: 'translation',
                                seqId: immediateSeqId // Use same seqId for update
                              }, false);
                            } catch (translationError) {
                              console.error(`[SoloMode] Translation failed (async):`, translationError.message);
                            }
                          }
                        } catch (error) {
                          console.error(`[SoloMode] Async update error:`, error);
                        }
                      })();

                      return; // Exit early - async updates will handle the rest
                    }

                    // Regular finals - keep existing behavior (wait for grammar/translation)
                    if (isTranscriptionOnly) {
                      // Same language - just send transcript with grammar correction (English only)
                      if (currentSourceLang === 'en') {
                        try {
                          const correctedText = await grammarWorker.correctFinal(textToProcess, process.env.OPENAI_API_KEY);

                          // Apply emit guards before sending final
                          // Use correctedText for the check since that's what we'll send
                          const finalSegmentId = `final_${Date.now()}`; // Temporary, will use seqId after send
                          const emitCheck = shouldEmitFinal(finalSegmentId, correctedText, {
                            allowCorrection: true, // Allow corrections
                            mode: 'SoloMode'
                          });

                          if (!emitCheck.shouldEmit) {
                            console.log(`[SoloMode] ⏭️ ${emitCheck.reason}: "${correctedText.substring(0, 50)}..."`);
                            // Still update tracking even if skipping
                            lastSentOriginalText = textToProcess;
                            lastSentFinalText = correctedText;
                            lastSentFinalTime = Date.now();
                            return; // Skip emitting this final
                          }

                          const finalSeqId = sendWithSequence({
                            type: 'translation',
                            originalText: textToProcess,
                            correctedText: correctedText,
                            translatedText: correctedText, // Use corrected text as the display text
                            timestamp: Date.now(),
                            hasCorrection: true,
                            isTranscriptionOnly: true,
                            forceFinal: false
                          }, false);

                          // Track last emitted text for this seqId
                          setLastEmittedText(finalSeqId, correctedText);

                          // Trigger TTS streaming for this committed segment
                          // CRITICAL: Normalize punctuation before TTS (convert single quotes to double, etc.)
                          const normalizedTtsText = normalizePunctuation(correctedText);
                          await triggerTtsStreaming(finalSeqId, normalizedTtsText, currentTargetLang);

                          // CRITICAL: Update last sent FINAL tracking after sending
                          // Track both original and corrected text to prevent duplicates
                          lastSentOriginalText = textToProcess; // Always track the original
                          lastSentFinalText = correctedText; // Track the corrected text that was sent
                          lastSentFinalTime = Date.now();

                          // CRITICAL: ALWAYS check for partials that extend this just-sent FINAL
                          checkForExtendingPartialsAfterFinal(textToProcess);
                        } catch (error) {
                          console.error('[SoloMode] Grammar correction error:', error);

                          // Apply emit guards before sending final (error case)
                          const finalSegmentIdError = `final_${Date.now()}`;
                          const emitCheckError = shouldEmitFinal(finalSegmentIdError, textToProcess, {
                            allowCorrection: false,
                            mode: 'SoloMode'
                          });

                          if (!emitCheckError.shouldEmit) {
                            console.log(`[SoloMode] ⏭️ ${emitCheckError.reason}: "${textToProcess.substring(0, 50)}..."`);
                            lastSentOriginalText = textToProcess;
                            lastSentFinalText = textToProcess;
                            lastSentFinalTime = Date.now();
                            return; // Skip emitting this final
                          }

                          const finalSeqIdError = sendWithSequence({
                            type: 'translation',
                            originalText: textToProcess,
                            correctedText: textToProcess,
                            translatedText: textToProcess,
                            timestamp: Date.now(),
                            hasCorrection: false,
                            isTranscriptionOnly: true,
                            forceFinal: false
                          }, false);

                          // Track last emitted text
                          setLastEmittedText(finalSeqIdError, textToProcess);

                          // Trigger TTS streaming for this committed segment
                          // CRITICAL: Normalize punctuation before TTS (convert single quotes to double, etc.)
                          const normalizedTtsTextError = normalizePunctuation(textToProcess);
                          await triggerTtsStreaming(finalSeqIdError, normalizedTtsTextError, currentTargetLang);

                          // CRITICAL: Update last sent FINAL tracking after sending (even on error)
                          lastSentOriginalText = textToProcess; // Track original
                          lastSentFinalText = textToProcess; // No correction, so same as original
                          lastSentFinalTime = Date.now();
                        }
                      } else {
                        // Non-English transcription - no grammar correction

                        // Apply emit guards before sending final
                        const finalSegmentIdNonEn = `final_${Date.now()}`;
                        const emitCheckNonEn = shouldEmitFinal(finalSegmentIdNonEn, textToProcess, {
                          allowCorrection: false,
                          mode: 'SoloMode'
                        });

                        if (!emitCheckNonEn.shouldEmit) {
                          console.log(`[SoloMode] ⏭️ ${emitCheckNonEn.reason}: "${textToProcess.substring(0, 50)}..."`);
                          lastSentOriginalText = textToProcess;
                          lastSentFinalText = textToProcess;
                          lastSentFinalTime = Date.now();
                          return; // Skip emitting this final
                        }

                        const finalSeqIdNonEn = sendWithSequence({
                          type: 'translation',
                          originalText: textToProcess,
                          correctedText: textToProcess,
                          translatedText: textToProcess,
                          timestamp: Date.now(),
                          hasCorrection: false,
                          isTranscriptionOnly: true,
                          forceFinal: false
                        }, false);

                        // Track last emitted text
                        setLastEmittedText(finalSeqIdNonEn, textToProcess);

                        // Trigger TTS streaming for this committed segment
                        // CRITICAL: Normalize punctuation before TTS (convert single quotes to double, etc.)
                        const normalizedTtsTextNonEn = normalizePunctuation(textToProcess);
                        await triggerTtsStreaming(finalSeqIdNonEn, normalizedTtsTextNonEn, currentTargetLang);

                        // CRITICAL: Update last sent FINAL tracking after sending
                        lastSentFinalText = textToProcess;
                        lastSentFinalTime = Date.now();

                        // CRITICAL: ALWAYS check for partials that extend this just-sent FINAL
                        checkForExtendingPartialsAfterFinal(textToProcess);
                      }
                    } else {
                      // Different language - KEEP COUPLED FOR FINALS (history needs complete data)
                      let correctedText = textToProcess; // Declare outside try for catch block access
                      try {
                        // CRITICAL FIX: Get grammar correction FIRST (English only), then translate the CORRECTED text
                        // This ensures the translation matches the corrected English text
                        if (currentSourceLang === 'en') {
                          try {
                            correctedText = await grammarWorker.correctFinal(textToProcess, process.env.OPENAI_API_KEY);
                            rememberGrammarCorrection(textToProcess, correctedText);
                          } catch (grammarError) {
                            console.warn(`[SoloMode] Grammar correction failed, using original text:`, grammarError.message);
                            correctedText = textToProcess; // Fallback to original on error
                          }
                        } else {
                          // Non-English source - skip grammar correction
                          correctedText = textToProcess;
                        }

                        // Translate the CORRECTED text (not the original)
                        // This ensures Spanish matches the corrected English
                        // Route to appropriate worker based on tier
                        let translatedText;
                        const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                        try {
                          const finalWorker = usePremiumTier
                            ? realtimeFinalTranslationWorker
                            : finalTranslationWorker;

                          // CRITICAL FIX: Ensure model compatibility with worker type
                          // If using Basic tier (Chat API) but plan has Realtime model, fallback to chat model
                          let effectiveModel = translateModel;
                          if (!usePremiumTier && translateModel.includes('realtime')) {
                            console.log(`[SoloMode] ⚠️ Model '${translateModel}' incompatible with Basic/Chat tier. Fallback to 'gpt-4o-mini'`);
                            effectiveModel = 'gpt-4o-mini';
                          }

                          console.log(`[SoloMode] 🔀 Using ${workerType} API for final translation (${correctedText.length} chars)`);
                          translatedText = await finalWorker.translateFinal(
                            correctedText, // Use corrected text for translation
                            currentSourceLang,
                            currentTargetLang,
                            process.env.OPENAI_API_KEY,
                            sessionId, // MULTI-SESSION: Pass sessionId for fair-share allocation
                            { model: effectiveModel } // Use resolved model from entitlements
                          );
                        } catch (translationError) {
                          // If it's a skip request error (rate limited), use original text silently
                          if (translationError.skipRequest) {
                            console.log(`[SoloMode] ⏸️ Translation skipped (rate limited), using original text`);
                            translatedText = correctedText; // Use corrected text (or original if grammar also failed)
                          } else if (translationError.message && translationError.message.includes('truncated')) {
                            // CRITICAL: If translation was truncated, log warning but use what we have
                            // The text might be too long - we've already used longest partial
                            console.warn(`[SoloMode] ⚠️ Translation truncated - text may be incomplete:`, translationError.message);
                            translatedText = correctedText; // Fallback to corrected English
                          } else if (translationError.message && translationError.message.includes('timeout')) {
                            // Handle timeout errors gracefully
                            console.error(`[SoloMode] ❌ ${workerType} API timeout for final translation:`, translationError.message);
                            console.warn(`[SoloMode] ⚠️ Using corrected text as fallback due to timeout`);
                            translatedText = correctedText; // Fallback to corrected text
                          } else {
                            console.error(`[SoloMode] Translation failed:`, translationError.message);
                            translatedText = `[Translation error: ${translationError.message}]`;
                          }
                        }

                        const hasCorrection = correctedText !== textToProcess;

                        // Log FINAL with correction details
                        console.log(`[SoloMode] 📤 Sending FINAL (coupled for history integrity):`);
                        console.log(`[SoloMode]   originalText: "${textToProcess}"`);
                        console.log(`[SoloMode]   correctedText: "${correctedText}"`);
                        console.log(`[SoloMode]   translatedText: "${translatedText}"`);
                        console.log(`[SoloMode]   hasCorrection: ${hasCorrection}`);
                        console.log(`[SoloMode]   correction changed text: ${hasCorrection}`);

                        // Apply emit guards before sending final (translation case)
                        // Use translatedText for the check since that's what we display
                        const finalSegmentIdTrans = `final_${Date.now()}`;
                        const emitCheckTrans = shouldEmitFinal(finalSegmentIdTrans, translatedText, {
                          allowCorrection: true, // Allow corrections
                          mode: 'SoloMode'
                        });

                        if (!emitCheckTrans.shouldEmit) {
                          console.log(`[SoloMode] ⏭️ ${emitCheckTrans.reason}: "${translatedText.substring(0, 50)}..."`);
                          lastSentOriginalText = correctedText;
                          lastSentFinalText = translatedText;
                          lastSentFinalTime = Date.now();
                          return; // Skip emitting this final
                        }

                        const finalSeqIdTrans = sendWithSequence({
                          type: 'translation',
                          originalText: textToProcess, // Use final text (may include recovered words from partials)
                          correctedText: correctedText, // Grammar-corrected text (updates when available)
                          translatedText: translatedText, // Translation of CORRECTED text
                          timestamp: Date.now(),
                          hasTranslation: translatedText && !translatedText.startsWith('[Translation error'),
                          hasCorrection: hasCorrection,
                          isTranscriptionOnly: false,
                          forceFinal: false
                        }, false);

                        // Track last emitted text
                        setLastEmittedText(finalSeqIdTrans, translatedText);

                        // Trigger TTS streaming for this committed segment (use translated text)
                        // CRITICAL: Normalize punctuation before TTS (convert single quotes to double, etc.)
                        const normalizedTtsTextTrans = normalizePunctuation(translatedText);
                        await triggerTtsStreaming(finalSeqIdTrans, normalizedTtsTextTrans, currentTargetLang);

                        // CRITICAL: Update last sent FINAL tracking after sending
                        // Track both original and corrected text to prevent duplicates
                        lastSentOriginalText = textToProcess; // Always track the original
                        lastSentFinalText = correctedText !== textToProcess ? correctedText : textToProcess; // Track corrected if different
                        lastSentFinalTime = Date.now();

                        // CRITICAL: ALWAYS check for partials that extend this just-sent FINAL
                        checkForExtendingPartialsAfterFinal(textToProcess);
                      } catch (error) {
                        console.error(`[SoloMode] Final processing error:`, error);
                        // If it's a skip request error, use corrected text (or original if not set)
                        const finalText = error.skipRequest ? (correctedText || textToProcess) : `[Translation error: ${error.message}]`;
                        sendWithSequence({
                          type: 'translation',
                          originalText: textToProcess, // Use final text (may include recovered words)
                          correctedText: correctedText || textToProcess, // Use corrected if available, otherwise final text
                          translatedText: finalText,
                          timestamp: Date.now(),
                          hasTranslation: error.skipRequest, // True if skipped (we have text), false if real error
                          hasCorrection: false,
                          isTranscriptionOnly: false,
                          forceFinal: false
                        }, false);

                        // CRITICAL: Update last sent FINAL tracking after sending (even on error, if we have text)
                        if (error.skipRequest || finalText !== `[Translation error: ${error.message}]`) {
                          lastSentOriginalText = textToProcess; // Track original
                          lastSentFinalText = textToProcess;
                          lastSentFinalTime = Date.now();

                          // CRITICAL: ALWAYS check for partials that extend this just-sent FINAL
                          checkForExtendingPartialsAfterFinal(textToProcess);
                        }
                      }
                    }
                  } catch (error) {
                    console.error(`[SoloMode] Error processing final:`, error);
                  } finally {
                    // CRITICAL: Always clear the processing flag when done
                    isProcessingFinal = false;

                    // Process next queued final if any
                    if (finalProcessingQueue.length > 0) {
                      const next = finalProcessingQueue.shift();
                      console.log(`[SoloMode] 🔄 Processing queued final: "${next.textToProcess.substring(0, 60)}..."`);
                      // Recursively process the next queued final
                      processFinalText(next.textToProcess, next.options);
                    }
                  }
                })();
              };

              // Set up result callback - handles both partials and finals
              speechStream.onResult(async (transcriptText, isPartial, meta = {}) => {
                if (!clientWs || clientWs.readyState !== WebSocket.OPEN) return;

                // CRITICAL: Null check - recovery stream may send null results
                if (!transcriptText || transcriptText.length === 0) {
                  console.log(`[SoloMode] ⚠️ Received empty/null transcriptText from stream, ignoring`);
                  return;
                }

                // 🧪 AUDIO BUFFER TEST: Log buffer status on every result
                const audioBufferStatus = speechStream.getAudioBufferStatus();
                console.log(`[AUDIO_BUFFER_TEST] 🎵 Buffer Status:`, {
                  type: isPartial ? 'PARTIAL' : 'FINAL',
                  chunks: audioBufferStatus.chunks,
                  durationMs: audioBufferStatus.durationMs,
                  utilizationPercent: audioBufferStatus.utilizationPercent?.toFixed(1),
                  totalBytes: audioBufferStatus.totalBytesStored,
                  isWorking: audioBufferStatus.chunks > 0 ? '✅ YES' : '❌ NO'
                });

                // 🧪 TEST: On every FINAL, retrieve recent audio to verify it works
                if (!isPartial) {
                  const recentAudio750ms = speechStream.getRecentAudio(750);
                  const recentAudio600ms = speechStream.getRecentAudio(600);
                  console.log(`[AUDIO_BUFFER_TEST] 🔍 Retrieval Test on FINAL:`, {
                    last750ms: recentAudio750ms.length + ' bytes',
                    last600ms: recentAudio600ms.length + ' bytes',
                    canRecover: recentAudio750ms.length > 0 ? '✅ YES' : '❌ NO',
                    estimatedMs: Math.round((recentAudio750ms.length / 48000) * 1000) + 'ms'
                  });
                }

                // DEBUG: Log every result to verify callback is being called
                const pipeline = meta.pipeline || 'normal';
                console.log(`[SoloMode] 📥 RESULT RECEIVED: ${isPartial ? 'PARTIAL' : 'FINAL'} "${transcriptText.substring(0, 60)}..." (pipeline: ${pipeline})`);

                if (isPartial) {
                  // PHASE 6: Use Forced Commit Engine to check for forced final extensions
                  syncForcedFinalBuffer(); // Sync variable from engine
                  if (forcedCommitEngine.hasForcedFinalBuffer()) {
                    // CRITICAL: Check if this partial extends the forced final or is a new segment
                    const extension = forcedCommitEngine.checkPartialExtendsForcedFinal(transcriptText);

                    if (extension && extension.extends) {
                      // Partial extends the forced final - but wait for recovery if in progress
                      console.log('[SoloMode] 🔁 New partial extends forced final - checking if recovery is in progress...');
                      syncForcedFinalBuffer();

                      // CRITICAL: If recovery is in progress, wait for it to complete first
                      if (forcedFinalBuffer && forcedFinalBuffer.recoveryInProgress && forcedFinalBuffer.recoveryPromise) {
                        console.log('[SoloMode] ⏳ Recovery in progress - waiting for completion before committing extended partial...');
                        try {
                          const recoveredText = await forcedFinalBuffer.recoveryPromise;
                          if (recoveredText && recoveredText.length > 0) {
                            console.log(`[SoloMode] ✅ Recovery completed with text: "${recoveredText.substring(0, 60)}..."`);
                            // Recovery found words - merge recovered text with extending partial
                            const recoveredMerged = mergeWithOverlap(recoveredText, transcriptText);
                            if (recoveredMerged) {
                              console.log('[SoloMode] 🔁 Merging recovered text with extending partial and committing');
                              forcedCommitEngine.clearForcedFinalBufferTimeout();
                              processFinalText(recoveredMerged, { forceFinal: true });
                              forcedCommitEngine.clearForcedFinalBuffer();
                              syncForcedFinalBuffer();
                              // Continue processing the extended partial normally
                              return; // Exit early - already committed
                            }
                          }
                        } catch (error) {
                          console.error('[SoloMode] ❌ Error waiting for recovery:', error.message);
                        }
                      }

                      // No recovery or recovery completed - merge and commit normally
                      console.log('[SoloMode] 🔁 New partial extends forced final - merging and committing');
                      forcedCommitEngine.clearForcedFinalBufferTimeout();
                      const mergedFinal = mergeWithOverlap(forcedCommitEngine.getForcedFinalBuffer().text, transcriptText);
                      if (mergedFinal) {
                        processFinalText(mergedFinal, { forceFinal: true });
                      } else {
                        // Merge failed - use extended text
                        processFinalText(extension.extendedText, { forceFinal: true });
                      }
                      forcedCommitEngine.clearForcedFinalBuffer();
                      syncForcedFinalBuffer();
                      // Continue processing the extended partial normally
                    } else {
                      // New segment detected - but DON'T cancel timeout yet!
                      // Let the POST-final audio recovery complete in the timeout
                      // CRITICAL: Check if recovery is in progress - if so, don't reset partial tracker yet
                      // This prevents race conditions where new partials mix with recovery data
                      syncForcedFinalBuffer();
                      const recoveryInProgress = forcedFinalBuffer && forcedFinalBuffer.recoveryInProgress;
                      if (recoveryInProgress) {
                        console.log('[SoloMode] 🔀 New segment detected but recovery in progress - deferring partial tracker reset');
                        console.log('[SoloMode] ⏳ Will reset partial tracker after recovery completes');
                      } else {
                        console.log('[SoloMode] 🔀 New segment detected - will let POST-final recovery complete first');
                      }
                      // DON'T clear timeout or set to null - let it run!
                      // The timeout will commit the final after POST-final audio recovery
                      // Continue processing the new partial as a new segment
                      // NOTE: Partial tracker reset will happen in the timeout callback after recovery
                    }
                  }
                  // CRITICAL: Dedupe ONLY runs in recovery pipeline
                  // Normal pipeline must NOT run dedupe to prevent dropping early partials
                  let partialTextToSend = transcriptText;

                  if (pipeline === 'recovery') {
                    // Recovery pipeline: run dedupe to stitch recovered transcript cleanly
                    console.log(`[SoloMode] 🔄 DEDUP RUNNING (recovery pipeline only)`);
                    const dedupResult = deduplicatePartialText({
                      partialText: transcriptText,
                      lastFinalText: lastSentFinalText,
                      lastFinalTime: lastSentFinalTime,
                      mode: 'SoloMode',
                      timeWindowMs: 5000,
                      maxWordsToCheck: 3
                    });

                    partialTextToSend = dedupResult.deduplicatedText;

                    // If all words were duplicates, skip sending this partial entirely
                    if (dedupResult.wasDeduplicated && (!partialTextToSend || partialTextToSend.length < 3)) {
                      console.log(`[SoloMode] ⏭️ Skipping partial - all words are duplicates of previous FINAL (recovery pipeline)`);
                      return; // Skip this partial entirely
                    }
                  } else {
                    // Normal pipeline: skip dedupe
                    console.log(`[SoloMode] ⏭️ skip: dedupe disabled (normal pipeline)`);
                  }

                  // PHASE 4: Update partial tracking using Partial Tracker
                  // Use deduplicated text for tracking to ensure consistency
                  partialTracker.updatePartial(partialTextToSend);
                  syncPartialVariables(); // Sync variables for compatibility
                  const translationSeedText = applyCachedCorrections(partialTextToSend);

                  // Segment start grace window: Allow early short partials with alphanumeric content
                  // This prevents dropping early partials like "you" at the start of a segment
                  syncPendingFinalization();
                  const hasPendingFinal = finalizationEngine.hasPendingFinalization();
                  syncForcedFinalBuffer();
                  const timeSinceLastFinal = lastSentFinalTime ? (Date.now() - lastSentFinalTime) : Infinity;
                  // New segment start if: no pending final AND (no forced final buffer OR forced final recovery not in progress) AND recent final (< 2 seconds)
                  const isNewSegmentStart = !hasPendingFinal &&
                    (!forcedFinalBuffer || !forcedFinalBuffer.recoveryInProgress) &&
                    timeSinceLastFinal < 2000;

                  // Track segment start time for grace window
                  if (isNewSegmentStart && !segmentStartTime) {
                    segmentStartTime = Date.now();
                    console.log(`[SoloMode] 🎯 Grace window active - new segment start detected`);
                  }

                  const timeSinceSegmentStart = segmentStartTime ? (Date.now() - segmentStartTime) : Infinity;
                  const isInGraceWindow = isNewSegmentStart && timeSinceSegmentStart < 900; // 600-900ms grace window

                  // In grace window: be conservative - only suppress if pure punctuation/noise
                  // Outside grace window: apply normal rules
                  const isVeryShortPartial = partialTextToSend.trim().length < 15;
                  const hasAlpha = hasAlphaNumeric(partialTextToSend);

                  if (isVeryShortPartial && isNewSegmentStart) {
                    if (isInGraceWindow) {
                      // Grace window: allow if has alphanumeric content
                      if (hasAlpha) {
                        console.log(`[SoloMode] ✅ Grace window active (${timeSinceSegmentStart.toFixed(0)}ms) - allowing short partial with alphanumeric: "${partialTextToSend.substring(0, 30)}..."`);
                        // Allow it through - emit guards will handle duplicates
                      } else {
                        // Pure punctuation/noise - suppress even in grace window
                        console.log(`[SoloMode] ⏳ Grace window active (${timeSinceSegmentStart.toFixed(0)}ms) - suppressing punctuation-only partial: "${partialTextToSend.substring(0, 30)}..."`);
                        return; // Skip sending this partial
                      }
                    } else {
                      // Outside grace window: apply normal suppression
                      console.log(`[SoloMode] ⏳ Delaying very short partial at segment start (${partialTextToSend.trim().length} chars, ${timeSinceLastFinal}ms since last final): "${partialTextToSend.substring(0, 30)}..." - waiting for transcription to stabilize`);
                      return; // Skip sending this partial
                    }
                  }

                  // Clear segment start time when we're clearly past the grace window
                  if (timeSinceSegmentStart >= 900) {
                    segmentStartTime = null;
                  }

                  // Apply emit guards to prevent duplicate flashes and fragment spam
                  // For partials, we need to check before sending
                  // Since partials update the same segment, we'll track by a segment identifier
                  // Use a temporary identifier - will track by seqId after send
                  const partialSegmentId = `partial_${Date.now()}`; // Temporary, will use seqId after send
                  const emitCheck = shouldEmitPartial(partialSegmentId, partialTextToSend, {
                    allowCorrection: false,
                    mode: 'SoloMode'
                  });

                  if (!emitCheck.shouldEmit) {
                    console.log(`[SoloMode] ⏭️ ${emitCheck.reason}: "${partialTextToSend.substring(0, 50)}..."`);
                    return; // Skip emitting this partial
                  }

                  // Live partial transcript - send original immediately with sequence ID
                  // Note: This is the initial send before grammar/translation, so use raw text
                  const seqId = sendWithSequence({
                    type: 'translation',
                    originalText: partialTextToSend, // Use deduplicated text
                    translatedText: isTranscriptionOnly ? partialTextToSend : undefined, // Only set if transcription-only mode
                    timestamp: Date.now(),
                    isTranscriptionOnly: isTranscriptionOnly,
                    hasTranslation: false, // Flag that translation is pending
                    hasCorrection: false // Flag that correction is pending
                  }, true);

                  // Track last emitted text for this seqId to prevent duplicates
                  // Note: For partials that update the same segment, we should track by a consistent segmentId
                  // For now, track by seqId - frontend should handle update-in-place
                  setLastEmittedText(seqId, partialTextToSend);

                  // CRITICAL: If we have pending finalization, check if this partial extends it or is a new segment
                  // Use deduplicated text for all checks to ensure consistency
                  if (pendingFinalization) {
                    const timeSinceFinal = Date.now() - pendingFinalization.timestamp;
                    const finalText = pendingFinalization.text.trim();
                    const partialText = partialTextToSend.trim(); // Use deduplicated text, not original

                    // Check if this partial actually extends the final (starts with it or has significant overlap)
                    // For short finals, require exact start match. For longer finals, allow some flexibility
                    const extendsFinal = partialText.length > finalText.length &&
                      (partialText.startsWith(finalText) ||
                        (finalText.length > 10 && partialText.substring(0, finalText.length) === finalText));

                    // CRITICAL: Sentence-aware continuation detection
                    // If FINAL doesn't end with complete sentence, partials are likely continuations
                    const finalEndsWithCompleteSentence = endsWithCompleteSentence(finalText);
                    const finalEndsWithPunctuationOrSpace = /[.!?…\s]$/.test(finalText);
                    const isVeryShortPartial = partialText.length < 20; // Very short partials (< 20 chars) are likely continuations

                    // CRITICAL FIX: Check if partial actually shares words with final before treating as continuation
                    // If partial is completely unrelated (no shared words, doesn't start with final), it's a new segment
                    const finalWords = finalText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                    const partialWords = partialText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                    const sharedWords = finalWords.filter(w => partialWords.includes(w));
                    const hasWordOverlap = sharedWords.length > 0;

                    // Also check if partial starts with any of the last few words of final (catches cases like "haven't" -> "haven't been")
                    const lastWordsOfFinal = finalWords.slice(-3);
                    const startsWithFinalWord = partialWords.length > 0 && lastWordsOfFinal.some(w =>
                      partialWords[0].startsWith(w) || w.startsWith(partialWords[0]) || wordsAreRelated(partialWords[0], w)
                    );

                    // Partial is only a potential continuation if:
                    // 1. Final doesn't end with complete sentence AND
                    // 2. Partial is very short AND
                    // 3. Partial actually has some relationship to final (word overlap OR starts with final word OR extends final)
                    const mightBeContinuation = !finalEndsWithCompleteSentence &&
                      isVeryShortPartial &&
                      timeSinceFinal < 5000 &&
                      (hasWordOverlap || startsWithFinalWord || extendsFinal);

                    // CRITICAL: Even if FINAL ends with period, Google Speech may have incorrectly finalized mid-sentence
                    // If a very short partial arrives very soon after (< 1.5 seconds), wait briefly to see if it's a continuation
                    // This catches cases like "You just can't." followed by "People...." which should be "You just can't beat people..."
                    const mightBeFalseFinal = finalEndsWithCompleteSentence &&
                      isVeryShortPartial &&
                      timeSinceFinal < 1500 &&
                      !hasWordOverlap &&
                      !startsWithFinalWord &&
                      !extendsFinal;

                    // If partial is clearly a new segment (no relationship to final), commit the pending final immediately
                    // BUT: If it might be a false final (period added incorrectly), wait a bit longer
                    if (!extendsFinal && !hasWordOverlap && !startsWithFinalWord && timeSinceFinal > 500 && !mightBeFalseFinal) {
                      console.log(`[SoloMode] 🔀 New segment detected - partial "${partialText}" has no relationship to pending FINAL "${finalText.substring(0, 50)}..."`);
                      console.log(`[SoloMode] ✅ Committing pending FINAL before processing new segment`);
                      // PHASE 5: Clear timeout using engine
                      finalizationEngine.clearPendingFinalizationTimeout();
                      const textToCommit = pendingFinalization.text;
                      // PHASE 5: Clear using engine
                      finalizationEngine.clearPendingFinalization();
                      syncPendingFinalization();
                      // PHASE 4: Reset partial tracking using tracker
                      partialTracker.reset();
                      syncPartialVariables();
                      processFinalText(textToCommit);
                      // Continue processing the new partial as a new segment (don't return - let it be processed below)
                    }

                    // If partial might be a continuation OR might be a false final (period added incorrectly), wait longer
                    // Continue tracking the partial so it can grow into the complete word
                    // CRITICAL: Check max wait time - don't extend wait if we've already waited too long
                    // CRITICAL: Check if pendingFinalization still exists (it may have been cleared above)
                    if (!pendingFinalization) {
                      // pendingFinalization was cleared (final was committed) - skip continuation logic
                      return; // Continue processing the new partial as a new segment
                    }
                    const timeSinceMaxWait = Date.now() - pendingFinalization.maxWaitTimestamp;
                    if ((mightBeContinuation || mightBeFalseFinal) && !extendsFinal && timeSinceMaxWait < MAX_FINALIZATION_WAIT_MS - 1000) {
                      if (mightBeFalseFinal) {
                        console.log(`[SoloMode] ⚠️ Possible false final - FINAL ends with period but very short partial arrived soon after (${timeSinceFinal}ms)`);
                        console.log(`[SoloMode] ⏳ Waiting to see if partial grows into continuation: FINAL="${finalText}", partial="${partialText}"`);
                      }
                      console.log(`[SoloMode] ⚠️ Short partial after incomplete FINAL - likely continuation (FINAL: "${finalText}", partial: "${partialText}")`);
                      console.log(`[SoloMode] ⏳ Extending wait to see if partial grows into complete word/phrase`);
                      // Extend timeout significantly to wait for complete word/phrase
                      // PHASE 5: Clear timeout using engine
                      finalizationEngine.clearPendingFinalizationTimeout();
                      // Mark that we've extended the wait
                      syncPendingFinalization();
                      if (pendingFinalization) {
                        pendingFinalization.extendedWaitCount = (pendingFinalization.extendedWaitCount || 0) + 1;
                      }
                      // Don't extend beyond max wait - cap at remaining time
                      const maxRemainingWait = MAX_FINALIZATION_WAIT_MS - timeSinceMaxWait;
                      const remainingWait = Math.min(Math.max(1000, 2500 - timeSinceFinal), maxRemainingWait);
                      console.log(`[SoloMode] ⏱️ Extending finalization wait by ${remainingWait}ms (waiting for complete word/phrase, ${timeSinceMaxWait}ms / ${MAX_FINALIZATION_WAIT_MS}ms)`);
                      // Reschedule - will check for longer partials when timeout fires
                      // PHASE 5: Use engine to set timeout
                      updateEngineFromPending();
                      finalizationEngine.setPendingFinalizationTimeout(() => {
                        // PHASE 5: Sync and null check (CRITICAL)
                        syncPendingFinalization();
                        if (!pendingFinalization) {
                          console.warn('[SoloMode] ⚠️ Timeout fired but pendingFinalization is null - skipping');
                          return;
                        }

                        // PHASE 4: Use tracker methods to check for extending partials
                        const longestExtends = partialTracker.checkLongestExtends(pendingFinalization.text, 10000);
                        const latestExtends = partialTracker.checkLatestExtends(pendingFinalization.text, 5000);
                        let finalTextToUse = pendingFinalization.text;
                        const finalTrimmed = pendingFinalization.text.trim();

                        // Check for longest partial that extends the final
                        if (longestExtends) {
                          const longestTrimmed = longestExtends.extendedText.trim();
                          if (longestTrimmed.startsWith(finalTrimmed) ||
                            (finalTrimmed.length > 10 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
                            console.log(`[SoloMode] ⚠️ Using LONGEST partial after continuation wait (${pendingFinalization.text.length} → ${longestExtends.extendedText.length} chars)`);
                            console.log(`[SoloMode] 📊 Recovered: "${longestExtends.missingWords}"`);
                            finalTextToUse = longestExtends.extendedText;
                          } else {
                            // Try overlap merge - might have missing words in middle
                            const merged = mergeWithOverlap(finalTrimmed, longestTrimmed);
                            if (merged && merged.length > finalTrimmed.length + 5 && merged.length > longestTrimmed.length * 0.7) {
                              console.log(`[SoloMode] ⚠️ Merged via overlap after continuation wait: "${merged}"`);
                              finalTextToUse = merged;
                            }
                          }
                        } else if (latestExtends) {
                          const latestTrimmed = latestExtends.extendedText.trim();
                          if (latestTrimmed.startsWith(finalTrimmed) ||
                            (finalTrimmed.length > 10 && latestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
                            console.log(`[SoloMode] ⚠️ Using LATEST partial after continuation wait (${pendingFinalization.text.length} → ${latestExtends.extendedText.length} chars)`);
                            console.log(`[SoloMode] 📊 Recovered: "${latestExtends.missingWords}"`);
                            finalTextToUse = latestExtends.extendedText;
                          } else {
                            // Try overlap merge
                            const merged = mergeWithOverlap(finalTrimmed, latestTrimmed);
                            if (merged && merged.length > finalTrimmed.length + 5 && merged.length > latestTrimmed.length * 0.7) {
                              console.log(`[SoloMode] ⚠️ Merged via overlap after continuation wait: "${merged}"`);
                              finalTextToUse = merged;
                            }
                          }
                        } else {
                          // No extending partial found via checkLongestExtends/checkLatestExtends
                          // But we might have partials that are continuations (don't start with final)
                          // Check longestPartialText and latestPartialText directly for overlap merge
                          syncPartialVariables();
                          if (longestPartialText && longestPartialText.length > 0) {
                            const longestTrimmed = longestPartialText.trim();
                            const merged = mergeWithOverlap(finalTrimmed, longestTrimmed);
                            if (merged && merged.length > finalTrimmed.length + 3) {
                              console.log(`[SoloMode] ⚠️ Found continuation via overlap merge after wait (${pendingFinalization.text.length} → ${merged.length} chars)`);
                              console.log(`[SoloMode] 📊 Merged: "${finalTrimmed}" + "${longestTrimmed}" = "${merged}"`);
                              finalTextToUse = merged;
                            }
                          } else if (latestPartialText && latestPartialText.length > 0) {
                            const latestTrimmed = latestPartialText.trim();
                            const merged = mergeWithOverlap(finalTrimmed, latestTrimmed);
                            if (merged && merged.length > finalTrimmed.length + 3) {
                              console.log(`[SoloMode] ⚠️ Found continuation via overlap merge after wait (${pendingFinalization.text.length} → ${merged.length} chars)`);
                              console.log(`[SoloMode] 📊 Merged: "${finalTrimmed}" + "${latestTrimmed}" = "${merged}"`);
                              finalTextToUse = merged;
                            }
                          }
                        }

                        // CRITICAL: Always finalize, even if no extending partial found
                        // The final text might be incomplete, but we need to commit it to prevent loss

                        const textToProcess = finalTextToUse;
                        // DON'T reset here - FINAL handler needs this data for snapshot
                        // latestPartialText = '';
                        // longestPartialText = '';
                        const waitTime = Date.now() - pendingFinalization.timestamp;
                        // PHASE 5: Clear using engine
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();
                        console.log(`[SoloMode] ✅ FINAL Transcript (after continuation wait): "${textToProcess.substring(0, 80)}..."`);
                        processFinalText(textToProcess);
                      }, remainingWait);
                      syncPendingFinalization(); // Sync after setting timeout
                      // Continue tracking this partial (don't return - let it be tracked normally below)
                    }

                    // If partials are still arriving and extending the final, update the pending text and extend the timeout
                    if (timeSinceFinal < 2000 && extendsFinal) {
                      // CRITICAL: Update the pending finalization text with the extended partial IMMEDIATELY
                      // Always use the LONGEST partial available, not just the current one
                      let textToUpdate = transcriptText;
                      const finalTrimmed = pendingFinalization.text.trim();

                      // Check if longestPartialText is even longer and extends the final
                      if (longestPartialText && longestPartialText.length > transcriptText.length &&
                        longestPartialTime && (Date.now() - longestPartialTime) < 10000) {
                        const longestTrimmed = longestPartialText.trim();
                        if (longestTrimmed.startsWith(finalTrimmed) ||
                          (finalTrimmed.length > 10 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
                          console.log(`[SoloMode] 📝 Using LONGEST partial instead of current (${transcriptText.length} → ${longestPartialText.length} chars)`);
                          textToUpdate = longestPartialText;
                        }
                      }

                      if (textToUpdate.length > pendingFinalization.text.length) {
                        console.log(`[SoloMode] 📝 Updating pending final with extended partial (${pendingFinalization.text.length} → ${textToUpdate.length} chars)`);
                        pendingFinalization.text = textToUpdate;
                        pendingFinalization.timestamp = Date.now(); // Reset timestamp to give more time

                        // CRITICAL: If extended text now ends with complete sentence, we can finalize sooner
                        const extendedEndsWithCompleteSentence = endsWithCompleteSentence(textToUpdate);
                        if (extendedEndsWithCompleteSentence && !endsWithCompleteSentence(pendingFinalization.text)) {
                          console.log(`[SoloMode] ✅ Extended partial completes sentence - will finalize after shorter wait`);
                        }
                      }
                      // Clear existing timeout and reschedule with fresh delay
                      // PHASE 5: Clear timeout using engine
                      finalizationEngine.clearPendingFinalizationTimeout();
                      // If extended text ends with complete sentence, use shorter wait; otherwise wait longer
                      const extendedEndsWithCompleteSentence = endsWithCompleteSentence(textToUpdate);
                      const baseWait = extendedEndsWithCompleteSentence ? 1000 : 2000; // Shorter wait if sentence is complete
                      const remainingWait = Math.max(800, baseWait - timeSinceFinal);
                      console.log(`[SoloMode] ⏱️ Extending finalization wait by ${remainingWait}ms (partial still growing: ${textToUpdate.length} chars, sentence complete: ${extendedEndsWithCompleteSentence})`);
                      // Reschedule with the same processing logic
                      // PHASE 5: Use engine to set timeout
                      updateEngineFromPending();
                      finalizationEngine.setPendingFinalizationTimeout(() => {
                        // PHASE 5: Sync and null check (CRITICAL)
                        syncPendingFinalization();
                        if (!pendingFinalization) {
                          console.warn('[SoloMode] ⚠️ Timeout fired but pendingFinalization is null - skipping');
                          return;
                        }

                        const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                        const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;
                        let finalTextToUse = pendingFinalization.text;
                        // CRITICAL: Only use longest/latest if they actually extend the final
                        const finalTrimmed = pendingFinalization.text.trim();
                        if (longestPartialText && longestPartialText.length > pendingFinalization.text.length && timeSinceLongest < 10000) {
                          const longestTrimmed = longestPartialText.trim();
                          if (longestTrimmed.startsWith(finalTrimmed) ||
                            (finalTrimmed.length > 10 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
                            const missingWords = longestPartialText.substring(pendingFinalization.text.length).trim();
                            console.log(`[SoloMode] ⚠️ Using LONGEST partial after extended wait (${pendingFinalization.text.length} → ${longestPartialText.length} chars)`);
                            console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                            finalTextToUse = longestPartialText;
                          }
                        } else if (latestPartialText && latestPartialText.length > pendingFinalization.text.length && timeSinceLatest < 5000) {
                          const latestTrimmed = latestPartialText.trim();
                          if (latestTrimmed.startsWith(finalTrimmed) ||
                            (finalTrimmed.length > 10 && latestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
                            const missingWords = latestPartialText.substring(pendingFinalization.text.length).trim();
                            console.log(`[SoloMode] ⚠️ Using LATEST partial after extended wait (${pendingFinalization.text.length} → ${latestPartialText.length} chars)`);
                            console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                            finalTextToUse = latestPartialText;
                          }
                        }
                        const textToProcess = finalTextToUse;
                        // DON'T reset here - FINAL handler needs this data for snapshot
                        // latestPartialText = '';
                        // longestPartialText = '';
                        const waitTime = Date.now() - pendingFinalization.timestamp;
                        // PHASE 5: Clear using engine
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();
                        console.log(`[SoloMode] ✅ FINAL Transcript (after ${waitTime}ms wait): "${textToProcess.substring(0, 80)}..."`);
                        // Process final (reuse the async function logic from the main timeout)
                        processFinalText(textToProcess);
                      }, remainingWait);
                    } else if (!extendsFinal && timeSinceFinal > 600) {
                      // New segment detected - commit FINAL immediately to avoid blocking
                      // CRITICAL: Check max wait time - if we've waited too long, commit regardless
                      const timeSinceMaxWait = Date.now() - pendingFinalization.maxWaitTimestamp;
                      const finalEndsWithCompleteSentence = endsWithCompleteSentence(pendingFinalization.text);

                      // CRITICAL FIX: If we've already extended the wait once (from "short partial after incomplete FINAL"),
                      // and a new partial arrives that doesn't extend the final, commit immediately to prevent indefinite waiting
                      // Only wait if: final is incomplete AND we haven't hit max wait AND it's been less than 2000ms AND we haven't already extended once
                      const hasExtendedWait = pendingFinalization.extendedWaitCount > 0;
                      const shouldWait = !finalEndsWithCompleteSentence && timeSinceFinal < 2000 && timeSinceMaxWait < MAX_FINALIZATION_WAIT_MS - 1000 && !hasExtendedWait;

                      if (shouldWait) {
                        // Final doesn't end with complete sentence and not enough time has passed - wait more
                        console.log(`[SoloMode] ⏳ New segment detected but final incomplete - waiting longer (${timeSinceFinal}ms < 2000ms, ${timeSinceMaxWait}ms / ${MAX_FINALIZATION_WAIT_MS}ms)`);
                        // Continue tracking - don't commit yet
                      } else {
                        if (hasExtendedWait) {
                          console.log(`[SoloMode] ⚠️ Already extended wait once - committing FINAL to prevent indefinite waiting`);
                        }
                        // Commit FINAL - either sentence is complete, enough time has passed, or max wait is approaching
                        if (timeSinceMaxWait >= MAX_FINALIZATION_WAIT_MS - 1000) {
                          console.log(`[SoloMode] ⚠️ Max wait approaching - committing FINAL even if incomplete`);
                        }
                        // Commit FINAL immediately using longest partial that extends it
                        // CRITICAL: Only use partials that DIRECTLY extend the final (start with it) to prevent mixing segments
                        console.log(`[SoloMode] 🔀 New segment detected during finalization (${timeSinceFinal}ms since final) - committing FINAL`);
                        console.log(`[SoloMode] 📊 Pending final: "${pendingFinalization.text.substring(0, 100)}..."`);
                        console.log(`[SoloMode] 📊 Longest partial: "${longestPartialText?.substring(0, 100) || 'none'}..."`);

                        // PHASE 5: Clear timeout using engine
                        finalizationEngine.clearPendingFinalizationTimeout();

                        // Save current partials before new segment overwrites them
                        const savedLongestPartial = longestPartialText;
                        const savedLatestPartial = latestPartialText;

                        // Use longest available partial ONLY if it DIRECTLY extends the final (starts with it)
                        // This prevents mixing segments and inaccurate text
                        let textToProcess = pendingFinalization.text;
                        const finalTrimmed = pendingFinalization.text.trim();

                        // Check saved partials first - ONLY if they start with the final
                        if (savedLongestPartial && savedLongestPartial.length > pendingFinalization.text.length) {
                          const savedLongestTrimmed = savedLongestPartial.trim();
                          if (savedLongestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[SoloMode] ⚠️ Using SAVED LONGEST partial (${pendingFinalization.text.length} → ${savedLongestPartial.length} chars)`);
                            textToProcess = savedLongestPartial;
                          }
                        } else if (savedLatestPartial && savedLatestPartial.length > pendingFinalization.text.length) {
                          const savedLatestTrimmed = savedLatestPartial.trim();
                          if (savedLatestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[SoloMode] ⚠️ Using SAVED LATEST partial (${pendingFinalization.text.length} → ${savedLatestPartial.length} chars)`);
                            textToProcess = savedLatestPartial;
                          }
                        }

                        // Also check current partials - ONLY if they start with the final
                        if (longestPartialText && longestPartialText.length > textToProcess.length) {
                          const longestTrimmed = longestPartialText.trim();
                          if (longestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[SoloMode] ⚠️ Using CURRENT LONGEST partial (${textToProcess.length} → ${longestPartialText.length} chars)`);
                            textToProcess = longestPartialText;
                          }
                        } else if (latestPartialText && latestPartialText.length > textToProcess.length) {
                          const latestTrimmed = latestPartialText.trim();
                          if (latestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[SoloMode] ⚠️ Using CURRENT LATEST partial (${textToProcess.length} → ${latestPartialText.length} chars)`);
                            textToProcess = latestPartialText;
                          }
                        }

                        // DON'T reset partial tracking here - FINAL handler will use snapshot and reset
                        // Resetting here causes data loss when FINAL arrives after "new segment detected"
                        // latestPartialText = '';
                        // longestPartialText = '';
                        // latestPartialTime = 0;
                        // longestPartialTime = 0;
                        // PHASE 5: Clear using engine
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();

                        // CRITICAL: Check if forced final recovery is in progress before resetting
                        // If recovery is in progress, defer reset until recovery completes
                        syncForcedFinalBuffer();
                        const recoveryInProgress = forcedFinalBuffer && forcedFinalBuffer.recoveryInProgress;
                        if (recoveryInProgress) {
                          console.log('[SoloMode] ⏳ Recovery in progress - deferring partial tracker reset until recovery completes');
                          // Reset will happen in recovery completion callback
                        } else {
                          // PHASE 8: Reset partial tracking using tracker
                          partialTracker.reset();
                          syncPartialVariables();
                        }

                        console.log(`[SoloMode] ✅ FINAL (new segment detected - committing): "${textToProcess.substring(0, 100)}..."`);
                        processFinalText(textToProcess);
                        // Continue processing the new partial as a new segment
                      }
                    } else {
                      // Partials are still arriving - update tracking but don't extend timeout
                      console.log(`[SoloMode] 📝 Partial arrived during finalization wait - tracking updated (${transcriptText.length} chars)`);
                    }
                  }

                  // Update last audio timestamp (we have new audio activity)
                  lastAudioTimestamp = Date.now();
                  silenceStartTime = null;

                  // OPTIMIZATION: Handle transcription mode separately (no translation needed)
                  if (isTranscriptionOnly && transcriptText.length >= 1) {
                    // For transcription mode, the initial send above is enough
                    // Just start grammar correction asynchronously (English only, don't wait for it)
                    const rawCapturedText = transcriptText;
                    if (currentSourceLang === 'en') {
                      grammarWorker.correctPartial(rawCapturedText, process.env.OPENAI_API_KEY)
                        .then(correctedText => {
                          // Check if still relevant
                          if (latestPartialTextForCorrection !== rawCapturedText) {
                            if (latestPartialTextForCorrection.length < rawCapturedText.length * 0.5) {
                              console.log(`[SoloMode] ⏭️ Skipping outdated grammar (text reset: ${rawCapturedText.length} → ${latestPartialTextForCorrection.length} chars)`);
                              return;
                            }
                          }

                          rememberGrammarCorrection(rawCapturedText, correctedText);

                          console.log(`[SoloMode] ✅ GRAMMAR (ASYNC): "${correctedText.substring(0, 40)}..."`);

                          // Send grammar update separately
                          sendWithSequence({
                            type: 'translation',
                            originalText: rawCapturedText,
                            correctedText: correctedText,
                            translatedText: correctedText,
                            timestamp: Date.now(),
                            isTranscriptionOnly: true,
                            hasTranslation: false,
                            hasCorrection: true,
                            updateType: 'grammar'
                          }, true);
                        })
                        .catch(error => {
                          if (error.name !== 'AbortError') {
                            console.error(`[SoloMode] ❌ Grammar error (${rawCapturedText.length} chars):`, error.message);
                          }
                        });
                    }
                    return; // Skip translation processing for transcription mode
                  }

                  // OPTIMIZED: Throttle updates to prevent overwhelming the API
                  // Updates every 2 characters for word-by-word feel with stable translations
                  if (transcriptText.length >= 1) {
                    // Update current partial text (used for delayed translations)
                    currentPartialText = transcriptText;

                    const now = Date.now();
                    const timeSinceLastTranslation = now - lastPartialTranslationTime;

                    // Balanced approach: Update every 2 characters OR every 150ms
                    // This provides responsive updates without overwhelming the API
                    const textGrowth = transcriptText.length - lastPartialTranslation.length;
                    const GROWTH_THRESHOLD = 2; // Update every 2 characters (~per word)
                    const MIN_TIME_MS = 150; // Minimum 150ms between updates (6-7 updates/sec)

                    const textGrewSignificantly = textGrowth >= GROWTH_THRESHOLD;
                    const enoughTimePassed = timeSinceLastTranslation >= MIN_TIME_MS;

                    // Immediate translation on growth OR time passed
                    const isFirstTranslation = lastPartialTranslation.length === 0;
                    const shouldTranslateNow = isFirstTranslation ||
                      (textGrewSignificantly && enoughTimePassed);

                    if (shouldTranslateNow) {
                      // Cancel any pending translation
                      if (pendingPartialTranslation) {
                        clearTimeout(pendingPartialTranslation);
                        pendingPartialTranslation = null;
                      }

                      // CRITICAL: Don't update lastPartialTranslation until AFTER successful translation
                      // This ensures we can retry if translation fails
                      lastPartialTranslationTime = now;
                      // Don't set lastPartialTranslation here - only after successful translation

                      try {
                        console.log(`[SoloMode] 🔄 Processing partial (${transcriptText.length} chars): "${transcriptText.substring(0, 40)}..."`);
                        const rawCapturedText = transcriptText;
                        const capturedText = rawCapturedText;
                        const translationReadyText = translationSeedText;

                        // OPTIMIZATION: For same-language (transcription mode), send immediately without API calls
                        const isTranscriptionMode = currentSourceLang === currentTargetLang;

                        if (isTranscriptionMode) {
                          // TRANSCRIPTION MODE: Send raw text immediately, no translation API call needed
                          lastPartialTranslation = capturedText;

                          console.log(`[SoloMode] ✅ TRANSCRIPTION (IMMEDIATE): "${capturedText.substring(0, 40)}..."`);

                          // Send transcription immediately - same speed as translation mode
                          sendWithSequence({
                            type: 'translation',
                            originalText: rawCapturedText,
                            translatedText: capturedText,
                            timestamp: Date.now(),
                            isTranscriptionOnly: true,
                            hasTranslation: false, // No translation needed
                            hasCorrection: false // Will be updated asynchronously
                          }, true);

                          // Start grammar correction asynchronously (English only, don't wait for it)
                          if (currentSourceLang === 'en') {
                            grammarWorker.correctPartial(rawCapturedText, process.env.OPENAI_API_KEY)
                              .then(correctedText => {
                                // Check if still relevant
                                if (latestPartialTextForCorrection !== rawCapturedText) {
                                  if (latestPartialTextForCorrection.length < rawCapturedText.length * 0.5) {
                                    console.log(`[SoloMode] ⏭️ Skipping outdated grammar (text reset: ${rawCapturedText.length} → ${latestPartialTextForCorrection.length} chars)`);
                                    return;
                                  }
                                }
                                rememberGrammarCorrection(rawCapturedText, correctedText);

                                console.log(`[SoloMode] ✅ GRAMMAR (ASYNC): "${correctedText.substring(0, 40)}..."`);

                                // Send grammar update separately
                                sendWithSequence({
                                  type: 'translation',
                                  originalText: rawCapturedText,
                                  correctedText: correctedText,
                                  translatedText: correctedText,
                                  timestamp: Date.now(),
                                  isTranscriptionOnly: true,
                                  hasTranslation: false,
                                  hasCorrection: true,
                                  updateType: 'grammar'
                                }, true);
                              })
                              .catch(error => {
                                if (error.name !== 'AbortError') {
                                  console.error(`[SoloMode] ❌ Grammar error (${rawCapturedText.length} chars):`, error.message);
                                }
                              });
                          }
                        } else {
                          // TRANSLATION MODE: Decouple grammar and translation for lowest latency
                          // Fire both in parallel, but send results independently (grammar only for English)
                          // Route to appropriate worker based on tier
                          const grammarPromise = currentSourceLang === 'en'
                            ? grammarWorker.correctPartial(rawCapturedText, process.env.OPENAI_API_KEY)
                            : Promise.resolve(rawCapturedText); // Skip grammar for non-English
                          const partialWorker = usePremiumTier
                            ? realtimePartialTranslationWorker
                            : partialTranslationWorker;
                          const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                          const underRestartCooldown = usePremiumTier && Date.now() < realtimeTranslationCooldownUntil;

                          if (underRestartCooldown) {
                            console.log(`[SoloMode] ⏸️ Skipping REALTIME translation - restart cooldown active (${realtimeTranslationCooldownUntil - Date.now()}ms remaining)`);
                          } else {
                            console.log(`[SoloMode] 🔀 Using ${workerType} API for partial translation (${capturedText.length} chars)`);
                            const translationPromise = partialWorker.translatePartial(
                              translationReadyText,
                              currentSourceLang,
                              currentTargetLang,
                              process.env.OPENAI_API_KEY,
                              sessionId // MULTI-SESSION: Pass sessionId for fair-share allocation
                            );

                            // Send translation IMMEDIATELY when ready (don't wait for grammar)
                            translationPromise.then(translatedText => {
                              // Validate translation result
                              if (!translatedText || translatedText.trim().length === 0) {
                                console.warn(`[SoloMode] ⚠️ Translation returned empty for ${capturedText.length} char text`);
                                return;
                              }

                              // CRITICAL: Validate that translation is different from original (prevent English leak)
                              const isSameAsOriginal = translatedText === translationReadyText ||
                                translatedText.trim() === translationReadyText.trim() ||
                                translatedText.toLowerCase() === translationReadyText.toLowerCase();

                              if (isSameAsOriginal) {
                                console.warn(`[SoloMode] ⚠️ Translation matches original (English leak detected): "${translatedText.substring(0, 60)}..."`);
                                return; // Don't send English as translation
                              }
                              // CRITICAL: Only update lastPartialTranslation AFTER successful translation
                              lastPartialTranslation = capturedText;

                              console.log(`[SoloMode] ✅ TRANSLATION (IMMEDIATE): "${translatedText.substring(0, 40)}..."`);

                              // Send translation result immediately - sequence IDs handle ordering
                              sendWithSequence({
                                type: 'translation',
                                originalText: rawCapturedText,
                                translatedText: translatedText,
                                timestamp: Date.now(),
                                isTranscriptionOnly: false,
                                hasTranslation: true,
                                hasCorrection: false // Grammar not ready yet
                              }, true);
                            }).catch(error => {
                              // Handle translation errors gracefully
                              if (error.name !== 'AbortError') {
                                if (error.message && error.message.includes('cancelled')) {
                                  // Request was cancelled by a newer request - this is expected, silently skip
                                  console.log(`[SoloMode] ⏭️ Translation cancelled (newer request took priority)`);
                                } else if (error.conversational) {
                                  // Model returned conversational response instead of translation - use original
                                  console.warn(`[SoloMode] ⚠️ Model returned conversational response instead of translation - using original text`);
                                  // Send original text as fallback
                                  sendWithSequence({
                                    type: 'translation',
                                    originalText: capturedText,
                                    translatedText: capturedText,
                                    timestamp: Date.now(),
                                    isTranscriptionOnly: false,
                                    hasTranslation: true,
                                    hasCorrection: false
                                  }, true);
                                } else if (error.englishLeak) {
                                  // Translation matched original (English leak) - silently skip
                                  console.log(`[SoloMode] ⏭️ English leak detected for partial - skipping (${rawCapturedText.length} chars)`);
                                  // Don't send anything - will retry with next partial
                                } else if (error.message && error.message.includes('truncated')) {
                                  // Translation was truncated - log warning but don't send incomplete translation
                                  console.warn(`[SoloMode] ⚠️ Partial translation truncated (${rawCapturedText.length} chars) - waiting for longer partial`);
                                } else if (error.message && error.message.includes('timeout')) {
                                  console.warn(`[SoloMode] ⚠️ ${workerType} API timeout - translation skipped for this partial`);
                                  // Don't send error message to frontend - just skip this translation
                                } else {
                                  console.error(`[SoloMode] ❌ Translation error (${workerType} API, ${rawCapturedText.length} chars):`, error.message);
                                }
                              }
                              // Don't send anything on error - keep last partial translation
                            });
                          }

                          // Send grammar correction separately when ready (English only)
                          if (currentSourceLang === 'en') {
                            grammarPromise.then(correctedText => {
                              const latestRaw = latestPartialTextForCorrection;
                              if (latestRaw !== rawCapturedText) {
                                if (latestRaw.length < rawCapturedText.length * 0.5) {
                                  console.log(`[SoloMode] ⏭️ Skipping outdated grammar (text reset: ${rawCapturedText.length} → ${latestRaw.length} chars)`);
                                  return;
                                }
                              }

                              rememberGrammarCorrection(rawCapturedText, correctedText);
                              console.log(`[SoloMode] ✅ GRAMMAR (IMMEDIATE): "${correctedText.substring(0, 40)}..."`);

                              sendWithSequence({
                                type: 'translation',
                                originalText: rawCapturedText,
                                correctedText: correctedText,
                                timestamp: Date.now(),
                                isTranscriptionOnly: false,
                                hasCorrection: true,
                                updateType: 'grammar' // Flag for grammar-only update
                              }, true);
                            }).catch(error => {
                              if (error.name !== 'AbortError') {
                                console.error(`[SoloMode] ❌ Grammar error (${rawCapturedText.length} chars):`, error.message);
                              }
                            });
                          }
                        }
                      } catch (error) {
                        console.error(`[SoloMode] ❌ Partial processing error (${transcriptText.length} chars):`, error.message);
                        // CRITICAL: Don't update lastPartialTranslation on error - allows retry
                        // Continue processing - don't stop translations on error
                      }
                    } else {
                      // With THROTTLE_MS = 0 and GROWTH_THRESHOLD = 1, this path should rarely execute
                      // But keep as fallback for edge cases
                      // Always cancel and reschedule to ensure we translate the latest text
                      if (pendingPartialTranslation) {
                        clearTimeout(pendingPartialTranslation);
                        pendingPartialTranslation = null;
                      }

                      // Immediate execution (no delay) for real-time feel
                      const delayMs = 0;

                      pendingPartialTranslation = setTimeout(async () => {
                        // CRITICAL: Always capture LATEST text at timeout execution
                        const latestText = currentPartialText;
                        if (!latestText || latestText.length < 1) {
                          pendingPartialTranslation = null;
                          return;
                        }

                        // Skip only if exact match (no need to retranslate identical text)
                        const isExactMatch = latestText === lastPartialTranslation;

                        if (isExactMatch) {
                          console.log(`[SoloMode] ⏭️ Skipping exact match translation`);
                          pendingPartialTranslation = null;
                          return;
                        }

                        try {
                          console.log(`[SoloMode] ⏱️ Delayed processing partial (${latestText.length} chars): "${latestText.substring(0, 40)}..."`);

                          // OPTIMIZATION: For same-language (transcription mode), send immediately without API calls
                          const isTranscriptionMode = currentSourceLang === currentTargetLang;

                          if (isTranscriptionMode) {
                            // TRANSCRIPTION MODE: Send raw text immediately, no translation API call needed
                            lastPartialTranslation = latestText;
                            lastPartialTranslationTime = Date.now();

                            console.log(`[SoloMode] ✅ TRANSCRIPTION (DELAYED): "${latestText.substring(0, 40)}..."`);

                            // Send transcription immediately
                            sendWithSequence({
                              type: 'translation',
                              originalText: latestText,
                              translatedText: latestText,
                              timestamp: Date.now(),
                              isTranscriptionOnly: true,
                              hasTranslation: false,
                              hasCorrection: false
                            }, true);

                            // Start grammar correction asynchronously (English only)
                            if (currentSourceLang === 'en') {
                              grammarWorker.correctPartial(latestText, process.env.OPENAI_API_KEY)
                                .then(correctedText => {
                                  console.log(`[SoloMode] ✅ GRAMMAR (DELAYED ASYNC): "${correctedText.substring(0, 40)}..."`);

                                  sendWithSequence({
                                    type: 'translation',
                                    originalText: latestText,
                                    correctedText: correctedText,
                                    translatedText: correctedText,
                                    timestamp: Date.now(),
                                    isTranscriptionOnly: true,
                                    hasTranslation: false,
                                    hasCorrection: true,
                                    updateType: 'grammar'
                                  }, true);
                                })
                                .catch(error => {
                                  if (error.name !== 'AbortError') {
                                    console.error(`[SoloMode] ❌ Delayed grammar error (${latestText.length} chars):`, error.message);
                                  }
                                });
                            }
                          } else {
                            // TRANSLATION MODE: Decouple grammar and translation for lowest latency (grammar only for English)
                            // Route to appropriate worker based on tier
                            const grammarPromise = currentSourceLang === 'en'
                              ? grammarWorker.correctPartial(latestText, process.env.OPENAI_API_KEY)
                              : Promise.resolve(latestText); // Skip grammar for non-English
                            const partialWorker = usePremiumTier
                              ? realtimePartialTranslationWorker
                              : partialTranslationWorker;
                            const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                            console.log(`[SoloMode] 🔀 Using ${workerType} API for delayed partial translation (${latestText.length} chars)`);
                            const underRestartCooldown = usePremiumTier && Date.now() < realtimeTranslationCooldownUntil;
                            if (underRestartCooldown) {
                              console.log(`[SoloMode] ⏸️ Skipping REALTIME translation (delayed) - restart cooldown active (${realtimeTranslationCooldownUntil - Date.now()}ms remaining)`);
                            } else {
                              const translationPromise = partialWorker.translatePartial(
                                latestText,
                                currentSourceLang,
                                currentTargetLang,
                                process.env.OPENAI_API_KEY,
                                sessionId // MULTI-SESSION: Pass sessionId for fair-share allocation
                              );

                              // Send translation IMMEDIATELY when ready (don't wait for grammar)
                              translationPromise.then(translatedText => {
                                // Validate translation result
                                if (!translatedText || translatedText.trim().length === 0) {
                                  console.warn(`[SoloMode] ⚠️ Delayed translation returned empty for ${latestText.length} char text`);
                                  return;
                                }

                                // CRITICAL: Update tracking and send translation
                                lastPartialTranslation = latestText;
                                lastPartialTranslationTime = Date.now();

                                console.log(`[SoloMode] ✅ TRANSLATION (DELAYED): "${translatedText.substring(0, 40)}..."`);

                                // Send immediately - sequence IDs handle ordering
                                sendWithSequence({
                                  type: 'translation',
                                  originalText: latestText,
                                  translatedText: translatedText,
                                  timestamp: Date.now(),
                                  isTranscriptionOnly: false,
                                  hasTranslation: true,
                                  hasCorrection: false // Grammar not ready yet
                                }, true);
                              }).catch(error => {
                                // Handle translation errors gracefully
                                if (error.name !== 'AbortError') {
                                  if (error.message && error.message.includes('cancelled')) {
                                    // Request was cancelled by a newer request - this is expected, silently skip
                                    console.log(`[SoloMode] ⏭️ Delayed translation cancelled (newer request took priority)`);
                                  } else if (error.englishLeak) {
                                    // Translation matched original (English leak) - silently skip
                                    console.log(`[SoloMode] ⏭️ English leak detected for delayed partial - skipping (${latestText.length} chars)`);
                                  } else if (error.message && error.message.includes('timeout')) {
                                    console.warn(`[SoloMode] ⚠️ ${workerType} API timeout - translation skipped for this partial`);
                                  } else {
                                    console.error(`[SoloMode] ❌ Delayed translation error (${workerType} API, ${latestText.length} chars):`, error.message);
                                  }
                                }
                                // Don't send anything on error
                              });
                            }

                            // Send grammar correction separately when ready (English only)
                            if (currentSourceLang === 'en') {
                              grammarPromise.then(correctedText => {
                                // Only send if correction actually changed the text
                                if (correctedText !== latestText && correctedText.trim() !== latestText.trim()) {
                                  console.log(`[SoloMode] ✅ GRAMMAR (DELAYED): "${correctedText.substring(0, 40)}..."`);

                                  // Send grammar update - sequence IDs handle ordering
                                  sendWithSequence({
                                    type: 'translation',
                                    originalText: latestText,
                                    correctedText: correctedText,
                                    timestamp: Date.now(),
                                    isTranscriptionOnly: false,
                                    hasCorrection: true,
                                    updateType: 'grammar'
                                  }, true);
                                }
                              }).catch(error => {
                                if (error.name !== 'AbortError') {
                                  console.error(`[SoloMode] ❌ Delayed grammar error (${latestText.length} chars):`, error.message);
                                }
                              });
                            }
                          }

                          pendingPartialTranslation = null;
                        } catch (error) {
                          console.error(`[SoloMode] ❌ Delayed partial processing error (${latestText.length} chars):`, error.message);
                          pendingPartialTranslation = null;
                        }
                      }, delayMs);
                    }
                  }
                } else {
                  const isForcedFinal = meta?.forced === true;
                  // Final transcript from Google Speech
                  console.log(`[SoloMode] 📝 FINAL signal received (${transcriptText.length} chars): "${transcriptText.substring(0, 80)}..."`);

                  // 🔍 CRITICAL SNAPSHOT: Capture longest partial RIGHT NOW before stream restart overwrites it
                  // PHASE 4: Get snapshot from tracker
                  const snapshot = partialTracker.getSnapshot();
                  const longestPartialSnapshot = snapshot.longest;
                  const longestPartialTimeSnapshot = snapshot.longestTime;
                  const latestPartialSnapshot = snapshot.latest;
                  const latestPartialTimeSnapshot = snapshot.latestTime;

                  console.log(`[SoloMode] 📸 SNAPSHOT: longest=${longestPartialSnapshot?.length || 0} chars, latest=${latestPartialSnapshot?.length || 0} chars`);

                  if (isForcedFinal) {
                    console.warn(`[SoloMode] ⚠️ Forced FINAL due to stream restart (${transcriptText.length} chars)`);
                    realtimeTranslationCooldownUntil = Date.now() + TRANSLATION_RESTART_COOLDOWN_MS;

                    // PHASE 6: Use Forced Commit Engine to clear existing buffer
                    if (forcedCommitEngine.hasForcedFinalBuffer()) {
                      forcedCommitEngine.clearForcedFinalBufferTimeout();
                      forcedCommitEngine.clearForcedFinalBuffer();
                      syncForcedFinalBuffer();
                    }

                    // CRITICAL: Use SNAPSHOT not live value (live value may already be from next segment!)
                    const timeSinceLongestForced = longestPartialTimeSnapshot ? (Date.now() - longestPartialTimeSnapshot) : Infinity;
                    if (longestPartialSnapshot && longestPartialSnapshot.length > transcriptText.length && timeSinceLongestForced < 5000) {
                      const forcedTrimmed = transcriptText.trim();
                      const longestTrimmed = longestPartialSnapshot.trim();
                      // Verify it actually extends the forced final (not from a previous segment)
                      if (longestTrimmed.startsWith(forcedTrimmed) ||
                        (forcedTrimmed.length > 10 && longestTrimmed.substring(0, forcedTrimmed.length) === forcedTrimmed)) {
                        const missingWords = longestPartialSnapshot.substring(transcriptText.length).trim();
                        console.log(`[SoloMode] ⚠️ Forced FINAL using LONGEST partial SNAPSHOT (${transcriptText.length} → ${longestPartialSnapshot.length} chars)`);
                        console.log(`[SoloMode] 📊 Recovered (forced): "${missingWords}"`);
                        transcriptText = longestPartialSnapshot;
                      } else {
                        console.log(`[SoloMode] ⚠️ Ignoring LONGEST partial snapshot - doesn't extend forced final`);
                      }
                    }

                    const endsWithPunctuation = /[.!?…]$/.test(transcriptText.trim());

                    // ALWAYS capture and inject recovery audio for ALL forced finals (for testing)
                    // CRITICAL: Don't commit immediately - wait for recovery and grammar correction
                    // The timeout callback will commit after recovery completes (with grammar correction)
                    console.log('[SoloMode] ⏳ Buffering forced final until recovery completes (with grammar correction)');
                    // This ensures we can verify audio recovery is working
                    console.log('[SoloMode] ⏳ Buffering forced final until continuation arrives or timeout elapses');

                    try {
                      console.log(`[SoloMode] 📝 Forced final text: "${transcriptText.substring(0, 80)}..." (${transcriptText.length} chars, ends with punctuation: ${endsWithPunctuation})`);

                      // ⭐ CRITICAL TIMING FIX: Capture PRE-final audio (not post-final)
                      // The decoder gap occurs 200-500ms BEFORE the forced final
                      // We need a buffer window that spans BOTH before and after the final
                      console.log(`[SoloMode] 🎯 Starting PRE+POST-final audio capture window (800ms wait)...`);

                      const bufferedText = transcriptText;
                      const forcedFinalTimestamp = Date.now();

                      // Track recovery start time to capture next final for deduplication
                      recoveryStartTime = Date.now();
                      nextFinalAfterRecovery = null; // Reset

                      // PHASE 6: Create forced final buffer using engine
                      forcedCommitEngine.createForcedFinalBuffer(transcriptText, forcedFinalTimestamp);
                      syncForcedFinalBuffer(); // Sync variable for compatibility

                      // PHASE 6: Set up two-phase timeout using engine
                      forcedCommitEngine.setForcedFinalBufferTimeout(() => {
                        console.log(`[SoloMode] ⏰ Phase 1: Waiting ${forcedCommitEngine.PHASE_2_WAIT_MS}ms for late partials and POST-final audio accumulation...`);

                        // Phase 1: Wait for late partials to arrive AND for POST-final audio to accumulate
                        setTimeout(async () => {
                          console.warn('[SoloMode] ⏰ Phase 2: Late partial window complete - capturing PRE+POST-final audio');

                          // PHASE 6: Sync forced final buffer before accessing
                          syncForcedFinalBuffer();

                          // Snapshot any late partials that arrived during the wait period
                          const partialSnapshot = {
                            longest: longestPartialText,
                            latest: latestPartialText,
                            longestTime: longestPartialTime,
                            latestTime: latestPartialTime
                          };

                          console.log(`[SoloMode] 📸 Late partial snapshot: longest=${partialSnapshot.longest?.length || 0} chars, latest=${partialSnapshot.latest?.length || 0} chars`);

                          // Check if late partials extend the buffered text
                          let finalWithPartials = bufferedText;
                          if (partialSnapshot.longest && partialSnapshot.longest.length > bufferedText.length) {
                            const bufferedTrimmed = bufferedText.trim();
                            const longestTrimmed = partialSnapshot.longest.trim();
                            const timeSinceLongest = partialSnapshot.longestTime ? (Date.now() - partialSnapshot.longestTime) : Infinity;

                            // Verify it extends the buffered text and is recent (< 5000ms)
                            if (timeSinceLongest < 5000 &&
                              (longestTrimmed.startsWith(bufferedTrimmed) ||
                                (bufferedTrimmed.length > 10 && longestTrimmed.substring(0, bufferedTrimmed.length) === bufferedTrimmed))) {
                              const recoveredWords = partialSnapshot.longest.substring(bufferedText.length).trim();
                              console.log(`[SoloMode] ✅ Late partials extended buffered text (${bufferedText.length} → ${partialSnapshot.longest.length} chars)`);
                              console.log(`[SoloMode] 📊 Recovered from late partials: "${recoveredWords}"`);
                              finalWithPartials = partialSnapshot.longest;
                            }
                          }

                          // NOW reset partial tracking for next segment (clean slate for recovery)
                          // CRITICAL: Use snapshotAndReset to prevent race conditions where new partials
                          // arrive between snapshot and reset, which could mix segments
                          console.log(`[SoloMode] 🧹 Resetting partial tracking for next segment`);
                          // PHASE 4: Reset partial tracking using tracker (snapshot already taken above)
                          partialTracker.reset();
                          syncPartialVariables(); // Sync variables after reset

                          // Calculate how much time has passed since forced final
                          const timeSinceForcedFinal = Date.now() - forcedFinalTimestamp;
                          console.log(`[SoloMode] ⏱️ ${timeSinceForcedFinal}ms has passed since forced final`);

                          // ⭐ CRITICAL: Capture 2200ms window that includes BOTH:
                          // - PRE-final audio (1400ms before the final) ← Contains the decoder gap!
                          // - POST-final audio (800ms after the final) ← Captures complete phrases like "self-centered"
                          const captureWindowMs = forcedCommitEngine.CAPTURE_WINDOW_MS;
                          console.log(`[SoloMode] 🎵 Capturing PRE+POST-final audio: last ${captureWindowMs}ms`);
                          console.log(`[SoloMode] 📊 Window covers: [T-${captureWindowMs - timeSinceForcedFinal}ms to T+${timeSinceForcedFinal}ms]`);
                          console.log(`[SoloMode] 🎯 This INCLUDES the decoder gap at ~T-200ms where missing words exist!`);

                          const recoveryAudio = speechStream.getRecentAudio(captureWindowMs);
                          console.log(`[SoloMode] 🎵 Captured ${recoveryAudio.length} bytes of PRE+POST-final audio`);

                          // CRITICAL: If audio buffer is empty (stream ended), commit forced final immediately
                          if (recoveryAudio.length === 0) {
                            console.log('[SoloMode] ⚠️ Audio buffer is empty (stream likely ended) - committing forced final immediately without recovery');
                            syncForcedFinalBuffer();
                            if (forcedCommitEngine.hasForcedFinalBuffer()) {
                              const buffer = forcedCommitEngine.getForcedFinalBuffer();
                              const forcedFinalText = buffer.text;

                              // Mark as committed to prevent timeout from also committing
                              if (forcedFinalBuffer) {
                                forcedFinalBuffer.committedByRecovery = true;
                              }

                              // Commit the forced final immediately
                              processFinalText(forcedFinalText, { forceFinal: true });

                              // Clear the buffer
                              forcedCommitEngine.clearForcedFinalBuffer();
                              syncForcedFinalBuffer();

                              console.log('[SoloMode] ✅ Forced final committed immediately (no audio to recover)');
                              return; // Skip recovery attempt
                            }
                          }

                          // CRITICAL: If audio recovery is in progress, wait for it to complete
                          // PHASE 6: Sync buffer and check recovery status
                          syncForcedFinalBuffer();
                          if (forcedFinalBuffer && forcedFinalBuffer.recoveryInProgress && forcedFinalBuffer.recoveryPromise) {
                            console.log('[SoloMode] ⏳ Audio recovery still in progress, waiting for completion...');
                            try {
                              const recoveredText = await forcedFinalBuffer.recoveryPromise;
                              if (recoveredText && recoveredText.length > 0) {
                                console.log(`[SoloMode] ✅ Audio recovery completed before timeout, text already updated`);
                              } else {
                                console.log(`[SoloMode] ⚠️ Audio recovery completed but no text was recovered`);
                              }
                            } catch (error) {
                              console.error('[SoloMode] ❌ Error waiting for audio recovery:', error.message);
                            }
                          }

                          // Use finalWithPartials (which includes any late partials captured in Phase 1)
                          let finalTextToCommit = finalWithPartials;

                          // CRITICAL: bufferedText (captured earlier) is the original forced final text
                          // We'll use this as fallback if buffer is cleared before we can commit

                          console.log(`[SoloMode] 📊 Text to commit after late partial recovery:`);
                          console.log(`[SoloMode]   Text: "${finalTextToCommit}"`);
                          console.log(`[SoloMode]   Original forced final (bufferedText): "${bufferedText}"`);

                          // ⭐ NOW: Send the PRE+POST-final audio to recovery stream
                          // This audio includes the decoder gap at T-200ms where "spent" exists!
                          if (recoveryAudio.length > 0) {
                            // Use RecoveryStreamEngine to handle recovery stream operations
                            // Wrap recoveryStartTime and nextFinalAfterRecovery in objects so they can be modified
                            const recoveryStartTimeRef = { value: recoveryStartTime };
                            const nextFinalAfterRecoveryRef = { value: nextFinalAfterRecovery };

                            await coreEngine.recoveryStreamEngine.performRecoveryStream({
                              speechStream,
                              sourceLang: currentSourceLang,
                              forcedCommitEngine,
                              finalWithPartials,
                              latestPartialText,
                              nextFinalAfterRecovery,
                              bufferedText,
                              processFinalText,
                              syncForcedFinalBuffer,
                              syncPartialVariables,
                              mode: 'SoloMode',
                              recoveryStartTime: recoveryStartTimeRef,
                              nextFinalAfterRecovery: nextFinalAfterRecoveryRef,
                              recoveryAudio
                            });

                            // Update the original variables from the refs
                            recoveryStartTime = recoveryStartTimeRef.value;
                            nextFinalAfterRecovery = nextFinalAfterRecoveryRef.value;
                          } else {
                            // No recovery audio available
                            console.log(`[SoloMode] ⚠️ No recovery audio available (${recoveryAudio.length} bytes) - committing without recovery`);
                          }

                          // CRITICAL: Check if recovery already committed before committing from timeout
                          syncForcedFinalBuffer();
                          const bufferStillExists = forcedCommitEngine.hasForcedFinalBuffer();
                          const wasCommittedByRecovery = forcedFinalBuffer?.committedByRecovery === true;

                          if (wasCommittedByRecovery) {
                            console.log('[SoloMode] ⏭️ Skipping timeout commit - recovery already committed this forced final');
                            // Clear buffer if it still exists
                            if (bufferStillExists) {
                              forcedCommitEngine.clearForcedFinalBuffer();
                              syncForcedFinalBuffer();
                            }
                            return; // Skip commit - recovery already handled it
                          }

                          // Use finalTextToCommit (which may include recovery words) or fallback to bufferedText
                          // CRITICAL: bufferedText is captured in closure, so it's always available even if buffer is cleared
                          const textToCommit = finalTextToCommit || bufferedText;

                          if (!textToCommit || textToCommit.length === 0) {
                            console.error('[SoloMode] ❌ No text to commit - forced final text is empty!');
                            // Clear buffer if it still exists
                            if (bufferStillExists) {
                              forcedCommitEngine.clearForcedFinalBuffer();
                              syncForcedFinalBuffer();
                            }
                            return;
                          }

                          if (!bufferStillExists) {
                            console.log('[SoloMode] ⚠️ Forced final buffer already cleared - but committing forced final to ensure it is not lost');
                            // Buffer was cleared (likely by extending partial or new FINAL), but we should still commit
                            // the forced final text to ensure it's not lost (recovery didn't commit it, so timeout must)
                          }

                          // Commit the forced final (with grammar correction via processFinalText)
                          console.log(`[SoloMode] 📝 Committing forced final from timeout: "${textToCommit.substring(0, 80)}..." (${textToCommit.length} chars)`);
                          console.log(`[SoloMode] 📊 Final text to commit: "${textToCommit}"`);
                          processFinalText(textToCommit, { forceFinal: true });

                          // Clear buffer if it still exists
                          if (bufferStillExists) {
                            forcedCommitEngine.clearForcedFinalBuffer();
                            syncForcedFinalBuffer();
                          }

                          // Reset recovery tracking after commit
                          recoveryStartTime = 0;
                          nextFinalAfterRecovery = null;
                        }, forcedCommitEngine.PHASE_2_WAIT_MS);  // Phase 2: Wait to capture POST-final audio (800ms) + late partials buffer (200ms)
                      }, 0);  // Phase 1: Start immediately

                    } catch (error) {
                      console.error(`[SoloMode] ❌ Error in forced final audio recovery setup:`, error);
                      console.error(`[SoloMode] ❌ Stack:`, error.stack);
                    }

                    // Cancel pending finalization timers (if any) since we're handling it now
                    // PHASE 5: Clear using engine
                    if (finalizationEngine.hasPendingFinalization()) {
                      finalizationEngine.clearPendingFinalization();
                    }
                    syncPendingFinalization();

                    return;
                  }

                  // PHASE 6: Check for forced final buffer using engine
                  syncForcedFinalBuffer();
                  if (forcedCommitEngine.hasForcedFinalBuffer()) {
                    const buffer = forcedCommitEngine.getForcedFinalBuffer();

                    // CRITICAL: If recovery is in progress, wait for it to complete first
                    // This ensures forced finals are committed in chronological order
                    if (buffer.recoveryInProgress && buffer.recoveryPromise) {
                      console.log('[SoloMode] ⏳ Forced final recovery in progress - waiting for completion before processing new FINAL (maintaining order)...');
                      try {
                        const recoveredText = await buffer.recoveryPromise;
                        if (recoveredText && recoveredText.length > 0) {
                          console.log(`[SoloMode] ✅ Forced final recovery completed with text: "${recoveredText.substring(0, 60)}..."`);
                          // Recovery found words - commit the forced final first
                          console.log('[SoloMode] 📝 Committing forced final first (maintaining chronological order)');

                          // Mark as committed by recovery BEFORE clearing buffer
                          syncForcedFinalBuffer();
                          if (forcedFinalBuffer) {
                            forcedFinalBuffer.committedByRecovery = true;
                          }

                          processFinalText(recoveredText, { forceFinal: true });
                          forcedCommitEngine.clearForcedFinalBuffer();
                          syncForcedFinalBuffer();

                          // Reset recovery tracking
                          recoveryStartTime = 0;
                          nextFinalAfterRecovery = null;

                          // Now process the new FINAL (which arrived after the forced final)
                          console.log('[SoloMode] 📝 Now processing new FINAL that arrived after forced final');
                          // Continue with transcriptText processing below
                        } else {
                          console.log('[SoloMode] ⚠️ Forced final recovery completed but no text was recovered');
                          // Recovery found nothing - need to commit the forced final first, then process new FINAL
                          console.log('[SoloMode] 📝 Committing forced final first (recovery found nothing, but forced final must be committed)');

                          // CRITICAL: Mark as committed BEFORE clearing buffer so timeout callback can skip
                          // Even though recovery found nothing, we're committing it here due to new FINAL arriving
                          syncForcedFinalBuffer();
                          if (forcedFinalBuffer) {
                            forcedFinalBuffer.committedByRecovery = true; // Mark as committed to prevent timeout from also committing
                          }

                          // Commit the forced final (from buffer, since recovery found nothing)
                          const forcedFinalText = buffer.text;
                          processFinalText(forcedFinalText, { forceFinal: true });

                          // Now merge with new FINAL and process it
                          forcedCommitEngine.clearForcedFinalBufferTimeout();
                          const merged = mergeWithOverlap(forcedFinalText, transcriptText);
                          if (merged) {
                            transcriptText = merged;
                          } else {
                            console.warn('[SoloMode] ⚠️ Merge failed, using new FINAL transcript');
                          }
                          forcedCommitEngine.clearForcedFinalBuffer();
                          syncForcedFinalBuffer();

                          // Reset recovery tracking
                          recoveryStartTime = 0;
                          nextFinalAfterRecovery = null;

                          // Continue processing the new FINAL below
                        }
                      } catch (error) {
                        console.error('[SoloMode] ❌ Error waiting for forced final recovery:', error.message);
                        // On error, proceed with merge as before
                        forcedCommitEngine.clearForcedFinalBufferTimeout();
                        const merged = mergeWithOverlap(buffer.text, transcriptText);
                        if (merged) {
                          transcriptText = merged;
                        } else {
                          console.warn('[SoloMode] ⚠️ Merge failed, using new FINAL transcript');
                        }
                        forcedCommitEngine.clearForcedFinalBuffer();
                        syncForcedFinalBuffer();

                        // Reset recovery tracking
                        recoveryStartTime = 0;
                        nextFinalAfterRecovery = null;
                      }
                    } else {
                      // No recovery in progress - merge immediately as before
                      console.log('[SoloMode] 🔁 Merging buffered forced final with new FINAL transcript');
                      forcedCommitEngine.clearForcedFinalBufferTimeout();
                      const merged = mergeWithOverlap(buffer.text, transcriptText);
                      if (merged) {
                        transcriptText = merged;
                      } else {
                        // Merge failed - use the new FINAL transcript as-is
                        console.warn('[SoloMode] ⚠️ Merge failed, using new FINAL transcript');
                      }
                      forcedCommitEngine.clearForcedFinalBuffer();
                      syncForcedFinalBuffer();

                      // Reset recovery tracking since recovery was cancelled by new final
                      recoveryStartTime = 0;
                      nextFinalAfterRecovery = null;
                    }
                  }

                  // CRITICAL: Null check after merge operations
                  if (!transcriptText || transcriptText.length === 0) {
                    console.warn('[SoloMode] ⚠️ transcriptText is null or empty after merge operations - skipping final processing');
                    return;
                  }

                  // Capture next final if it arrives after recovery started (for deduplication)
                  if (recoveryStartTime > 0 && Date.now() > recoveryStartTime) {
                    // This final arrived after recovery started - store it for deduplication
                    if (!nextFinalAfterRecovery) {
                      nextFinalAfterRecovery = {
                        text: transcriptText,
                        timestamp: Date.now()
                      };
                      console.log(`[SoloMode] 📌 Captured next final after recovery start: "${transcriptText.substring(0, 60)}..."`);
                    }
                  }

                  // CRITICAL: Check if lastSentFinalText (which may include recovery) ends with words
                  // that overlap with the start of the new final - this prevents duplication
                  // Example: lastSentFinalText="...self-centered desires", newFinal="Desires cordoned off..."
                  let lastSentFinalTextToUse = lastSentFinalText;
                  if (lastSentFinalText && transcriptText) {
                    const lastSentWords = lastSentFinalText.trim().split(/\s+/);
                    const newFinalWords = transcriptText.trim().toLowerCase().split(/\s+/);

                    // Helper function for word matching (same as in recovery merge)
                    const wordsAreRelated = (word1, word2) => {
                      const w1 = word1.toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
                      const w2 = word2.toLowerCase().replace(/[.,!?;:\-'"()]/g, '');

                      if (w1 === w2) return true;
                      if (w1.includes(w2) || w2.includes(w1)) {
                        const shorter = w1.length < w2.length ? w1 : w2;
                        const longer = w1.length >= w2.length ? w1 : w2;
                        if (longer.startsWith(shorter) && shorter.length >= 3) {
                          const remaining = longer.substring(shorter.length);
                          if (['ing', 'ed', 'er', 's', 'es', 'ly', 'd'].includes(remaining)) {
                            return true;
                          }
                        }
                      }
                      // Levenshtein distance for transcription errors
                      const levenshteinDistance = (a, b) => {
                        const matrix = [];
                        for (let i = 0; i <= b.length; i++) {
                          matrix[i] = [i];
                        }
                        for (let j = 0; j <= a.length; j++) {
                          matrix[0][j] = j;
                        }
                        for (let i = 1; i <= b.length; i++) {
                          for (let j = 1; j <= a.length; j++) {
                            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                              matrix[i][j] = matrix[i - 1][j - 1];
                            } else {
                              matrix[i][j] = Math.min(
                                matrix[i - 1][j - 1] + 1,
                                matrix[i][j - 1] + 1,
                                matrix[i - 1][j] + 1
                              );
                            }
                          }
                        }
                        return matrix[b.length][a.length];
                      };
                      const distance = levenshteinDistance(w1, w2);
                      const maxLen = Math.max(w1.length, w2.length);
                      return maxLen > 0 && distance / maxLen <= 0.3; // 30% difference threshold
                    };

                    // Check if last words of lastSentFinalText overlap with first words of new final
                    // Check up to 5 words from the end of lastSentFinalText
                    let overlapCount = 0;
                    for (let i = lastSentWords.length - 1; i >= Math.max(0, lastSentWords.length - 5); i--) {
                      const lastWord = lastSentWords[i].toLowerCase().replace(/[.,!?;:\-'"()]/g, '');
                      // Check first 5 words of new final
                      const checkWords = newFinalWords.slice(0, Math.min(5, newFinalWords.length));
                      const matches = checkWords.some(newWord => {
                        const newWordClean = newWord.replace(/[.,!?;:\-'"()]/g, '');
                        if (lastWord === newWordClean) return true;
                        if (wordsAreRelated(lastWord, newWordClean)) return true;
                        return false;
                      });
                      if (matches) {
                        overlapCount++;
                      } else {
                        break; // Stop at first non-match
                      }
                    }

                    if (overlapCount > 0) {
                      // Trim overlapping words from lastSentFinalText
                      const wordsToKeep = lastSentWords.length - overlapCount;
                      if (wordsToKeep > 0) {
                        lastSentFinalTextToUse = lastSentWords.slice(0, wordsToKeep).join(' ');
                        // Update lastSentFinalText so future checks use the trimmed version
                        lastSentFinalText = lastSentFinalTextToUse;
                        console.log(`[SoloMode] ✂️ Trimming ${overlapCount} overlapping word(s) from lastSentFinalText: "${lastSentWords.slice(-overlapCount).join(' ')}"`);
                        console.log(`[SoloMode]   Before: "${lastSentFinalText.substring(Math.max(0, lastSentFinalText.length - 60))}"`);
                        console.log(`[SoloMode]   After:  "${lastSentFinalTextToUse.substring(Math.max(0, lastSentFinalTextToUse.length - 60))}"`);
                      } else {
                        console.log(`[SoloMode] ⚠️ All words in lastSentFinalText overlap with new final - this should not happen`);
                      }
                    }
                  }

                  // CRITICAL: Check if this FINAL is a continuation of the last sent FINAL
                  // This prevents splitting sentences like "Where two or three" / "Are gathered together"
                  if (lastSentFinalTextToUse && (Date.now() - lastSentFinalTime) < FINAL_CONTINUATION_WINDOW_MS) {
                    const lastSentTrimmed = lastSentFinalTextToUse.trim();
                    const newFinalTrimmed = transcriptText.trim();

                    // Check if new FINAL continues the last sent FINAL
                    // Case 1: New FINAL starts with last sent FINAL (exact match)
                    // Case 2: New FINAL has overlap with last sent FINAL (merge needed)
                    // Case 3: New FINAL is completely new (different segment)

                    const lastNormalized = lastSentTrimmed.replace(/\s+/g, ' ').toLowerCase();
                    const newNormalized = newFinalTrimmed.replace(/\s+/g, ' ').toLowerCase();

                    // Check if new FINAL extends last sent FINAL
                    if (newNormalized.startsWith(lastNormalized) && newFinalTrimmed.length > lastSentTrimmed.length) {
                      // New FINAL extends last sent - this is a continuation
                      const continuation = newFinalTrimmed.substring(lastSentTrimmed.length).trim();
                      console.log(`[SoloMode] 🔗 New FINAL continues last sent FINAL: "${lastSentTrimmed.substring(Math.max(0, lastSentTrimmed.length - 40))}" + "${continuation.substring(0, 40)}..."`);
                      console.log(`[SoloMode] 📦 Merging consecutive FINALs: "${lastSentTrimmed}" + "${continuation}"`);
                      // Merge them - the new FINAL contains the continuation
                      transcriptText = newFinalTrimmed; // Use the full new FINAL (it already contains the continuation)
                    } else {
                      // Check for overlap - last FINAL might end mid-sentence and new FINAL continues it
                      const merged = mergeWithOverlap(lastSentTrimmed, newFinalTrimmed);
                      if (merged && merged.length > lastSentTrimmed.length + 3) {
                        // Overlap detected - merge them
                        const continuation = merged.substring(lastSentTrimmed.length).trim();
                        console.log(`[SoloMode] 🔗 New FINAL continues last sent FINAL via overlap: "${lastSentTrimmed.substring(Math.max(0, lastSentTrimmed.length - 40))}" + "${continuation.substring(0, 40)}..."`);
                        console.log(`[SoloMode] 📦 Merging consecutive FINALs via overlap: "${lastSentTrimmed}" + "${continuation}"`);
                        transcriptText = merged;
                      }
                    }
                  }

                  // CRITICAL: Null check after merge operations (before accessing transcriptText.length)
                  if (!transcriptText || transcriptText.length === 0) {
                    console.warn('[SoloMode] ⚠️ transcriptText is null or empty after merge operations - skipping final processing');
                    return;
                  }

                  // CRITICAL: For long text, wait proportionally longer before processing final
                  // Google Speech may send final signal but still have partials for the last few words in flight
                  // Very long text (>300 chars) needs more time for all partials to arrive
                  // EXTENDED: Account for translation latency (150-300ms for Realtime Mini) + partial arrival time
                  // INCREASED: Longer waits to prevent word loss between segments
                  // CRITICAL: Google Speech may send incomplete FINALs (missing words) - wait longer to catch corrections
                  const BASE_WAIT_MS = 1000; // Base wait to catch partials
                  const LONG_TEXT_THRESHOLD = 200;
                  const VERY_LONG_TEXT_THRESHOLD = 300;
                  const CHAR_DELAY_MS = 3; // Per character delay for very long text

                  let WAIT_FOR_PARTIALS_MS;
                  if (transcriptText.length > VERY_LONG_TEXT_THRESHOLD) {
                    // Very long text: base wait + proportional delay (up to 3500ms max)
                    WAIT_FOR_PARTIALS_MS = Math.min(3500, BASE_WAIT_MS + (transcriptText.length - VERY_LONG_TEXT_THRESHOLD) * CHAR_DELAY_MS);
                  } else if (transcriptText.length > LONG_TEXT_THRESHOLD) {
                    // Long text: fixed longer wait
                    WAIT_FOR_PARTIALS_MS = 1800;
                  } else {
                    // Short text: base wait
                    WAIT_FOR_PARTIALS_MS = BASE_WAIT_MS;
                  }

                  // CRITICAL: Check if FINAL is incomplete - if so, wait briefly for extending partials
                  // This prevents committing incomplete phrases like "you just," when they should continue
                  const finalEndsWithCompleteSentence = endsWithCompleteSentence(transcriptText);
                  const finalEndsWithSentencePunctuation = /[.!?…]$/.test(transcriptText.trim());
                  // Incomplete if: doesn't end with sentence punctuation (period, exclamation, question mark)
                  // Commas, semicolons, colons are NOT sentence-ending, so text ending with them is incomplete
                  const isIncomplete = !finalEndsWithSentencePunctuation;

                  if (isIncomplete) {
                    console.log(`[SoloMode] 📝 FINAL is incomplete (ends with "${transcriptText.trim().slice(-1)}" not sentence punctuation) - will wait briefly for extending partials`);
                    console.log(`[SoloMode] 📝 Current text: "${transcriptText.substring(Math.max(0, transcriptText.length - 60))}"`);
                    // For incomplete finals, extend wait time to catch extending partials
                    // Short incomplete finals (< 50 chars) likely need more words - wait longer
                    if (transcriptText.length < 50) {
                      WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 2000); // At least 2 seconds for short incomplete phrases
                    } else {
                      WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 1500); // 1.5 seconds for longer incomplete text
                    }
                  } else if (!finalEndsWithCompleteSentence) {
                    // Ends with sentence punctuation but not complete sentence - still wait a bit
                    console.log(`[SoloMode] 📝 FINAL ends with sentence punctuation but not complete sentence - will commit after standard wait`);
                  }

                  // CRITICAL: Before setting up finalization, check if we have longer partials that extend this final
                  // This ensures we don't lose words like "gathered" that might be in a partial but not in the FINAL
                  let finalTextToUse = transcriptText;
                  const finalTrimmed = transcriptText.trim();
                  const finalEndsCompleteWord = endsWithCompleteWord(finalTrimmed);
                  const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                  const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;

                  // Note: We no longer extend wait time for mid-word finals - commit immediately
                  // Continuations will be caught by the partial continuation detection logic
                  if (!finalEndsCompleteWord) {
                    console.log(`[SoloMode] 📝 FINAL ends mid-word - will commit immediately, continuation will be caught in partials`);
                  }

                  // Check if longest partial extends the final
                  // CRITICAL: Google Speech may send incomplete FINALs (missing words like "secular")
                  // Always check partials even if FINAL appears complete - partials may have more complete text
                  if (longestPartialText && longestPartialText.length > transcriptText.length && timeSinceLongest < 10000) {
                    const longestTrimmed = longestPartialText.trim();
                    // More lenient matching: check if partial extends final (case-insensitive, normalized)
                    const finalNormalized = finalTrimmed.replace(/\s+/g, ' ').toLowerCase();
                    const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
                    const extendsFinal = longestNormalized.startsWith(finalNormalized) ||
                      (finalTrimmed.length > 5 && longestNormalized.substring(0, finalNormalized.length) === finalNormalized) ||
                      longestTrimmed.startsWith(finalTrimmed) ||
                      (finalTrimmed.length > 5 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed);

                    if (extendsFinal) {
                      const missingWords = longestPartialText.substring(transcriptText.length).trim();
                      // If final ends mid-word, prefer partials that end with complete word
                      const partialEndsCompleteWord = endsWithCompleteWord(longestTrimmed);
                      if (!finalEndsCompleteWord && !partialEndsCompleteWord) {
                        // Both are mid-word, but partial is longer - use it but might need to wait more
                        console.log(`[SoloMode] ⚠️ Both FINAL and partial end mid-word - using longer partial but may need more time`);
                      }
                      console.log(`[SoloMode] ⚠️ FINAL extended by LONGEST partial (${transcriptText.length} → ${longestPartialText.length} chars)`);
                      console.log(`[SoloMode] 📊 Recovered from partial: "${missingWords}"`);
                      finalTextToUse = longestPartialText;
                    } else {
                      // Partial doesn't start with final - check for overlap (Google might have missed words)
                      // CRITICAL: Be more aggressive - accept overlap if it adds at least 3 characters
                      const merged = mergeWithOverlap(finalTrimmed, longestTrimmed);
                      if (merged && merged.length > finalTrimmed.length + 3) {
                        // Overlap detected and merged text is longer - likely same segment with missing words
                        console.log(`[SoloMode] ⚠️ FINAL merged with LONGEST partial via overlap (${transcriptText.length} → ${merged.length} chars)`);
                        console.log(`[SoloMode] 📊 Recovered via overlap: "${merged.substring(finalTrimmed.length)}"`);
                        finalTextToUse = merged;
                      }
                    }
                  } else if (latestPartialText && latestPartialText.length > transcriptText.length && timeSinceLatest < 5000) {
                    // Fallback to latest partial if longest is too old
                    const latestTrimmed = latestPartialText.trim();
                    // More lenient matching: check if partial extends final (case-insensitive, normalized)
                    const finalNormalized = finalTrimmed.replace(/\s+/g, ' ').toLowerCase();
                    const latestNormalized = latestTrimmed.replace(/\s+/g, ' ').toLowerCase();
                    const extendsFinal = latestNormalized.startsWith(finalNormalized) ||
                      (finalTrimmed.length > 5 && latestNormalized.substring(0, finalNormalized.length) === finalNormalized) ||
                      latestTrimmed.startsWith(finalTrimmed) ||
                      (finalTrimmed.length > 5 && latestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed);

                    if (extendsFinal) {
                      const missingWords = latestPartialText.substring(transcriptText.length).trim();
                      // If final ends mid-word, prefer partials that end with complete word
                      const partialEndsCompleteWord = endsWithCompleteWord(latestTrimmed);
                      if (!finalEndsCompleteWord && !partialEndsCompleteWord) {
                        // Both are mid-word, but partial is longer - use it but might need to wait more
                        console.log(`[SoloMode] ⚠️ Both FINAL and partial end mid-word - using longer partial but may need more time`);
                      }
                      console.log(`[SoloMode] ⚠️ FINAL extended by LATEST partial (${transcriptText.length} → ${latestPartialText.length} chars)`);
                      console.log(`[SoloMode] 📊 Recovered from partial: "${missingWords}"`);
                      finalTextToUse = latestPartialText;
                    } else {
                      // Partial doesn't start with final - check for overlap (Google might have missed words)
                      // CRITICAL: Be more aggressive - accept overlap if it adds at least 3 characters
                      const merged = mergeWithOverlap(finalTrimmed, latestTrimmed);
                      if (merged && merged.length > finalTrimmed.length + 3) {
                        // Overlap detected and merged text is longer - likely same segment with missing words
                        console.log(`[SoloMode] ⚠️ FINAL merged with LATEST partial via overlap (${transcriptText.length} → ${merged.length} chars)`);
                        console.log(`[SoloMode] 📊 Recovered via overlap: "${merged.substring(finalTrimmed.length)}"`);
                        finalTextToUse = merged;
                      }
                    }
                  }

                  // If we have a pending finalization, check if this final extends it
                  // Google can send multiple finals for long phrases - accumulate them
                  if (pendingFinalization) {
                    // Check if this final (or extended final) extends the pending one
                    if (finalTextToUse.length > pendingFinalization.text.length &&
                      finalTextToUse.startsWith(pendingFinalization.text.trim())) {
                      // This final extends the pending one - update it with the extended text
                      console.log(`[SoloMode] 📦 Final extends pending (${pendingFinalization.text.length} → ${finalTextToUse.length} chars)`);
                      // PHASE 5: Update using engine
                      finalizationEngine.updatePendingFinalizationText(finalTextToUse);
                      syncPendingFinalization();
                      // Reset the timeout to give more time for partials
                      finalizationEngine.clearPendingFinalizationTimeout();
                      // Recalculate wait time for the longer text
                      if (finalTextToUse.length > VERY_LONG_TEXT_THRESHOLD) {
                        WAIT_FOR_PARTIALS_MS = Math.min(1500, BASE_WAIT_MS + (finalTextToUse.length - VERY_LONG_TEXT_THRESHOLD) * CHAR_DELAY_MS);
                      }
                    } else {
                      // Different final - cancel old one and start new
                      // PHASE 5: Clear using engine
                      finalizationEngine.clearPendingFinalization();
                      syncPendingFinalization();
                    }
                  }

                  // Schedule final processing after a delay to catch any remaining partials
                  // PHASE 5: Use Finalization Engine for pending finalization
                  // If pendingFinalization exists and was extended, we'll reschedule it below
                  if (!finalizationEngine.hasPendingFinalization()) {
                    // CRITICAL: Don't reset partials here - they're needed during timeout check
                    // Both BASIC and PREMIUM tiers need partials available during the wait period
                    // Partials will be reset AFTER final processing completes (see timeout callback)
                    finalizationEngine.createPendingFinalization(finalTextToUse, null);
                  }

                  // Schedule or reschedule the timeout
                  finalizationEngine.setPendingFinalizationTimeout(() => {
                    // PHASE 5: Sync variable from engine at start of timeout (CRITICAL - must be first)
                    syncPendingFinalization();
                    if (!pendingFinalization) {
                      console.warn('[SoloMode] ⚠️ Timeout fired but pendingFinalization is null - skipping');
                      return; // Safety check
                    }

                    // After waiting, check again for longer partials
                    // CRITICAL: Google Speech may send FINALs that are incomplete (missing words)
                    // Always prefer partials that extend the FINAL, even if FINAL appears "complete"
                    const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                    const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;

                    // Use the longest available partial (within reasonable time window)
                    // CRITICAL: Only use if it actually extends the final (not from a previous segment)
                    let finalTextToUse = pendingFinalization.text;
                    const finalTrimmed = pendingFinalization.text.trim();

                    // Check if FINAL ends with complete sentence
                    // If not, be more aggressive about using partials and wait longer
                    let finalEndsWithCompleteSentence = endsWithCompleteSentence(finalTrimmed);
                    const shouldPreferPartials = !finalEndsWithCompleteSentence || longestPartialText?.length > pendingFinalization.text.length + 10;

                    if (longestPartialText && longestPartialText.length > pendingFinalization.text.length && timeSinceLongest < 10000) {
                      const longestTrimmed = longestPartialText.trim();
                      // More lenient matching: check if partial extends final (case-insensitive, normalized)
                      const finalNormalized = finalTrimmed.replace(/\s+/g, ' ').toLowerCase();
                      const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
                      const extendsFinal = longestNormalized.startsWith(finalNormalized) ||
                        (finalTrimmed.length > 5 && longestNormalized.substring(0, finalNormalized.length) === finalNormalized) ||
                        longestTrimmed.startsWith(finalTrimmed) ||
                        (finalTrimmed.length > 5 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed);

                      if (extendsFinal) {
                        const missingWords = longestPartialText.substring(pendingFinalization.text.length).trim();
                        console.log(`[SoloMode] ⚠️ Using LONGEST partial (${pendingFinalization.text.length} → ${longestPartialText.length} chars)`);
                        console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                        finalTextToUse = longestPartialText;
                      } else {
                        // Check for overlap - Google might have missed words in the middle
                        // CRITICAL: Be more aggressive - accept overlap if it adds at least 3 characters
                        const overlap = mergeWithOverlap(finalTrimmed, longestTrimmed);
                        if (overlap && overlap.length > finalTrimmed.length + 3) {
                          // Overlap detected - likely same segment with missing words
                          console.log(`[SoloMode] ⚠️ Using LONGEST partial with overlap (${pendingFinalization.text.length} → ${overlap.length} chars)`);
                          console.log(`[SoloMode] 📊 Recovered via overlap: "${overlap.substring(finalTrimmed.length)}"`);
                          finalTextToUse = overlap;
                        } else {
                          console.log(`[SoloMode] ⚠️ Ignoring LONGEST partial - no significant overlap (${overlap ? overlap.length : 0} chars)`);
                        }
                      }
                    } else if (latestPartialText && latestPartialText.length > pendingFinalization.text.length && timeSinceLatest < 5000) {
                      // Fallback to latest partial if longest is too old
                      const latestTrimmed = latestPartialText.trim();
                      // More lenient matching: check if partial extends final (case-insensitive, normalized)
                      const finalNormalized = finalTrimmed.replace(/\s+/g, ' ').toLowerCase();
                      const latestNormalized = latestTrimmed.replace(/\s+/g, ' ').toLowerCase();
                      const extendsFinal = latestNormalized.startsWith(finalNormalized) ||
                        (finalTrimmed.length > 5 && latestNormalized.substring(0, finalNormalized.length) === finalNormalized) ||
                        latestTrimmed.startsWith(finalTrimmed) ||
                        (finalTrimmed.length > 5 && latestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed);

                      if (extendsFinal) {
                        const missingWords = latestPartialText.substring(pendingFinalization.text.length).trim();
                        console.log(`[SoloMode] ⚠️ Using LATEST partial (${pendingFinalization.text.length} → ${latestPartialText.length} chars)`);
                        console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                        finalTextToUse = latestPartialText;
                      } else {
                        // Check for overlap - Google might have missed words in the middle
                        // CRITICAL: Be more aggressive - accept overlap if it adds at least 3 characters
                        const overlap = mergeWithOverlap(finalTrimmed, latestTrimmed);
                        if (overlap && overlap.length > finalTrimmed.length + 3) {
                          // Overlap detected - likely same segment with missing words
                          console.log(`[SoloMode] ⚠️ Using LATEST partial with overlap (${pendingFinalization.text.length} → ${overlap.length} chars)`);
                          console.log(`[SoloMode] 📊 Recovered via overlap: "${overlap.substring(finalTrimmed.length)}"`);
                          finalTextToUse = overlap;
                        } else {
                          console.log(`[SoloMode] ⚠️ Ignoring LATEST partial - no significant overlap (${overlap ? overlap.length : 0} chars)`);
                        }
                      }
                    }

                    // CRITICAL: Check if we've exceeded MAX_FINALIZATION_WAIT_MS
                    // If so, commit even if sentence is incomplete (safety net)
                    const timeSinceMaxWait = Date.now() - pendingFinalization.maxWaitTimestamp;
                    finalEndsWithCompleteSentence = endsWithCompleteSentence(finalTextToUse);

                    if (!finalEndsWithCompleteSentence && timeSinceMaxWait < MAX_FINALIZATION_WAIT_MS - 2000) {
                      // Sentence is incomplete but we haven't hit max wait yet - wait a bit more
                      // CRITICAL: Update pendingFinalization.text with the latest finalTextToUse (may include partials)
                      pendingFinalization.text = finalTextToUse;
                      // Reduced wait: up to 2 seconds per reschedule (down from 4), but don't exceed max wait
                      const remainingWait = Math.min(2000, MAX_FINALIZATION_WAIT_MS - timeSinceMaxWait - 1000);
                      console.log(`[SoloMode] ⏳ Sentence incomplete - waiting ${remainingWait}ms more (${timeSinceMaxWait}ms / ${MAX_FINALIZATION_WAIT_MS}ms)`);
                      // Reschedule the timeout to check again after remaining wait
                      // PHASE 5: Use engine to set timeout
                      updateEngineFromPending();
                      finalizationEngine.setPendingFinalizationTimeout(() => {
                        // PHASE 5: Sync and null check (CRITICAL)
                        syncPendingFinalization();
                        if (!pendingFinalization) {
                          console.warn('[SoloMode] ⚠️ Timeout fired but pendingFinalization is null - skipping');
                          return;
                        }

                        // CRITICAL: Re-check for partials again - they may have updated since last check
                        const timeSinceLongest2 = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                        const timeSinceLatest2 = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;
                        let finalTextToUse2 = pendingFinalization.text;
                        const finalTrimmed2 = pendingFinalization.text.trim();

                        // Check for longer partials again
                        if (longestPartialText && longestPartialText.length > pendingFinalization.text.length && timeSinceLongest2 < 10000) {
                          const longestTrimmed2 = longestPartialText.trim();
                          // More lenient matching
                          const finalNormalized2 = finalTrimmed2.replace(/\s+/g, ' ').toLowerCase();
                          const longestNormalized2 = longestTrimmed2.replace(/\s+/g, ' ').toLowerCase();
                          const extendsFinal2 = longestNormalized2.startsWith(finalNormalized2) ||
                            (finalTrimmed2.length > 5 && longestNormalized2.substring(0, finalNormalized2.length) === finalNormalized2) ||
                            longestTrimmed2.startsWith(finalTrimmed2) ||
                            (finalTrimmed2.length > 5 && longestTrimmed2.substring(0, finalTrimmed2.length) === finalTrimmed2);

                          if (extendsFinal2) {
                            const missingWords = longestPartialText.substring(pendingFinalization.text.length).trim();
                            console.log(`[SoloMode] ⚠️ Reschedule: Using LONGEST partial (${pendingFinalization.text.length} → ${longestPartialText.length} chars)`);
                            console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                            finalTextToUse2 = longestPartialText;
                          } else {
                            const overlap = mergeWithOverlap(finalTrimmed2, longestTrimmed2);
                            if (overlap && overlap.length > finalTrimmed2.length + 3) {
                              console.log(`[SoloMode] ⚠️ Reschedule: Using LONGEST partial with overlap (${pendingFinalization.text.length} → ${overlap.length} chars)`);
                              console.log(`[SoloMode] 📊 Recovered via overlap: "${overlap.substring(finalTrimmed2.length)}"`);
                              finalTextToUse2 = overlap;
                            }
                          }
                        } else if (latestPartialText && latestPartialText.length > pendingFinalization.text.length && timeSinceLatest2 < 5000) {
                          const latestTrimmed2 = latestPartialText.trim();
                          // More lenient matching
                          const finalNormalized2 = finalTrimmed2.replace(/\s+/g, ' ').toLowerCase();
                          const latestNormalized2 = latestTrimmed2.replace(/\s+/g, ' ').toLowerCase();
                          const extendsFinal2 = latestNormalized2.startsWith(finalNormalized2) ||
                            (finalTrimmed2.length > 5 && latestNormalized2.substring(0, finalNormalized2.length) === finalNormalized2) ||
                            latestTrimmed2.startsWith(finalTrimmed2) ||
                            (finalTrimmed2.length > 5 && latestTrimmed2.substring(0, finalTrimmed2.length) === finalTrimmed2);

                          if (extendsFinal2) {
                            const missingWords = latestPartialText.substring(pendingFinalization.text.length).trim();
                            console.log(`[SoloMode] ⚠️ Reschedule: Using LATEST partial (${pendingFinalization.text.length} → ${latestPartialText.length} chars)`);
                            console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                            finalTextToUse2 = latestPartialText;
                          } else {
                            const overlap = mergeWithOverlap(finalTrimmed2, latestTrimmed2);
                            if (overlap && overlap.length > finalTrimmed2.length + 3) {
                              console.log(`[SoloMode] ⚠️ Reschedule: Using LATEST partial with overlap (${pendingFinalization.text.length} → ${overlap.length} chars)`);
                              console.log(`[SoloMode] 📊 Recovered via overlap: "${overlap.substring(finalTrimmed2.length)}"`);
                              finalTextToUse2 = overlap;
                            }
                          }
                        }

                        const finalEndsWithCompleteSentence2 = endsWithCompleteSentence(finalTextToUse2);
                        const timeSinceMaxWait2 = Date.now() - pendingFinalization.maxWaitTimestamp;

                        if (!finalEndsWithCompleteSentence2 && timeSinceMaxWait2 >= MAX_FINALIZATION_WAIT_MS) {
                          console.log(`[SoloMode] ⚠️ Max wait exceeded - committing incomplete sentence`);
                        }
                        // Continue with commit using the updated text
                        const textToProcess = finalTextToUse2;
                        const waitTime = Date.now() - pendingFinalization.timestamp;
                        // DON'T reset here - FINAL handler needs this data for snapshot
                        // latestPartialText = '';
                        // longestPartialText = '';
                        // latestPartialTime = 0;
                        // longestPartialTime = 0;
                        // PHASE 5: Clear using engine
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();
                        console.log(`[SoloMode] ✅ FINAL Transcript (after ${waitTime}ms wait): "${textToProcess.substring(0, 80)}..."`);
                        processFinalText(textToProcess);
                      }, remainingWait);
                      return; // Don't commit yet
                    }

                    // DON'T reset here - FINAL handler needs this data for snapshot
                    const textToProcess = finalTextToUse;
                    const waitTime = Date.now() - pendingFinalization.timestamp;
                    // Partial tracking will be reset by FINAL handler after snapshot
                    // latestPartialText = '';
                    // longestPartialText = '';
                    // latestPartialTime = 0;
                    // longestPartialTime = 0;
                    // PHASE 5: Clear using engine (prevents duplicate processing)
                    finalizationEngine.clearPendingFinalization();
                    syncPendingFinalization();

                    if (!finalEndsWithCompleteSentence) {
                      console.log(`[SoloMode] ⚠️ Committing incomplete sentence after ${waitTime}ms wait (max wait: ${MAX_FINALIZATION_WAIT_MS}ms)`);
                    }
                    console.log(`[SoloMode] ✅ FINAL Transcript (after ${waitTime}ms wait): "${textToProcess.substring(0, 80)}..."`);

                    // Process final - translate and send to client
                    processFinalText(textToProcess);
                  }, WAIT_FOR_PARTIALS_MS);
                }
              });

              console.log('[SoloMode] ✅ Google Speech stream initialized and ready');
            } catch (error) {
              console.error('[SoloMode] Failed to initialize Google Speech stream:', error);
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'error',
                  message: `Failed to initialize: ${error.message}`
                }));
              }
              return;
            }
          }

          // Send ready message
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'session_ready',
              sessionId: legacySessionId,
              message: `Translation session ready: ${currentSourceLang} → ${currentTargetLang}`
            }));
          }
          break;

        case 'audio':
          // Process audio through Google Speech stream
          if (speechStream) {
            // START SESSION SPAN on first audio (active streaming time only)
            // CRITICAL: Fire-and-forget pattern - DO NOT BLOCK audio processing
            ensureSessionActive();


            // Measure RTT if client sent timestamp
            if (message.clientTimestamp) {
              const rtt = measureRTT(message.clientTimestamp);
              if (rtt !== null) {
                const avgRTT = rttTracker.getAverageRTT();
                console.log(`[SoloMode] 📊 RTT: ${rtt}ms (avg: ${avgRTT !== null ? avgRTT : 'N/A'}ms)`);
              }
            }

            // Update audio activity timestamp
            lastAudioTimestamp = Date.now();

            // Stream audio to Google Speech for transcription
            // Pass chunk metadata for tracking
            await speechStream.processAudio(message.audioData, {
              chunkIndex: message.chunkIndex,
              startMs: message.startMs,
              endMs: message.endMs,
              clientTimestamp: message.clientTimestamp
            });
          } else {
            console.warn('[SoloMode] Received audio before stream initialization');
          }
          break;

        case 'audio_end':
          console.log('[SoloMode] 🛑 Audio stream ended');

          // STOP SESSION SPAN - user stopped recording
          if (sessionSpanStarted) {
            if (sessionSpanHeartbeatInterval) {
              clearInterval(sessionSpanHeartbeatInterval);
              sessionSpanHeartbeatInterval = null;
            }

            // Fix: Use trackingSessionId (UUID) for DB operations
            // Check if we have a valid tracking session before calling DB
            if (trackingSessionId) {
              (async () => {
                if (sessionSpanStartPromise) await sessionSpanStartPromise;

                stopSessionSpan({
                  sessionId: trackingSessionId,
                  reason: 'audio_end'
                }).then(async (result) => {
                  console.log(`[SoloMode] ✓ Session span stopped (audio_end): ${result.durationSeconds}s`);

                  // Also mark the DB session as ended to keep data clean
                  try {
                    await supabaseAdmin.from('sessions').update({
                      status: 'ended',
                      ended_at: new Date().toISOString(),
                      metadata: { ended_reason: 'audio_end' }
                    }).eq('id', trackingSessionId);
                  } catch (e) { /* ignore cleanup error */ }

                }).catch(err => {
                  console.warn(`[SoloMode] ⚠️ Failed to stop session span:`, err.message);
                });
              })();
            } else {
              console.log(`[SoloMode] ⚠️ Skipping stopSessionSpan (no tracking UUID)`);
            }
            sessionSpanStarted = false; // Reset so next recording starts a new span
          }

          // CRITICAL: If there's a forced final buffer waiting for recovery, commit it immediately
          // The audio buffer will be empty, so recovery won't work anyway
          syncForcedFinalBuffer();
          if (forcedCommitEngine.hasForcedFinalBuffer()) {
            const buffer = forcedCommitEngine.getForcedFinalBuffer();
            console.log('[SoloMode] ⚠️ Audio stream ended with forced final buffer - committing immediately (no audio to recover)');

            // Cancel recovery timeout since there's no audio to recover
            forcedCommitEngine.clearForcedFinalBufferTimeout();

            // Commit the forced final immediately
            const forcedFinalText = buffer.text;
            processFinalText(forcedFinalText, { forceFinal: true });

            // Clear the buffer
            forcedCommitEngine.clearForcedFinalBuffer();
            syncForcedFinalBuffer();

            console.log('[SoloMode] ✅ Forced final committed due to audio stream end');
          }

          if (speechStream) {
            await speechStream.endAudio();
          }
          break;

        case 'force_commit':
          // Frontend requests to force-commit current turn using 2-buffer system
          console.log('[SoloMode] 🔄 Force commit requested by frontend');
          if (speechStream) {
            try {
              await speechStream.forceCommit();
              console.log('[SoloMode] ✅ Force commit completed - all buffered audio flushed and final received');
            } catch (error) {
              console.error('[SoloMode] ❌ Force commit error:', error);
              // Don't throw - allow normal flow to continue
            }
          } else {
            console.warn('[SoloMode] ⚠️ Force commit requested but speech stream not initialized');
          }
          break;

        case 'client_hidden':
          console.log('[SoloMode] 📴 Client tab hidden - may affect history updates');
          // Could pause history writes or adjust behavior here
          break;

        case 'client_visible':
          console.log('[SoloMode] 📴 Client tab visible - resuming normal operation');
          break;

        // ============================================================
        // TTS HANDLERS - Ported from websocketHandler.js (Host Mode)
        // ============================================================

        case 'tts/start':
          console.log('[SoloMode] Starting TTS playback');

          // Initialize TTS state on socket
          if (!clientWs.ttsState) {
            clientWs.ttsState = {};
          }

          clientWs.ttsState.playbackState = 'PLAYING';
          clientWs.ttsState.languageCode = message.languageCode || currentTargetLang;
          clientWs.ttsState.voiceName = message.voiceName || null;
          clientWs.ttsState.tier = message.tier || 'gemini';
          clientWs.ttsState.mode = message.mode || 'unary';
          clientWs.ttsState.ttsLeaseExpiresAt = Date.now() + (300 * 1000); // 5 minutes

          // Store full config for lease validation
          clientWs.ttsState.ttsConfig = {
            languageCode: message.languageCode || currentTargetLang,
            voiceName: message.voiceName,
            tier: message.tier || 'gemini',
            mode: message.mode || 'unary',
            ssmlOptions: message.ssmlOptions,
            promptPresetId: message.promptPresetId,
            ttsPrompt: message.ttsPrompt,
            intensity: message.intensity
          };

          // Send acknowledgment
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'tts/ack',
              action: 'start',
              state: clientWs.ttsState,
              leaseExpiresAt: clientWs.ttsState.ttsLeaseExpiresAt
            }));
          }
          console.log('[SoloMode] TTS state:', clientWs.ttsState);
          break;

        case 'tts/pause':
          console.log('[SoloMode] Pausing TTS playback');
          if (clientWs.ttsState) {
            clientWs.ttsState.playbackState = 'PAUSED';
            clientWs.ttsState.ttsLeaseExpiresAt = Date.now() + (60 * 1000); // 1 minute
          }
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'tts/ack',
              action: 'pause',
              leaseExpiresAt: clientWs.ttsState?.ttsLeaseExpiresAt
            }));
          }
          break;

        case 'tts/resume':
          console.log('[SoloMode] Resuming TTS playback');
          if (clientWs.ttsState) {
            clientWs.ttsState.playbackState = 'PLAYING';
            clientWs.ttsState.ttsLeaseExpiresAt = Date.now() + (300 * 1000); // 5 minutes
          }
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'tts/ack',
              action: 'resume',
              leaseExpiresAt: clientWs.ttsState?.ttsLeaseExpiresAt
            }));
          }
          break;

        case 'tts/stop':
          console.log('[SoloMode] Stopping TTS playback');
          if (clientWs.ttsState) {
            clientWs.ttsState.playbackState = 'STOPPED';
            clientWs.ttsState.ttsLeaseExpiresAt = null;
            clientWs.ttsState.ttsConfig = null;
          }
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'tts/ack',
              action: 'stop'
            }));
          }
          break;

        case 'tts/list_voices': {
          console.log(`[SoloMode] Requesting voice list for ${message.languageCode}`);

          if (!message.languageCode) {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/error',
                code: 'INVALID_REQUEST',
                message: 'Missing required field: languageCode'
              }));
            }
            break;
          }

          try {
            const { getVoicesFor } = await import('./tts/voiceCatalog.js');

            // Use real entitlements if available, otherwise fallback to starter tier
            const ttsTier = entitlements?.limits?.ttsTier || 'starter';
            const allowedTiers = getAllowedTtsTiers(ttsTier);
            const planCode = entitlements?.subscription?.planCode || 'starter';

            console.log(`[SoloMode] Fetching voices for ${message.languageCode} (plan=${planCode}, ttsTier=${ttsTier})`);
            console.log(`[SoloMode] Allowed tiers: [${allowedTiers.join(', ')}]`);

            // Get ALL voices for the language (not filtered by tier)
            // We send all voices so frontend can show locked/unlocked state
            const allTiers = ['gemini', 'chirp3_hd', 'neural2', 'standard', 'studio', 'elevenlabs', 'elevenlabs_v3', 'elevenlabs_turbo', 'elevenlabs_flash'];
            const voices = await getVoicesFor({
              languageCode: message.languageCode,
              allowedTiers: allTiers  // Get all voices
            });

            // Transform to client format with tier info
            const clientVoices = voices.map(v => ({
              tier: v.tier,
              voiceId: v.voiceId,
              voiceName: v.voiceName,
              displayName: v.displayName,
              isAllowed: allowedTiers.includes(v.tier)  // Mark if voice is allowed for this plan
            }));

            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/voices',
                languageCode: message.languageCode,
                voices: clientVoices,
                allowedTiers,  // Send allowed tiers to frontend
                planCode       // Send plan code for display
              }));
            }
            console.log(`[SoloMode] Sent ${clientVoices.length} voices for ${message.languageCode} (${allowedTiers.length} tiers allowed)`);
          } catch (error) {
            console.error('[SoloMode] Failed to list voices:', error);
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/error',
                code: 'VOICE_LIST_FAILED',
                message: `Failed to list voices: ${error.message}`
              }));
            }
          }
          break;
        }

        case 'tts/get_defaults': {
          console.log('[SoloMode] Requesting voice defaults');

          try {
            const { getOrgVoiceDefaults } = await import('./tts/defaults/defaultsStore.js');

            const orgId = 'default';
            const defaults = await getOrgVoiceDefaults(orgId);

            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/defaults',
                defaultsByLanguage: defaults
              }));
            }
            console.log(`[SoloMode] Sent voice defaults for ${Object.keys(defaults).length} languages`);
          } catch (error) {
            console.error('[SoloMode] Failed to get defaults:', error);
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/error',
                code: 'GET_DEFAULTS_FAILED',
                message: `Failed to get defaults: ${error.message}`
              }));
            }
          }
          break;
        }

        case 'tts/synthesize': {
          console.log('[SoloMode] TTS synthesis request');

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
            break;
          }

          // Check playback state
          // Relaxed check: If state is undefined (e.g. fresh connection/restart), assume PLAYING for Solo mode flexibility
          const currentState = clientWs.ttsState?.playbackState;
          if (clientWs.ttsState && currentState !== 'PLAYING') {
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
            break;
          }

          // Check lease expiry
          if (clientWs.ttsState?.ttsLeaseExpiresAt && Date.now() > clientWs.ttsState.ttsLeaseExpiresAt) {
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
            break;
          }

          // Refresh lease on active synthesis
          if (clientWs.ttsState?.playbackState === 'PLAYING') {
            clientWs.ttsState.ttsLeaseExpiresAt = Date.now() + (300 * 1000);
          }

          // Streaming mode not implemented
          if (message.mode === 'streaming') {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'tts/error',
                code: 'TTS_STREAMING_NOT_IMPLEMENTED',
                message: 'TTS streaming mode not implemented yet',
                details: { segmentId: message.segmentId }
              }));
            }
            break;
          }

          try {
            // Import TTS modules
            const { getTtsServiceForProvider } = await import('./tts/ttsService.js');
            const { validateTtsRequest } = await import('./tts/ttsPolicy.js');
            const { canSynthesize } = await import('./tts/ttsQuota.js');
            const { recordUsage } = await import('./tts/ttsUsage.js');
            const { resolveTtsRoute } = await import('./tts/ttsRouting.js');

            // Fix tier typo
            if (message.tier === 'chirp_hd') {
              message.tier = 'chirp3_hd';
            }

            // Determine voice preference
            // Priority: 1. Message-specific override, 2. Persisted session voice, 3. Null (let resolver decide)
            const voicePreference = message.voiceId || message.voiceName || currentVoiceId;

            console.log(`[SoloMode] 🔍 Unary TTS Request Debug:`);
            console.log(`[SoloMode]   message.tier: ${message.tier}`);
            console.log(`[SoloMode]   message.voiceId: ${message.voiceId}`);
            console.log(`[SoloMode]   message.voiceName: ${message.voiceName}`);
            console.log(`[SoloMode]   currentVoiceId: ${currentVoiceId}`);
            console.log(`[SoloMode]   voicePreference: ${voicePreference}`);

            // Determine tier preference
            // CRITICAL: Extract tier from voice URN if present (same logic as Streaming mode)
            let tierPreference = message.tier;

            if (!tierPreference && voicePreference) {
              // Extract tier from voiceId URN if present (e.g. google_cloud_tts:chirp3_hd:...)
              if (voicePreference.includes(':')) {
                const parts = voicePreference.split(':');
                if (parts.length >= 2) {
                  // Map URN tier 'gemini_tts' to 'gemini' for the resolver check
                  const extractedTier = parts[1] === 'gemini_tts' ? 'gemini' : parts[1];
                  tierPreference = extractedTier;
                  console.log(`[SoloMode]   ✅ Extracted tier from URN: ${extractedTier}`);
                }
              } else if (voicePreference.startsWith('elevenlabs')) {
                tierPreference = 'elevenlabs';
                console.log(`[SoloMode]   ✅ Detected ElevenLabs tier`);
              }
            }

            // If still no tier and no voice, default to gemini
            if (!tierPreference && !voicePreference) {
              tierPreference = 'gemini';
              console.log(`[SoloMode]   ⚠️ No tier or voice, defaulting to gemini`);
            }

            console.log(`[SoloMode]   📍 Final tierPreference: ${tierPreference}`);
            console.log(`[SoloMode]   📍 Final voicePreference: ${voicePreference}`);

            // Resolve TTS routing
            const route = await resolveTtsRoute({
              requestedTier: tierPreference,
              requestedVoice: voicePreference,
              languageCode: message.languageCode,
              mode: 'unary',
              orgConfig: {},
              userSubscription: {}
            });

            console.log(`[SoloMode]   🎯 Resolved route:`, JSON.stringify(route, null, 2));

            // Broadcast routing info for overlay (consistent with Streaming Orchestrator)
            if (clientWs.readyState === WebSocket.OPEN) {
              // Correctly resolve provider name from the route object
              // route.provider is populated by resolveTtsRoute (e.g. 'elevenlabs', 'google')
              const providerName = route.provider === 'elevenlabs' ? 'ElevenLabs' : 'Google';

              clientWs.send(JSON.stringify({
                type: 'tts/routing',
                voiceName: route.voiceName,
                // Map internal engine/provider names to overlay expectations
                provider: providerName,
                tier: route.tier || message.tier || 'gemini',  // Use route.tier (the returned property)
                latencyMs: 0, // Unary starts immediately
                timestamp: Date.now()
              }));
            }

            // Build TTS request
            const ttsRequest = {
              sessionId: sessionId,
              userId: 'solo_user',
              orgId: 'default',
              text: message.text,
              segmentId: message.segmentId,
              profile: {
                engine: route.engine,
                requestedTier: message.tier || 'gemini',
                languageCode: route.languageCode,
                voiceName: route.voiceName,
                modelName: route.model || message.modelName,
                encoding: route.audioEncoding,
                streaming: false,
                prompt: message.prompt
              },
              ssmlOptions: message.ssmlOptions || null,
              promptPresetId: message.promptPresetId || null,
              ttsPrompt: message.ttsPrompt || null,
              intensity: message.intensity || null
            };

            // Check quota
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
              break;
            }

            // Validate policy
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
              break;
            }

            // Synthesize audio
            const ttsService = getTtsServiceForProvider(route.provider);
            const response = await ttsService.synthesizeUnary(ttsRequest, route);

            // Send audio response
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
                resolvedRoute: response.route,
                ssmlOptions: ttsRequest.ssmlOptions || null
              }));
            }

            // Record usage
            await recordUsage({
              orgId: ttsRequest.orgId,
              userId: ttsRequest.userId,
              sessionId: ttsRequest.sessionId,
              segmentId: message.segmentId,
              requested: {
                tier: message.tier || 'gemini',
                voiceName: message.voiceName,
                languageCode: message.languageCode
              },
              route: response.route,
              characters: ttsRequest.text.length,
              audioSeconds: response.durationMs ? response.durationMs / 1000 : null,
              status: 'success'
            });

            console.log(`[SoloMode] TTS synthesis successful: ${message.segmentId}`);

          } catch (error) {
            console.error('[SoloMode] TTS synthesis error:', error);

            let errorCode = 'SYNTHESIS_FAILED';
            let errorMessage = error.message;
            let errorDetails = {};

            try {
              const parsedError = JSON.parse(error.message);
              errorCode = parsedError.code || errorCode;
              errorMessage = parsedError.message || errorMessage;
              errorDetails = parsedError.details || {};
            } catch (e) {
              // Not a JSON error
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
          }
          break;
        }

        default:
          console.log(`[SoloMode] Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error("[SoloMode] Error processing message:", error);
    }
  });

  // Handle client disconnect
  clientWs.on("close", () => {
    console.log("[SoloMode] Client disconnected");

    // STOP SESSION SPAN for billing (on disconnect)
    if (sessionSpanHeartbeatInterval) {
      clearInterval(sessionSpanHeartbeatInterval);
      sessionSpanHeartbeatInterval = null;
    }
    if (sessionSpanStarted && trackingSessionId) {
      (async () => {
        if (sessionSpanStartPromise) await sessionSpanStartPromise;

        stopSessionSpan({
          sessionId: trackingSessionId,
          reason: 'client_disconnect'
        }).then(async (result) => {
          console.log(`[SoloMode] ✓ Session span stopped on disconnect: ${result.durationSeconds}s`);

          // Also mark the DB session as ended to keep data clean
          try {
            await supabaseAdmin.from('sessions').update({
              status: 'ended',
              ended_at: new Date().toISOString(),
              metadata: { ended_reason: 'disconnect' }
            }).eq('id', trackingSessionId);
          } catch (e) { /* ignore cleanup error */ }

        }).catch(err => {
          console.warn(`[SoloMode] ⚠️ Failed to stop session span on disconnect:`, err.message);
        });
      })();
      sessionSpanStarted = false;
    }

    // CRITICAL: If there's a forced final buffer waiting for recovery, commit it immediately
    // The audio buffer will be cleared, so recovery won't work anyway
    syncForcedFinalBuffer();
    if (forcedCommitEngine.hasForcedFinalBuffer()) {
      const buffer = forcedCommitEngine.getForcedFinalBuffer();
      console.log('[SoloMode] ⚠️ Client disconnected with forced final buffer - committing immediately (no audio to recover)');

      // Cancel recovery timeout since there's no audio to recover
      forcedCommitEngine.clearForcedFinalBufferTimeout();

      // Commit the forced final immediately
      const forcedFinalText = buffer.text;
      processFinalText(forcedFinalText, { forceFinal: true });

      // Clear the buffer
      forcedCommitEngine.clearForcedFinalBuffer();
      syncForcedFinalBuffer();

      console.log('[SoloMode] ✅ Forced final committed due to client disconnect');
    }

    if (speechStream) {
      speechStream.destroy();
      speechStream = null;
    }

    // AGGREGATE STT USAGE METERING: Record total transcription usage at session end
    if (totalTranscribedCharacters > 0 && clientWs.churchId) {
      const sessionDurationSeconds = Math.ceil((Date.now() - sessionStartTime) / 1000);
      // Estimate transcription seconds from character count (avg ~15 chars/second of speech)
      const estimatedTranscriptionSeconds = Math.ceil(totalTranscribedCharacters / 15);
      const sessionHash = crypto.createHash('md5').update(sessionId).digest('hex').substring(0, 8);
      const idempotencyKey = `stt:${clientWs.churchId}:${sessionId}:${sessionHash}`;

      recordUsageEvent({
        church_id: clientWs.churchId,
        metric: 'transcription_seconds',
        quantity: estimatedTranscriptionSeconds,
        idempotency_key: idempotencyKey,
        metadata: {
          sessionId,
          totalCharacters: totalTranscribedCharacters,
          sessionDurationSeconds,
          sourceLang: currentSourceLang,
          targetLang: currentTargetLang
        }
      }).then(() => {
        console.log(`[SoloMode] ✓ Recorded usage: ${estimatedTranscriptionSeconds} transcription_seconds (key: ${idempotencyKey})`);
      }).catch(err => {
        console.warn(`[SoloMode] ⚠️ Failed to record STT usage:`, err.message);
      });
    }
  });

  // Initial greeting
  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify({
      type: 'info',
      message: 'Connected to Google Speech + OpenAI Translation. Waiting for initialization...'
    }));
  }
}

