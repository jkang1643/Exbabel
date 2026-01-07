/**
 * Host Mode Adapter - Uses CoreEngine for translation pipeline
 *
 * PHASE 8: Migrate host mode to use CoreEngine
 *
 * This adapter wraps CoreEngine and adds host-specific functionality:
 * - SessionStore integration for broadcasting
 * - Multi-language translation broadcasting
 * - Listener management
 *
 * CRITICAL: Must maintain exact same behavior as current hostModeHandler
 */

// --- TEMP DEBUG LEDGER (remove later) ---
const corrLedger = new Map(); // sourceSeqId -> { en: [...], es: [...] }
function ledgerAdd(sourceSeqId, kind, payload, route) {
  if (sourceSeqId == null || sourceSeqId === 0) return;
  const entry = corrLedger.get(sourceSeqId) || { en: [], es: [], other: [] };
  const rec = {
    t: Date.now(),
    route, // 'host' | 'listeners'
    kind,  // 'EN_ANCHOR' | 'ES_TRANSLATION' | etc
    isPartial: payload?.isPartial,
    hasTranslation: payload?.hasTranslation,
    hasCorrection: payload?.hasCorrection,
    targetLang: payload?.targetLang,
    previewO: String(payload?.originalText ?? '').slice(0, 60),
    previewT: String(payload?.translatedText ?? '').slice(0, 60),
    updateType: payload?.updateType,
  };
  if (payload?.targetLang === 'en') entry.en.push(rec);
  else if (payload?.targetLang === 'es') entry.es.push(rec);
  else entry.other.push(rec);

  // Keep small
  entry.en = entry.en.slice(-5);
  entry.es = entry.es.slice(-5);
  entry.other = entry.other.slice(-5);

  corrLedger.set(sourceSeqId, entry);
}

import { GoogleSpeechStream } from '../googleSpeechStream.js';
import WebSocket from 'ws';
import sessionStore from '../sessionStore.js';
import translationManager from '../translationManager.js';
import { partialTranslationWorker, finalTranslationWorker } from '../translationWorkers.js';
import { realtimePartialTranslationWorker, realtimeFinalTranslationWorker } from '../translationWorkersRealtime.js';
import { grammarWorker } from '../grammarWorker.js';
import { CoreEngine } from '../../core/engine/coreEngine.js';
import { mergeRecoveryText, wordsAreRelated } from '../utils/recoveryMerge.js';
import { deduplicatePartialText } from '../../core/utils/partialDeduplicator.js';
import { shouldEmitPartial, shouldEmitFinal, setLastEmittedText, clearLastEmittedText, hasAlphaNumeric } from '../../core/utils/emitGuards.js';

/**
 * Normalize text for comparison
 * @param {string} s - Text to normalize
 * @returns {string} Normalized text
 */
function normalizeForCompare(s = '') {
  return s.trim().toLowerCase().replace(/[^\w\s']/g, '').replace(/\s+/g, ' ');
}

/**
 * Check if a partial is a recovery stub that should be suppressed
 * @param {Object} params - Parameters
 * @param {string} params.partialText - Partial text to check
 * @param {string} params.forcedBufferText - Forced buffer text to compare against
 * @returns {boolean} True if partial is a stub that should be suppressed
 */
function isRecoveryStubPartial({ partialText, forcedBufferText }) {
  const p = normalizeForCompare(partialText);
  const f = normalizeForCompare(forcedBufferText);

  if (!p) return true;

  // If it's very short, it's almost always a stub in recovery
  if (p.length < 18) return true; // tune 15–25

  // If partial is entirely contained in forced buffer text (or likely a prefix)
  if (f && (f.includes(p) || p.startsWith(f) || f.startsWith(p))) return true;

  // Word-based containment (handles small ASR rewrite like "ours"/"our")
  const pWords = p.split(' ').filter(w => w.length > 2);
  const fWords = f.split(' ').filter(w => w.length > 2);
  if (pWords.length <= 4 && pWords.every(w => fWords.includes(w))) return true;

  return false;
}

/**
 * Handle host connection using CoreEngine
 * 
 * @param {WebSocket} clientWs - WebSocket connection for host
 * @param {string} sessionId - Session ID
 */
export async function handleHostConnection(clientWs, sessionId) {
  if (!sessionId) {
    console.error(`[HostMode] ❌ ERROR: sessionId is required but was not provided!`);
    clientWs.send(JSON.stringify({
      type: 'error',
      message: 'Session ID is required'
    }));
    clientWs.close();
    return;
  }
  
  console.log(`[HostMode] ⚡ Host connecting to session ${sessionId} - Using Google Speech + OpenAI Translation`);
  
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    clientWs.send(JSON.stringify({
      type: 'error',
      message: 'Session not found'
    }));
    clientWs.close();
    return;
  }
  
  // Store sessionId in a const to ensure it's captured in closures
  const currentSessionId = sessionId;

  let speechStream = null;
  let currentSourceLang = 'en';
  let usePremiumTier = false; // Tier selection: false = basic (Chat API), true = premium (Realtime API)

  // PHASE 8: Core Engine Orchestrator - coordinates all extracted engines
  // Initialize core engine (same as solo mode)
  const coreEngine = new CoreEngine();
  coreEngine.initialize();
  
  // PHASE 8: Access individual engines via coreEngine for backward compatibility
  const timelineTracker = coreEngine.timelineTracker;
  const rttTracker = coreEngine.rttTracker;
  const partialTracker = coreEngine.partialTracker;
  const finalizationEngine = coreEngine.finalizationEngine;
  const forcedCommitEngine = coreEngine.forcedCommitEngine;
  
  const DEFAULT_LOOKAHEAD_MS = 200; // Default 200ms lookahead (used by RTT tracker)
  
  // PHASE 8: Constants now from core engine (for backward compatibility)
  const MAX_FINALIZATION_WAIT_MS = finalizationEngine.MAX_FINALIZATION_WAIT_MS;
  const FINALIZATION_CONFIRMATION_WINDOW = finalizationEngine.FINALIZATION_CONFIRMATION_WINDOW;
  const MIN_SILENCE_MS = finalizationEngine.MIN_SILENCE_MS;
  const FORCED_FINAL_MAX_WAIT_MS = forcedCommitEngine.FORCED_FINAL_MAX_WAIT_MS;
  const TRANSLATION_RESTART_COOLDOWN_MS = 400; // Pause realtime translations briefly after stream restart
  
  // PHASE 8: Compatibility layers (same pattern as solo mode)
  let forcedFinalBuffer = null;
  const syncForcedFinalBuffer = () => {
    forcedFinalBuffer = forcedCommitEngine.getForcedFinalBuffer();
  };
  
  let pendingFinalization = null;
  const syncPendingFinalization = () => {
    pendingFinalization = finalizationEngine.getPendingFinalization();
  };
  
  // Last audio timestamp for silence detection
  let lastAudioTimestamp = null;
  let silenceStartTime = null;
  let realtimeTranslationCooldownUntil = 0;
  
  // Track next final that arrives after recovery starts (to prevent word duplication)
  let nextFinalAfterRecovery = null;
  let recoveryStartTime = 0;

  // Helper: Measure RTT from client timestamp
  const measureRTT = (clientTimestamp) => {
    return rttTracker.measureRTT(clientTimestamp);
  };

  // Helper: Get adaptive lookahead based on RTT
  const getAdaptiveLookahead = () => {
    return rttTracker.getAdaptiveLookahead();
  };

  // Helper: Send message with sequence info (uses CoreEngine timeline tracker)
  const sendWithSequence = (messageData, isPartial = true) => {
    const { message, seqId } = timelineTracker.createSequencedMessage(messageData, isPartial);
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(message));
    }
    return seqId;
  };

  // Helper: Broadcast message to all listeners
  const broadcastToListeners = (messageData, isPartial = true) => {
    // Spanish emission tracer for bypass path
    const tl = messageData?.targetLang;
    const sl = messageData?.sourceLang;
    const hasT = !!messageData?.hasTranslation;
    if (tl === 'es') {
      console.warn('[TRACE_ES_BYPASS] Spanish emission via broadcastToListeners (bypasses broadcastWithSequence)', {
        type: messageData?.type,
        hasTranslation: hasT,
        sourceLang: sl,
        targetLang: tl,
        originalPreview: String(messageData?.originalText ?? '').slice(0, 80),
        translatedPreview: String(messageData?.translatedText ?? '').slice(0, 80),
      });
      console.warn(new Error('[TRACE_ES_BYPASS] stack').stack);
    }
    
    const { message, seqId } = timelineTracker.createSequencedMessage(messageData, isPartial);
    sessionStore.broadcastToListeners(currentSessionId, message);
    return seqId;
  };

  // Handle client messages
  clientWs.on('message', async (msg) => {
    try {
      const message = JSON.parse(msg.toString());

      switch (message.type) {
        case 'init':
          if (message.sourceLang) {
            currentSourceLang = message.sourceLang;
            sessionStore.updateSourceLanguage(currentSessionId, currentSourceLang);
          }
          if (message.tier !== undefined) {
            const newTier = message.tier === 'premium' || message.tier === true;
            const tierChanged = newTier !== usePremiumTier;
            usePremiumTier = newTier;
            
            if (tierChanged) {
              console.log(`[HostMode] 🔄 TIER SWITCHED: ${usePremiumTier ? 'BASIC → PREMIUM' : 'PREMIUM → BASIC'}`);
              console.log(`[HostMode] 📊 New Tier: ${usePremiumTier ? 'PREMIUM (gpt-realtime-mini)' : 'BASIC (gpt-4o-mini Chat API)'}`);
              console.log(`[HostMode] ⚡ Expected Latency: ${usePremiumTier ? '150-300ms' : '400-1500ms'}`);
              console.log(`[HostMode] 💰 Cost Multiplier: ${usePremiumTier ? '3-4x' : '1x'}`);
            } else {
              console.log(`[HostMode] Tier: ${usePremiumTier ? 'PREMIUM (Realtime API)' : 'BASIC (Chat API)'}`);
            }
          }
          
          console.log(`[HostMode] Session ${currentSessionId} initialized with source language: ${currentSourceLang}`);
          
          // Initialize Google Speech stream
          if (!speechStream) {
            try {
              console.log(`[HostMode] 🚀 Creating Google Speech stream for ${currentSourceLang}...`);
              speechStream = new GoogleSpeechStream();
              
              // Initialize with source language for transcription
              await speechStream.initialize(currentSourceLang);
              
              // Set up error callback
              speechStream.onError((error) => {
                console.error('[HostMode] Speech stream error:', error);
                // Notify host
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({
                    type: 'warning',
                    message: 'Transcription service restarting...',
                    code: error.code
                  }));
                }
                // Optionally notify all listeners
                sessionStore.broadcastToListeners(currentSessionId, {
                  type: 'warning',
                  message: 'Service restarting, please wait...'
                });
              });
              
              // PHASE 8: Set up helper functions and result callback using CoreEngine components
              // Translation throttling for partials (solo mode style)
              let lastPartialTranslation = ''; // Track last translation (single value, not per language)
              let lastPartialTranslationTime = 0;
              let pendingPartialTranslation = null;
              let currentPartialText = ''; // Track current partial text for delayed translations
              let latestPartialTextForCorrection = ''; // Track the absolute latest partial to avoid race conditions
              
              // Segment epoch tracking - prevents out-of-order delayed partial emissions
              let segmentEpoch = 0;           // increments every time we move to a new segment or emit a FINAL
              let delayedPartialTimer = null; // timer for delayed partial processing
              
              // PHASE 8: Partial tracking now uses CoreEngine Partial Tracker
              // Compatibility layer - variables that reference tracker (for closures/timeouts)
              let latestPartialText = '';
              let longestPartialText = '';
              let latestPartialTime = 0;
              let longestPartialTime = 0;
              
              // Helper to sync variables from tracker (call after updatePartial)
              const syncPartialVariables = () => {
                const snapshot = partialTracker.getSnapshot();
                latestPartialText = snapshot.latest || '';
                longestPartialText = snapshot.longest || '';
                latestPartialTime = snapshot.latestTime || 0;
                longestPartialTime = snapshot.longestTime || 0;
              };
              
              // Helper to sync pendingFinalization from engine (call after engine operations)
              const syncPendingFinalizationFromEngine = () => {
                syncPendingFinalization();
              };
              
              // Helper to sync forcedFinalBuffer from engine (call after engine operations)
              const syncForcedFinalBufferFromEngine = () => {
                syncForcedFinalBuffer();
              };
              
              // Helper functions for text processing (delegated to PartialTracker where possible)
              const mergeWithOverlap = (previousText = '', currentText = '') => {
                return partialTracker.mergeWithOverlap(previousText, currentText);
              };
              
              // Helper: Check if text ends with a complete word (not mid-word)
              const endsWithCompleteWord = (text) => {
                if (!text || text.length === 0) return true;
                const trimmed = text.trim();
                // Ends with punctuation, space, or is empty
                if (/[.!?…,;:\s]$/.test(trimmed)) return true;
                return false;
              };
              
              // Helper: Check if text ends with a complete sentence (delegated to FinalizationEngine)
              const endsWithCompleteSentence = (text) => {
                return finalizationEngine.endsWithCompleteSentence(text);
              };
              
              // Helper function to check for partials that extend a just-sent FINAL
              // This should ALWAYS be called after a FINAL is sent to catch any partials that arrived
              // during async processing (grammar correction, translation, etc.)
              const checkForExtendingPartialsAfterFinal = (sentFinalText) => {
                if (!sentFinalText) return;
                
                // Sync partial variables to get the latest state
                syncPartialVariables();
                
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
                    console.log(`[HostMode] ⚠️ Partial extends just-sent FINAL - likely continuation (FINAL: "${sentFinalTrimmed.substring(Math.max(0, sentFinalTrimmed.length - 50))}", partial extends by: "${missingWords.substring(0, 50)}...")`);
                    console.log(`[HostMode] 📊 This indicates words were spoken during final processing - they should be captured in next segment`);
                    foundExtension = true;
                  } else {
                    // Check for overlap using partialTracker
                    const merged = partialTracker.mergeWithOverlap(sentFinalTrimmed, longestTrimmed);
                    if (merged && merged.length > sentFinalTrimmed.length + 3) {
                      const missingWords = merged.substring(sentFinalTrimmed.length).trim();
                      console.log(`[HostMode] ⚠️ Partial extends just-sent FINAL via overlap - likely continuation (FINAL: "${sentFinalTrimmed.substring(Math.max(0, sentFinalTrimmed.length - 50))}", partial extends by: "${missingWords.substring(0, 50)}...")`);
                      console.log(`[HostMode] 📊 This indicates words were spoken during final processing - they should be captured in next segment`);
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
                    console.log(`[HostMode] ⚠️ Partial extends just-sent FINAL - likely continuation (FINAL: "${sentFinalTrimmed.substring(Math.max(0, sentFinalTrimmed.length - 50))}", partial extends by: "${missingWords.substring(0, 50)}...")`);
                    console.log(`[HostMode] 📊 This indicates words were spoken during final processing - they should be captured in next segment`);
                    foundExtension = true;
                  } else {
                    // Check for overlap using partialTracker
                    const merged = partialTracker.mergeWithOverlap(sentFinalTrimmed, latestTrimmed);
                    if (merged && merged.length > sentFinalTrimmed.length + 3) {
                      const missingWords = merged.substring(sentFinalTrimmed.length).trim();
                      console.log(`[HostMode] ⚠️ Partial extends just-sent FINAL via overlap - likely continuation (FINAL: "${sentFinalTrimmed.substring(Math.max(0, sentFinalTrimmed.length - 50))}", partial extends by: "${missingWords.substring(0, 50)}...")`);
                      console.log(`[HostMode] 📊 This indicates words were spoken during final processing - they should be captured in next segment`);
                      foundExtension = true;
                    }
                  }
                }
                
                if (!foundExtension) {
                  // Still log that we checked (for debugging)
                  const finalEndsWithCompleteSentence = endsWithCompleteSentence(sentFinalTrimmed);
                  if (!finalEndsWithCompleteSentence) {
                    console.log(`[HostMode] ✓ Checked for extending partials after FINAL (none found): "${sentFinalTrimmed.substring(Math.max(0, sentFinalTrimmed.length - 50))}"`);
                  }
                }
              };
              
              // Helper function to broadcast message to host and listeners (uses CoreEngine for sequencing)
              const broadcastWithSequence = (messageData, isPartial = true, targetLang = null) => {
                if (!currentSessionId) {
                  console.error(`[HostMode] ❌ ERROR: currentSessionId is not defined! Cannot broadcast message.`);
                  return -1;
                }

                // ✅ CENTRAL INVARIANT: Remove sourceSeqId from same-language payloads (EN payloads)
                const payloadToSend = { ...messageData };
                if (payloadToSend.targetLang === payloadToSend.sourceLang) {
                  delete payloadToSend.sourceSeqId;
                }
                
                // Spanish emission stack tracer - catches every path that emits Spanish
                const tl = payloadToSend?.targetLang || targetLang;
                const sl = payloadToSend?.sourceLang;
                const hasT = !!payloadToSend?.hasTranslation;
                const upd = payloadToSend?.updateType;
                const corr = payloadToSend?.hasCorrection;
                const hasOriginal = !!(payloadToSend?.originalText && payloadToSend.originalText.trim());
                const hasTranslated = !!(payloadToSend?.translatedText && payloadToSend.translatedText.trim());
                
                // Catch ALL Spanish emissions to trace the source - log everything as warning for visibility
                if (tl === 'es') {
                  const isProblematic = !hasT || sl !== 'en' || !hasOriginal;

                  console.warn(`[TRACE_ES] Spanish emission ${isProblematic ? 'PROBLEMATIC' : 'VALID'}`, {
                    type: payloadToSend?.type,
                    updateType: upd,
                    hasCorrection: corr,
                    hasTranslation: payloadToSend?.hasTranslation,
                    sourceLang: sl,
                    targetLang: tl,
                    targetLangParam: targetLang,
                    payloadTargetLang: payloadToSend?.targetLang,
                    hasOriginalText: hasOriginal,
                    hasTranslatedText: hasTranslated,
                    sourceSeqId: payloadToSend?.sourceSeqId,
                    originalPreview: String(payloadToSend?.originalText ?? '').slice(0, 80),
                    correctedPreview: String(payloadToSend?.correctedText ?? '').slice(0, 80),
                    translatedPreview: String(payloadToSend?.translatedText ?? '').slice(0, 80),
                    isPartial: isPartial,
                    isProblematic: isProblematic,
                  });

                  // TEMP DEBUG LEDGER: Dump ledger for "Y grito" detection
                  if (payloadToSend?.translatedText?.includes('Y grito')) {
                    console.log('[LEDGER_DUMP]', payloadToSend.sourceSeqId, corrLedger.get(payloadToSend.sourceSeqId));
                  }

                  console.warn(new Error(`[TRACE_ES] ${isProblematic ? 'PROBLEMATIC' : 'VALID'} stack`).stack);
                }
                
                // ✅ INVARIANT: Never allow non-source language emissions unless it actually has translation text
                if ((payloadToSend?.targetLang !== payloadToSend?.sourceLang) && !payloadToSend?.hasTranslation) {
                  console.warn('[HostMode] 🚫 [Invariant] Dropping non-source emission without translation', {
                    sourceLang: payloadToSend?.sourceLang,
                    targetLang: payloadToSend?.targetLang,
                    updateType: payloadToSend?.updateType,
                    hasCorrection: payloadToSend?.hasCorrection,
                    seqId: payloadToSend?.seqId
                  });
                  return -1; // Return error code to indicate rejection
                }

                // ✅ NEW: Emergency guard - never allow translation broadcasts missing sourceSeqId
                const missingSourceSeqId =
                  payloadToSend?.sourceSeqId === undefined ||
                  payloadToSend?.sourceSeqId === null ||
                  payloadToSend?.sourceSeqId === 0;

                if (payloadToSend?.hasTranslation && payloadToSend?.targetLang !== payloadToSend?.sourceLang && missingSourceSeqId) {
                  console.warn('[Invariant] Dropping translation missing sourceSeqId', {
                    sourceLang: payloadToSend?.sourceLang,
                    targetLang: payloadToSend?.targetLang,
                    hasCorrection: payloadToSend?.hasCorrection,
                    isPartial: payloadToSend?.isPartial,
                    originalPreview: String(payloadToSend?.originalText ?? '').slice(0, 80),
                    translatedPreview: String(payloadToSend?.translatedText ?? '').slice(0, 80),
                  });
                  return null;
                }

                // PHASE 8: Use CoreEngine timeline tracker for sequence IDs
                const { message, seqId } = timelineTracker.createSequencedMessage(payloadToSend, isPartial);

                // TEMP DEBUG LEDGER: Add to correlation ledger
                const sid = payloadToSend?.sourceSeqId ?? (payloadToSend?.targetLang === payloadToSend?.sourceLang ? seqId : null);
                ledgerAdd(sid, payloadToSend?.targetLang === 'es' ? 'ES_EMIT' : 'EN_EMIT', payloadToSend, targetLang ? 'listeners' : 'host');

                // Send to host
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify(message));
                  console.log(`[HostMode] 📤 Sent to host (${isPartial ? 'PARTIAL' : 'FINAL'}, seqId: ${seqId}, targetLang: ${payloadToSend.targetLang || 'N/A'})`);

                  // Optional correlation logging
                  if (payloadToSend?.sourceSeqId !== undefined) {
                    console.log(`[HostMode] 🔗 Correlate: seqId=${seqId} sourceSeqId=${payloadToSend.sourceSeqId} target=${payloadToSend.targetLang || 'N/A'}`);
                  }
                }
                
                // Broadcast to listeners
                if (targetLang) {
                  // Spanish routing tracer - check if routing parameter routes to Spanish
                  if (targetLang === 'es' && (!payloadToSend?.hasTranslation || payloadToSend?.sourceLang !== 'en')) {
                    console.warn('[TRACE_ES_ROUTING] Spanish routing via targetLang parameter', {
                      targetLangParam: targetLang,
                      payloadTargetLang: payloadToSend?.targetLang,
                      hasTranslation: payloadToSend?.hasTranslation,
                      sourceLang: payloadToSend?.sourceLang,
                      type: payloadToSend?.type,
                      updateType: payloadToSend?.updateType,
                      originalPreview: String(payloadToSend?.originalText ?? '').slice(0, 80),
                      translatedPreview: String(payloadToSend?.translatedText ?? '').slice(0, 80),
                    });
                    console.warn(new Error('[TRACE_ES_ROUTING] stack').stack);
                  }
                  
                  // Broadcast to specific language group
                  console.log(`[HostMode] 📡 Broadcasting to ${targetLang} listeners (${isPartial ? 'PARTIAL' : 'FINAL'}, seqId: ${seqId})`);
                  sessionStore.broadcastToListeners(currentSessionId, message, targetLang);
                } else {
                  // Broadcast to all listeners
                  console.log(`[HostMode] 📡 Broadcasting to ALL listeners (${isPartial ? 'PARTIAL' : 'FINAL'}, seqId: ${seqId})`);
                  sessionStore.broadcastToListeners(currentSessionId, message);
                }
                
                return seqId;
              };
              
              // Grammar correction cache (from solo mode)
              const grammarCorrectionCache = new Map();
              const MAX_GRAMMAR_CACHE_ENTRIES = 20;
              const MIN_GRAMMAR_CACHE_LENGTH = 5;
              const MAX_LENGTH_MULTIPLIER = 3;
              
              const rememberGrammarCorrection = (originalText, correctedText) => {
                if (!originalText || !correctedText) return;
                if (originalText === correctedText) return;
                if (originalText.length < MIN_GRAMMAR_CACHE_LENGTH) return;
                const lengthRatio = correctedText.length / originalText.length;
                if (lengthRatio > MAX_LENGTH_MULTIPLIER) {
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
                    break;
                  }
                }
                return updated;
              };
              
              // Track last sent FINAL (from solo mode)
              let lastSentFinalText = '';
              let segmentStartTime = null; // Track segment start time for grace window
              let lastSentFinalTime = 0;
              let lastSentOriginalText = ''; // Track original text to prevent grammar correction duplicates
              const FINAL_CONTINUATION_WINDOW_MS = 3000;
              
              // Flag to prevent concurrent final processing
              let isProcessingFinal = false;
              // Queue for finals that arrive while another is being processed
              const finalProcessingQueue = [];
              
              // Queue for deferred finals from recovery/dedupe pipeline
              const deferredFinalQueue = [];
              
              // Function to drain deferred final queue (called from recovery completion callbacks)
              async function drainDeferredFinals({ processFinalText }) {
                const queueLength = deferredFinalQueue.length;
                console.log(`[HostMode] 🔄 drainDeferredFinals called - queue length: ${queueLength}`);
                
                if (queueLength === 0) {
                  console.log('[HostMode] ✅ Deferred final queue is empty - nothing to drain');
                  return;
                }
                
                if (!processFinalText) {
                  console.error('[HostMode] ❌ drainDeferredFinals: processFinalText is not provided!');
                  return;
                }
                
                let processedCount = 0;
                while (deferredFinalQueue.length > 0) {
                  const item = deferredFinalQueue.shift();
                  try {
                    // item should include { text, options } or similar
                    if (item && item.text) {
                      console.log(`[HostMode] 📝 Processing deferred final ${processedCount + 1}/${queueLength}: "${item.text.substring(0, 60)}..."`);
                      console.log(`[HostMode]   Options: ${JSON.stringify(item.options || {})}`);
                      processFinalText(item.text, item.options || {});
                      processedCount++;
                    } else {
                      console.warn(`[HostMode] ⚠️ Skipping invalid deferred final item: ${JSON.stringify(item)}`);
                    }
                  } catch (err) {
                    console.error('[HostMode] ❌ Error processing deferred final:', err);
                    console.error('[HostMode]   Item that failed:', JSON.stringify(item));
                    console.error('[HostMode]   Error stack:', err.stack);
                  }
                }
                
                console.log(`[HostMode] ✅ drainDeferredFinals completed - processed ${processedCount}/${queueLength} items`);
              }
              
              // Extract final processing into separate async function (using solo mode logic, adapted for broadcasting)
              const processFinalText = (textToProcess, options = {}) => {
                // If already processing, queue this final instead of skipping
                if (isProcessingFinal) {
                  // CRITICAL: Before queuing, check if this is an older version of text already committed
                  // This prevents queuing incomplete versions after recovery has committed complete versions
                  if (lastSentFinalText) {
                    const queuedNormalized = textToProcess.trim().replace(/\s+/g, ' ').toLowerCase();
                    const lastSentNormalized = lastSentFinalText.replace(/\s+/g, ' ').toLowerCase();
                    
                    // If this text is a prefix of what we already sent, skip queuing (older version)
                    if (lastSentNormalized.startsWith(queuedNormalized) && lastSentNormalized.length > queuedNormalized.length) {
                      console.log(`[HostMode] ⏭️ Skipping queued final - older version already committed (queued: ${queuedNormalized.length} chars, sent: ${lastSentNormalized.length} chars)`);
                      console.log(`[HostMode]   Would queue: "${textToProcess.substring(0, 80)}..."`);
                      console.log(`[HostMode]   Already sent: "${lastSentFinalText.substring(0, 80)}..."`);
                      return; // Don't queue older version
                    }
                  }
                  
                  console.log(`[HostMode] ⏳ Final already being processed, queuing: "${textToProcess.substring(0, 60)}..."`);
                  finalProcessingQueue.push({ textToProcess, options });
                  return; // Queue instead of skip
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
                    const isForcedFinal = !!options.forceFinal;
                    
                    // Always check for duplicates if we have tracking data (not just within time window)
                    // This catches duplicates even if they arrive outside the continuation window
                    if (lastSentOriginalText) {
                      const lastSentOriginalNormalized = lastSentOriginalText.replace(/\s+/g, ' ').toLowerCase();
                      const lastSentFinalNormalized = lastSentFinalText.replace(/\s+/g, ' ').toLowerCase();
                      const timeSinceLastFinal = Date.now() - lastSentFinalTime;
                      
                      // CRITICAL: For forced finals, use MORE aggressive deduplication
                      // Forced finals can be committed multiple times (recovery + timeout) with slight variations
                      // Check if one is a prefix/extension of another, or if they're very similar
                      if (isForcedFinal) {
                        // For forced finals, check within a longer window (10 seconds) since recovery can take time
                        const FORCED_FINAL_DEDUP_WINDOW_MS = 10000;
                        
                        if (timeSinceLastFinal < FORCED_FINAL_DEDUP_WINDOW_MS) {
                          // Check if texts are identical (normalized)
                          if (textNormalized === lastSentFinalNormalized || textNormalized === lastSentOriginalNormalized) {
                            console.log(`[HostMode] ⚠️ Duplicate FORCED final detected (identical text, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..."`);
                            isProcessingFinal = false;
                            return;
                          }
                          
                          // CRITICAL: Check if one forced final is a prefix/extension of another
                          // This catches cases where recovery adds words to the same base text
                          if (textNormalized.length > 20 && lastSentFinalNormalized.length > 20) {
                            // Check if new text starts with last sent (new is extension)
                            if (lastSentFinalNormalized.startsWith(textNormalized.substring(0, Math.min(textNormalized.length, lastSentFinalNormalized.length - 5)))) {
                              const prefixLen = Math.min(textNormalized.length, lastSentFinalNormalized.length - 5);
                              if (prefixLen > 30) {
                                console.log(`[HostMode] ⚠️ Duplicate FORCED final detected (new is prefix of last sent, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..."`);
                                console.log(`[HostMode]   New: "${trimmedText.substring(0, 80)}..."`);
                                console.log(`[HostMode]   Last sent: "${lastSentFinalText.substring(0, 80)}..."`);
                                isProcessingFinal = false;
                                return;
                              }
                            }
                            
                            // Check if last sent starts with new text (last sent is extension - prefer longer one)
                            if (textNormalized.startsWith(lastSentFinalNormalized.substring(0, Math.min(lastSentFinalNormalized.length, textNormalized.length - 5)))) {
                              const prefixLen = Math.min(lastSentFinalNormalized.length, textNormalized.length - 5);
                              if (prefixLen > 30 && textNormalized.length > lastSentFinalNormalized.length) {
                                console.log(`[HostMode] ⚠️ Duplicate FORCED final detected (last sent is prefix of new, ${timeSinceLastFinal}ms ago), but new is longer - will replace`);
                                // Allow this to proceed - it's an extension, but we'll update tracking
                              } else if (prefixLen > 30) {
                                console.log(`[HostMode] ⚠️ Duplicate FORCED final detected (last sent is prefix of new but new is not longer, ${timeSinceLastFinal}ms ago), skipping`);
                                isProcessingFinal = false;
                                return;
                              }
                            }
                          }
                          
                          // Check for high word overlap (catches punctuation/capitalization/grammar differences)
                          const textWords = textNormalized.split(/\s+/).filter(w => w.length > 2);
                          const lastSentWords = lastSentFinalNormalized.split(/\s+/).filter(w => w.length > 2);
                          
                          if (textWords.length > 5 && lastSentWords.length > 5) {
                            const matchingWords = textWords.filter(w => 
                              lastSentWords.some(lw => wordsAreRelated(w, lw))
                            );
                            const wordOverlapRatio = matchingWords.length / Math.min(textWords.length, lastSentWords.length);
                            const lengthDiff = Math.abs(textNormalized.length - lastSentFinalNormalized.length);
                            
                            // For forced finals, if 75%+ words match and length difference is small, it's a duplicate
                            // Use lower threshold (75% vs 80%) because forced finals may have recovery words added
                            if (wordOverlapRatio >= 0.75 && lengthDiff < 30) {
                              // But allow if new text is significantly longer (recovery found more words)
                              if (textNormalized.length <= lastSentFinalNormalized.length + 10) {
                                console.log(`[HostMode] ⚠️ Duplicate FORCED final detected (high word overlap ${(wordOverlapRatio * 100).toFixed(0)}%, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..."`);
                                isProcessingFinal = false;
                                return;
                              }
                            }
                          }
                        }
                      }
                      
                      // Check if this is the same original text (even if grammar correction would change it)
                      // Use stricter matching for very recent commits (within 5 seconds)
                      if (textNormalized === lastSentOriginalNormalized) {
                        if (timeSinceLastFinal < 5000) {
                          console.log(`[HostMode] ⚠️ Duplicate final detected (same original text, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..."`);
                          isProcessingFinal = false; // Clear flag before returning
                          return; // Skip processing duplicate
                        }
                      }
                      
                      // Also check if corrected text matches what we already sent
                      // Use stricter matching for very recent commits
                      if (timeSinceLastFinal < 5000) {
                        if (textNormalized === lastSentFinalNormalized) {
                          console.log(`[HostMode] ⚠️ Duplicate final detected (same corrected text, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                          isProcessingFinal = false; // Clear flag before returning
                          return; // Skip processing duplicate
                        }
                        
                        // Check for near-exact matches (very similar text within 5 seconds)
                        if (textNormalized.length > 10 && lastSentFinalNormalized.length > 10) {
                          const lengthDiff = Math.abs(textNormalized.length - lastSentFinalNormalized.length);
                          const similarity = textNormalized.includes(lastSentFinalNormalized) || lastSentFinalNormalized.includes(textNormalized);
                          
                          // If texts are very similar (one contains the other) and length difference is small
                          if (similarity && lengthDiff < 10 && lengthDiff < Math.min(textNormalized.length, lastSentFinalNormalized.length) * 0.1) {
                            console.log(`[HostMode] ⚠️ Duplicate final detected (very similar text, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                            isProcessingFinal = false; // Clear flag before returning
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
                              console.log(`[HostMode] ⚠️ Duplicate final detected (high word overlap ${(wordOverlapRatio * 100).toFixed(0)}%, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                              isProcessingFinal = false; // Clear flag before returning
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
                          console.log(`[HostMode] ⚠️ Duplicate final detected (same corrected text), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                          isProcessingFinal = false; // Clear flag before returning
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
                              console.log(`[HostMode] ⚠️ Duplicate final detected (high word overlap ${(wordOverlapRatio * 100).toFixed(0)}% in continuation window), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                              isProcessingFinal = false; // Clear flag before returning
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
                              console.log(`[HostMode] ⚠️ Duplicate final detected (very high word overlap ${(wordOverlapRatio * 100).toFixed(0)}% outside time window, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                              isProcessingFinal = false; // Clear flag before returning
                              return; // Skip processing duplicate
                            }
                          }
                        }
                      }
                    }
                    
                    const isTranscriptionOnly = false; // Host mode always translates
                    
                    // Different language - KEEP COUPLED FOR FINALS (history needs complete data)
                    let correctedText = textToProcess; // Declare outside try for catch block access
                    try {
                      // CRITICAL FIX: Apply cached grammar corrections FIRST before running new grammar correction
                      // This ensures that if a final extends a partial that had grammar corrections, we use those cached corrections
                      // This prevents cases where a partial was sent with uncorrected grammar, then a final extends it
                      // and we send the final with uncorrected grammar for the partial portion
                      let textWithCachedCorrections = textToProcess;
                      if (currentSourceLang === 'en' && grammarCorrectionCache.size > 0) {
                        textWithCachedCorrections = applyCachedCorrections(textToProcess);
                        if (textWithCachedCorrections !== textToProcess) {
                          console.log(`[HostMode] ✅ Applied cached grammar corrections to final: "${textToProcess.substring(0, 50)}..." → "${textWithCachedCorrections.substring(0, 50)}..."`);
                        }
                      }
                      
                      // CRITICAL FIX: Get grammar correction FIRST (English only), then translate the CORRECTED text
                      // This ensures the translation matches the corrected English text
                      // Use Promise.race to prevent grammar correction from blocking too long
                      // Use textWithCachedCorrections as input (not original textToProcess) to avoid re-correcting already-corrected portions
                      if (currentSourceLang === 'en') {
                        try {
                          // Set a timeout for grammar correction (max 2 seconds) to prevent blocking
                          const grammarTimeout = new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Grammar correction timeout')), 2000)
                          );
                          
                          // Run grammar correction on text that already has cached corrections applied
                          // This ensures we don't lose corrections that were already made to partial portions
                          correctedText = await Promise.race([
                            grammarWorker.correctFinal(textWithCachedCorrections, process.env.OPENAI_API_KEY),
                            grammarTimeout
                          ]);
                          
                          // Remember the correction mapping from original text to final corrected text
                          rememberGrammarCorrection(textToProcess, correctedText);
                        } catch (grammarError) {
                          if (grammarError.message === 'Grammar correction timeout') {
                            console.warn(`[HostMode] Grammar correction timed out after 2s, using text with cached corrections`);
                            // Use text with cached corrections as fallback (better than original)
                            correctedText = textWithCachedCorrections;
                          } else {
                            console.warn(`[HostMode] Grammar correction failed, using text with cached corrections:`, grammarError.message);
                            // Use text with cached corrections as fallback (better than original)
                            correctedText = textWithCachedCorrections;
                          }
                        }
                      } else {
                        // Non-English source - skip grammar correction, but still apply cached corrections if any
                        correctedText = textWithCachedCorrections;
                      }

                      // Get all target languages needed for listeners
                      const targetLanguages = sessionStore.getSessionLanguages(currentSessionId);
                      console.log(`[HostMode] 🔍 Target languages for session: ${JSON.stringify(targetLanguages)}`);
                      
                      if (targetLanguages.length === 0) {
                        console.log('[HostMode] No listeners yet, skipping translation');
                        // Still send to host
                        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                          broadcastWithSequence({
                            type: 'translation',
                            originalText: correctedText,
                            correctedText: correctedText,
                            translatedText: correctedText,
                            sourceLang: currentSourceLang,
                            targetLang: currentSourceLang,
                            timestamp: Date.now(),
                            hasTranslation: false,
                            hasCorrection: correctedText !== textToProcess,
                            forceFinal: !!options.forceFinal
                          }, false);
                        }
                        return;
                      }

                      // Translate the CORRECTED text (not the original) to all target languages
                      // Route to appropriate worker based on tier
                      let translations = {};
                      const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                      try {
                        const finalWorker = usePremiumTier 
                          ? realtimeFinalTranslationWorker 
                          : finalTranslationWorker;
                        console.log(`[HostMode] 🔀 Using ${workerType} API for final translation to ${targetLanguages.length} language(s) (${correctedText.length} chars)`);
                        console.log(`[HostMode]   Target languages: ${JSON.stringify(targetLanguages)}`);
                        console.log(`[HostMode]   sessionId: ${currentSessionId || 'NULL'}`);
                        translations = await finalWorker.translateToMultipleLanguages(
                          correctedText, // Use corrected text for translation
                          currentSourceLang,
                          targetLanguages,
                          process.env.OPENAI_API_KEY,
                          currentSessionId
                        );
                        console.log(`[HostMode] ✅ Translation result keys: ${JSON.stringify(Object.keys(translations))}`);
                        console.log(`[HostMode] ✅ Translation result: ${JSON.stringify(Object.fromEntries(Object.entries(translations).map(([k, v]) => [k, v?.substring(0, 50) + '...'])))}`);
                      } catch (translationError) {
                        // If it's a skip request error (rate limited), use original text silently
                        if (translationError.skipRequest) {
                          console.log(`[HostMode] ⏸️ Translation skipped (rate limited), using original text`);
                          // Use corrected text (or original if grammar also failed) for all languages
                          for (const targetLang of targetLanguages) {
                            translations[targetLang] = correctedText;
                          }
                        } else if (translationError.message && translationError.message.includes('truncated')) {
                          console.warn(`[HostMode] ⚠️ Translation truncated - text may be incomplete:`, translationError.message);
                          // Fallback to corrected English for all languages
                          for (const targetLang of targetLanguages) {
                            translations[targetLang] = correctedText;
                          }
                        } else if (translationError.message && translationError.message.includes('timeout')) {
                          console.error(`[HostMode] ❌ ${workerType} API timeout for final translation:`, translationError.message);
                          console.warn(`[HostMode] ⚠️ Using corrected text as fallback due to timeout`);
                          // Fallback to corrected text for all languages
                          for (const targetLang of targetLanguages) {
                            translations[targetLang] = correctedText;
                          }
                        } else {
                          console.error(`[HostMode] Translation failed:`, translationError.message);
                          // Empty translations - will be handled below
                        }
                      }

                      const hasCorrection = correctedText !== textToProcess;

                      // Log FINAL with correction details
                      console.log(`[HostMode] 📤 Processing FINAL translations for listeners:`);
                      console.log(`[HostMode]   originalText: "${textToProcess}"`);
                      console.log(`[HostMode]   correctedText: "${correctedText}"`);
                      console.log(`[HostMode]   translations: ${Object.keys(translations).length} language(s)`);
                      console.log(`[HostMode]   hasCorrection: ${hasCorrection}`);

                      // ✅ NEW: Create a guaranteed source-language FINAL anchor seqId for correlation.
                      // This does NOT change UI behavior (still same content), it only provides a stable join key.
                      let finalSourceSeqId = null;
                      try {
                        const anchorPayload = {
                          type: 'translation',
                          originalText: correctedText,
                          correctedText: correctedText,
                          sourceLang: currentSourceLang,
                          targetLang: currentSourceLang,
                          timestamp: Date.now(),
                          hasTranslation: false,
                          hasCorrection: hasCorrection,
                          forceFinal: !!options.forceFinal,
                          // Same-language: show corrected text as translatedText (existing behavior)
                          translatedText: correctedText
                        };

                        const anchorSeqId = broadcastWithSequence(anchorPayload, false, currentSourceLang);
                        // Treat 0/undefined/null as invalid
                        if (anchorSeqId !== undefined && anchorSeqId !== null && anchorSeqId !== 0) {
                          finalSourceSeqId = anchorSeqId;
                        } else {
                          console.warn(`[HostMode] ⚠️ FINAL anchor broadcast returned invalid seqId`, { anchorSeqId });
                        }
                      } catch (e) {
                        console.warn(`[HostMode] ⚠️ FINAL anchor broadcast failed`, e?.message || e);
                      }

                      // Broadcast to each language group
                      for (const targetLang of targetLanguages) {
                        // CRITICAL: Only use translation if it exists and is valid - never fallback to English transcriptText
                        const translatedText = translations[targetLang];

                        // Check if translation is valid:
                        // 1. Must exist and not be empty
                        // 2. Must not be the same as original or corrected text (no translation happened)
                        // 3. Must not be an error message
                        const isErrorMessage = translatedText && (
                          translatedText.startsWith('[Translation error:') ||
                          translatedText.startsWith('[Translation error') ||
                          translatedText.includes('Translation error')
                        );

                        const hasTranslationForLang = translatedText &&
                          translatedText.trim() &&
                          !isErrorMessage &&
                          translatedText !== textToProcess &&
                          translatedText !== correctedText;

                        console.log(`[HostMode] 📤 Broadcasting FINAL to ${targetLang}:`);
                        console.log(`[HostMode]   translatedText: "${translatedText || 'undefined'}"`);
                        console.log(`[HostMode]   isErrorMessage: ${isErrorMessage}`);
                        console.log(`[HostMode]   hasTranslationForLang: ${hasTranslationForLang}`);

                        // CRITICAL: If translation is valid, send it. Otherwise, don't send translatedText at all
                        // The frontend will handle the absence of translatedText appropriately
                        const messageToSend = {
                          type: 'translation',
                          originalText: correctedText,
                          correctedText: correctedText,
                          sourceLang: currentSourceLang,
                          targetLang: targetLang,
                          timestamp: Date.now(),
                          hasTranslation: hasTranslationForLang,
                          hasCorrection: hasCorrection,
                          forceFinal: !!options.forceFinal
                        };

                        // ✅ NEW: attach correlation key to *non-source language* FINAL translations only
                        if (targetLang !== currentSourceLang && hasTranslationForLang) {
                          messageToSend.sourceSeqId = finalSourceSeqId;

                          // ✅ NEW: hard invariant — never broadcast a translated FINAL without a valid sourceSeqId
                          if (messageToSend.sourceSeqId === undefined || messageToSend.sourceSeqId === null || messageToSend.sourceSeqId === 0) {
                            console.warn(`[HostMode] 🚫 Dropping FINAL translation missing sourceSeqId`, {
                              targetLang,
                              finalSourceSeqId,
                              originalPreview: (textToProcess || '').slice(0, 80),
                              translatedPreview: (translatedText || '').slice(0, 80)
                            });
                            continue;
                          }
                        }

                        // CRITICAL: For same-language listeners, use correctedText as translatedText (like solo mode)
                        // This ensures grammar corrections appear in history
                        if (targetLang === currentSourceLang) {
                          messageToSend.translatedText = correctedText; // Same language = show corrected text
                          messageToSend.hasTranslation = false; // No translation needed
                          // (No sourceSeqId needed for same-language)
                        }
                        // Only include translatedText if we have a valid translation
                        else if (hasTranslationForLang) {
                          messageToSend.translatedText = translatedText;
                        }
                        // Explicitly set to undefined if we have an error message (so frontend knows translation failed)
                        else if (isErrorMessage) {
                          messageToSend.translatedText = undefined;
                          messageToSend.translationError = true;
                        }

                        broadcastWithSequence(messageToSend, false, targetLang);
                      }
                      
                      // Increment epoch and cancel any pending delayed partial timers when FINAL is emitted
                      segmentEpoch++;
                      if (delayedPartialTimer) {
                        clearTimeout(delayedPartialTimer);
                        delayedPartialTimer = null;
                        console.log(`[HostMode] 🔄 FINAL emitted - cancelled pending delayed partial timer (epoch: ${segmentEpoch})`);
                      }
                      
                      // CRITICAL: Update last sent FINAL tracking after sending
                      // Track both original and corrected text to prevent duplicates
                      lastSentOriginalText = textToProcess; // Always track the original
                      lastSentFinalText = correctedText !== textToProcess ? correctedText : textToProcess;
                      lastSentFinalTime = Date.now();
                      
                      // CRITICAL: Check for partials that arrived during async processing (grammar correction, translation)
                      // This catches words that were spoken while the final was being processed
                      checkForExtendingPartialsAfterFinal(lastSentFinalText);
                    } catch (error) {
                      console.error(`[HostMode] Final processing error:`, error);
                      // If it's a skip request error, use corrected text (or original if not set)
                      const finalText = error.skipRequest ? (correctedText || textToProcess) : `[Translation error: ${error.message}]`;
                      broadcastWithSequence({
                        type: 'translation',
                        originalText: textToProcess,
                        correctedText: correctedText || textToProcess,
                        translatedText: finalText,
                        sourceLang: currentSourceLang,
                        targetLang: currentSourceLang,
                        timestamp: Date.now(),
                        hasTranslation: error.skipRequest,
                        hasCorrection: false,
                        forceFinal: !!options.forceFinal
                      }, false);
                      
                      // CRITICAL: Update last sent FINAL tracking after sending (even on error, if we have text)
                      if (error.skipRequest || finalText !== `[Translation error: ${error.message}]`) {
                        lastSentOriginalText = textToProcess; // Track original
                        lastSentFinalText = textToProcess;
                        lastSentFinalTime = Date.now();
                        
                        // CRITICAL: Check for partials that arrived during async processing
                        checkForExtendingPartialsAfterFinal(lastSentFinalText);
                      }
                    } finally {
                      // CRITICAL: Always clear the processing flag when done
                      isProcessingFinal = false;
                      
                      // Process next queued final if any
                      // CRITICAL: Filter out queued finals that are older versions of text already committed
                      while (finalProcessingQueue.length > 0) {
                        const next = finalProcessingQueue.shift();
                        
                        // Check if this queued final is an older version of text we already sent
                        // This prevents processing incomplete versions after recovery has committed a complete version
                        if (lastSentFinalText && lastSentOriginalText) {
                          const queuedNormalized = next.textToProcess.trim().replace(/\s+/g, ' ').toLowerCase();
                          const lastSentNormalized = lastSentFinalText.replace(/\s+/g, ' ').toLowerCase();
                          const lastSentOriginalNormalized = lastSentOriginalText.replace(/\s+/g, ' ').toLowerCase();
                          
                          // If queued text is a prefix of what we already sent, skip it (older version)
                          if (lastSentNormalized.startsWith(queuedNormalized) && lastSentNormalized.length > queuedNormalized.length) {
                            console.log(`[HostMode] ⏭️ Skipping queued final - older version already committed (queued: ${queuedNormalized.length} chars, sent: ${lastSentNormalized.length} chars)`);
                            console.log(`[HostMode]   Queued: "${next.textToProcess.substring(0, 80)}..."`);
                            console.log(`[HostMode]   Already sent: "${lastSentFinalText.substring(0, 80)}..."`);
                            continue; // Skip this queued final, check next one
                          }
                          
                          // Also check if queued text matches original but we already sent a corrected version
                          if (queuedNormalized === lastSentOriginalNormalized && lastSentNormalized !== lastSentOriginalNormalized) {
                            console.log(`[HostMode] ⏭️ Skipping queued final - original version already committed as corrected version`);
                            continue; // Skip this queued final, check next one
                          }
                        }
                        
                        console.log(`[HostMode] 🔄 Processing queued final: "${next.textToProcess.substring(0, 60)}..."`);
                        // Recursively process the next queued final
                        processFinalText(next.textToProcess, next.options);
                        break; // Only process one at a time
                      }
                    }
                  } catch (error) {
                    console.error(`[HostMode] Error processing final:`, error);
                    // CRITICAL: Clear flag on outer error too
                    isProcessingFinal = false;
                    
                    // Process next queued final even on error
                    // CRITICAL: Filter out queued finals that are older versions of text already committed
                    while (finalProcessingQueue.length > 0) {
                      const next = finalProcessingQueue.shift();
                      
                      // Check if this queued final is an older version of text we already sent
                      if (lastSentFinalText && lastSentOriginalText) {
                        const queuedNormalized = next.textToProcess.trim().replace(/\s+/g, ' ').toLowerCase();
                        const lastSentNormalized = lastSentFinalText.replace(/\s+/g, ' ').toLowerCase();
                        const lastSentOriginalNormalized = lastSentOriginalText.replace(/\s+/g, ' ').toLowerCase();
                        
                        // If queued text is a prefix of what we already sent, skip it (older version)
                        if (lastSentNormalized.startsWith(queuedNormalized) && lastSentNormalized.length > queuedNormalized.length) {
                          console.log(`[HostMode] ⏭️ Skipping queued final after error - older version already committed`);
                          continue; // Skip this queued final, check next one
                        }
                        
                        // Also check if queued text matches original but we already sent a corrected version
                        if (queuedNormalized === lastSentOriginalNormalized && lastSentNormalized !== lastSentOriginalNormalized) {
                          console.log(`[HostMode] ⏭️ Skipping queued final after error - original version already committed as corrected version`);
                          continue; // Skip this queued final, check next one
                        }
                      }
                      
                      console.log(`[HostMode] 🔄 Processing queued final after error: "${next.textToProcess.substring(0, 60)}..."`);
                      processFinalText(next.textToProcess, next.options);
                      break; // Only process one at a time
                    }
                  }
                })();
              };
              
              // Alias for backwards compatibility
              const processFinalTranscript = processFinalText;
              
              // Set up result callback - handles both partials and finals (solo mode logic, adapted for broadcasting)
              speechStream.onResult(async (transcriptText, isPartial, meta = {}) => {
                if (!clientWs || clientWs.readyState !== WebSocket.OPEN) return;
                
                // CRITICAL: Null check - recovery stream may send null results
                if (!transcriptText || transcriptText.length === 0) {
                  console.log(`[HostMode] ⚠️ Received empty/null transcriptText from stream, ignoring`);
                  return;
                }
                
                // Extract pipeline from meta (default to 'normal')
                const pipeline = meta.pipeline || 'normal';
                console.log(`[HostMode] 📥 RESULT RECEIVED: ${isPartial ? 'PARTIAL' : 'FINAL'} "${transcriptText.substring(0, 60)}..." (pipeline: ${pipeline})`);

                // 🧪 AUDIO BUFFER TEST: Log buffer status on every result (same as solo mode)
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
                console.log(`[HostMode] 📥 RESULT RECEIVED: ${isPartial ? 'PARTIAL' : 'FINAL'} "${transcriptText.substring(0, 60)}..." (meta: ${JSON.stringify(meta)})`);
                
                if (isPartial) {
                  // PHASE 8: Removed deprecated PRIORITY 0 backpatching logic
                  // Dual buffer recovery system handles word recovery now
                  
                  // Handle forced final buffer (solo mode logic)
                  // PHASE 8: Use Forced Commit Engine to check for forced final extensions
                  syncForcedFinalBuffer(); // Sync variable from engine
                  if (forcedCommitEngine.hasForcedFinalBuffer()) {
                    // CRITICAL: Check if this partial extends the forced final or is a new segment
                    const extension = forcedCommitEngine.checkPartialExtendsForcedFinal(transcriptText);
                    
                    if (extension && extension.extends) {
                      // Partial extends the forced final - but wait for recovery if in progress
                      console.log('[HostMode] 🔁 New partial extends forced final - checking if recovery is in progress...');
                      syncForcedFinalBuffer();
                      
                      // CRITICAL: If recovery is in progress, wait for it to complete first
                      if (forcedFinalBuffer && forcedFinalBuffer.recoveryInProgress && forcedFinalBuffer.recoveryPromise) {
                        console.log('[HostMode] ⏳ Recovery in progress - waiting for completion before committing extended partial...');
                        try {
                          const recoveredText = await forcedFinalBuffer.recoveryPromise;
                          if (recoveredText && recoveredText.length > 0) {
                            console.log(`[HostMode] ✅ Recovery completed with text: "${recoveredText.substring(0, 60)}..."`);
                            // Recovery found words - merge recovered text with extending partial
                            const recoveredMerged = partialTracker.mergeWithOverlap(recoveredText, transcriptText);
                            if (recoveredMerged) {
                              console.log('[HostMode] 🔁 Merging recovered text with extending partial and committing');
                              forcedCommitEngine.clearForcedFinalBufferTimeout();
                              try {
                                processFinalText(recoveredMerged, { forceFinal: true });
                              } catch (e) {
                                console.error('[HostMode] ❌ Forced-final commit failed (recovered merged):', e);
                              }
                              forcedCommitEngine.clearForcedFinalBuffer();
                              syncForcedFinalBuffer();
                              // Continue processing the extended partial normally
                              return; // Exit early - already committed
                            }
                          }
                        } catch (error) {
                          console.error('[HostMode] ❌ Error waiting for recovery:', error.message);
                        }
                      }
                      
                      // No recovery or recovery completed - merge and commit normally
                      console.log('[HostMode] 🔁 New partial extends forced final - merging and committing');
                      forcedCommitEngine.clearForcedFinalBufferTimeout();
                      const mergedFinal = partialTracker.mergeWithOverlap(forcedCommitEngine.getForcedFinalBuffer().text, transcriptText);
                      try {
                        if (mergedFinal) {
                          processFinalText(mergedFinal, { forceFinal: true });
                        } else {
                          // Merge failed - use extended text
                          processFinalText(extension.extendedText, { forceFinal: true });
                        }
                      } catch (e) {
                        console.error('[HostMode] ❌ Forced-final commit failed (extending partial):', e);
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
                        console.log('[HostMode] 🔀 New segment detected but recovery in progress - deferring partial tracker reset');
                        console.log('[HostMode] ⏳ Will reset partial tracker after recovery completes');
                      } else {
                        console.log('[HostMode] 🔀 New segment detected - will let POST-final recovery complete first');
                      }
                      // DON'T clear timeout or set to null - let it run!
                      // The timeout will commit the final after POST-final audio recovery
                      // Continue processing the new partial as a new segment
                      // NOTE: Partial tracker reset will happen in the timeout callback after recovery
                    }
                  }
                  
                  // CRITICAL: Check if this partial duplicates words from the previous FINAL FIRST
                  // This prevents cases like "desires" in FINAL followed by "Desires" in PARTIAL
                  // Do this BEFORE updating partial tracker so we track the deduplicated text
                  // CRITICAL: If there's a forced final buffer, also check against it (it hasn't been committed yet)
                  // This prevents partials like "I've been..." from being treated as new when they're actually
                  // continuations of the forced final "Bend. Oh boy, I've been to grocery store..."
                  syncForcedFinalBuffer();
                  let textToCheckAgainst = lastSentFinalText;
                  let timeToCheckAgainst = lastSentFinalTime;
                  
                  // If there's a forced final buffer, check against it instead (it's more recent and hasn't been committed yet)
                  if (forcedFinalBuffer && forcedFinalBuffer.text) {
                    // Use the forced final text - it represents the most recent final, even though it hasn't been sent yet
                    textToCheckAgainst = forcedFinalBuffer.text;
                    // Use the timestamp from when the forced final was received (stored in buffer)
                    timeToCheckAgainst = forcedFinalBuffer.timestamp || Date.now();
                    console.log(`[HostMode] 🔍 Checking partial against forced final buffer (timestamp: ${timeToCheckAgainst}): "${textToCheckAgainst.substring(0, 60)}..."`);
                  }
                  
                  // ✅ Recovery-pipeline stub suppression:
                  // If recovery is active and forced buffer exists, do NOT emit short "stub" partials that will be extended.
                  const recoveryActive = pipeline === 'recovery' && forcedFinalBuffer && forcedFinalBuffer.text;
                  const forcedRecoveryInProgress = !!forcedFinalBuffer?.recoveryInProgress;

                  if (recoveryActive && forcedRecoveryInProgress) {
                    if (isRecoveryStubPartial({ partialText: transcriptText, forcedBufferText: forcedFinalBuffer.text })) {
                      console.log('[HostMode] ⏭️ Skipping recovery stub partial (prevents early emission flicker)');
                      console.log(`[HostMode]   Stub: "${transcriptText.substring(0, 60)}..."`);
                      console.log(`[HostMode]   Forced buffer: "${forcedFinalBuffer.text.substring(0, 60)}..."`);
                      return;
                    }
                  }
                  
                  // CRITICAL: Dedupe ONLY runs in recovery pipeline
                  // Normal pipeline must NOT run dedupe to prevent dropping early partials
                  let partialTextToSend = transcriptText;
                  
                  // Determine if dedupe should run: only in recovery pipeline with proper conditions
                  const shouldDedupe =
                    pipeline === 'recovery' &&
                    (meta?.forceFinal === true || meta?.ranAudioRecovery === true);
                  
                  console.log(`[HostMode] 🔍 Dedupe check: pipeline="${pipeline}", forceFinal=${meta?.forceFinal}, ranAudioRecovery=${meta?.ranAudioRecovery}, shouldDedupe=${shouldDedupe}`);
                  
                  if (shouldDedupe) {
                    // Recovery pipeline: run dedupe to stitch recovered transcript cleanly
                    console.log(`[HostMode] 🔄 DEDUP RUNNING (recovery pipeline only)`);
                    console.log(`[HostMode]   Partial text: "${transcriptText.substring(0, 60)}..."`);
                    console.log(`[HostMode]   Checking against: "${textToCheckAgainst?.substring(0, 60) || 'none'}..."`);
                    
                    const dedupResult = deduplicatePartialText({
                      partialText: transcriptText,
                      lastFinalText: textToCheckAgainst,
                      lastFinalTime: timeToCheckAgainst,
                      mode: 'HostMode',
                      timeWindowMs: 5000,
                      maxWordsToCheck: 3
                    });
                    
                    console.log(`[HostMode]   Dedupe result: wasDeduplicated=${dedupResult.wasDeduplicated}, wordsSkipped=${dedupResult.wordsSkipped}`);
                    console.log(`[HostMode]   Original: "${transcriptText.substring(0, 60)}..."`);
                    console.log(`[HostMode]   Deduplicated: "${dedupResult.deduplicatedText?.substring(0, 60) || 'empty'}..."`);
                    
                    partialTextToSend = dedupResult.deduplicatedText;
                    
                    // If all words were duplicates, skip sending this partial entirely
                    if (dedupResult.wasDeduplicated && (!partialTextToSend || partialTextToSend.length < 3)) {
                      console.log(`[HostMode] ⏭️ Skipping partial - all words are duplicates of previous FINAL (recovery pipeline)`);
                      return; // Skip this partial entirely
                    }
                  } else {
                    // Normal pipeline: skip dedupe
                    console.log(`[HostMode] ⏭️ skip: dedupe disabled (normal pipeline)`);
                    console.log(`[HostMode]   Reason: pipeline="${pipeline}" (needs "recovery") OR missing forceFinal/ranAudioRecovery flags`);
                  }
                  
                  // Track latest partial for correction race condition prevention (use deduplicated text)
                  latestPartialTextForCorrection = partialTextToSend;
                  const translationSeedText = applyCachedCorrections(partialTextToSend);
                  
                  // PHASE 8: Update partial tracking using CoreEngine Partial Tracker
                  // Use deduplicated text for tracking to ensure consistency
                  partialTracker.updatePartial(partialTextToSend);
                  syncPartialVariables(); // Sync variables for compatibility
                  
                  const snapshot = partialTracker.getSnapshot();
                  if (snapshot.longest && snapshot.longest.length > (longestPartialText?.length || 0)) {
                    console.log(`[HostMode] 📏 New longest partial: ${snapshot.longest.length} chars`);
                  }
                  
                  // Segment start grace window: Allow early short partials with alphanumeric content
                  // This prevents dropping early partials like "you" at the start of a segment
                  const isVeryShortPartial = partialTextToSend.trim().length < 5;
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
                    console.log(`[HostMode] 🎯 Grace window active - new segment start detected`);
                    
                    // Increment epoch and cancel any pending delayed partial timers
                    segmentEpoch++;
                    if (delayedPartialTimer) {
                      clearTimeout(delayedPartialTimer);
                      delayedPartialTimer = null;
                      console.log(`[HostMode] 🔄 New segment detected - cancelled pending delayed partial timer (epoch: ${segmentEpoch})`);
                    }
                  }
                  
                  const timeSinceSegmentStart = segmentStartTime ? (Date.now() - segmentStartTime) : Infinity;
                  const isInGraceWindow = isNewSegmentStart && timeSinceSegmentStart < 900; // 600-900ms grace window
                  
                  // In grace window: be conservative - only suppress if pure punctuation/noise
                  // Outside grace window: apply normal rules
                  const hasAlpha = hasAlphaNumeric(partialTextToSend);
                  
                  if (isVeryShortPartial && isNewSegmentStart) {
                    if (isInGraceWindow) {
                      // Grace window: allow if has alphanumeric content
                      if (hasAlpha) {
                        console.log(`[HostMode] ✅ Grace window active (${timeSinceSegmentStart.toFixed(0)}ms) - allowing short partial with alphanumeric: "${partialTextToSend.substring(0, 30)}..."`);
                        // Allow it through - emit guards will handle duplicates
                      } else {
                        // Pure punctuation/noise - suppress even in grace window
                        console.log(`[HostMode] ⏳ Grace window active (${timeSinceSegmentStart.toFixed(0)}ms) - suppressing punctuation-only partial: "${partialTextToSend.substring(0, 30)}..."`);
                        return; // Skip sending this partial
                      }
                    } else {
                      // Outside grace window: apply normal suppression (only if very recent)
                      if (timeSinceLastFinal < 500) {
                        console.log(`[HostMode] ⏳ Delaying very short partial at segment start (${partialTextToSend.trim().length} chars, ${timeSinceLastFinal}ms since last final): "${partialTextToSend.substring(0, 30)}..." - waiting for transcription to stabilize`);
                        return; // Skip sending this partial
                      }
                    }
                  }
                  
                  // Clear segment start time when we're clearly past the grace window
                  if (timeSinceSegmentStart >= 900) {
                    segmentStartTime = null;
                  }
                  
                  // CRITICAL: Check if this partial extends a pending final BEFORE sending it
                  // If it does, we should NOT send it as a new partial to avoid duplication
                  // PHASE 8: Sync pendingFinalization before accessing
                  syncPendingFinalization();
                  let shouldSkipSendingPartial = false;
                  if (finalizationEngine.hasPendingFinalization()) {
                    const pending = finalizationEngine.getPendingFinalization();
                    const timeSinceFinal = Date.now() - pending.timestamp;
                    const finalText = pending.text.trim();
                    // CRITICAL: Use deduplicated text for all checks to ensure consistency
                    // The deduplicated text is what we'll actually send, so use it for extension checks
                    const partialText = partialTextToSend.trim(); // Use deduplicated text, not original
                    
                    // Check if the deduplicated partial extends the final
                    // For short finals, require exact start match. For longer finals, allow some flexibility
                    const extendsFinal = partialText.length > finalText.length && 
                                         (partialText.startsWith(finalText) || 
                                          (finalText.length > 10 && partialText.substring(0, finalText.length) === finalText));
                    
                    // If partial extends the final and it's recent, we should still send it to frontend
                    // so users can see the live updates, but we'll update the pending finalization
                    // The frontend will handle deduplication when the final arrives
                    if (extendsFinal && timeSinceFinal < 2000) {
                      console.log(`[HostMode] 🔁 Partial extends pending final - will send to frontend for live display`);
                      console.log(`[HostMode] 📝 Final: "${finalText.substring(0, 50)}..." → Raw Partial: "${rawPartialText.substring(0, 50)}..." → Deduplicated: "${deduplicatedPartialText.substring(0, 50)}..."`);
                      // Don't skip sending - let frontend see the live update
                      // shouldSkipSendingPartial = true; // REMOVED: Send partials even if they extend finals
                    }
                  }
                  
                  // Only send partial if it doesn't extend a pending final
                  if (!shouldSkipSendingPartial) {
                    // Live partial transcript - send original immediately with sequence ID (solo mode style)
                    // Apply emit guards to prevent duplicate flashes and fragment spam
                    const partialSegmentId = `partial_${Date.now()}`; // Temporary, will use seqId after send
                    const emitCheck = shouldEmitPartial(partialSegmentId, partialTextToSend, {
                      allowCorrection: false,
                      mode: 'HostMode'
                    });
                    
                    if (!emitCheck.shouldEmit) {
                      console.log(`[HostMode] ⏭️ ${emitCheck.reason}: "${partialTextToSend.substring(0, 50)}..."`);
                      return; // Skip emitting this partial
                    }
                    
                    // Note: This is the initial send before grammar/translation, so use raw text
                    // CRITICAL: Explicitly set isPartial: true to prevent frontend from committing as FINAL
                    const isTranscriptionOnly = false; // Host mode always translates (no transcription-only mode)
                    const seqId = broadcastWithSequence({
                      type: 'translation',
                      originalText: partialTextToSend, // Use deduplicated text
                      translatedText: undefined, // Will be updated when translation arrives
                      sourceLang: currentSourceLang,
                      targetLang: currentSourceLang,
                      timestamp: Date.now(),
                      isTranscriptionOnly: false,
                      hasTranslation: false, // Flag that translation is pending
                      hasCorrection: false, // Flag that correction is pending
                      isPartial: true // CRITICAL: Explicitly mark as partial to prevent frontend from committing
                    }, true);
                    
                    // Track last emitted text for this seqId to prevent duplicates
                    setLastEmittedText(seqId, partialTextToSend);
                  }
                  
                  // CRITICAL: If we have pending finalization, check if this partial extends it or is a new segment
                  // PHASE 8: Sync pendingFinalization before accessing
                  // Use deduplicated text for all checks to ensure consistency
                  syncPendingFinalization();
                  if (finalizationEngine.hasPendingFinalization()) {
                    const pending = finalizationEngine.getPendingFinalization();
                    const timeSinceFinal = Date.now() - pending.timestamp;
                    const finalText = pending.text.trim();
                    const partialText = partialTextToSend.trim(); // Use deduplicated text, not original
                    
                    // Check if this partial actually extends the final (starts with it or has significant overlap)
                    // For short finals, require exact start match. For longer finals, allow some flexibility
                    const extendsFinal = partialText.length > finalText.length && 
                                         (partialText.startsWith(finalText) || 
                                          (finalText.length > 10 && partialText.substring(0, finalText.length) === finalText));
                    
                    // CRITICAL: Sentence-aware continuation detection
                    // If FINAL doesn't end with complete sentence, partials are likely continuations
                    const finalEndsWithCompleteSentence = finalizationEngine.endsWithCompleteSentence(finalText);
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
                      console.log(`[HostMode] 🔀 New segment detected - partial "${partialText}" has no relationship to pending FINAL "${finalText.substring(0, 50)}..."`);
                      console.log(`[HostMode] ✅ Committing pending FINAL before processing new segment`);
                      // PHASE 8: Clear timeout using engine
                      finalizationEngine.clearPendingFinalizationTimeout();
                      const textToCommit = pendingFinalization.text;
                      // PHASE 8: Clear using engine
                      finalizationEngine.clearPendingFinalization();
                      syncPendingFinalization();
                      // PHASE 8: Reset partial tracking using tracker
                      partialTracker.reset();
                      syncPartialVariables();
                      processFinalText(textToCommit);
                      // Continue processing the new partial as a new segment (don't return - let it be processed below)
                    }
                    
                    // If partial might be a continuation OR might be a false final (period added incorrectly), wait longer
                    // Continue tracking the partial so it can grow into the complete word
                    // CRITICAL: Check max wait time - don't extend wait if we've already waited too long
                    // CRITICAL: Check if pending still exists (it may have been cleared above)
                    if (!pending) {
                      // pendingFinalization was cleared (final was committed) - skip continuation logic
                      return; // Continue processing the new partial as a new segment
                    }
                    const timeSinceMaxWait = Date.now() - pending.maxWaitTimestamp;
                    if ((mightBeContinuation || mightBeFalseFinal) && !extendsFinal && timeSinceMaxWait < MAX_FINALIZATION_WAIT_MS - 1000) {
                      if (mightBeFalseFinal) {
                        console.log(`[HostMode] ⚠️ Possible false final - FINAL ends with period but very short partial arrived soon after (${timeSinceFinal}ms)`);
                        console.log(`[HostMode] ⏳ Waiting to see if partial grows into continuation: FINAL="${finalText}", partial="${partialText}"`);
                      }
                      console.log(`[HostMode] ⚠️ Short partial after incomplete FINAL - likely continuation (FINAL: "${finalText}", partial: "${partialText}")`);
                      console.log(`[HostMode] ⏳ Extending wait to see if partial grows into complete word/phrase`);
                      // Extend timeout significantly to wait for complete word/phrase
                      // PHASE 8: Clear timeout using engine
                      finalizationEngine.clearPendingFinalizationTimeout();
                      // Don't extend beyond max wait - cap at remaining time
                      const maxRemainingWait = MAX_FINALIZATION_WAIT_MS - timeSinceMaxWait;
                      const remainingWait = Math.min(Math.max(1000, 2500 - timeSinceFinal), maxRemainingWait);
                      console.log(`[HostMode] ⏱️ Extending finalization wait by ${remainingWait}ms (waiting for complete word/phrase, ${timeSinceMaxWait}ms / ${MAX_FINALIZATION_WAIT_MS}ms)`);
                      // Reschedule - will check for longer partials when timeout fires
                      // PHASE 8: Use engine to set timeout
                      finalizationEngine.setPendingFinalizationTimeout(() => {
                        // PHASE 8: Sync and null check (CRITICAL)
                        syncPendingFinalization();
                        if (!pendingFinalization) {
                          console.warn('[HostMode] ⚠️ Timeout fired but pendingFinalization is null - skipping');
                          return;
                        }
                        
                        // PHASE 8: Use tracker methods to check for extending partials
                        const longestExtends = partialTracker.checkLongestExtends(pendingFinalization.text, 10000);
                        const latestExtends = partialTracker.checkLatestExtends(pendingFinalization.text, 5000);
                        let finalTextToUse = pendingFinalization.text;
                        const finalTrimmed = pendingFinalization.text.trim();
                        
                        if (longestExtends) {
                          console.log(`[HostMode] ⚠️ Using LONGEST partial after continuation wait (${pendingFinalization.text.length} → ${longestExtends.extendedText.length} chars)`);
                          console.log(`[HostMode] 📊 Recovered: "${longestExtends.missingWords}"`);
                          finalTextToUse = longestExtends.extendedText;
                        } else if (latestExtends) {
                          console.log(`[HostMode] ⚠️ Using LATEST partial after continuation wait (${pendingFinalization.text.length} → ${latestExtends.extendedText.length} chars)`);
                          console.log(`[HostMode] 📊 Recovered: "${latestExtends.missingWords}"`);
                          finalTextToUse = latestExtends.extendedText;
                        }
                        
                        const textToProcess = finalTextToUse;
                        // PHASE 8: Reset partial tracking using tracker
                        partialTracker.reset();
                        syncPartialVariables();
                        const waitTime = Date.now() - pendingFinalization.timestamp;
                        // PHASE 8: Clear using engine
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();
                        console.log(`[HostMode] ✅ FINAL Transcript (after continuation wait): "${textToProcess.substring(0, 80)}..."`);
                        processFinalText(textToProcess);
                      }, remainingWait);
                      // CRITICAL: Return early to prevent the code below from committing the final
                      // We're waiting for the partial to grow into a continuation, so don't treat it as a new segment yet
                      return; // Continue tracking this partial, but don't commit final or process as new segment
                    }
                    
                      // If partials are still arriving and extending the final, update the pending text and extend the timeout
                    if (timeSinceFinal < 2000 && extendsFinal) {
                      // CRITICAL: Update the pending finalization text with the extended partial IMMEDIATELY
                      // Always use the LONGEST partial available, not just the current one
                      syncPendingFinalization();
                      if (!pendingFinalization) return; // Safety check
                      
                      let textToUpdate = transcriptText;
                      const finalTrimmed = pendingFinalization.text.trim();
                      
                      // Check if longestPartialText is even longer and extends the final
                      const longestExtends = partialTracker.checkLongestExtends(finalTrimmed, 10000);
                      if (longestExtends && longestExtends.extendedText.length > transcriptText.length) {
                        console.log(`[HostMode] 📝 Using LONGEST partial instead of current (${transcriptText.length} → ${longestExtends.extendedText.length} chars)`);
                        textToUpdate = longestExtends.extendedText;
                      }
                      
                      if (textToUpdate.length > pendingFinalization.text.length) {
                        console.log(`[HostMode] 📝 Updating pending final with extended partial (${pendingFinalization.text.length} → ${textToUpdate.length} chars)`);
                        // PHASE 8: Update using engine
                        finalizationEngine.updatePendingFinalizationText(textToUpdate);
                        syncPendingFinalization();
                        
                        // CRITICAL: If extended text now ends with complete sentence, we can finalize sooner
                        const extendedEndsWithCompleteSentence = finalizationEngine.endsWithCompleteSentence(textToUpdate);
                        if (extendedEndsWithCompleteSentence && !finalizationEngine.endsWithCompleteSentence(pendingFinalization.text)) {
                          console.log(`[HostMode] ✅ Extended partial completes sentence - will finalize after shorter wait`);
                        }
                      }
                      // Clear existing timeout and reschedule with fresh delay
                      // PHASE 8: Clear timeout using engine
                      finalizationEngine.clearPendingFinalizationTimeout();
                      // If extended text ends with complete sentence, use shorter wait; otherwise wait longer
                      const extendedEndsWithCompleteSentence = finalizationEngine.endsWithCompleteSentence(textToUpdate);
                      const baseWait = extendedEndsWithCompleteSentence ? 1000 : 2000; // Shorter wait if sentence is complete
                      const remainingWait = Math.max(800, baseWait - timeSinceFinal);
                      console.log(`[HostMode] ⏱️ Extending finalization wait by ${remainingWait}ms (partial still growing: ${textToUpdate.length} chars, sentence complete: ${extendedEndsWithCompleteSentence})`);
                      // Reschedule with the same processing logic
                      // PHASE 8: Use engine to set timeout
                      finalizationEngine.setPendingFinalizationTimeout(() => {
                        // PHASE 8: Sync and null check (CRITICAL)
                        syncPendingFinalization();
                        if (!pendingFinalization) {
                          console.warn('[HostMode] ⚠️ Timeout fired but pendingFinalization is null - skipping');
                          return;
                        }
                        
                        // PHASE 8: Use tracker methods to check for extending partials
                        const longestExtends = partialTracker.checkLongestExtends(pendingFinalization.text, 10000);
                        const latestExtends = partialTracker.checkLatestExtends(pendingFinalization.text, 5000);
                        let finalTextToUse = pendingFinalization.text;
                        
                        if (longestExtends) {
                          console.log(`[HostMode] ⚠️ Using LONGEST partial after extended wait (${pendingFinalization.text.length} → ${longestExtends.extendedText.length} chars)`);
                          console.log(`[HostMode] 📊 Recovered: "${longestExtends.missingWords}"`);
                          finalTextToUse = longestExtends.extendedText;
                        } else if (latestExtends) {
                          console.log(`[HostMode] ⚠️ Using LATEST partial after extended wait (${pendingFinalization.text.length} → ${latestExtends.extendedText.length} chars)`);
                          console.log(`[HostMode] 📊 Recovered: "${latestExtends.missingWords}"`);
                          finalTextToUse = latestExtends.extendedText;
                        }
                        
                        const textToProcess = finalTextToUse;
                        // PHASE 8: Reset partial tracking using tracker
                        partialTracker.reset();
                        syncPartialVariables();
                        const waitTime = Date.now() - pendingFinalization.timestamp;
                        // PHASE 8: Clear using engine
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();
                        console.log(`[HostMode] ✅ FINAL Transcript (after ${waitTime}ms wait): "${textToProcess.substring(0, 80)}..."`);
                        // Process final (reuse the async function logic from the main timeout)
                        processFinalText(textToProcess);
                      }, remainingWait);
                      
                      // CRITICAL: We now send all partials to frontend (even if they extend finals) for live display
                      // The frontend will handle deduplication when the final arrives
                      // No need to skip translation processing - process all partials
                    } else if (!extendsFinal && timeSinceFinal > 600) {
                      // New segment detected - but check if final ends with complete sentence first
                      // If final doesn't end with complete sentence, wait longer before committing
                      syncPendingFinalization();
                      const finalEndsWithCompleteSentence = pendingFinalization ? finalizationEngine.endsWithCompleteSentence(pendingFinalization.text) : false;
                      if (!finalEndsWithCompleteSentence && timeSinceFinal < 3000) {
                        // Final doesn't end with complete sentence and not enough time has passed - wait more
                        console.log(`[HostMode] ⏳ New segment detected but final incomplete - waiting longer (${timeSinceFinal}ms < 3000ms)`);
                        // Continue tracking - don't commit yet
                      } else {
                        // Commit FINAL immediately using longest partial that extends it
                        // CRITICAL: Only use partials that DIRECTLY extend the final (start with it) to prevent mixing segments
                        console.log(`[HostMode] 🔀 New segment detected during finalization (${timeSinceFinal}ms since final) - committing FINAL`);
                        console.log(`[HostMode] 📊 Pending final: "${pendingFinalization.text.substring(0, 100)}..."`);
                        console.log(`[HostMode] 📊 Longest partial: "${longestPartialText?.substring(0, 100) || 'none'}..."`);
                        
                        // PHASE 8: Clear timeout using engine
                      finalizationEngine.clearPendingFinalizationTimeout();
                        
                        // Save current partials before new segment overwrites them
                        const savedLongestPartial = longestPartialText;
                        const savedLatestPartial = latestPartialText;
                        
                        // Use longest available partial ONLY if it DIRECTLY extends the final (starts with it)
                        // This prevents mixing segments and inaccurate text
                        let textToProcess = pendingFinalization.text;
                        const finalTrimmed = pendingFinalization.text.trim();
                        
                        // CRITICAL: Track if we're using partial text (to check if it's mid-sentence)
                        let usingPartialText = false;
                        
                        // Check saved partials first - ONLY if they start with the final
                        if (savedLongestPartial && savedLongestPartial.length > pendingFinalization.text.length) {
                          const savedLongestTrimmed = savedLongestPartial.trim();
                          if (savedLongestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[HostMode] ⚠️ Using SAVED LONGEST partial (${pendingFinalization.text.length} → ${savedLongestPartial.length} chars)`);
                            textToProcess = savedLongestPartial;
                            usingPartialText = true;
                          }
                        } else if (savedLatestPartial && savedLatestPartial.length > pendingFinalization.text.length) {
                          const savedLatestTrimmed = savedLatestPartial.trim();
                          if (savedLatestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[HostMode] ⚠️ Using SAVED LATEST partial (${pendingFinalization.text.length} → ${savedLatestPartial.length} chars)`);
                            textToProcess = savedLatestPartial;
                            usingPartialText = true;
                          }
                        }
                        
                        // Also check current partials - ONLY if they start with the final
                        // CRITICAL: Don't use current partials if they're from a new segment (don't start with final)
                        // This prevents wayward partials like "Important of." from being finalized
                        if (longestPartialText && longestPartialText.length > textToProcess.length) {
                          const longestTrimmed = longestPartialText.trim();
                          // CRITICAL: Must start with final to prevent mixing segments
                          if (longestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[HostMode] ⚠️ Using CURRENT LONGEST partial (${textToProcess.length} → ${longestPartialText.length} chars)`);
                            textToProcess = longestPartialText;
                            usingPartialText = true;
                          } else {
                            console.log(`[HostMode] ⚠️ Ignoring CURRENT LONGEST partial - doesn't start with final (new segment detected)`);
                          }
                        } else if (latestPartialText && latestPartialText.length > textToProcess.length) {
                          const latestTrimmed = latestPartialText.trim();
                          // CRITICAL: Must start with final to prevent mixing segments
                          if (latestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[HostMode] ⚠️ Using CURRENT LATEST partial (${textToProcess.length} → ${latestPartialText.length} chars)`);
                            textToProcess = latestPartialText;
                            usingPartialText = true;
                          } else {
                            console.log(`[HostMode] ⚠️ Ignoring CURRENT LATEST partial - doesn't start with final (new segment detected)`);
                          }
                        }
                        
                        // CRITICAL: If we're using partial text, verify it ends with a complete sentence
                        // This prevents committing mid-sentence partials when a new segment is detected
                        if (usingPartialText) {
                          const textToProcessTrimmed = textToProcess.trim();
                          const endsWithCompleteSentence = finalizationEngine.endsWithCompleteSentence(textToProcessTrimmed);
                          if (!endsWithCompleteSentence && timeSinceFinal < 2000) {
                            // Partial text is mid-sentence and not enough time has passed - wait longer
                            console.log(`[HostMode] ⏳ Partial text is mid-sentence and new segment detected - waiting longer before committing (${timeSinceFinal}ms < 2000ms)`);
                            console.log(`[HostMode] 📊 Text: "${textToProcessTrimmed.substring(0, 100)}..."`);
                            // Don't commit yet - continue tracking
                            return; // Exit early, let the partial continue to be tracked
                          }
                        }
                        
                        // CRITICAL: Check if forced final recovery is in progress before resetting
                        // If recovery is in progress, defer reset until recovery completes
                        syncForcedFinalBuffer();
                        const recoveryInProgress = forcedFinalBuffer && forcedFinalBuffer.recoveryInProgress;
                        if (recoveryInProgress) {
                          console.log('[HostMode] ⏳ Recovery in progress - deferring partial tracker reset until recovery completes');
                          // Reset will happen in recovery completion callback
                        } else {
                          // PHASE 8: Reset partial tracking using tracker
                          partialTracker.reset();
                          syncPartialVariables();
                        }
                        // PHASE 8: Clear using engine
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();
                        console.log(`[HostMode] ✅ FINAL (new segment detected - committing): "${textToProcess.substring(0, 100)}..."`);
                        processFinalText(textToProcess);
                        // Continue processing the new partial as a new segment
                      }
                    } else {
                      // Partials are still arriving - update tracking but don't extend timeout
                      console.log(`[HostMode] 📝 Partial arrived during finalization wait - tracking updated (${transcriptText.length} chars)`);
                    }
                  }
                  
                  // Update last audio timestamp (we have new audio activity)
                  lastAudioTimestamp = Date.now();
                  silenceStartTime = null;
                  
                  // OPTIMIZED: Throttle updates to prevent overwhelming the API (solo mode style)
                  // Updates every 2 characters for word-by-word feel with stable translations
                  if (transcriptText.length >= 1) {
                    // ✅ In recovery pipeline, avoid setting currentPartialText to short "stub" partials that flicker
                    // (e.g., "Ours cordoned off from others.") before the continuation arrives.
                    if (pipeline === 'recovery') {
                      syncForcedFinalBuffer();
                      const forcedRecoveryActive =
                        forcedFinalBuffer?.recoveryInProgress === true &&
                        typeof forcedFinalBuffer?.text === 'string' &&
                        forcedFinalBuffer.text.trim().length > 0;

                      if (forcedRecoveryActive) {
                        // Use the same stub detector used elsewhere
                        const shouldSuppress = isRecoveryStubPartial({
                          partialText: transcriptText,
                          forcedBufferText: forcedFinalBuffer.text
                        });

                        if (shouldSuppress) {
                          console.log('[HostMode] ⏭️ Suppressing recovery stub partial from delayed pipeline (not updating currentPartialText)');
                          console.log(`[HostMode]   Stub: "${transcriptText.substring(0, 60)}..."`);
                          console.log(`[HostMode]   Forced buffer: "${forcedFinalBuffer.text.substring(0, 60)}..."`);
                          // Do NOT update currentPartialText; keep the previous value
                        } else {
                          currentPartialText = transcriptText;
                        }
                      } else {
                        // Recovery pipeline but no active forced recovery buffer
                        currentPartialText = transcriptText;
                      }
                    } else {
                      // Normal pipeline: always update
                      currentPartialText = transcriptText;
                    }

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
                        console.log(`[HostMode] 🔄 Processing partial (${transcriptText.length} chars): "${transcriptText.substring(0, 40)}..."`);
                        const rawCapturedText = transcriptText;
                        const capturedText = rawCapturedText;
                        const translationReadyText = translationSeedText;
                        
                        // Get all target languages needed for listeners
                        const targetLanguages = sessionStore.getSessionLanguages(currentSessionId);
                        
                        if (targetLanguages.length === 0) {
                          // No listeners - just send to host
                          lastPartialTranslation = capturedText;
                          broadcastWithSequence({
                            type: 'translation',
                            originalText: rawCapturedText,
                            translatedText: capturedText,
                            sourceLang: currentSourceLang,
                            targetLang: currentSourceLang,
                            timestamp: Date.now(),
                            hasTranslation: false,
                            hasCorrection: false,
                            isPartial: true // CRITICAL: Explicitly mark as partial to prevent frontend from committing
                          }, true);
                          
                          // CRITICAL: Still run grammar correction even with no listeners
                          // This ensures the host sees grammar corrections in real-time
                          if (currentSourceLang === 'en') {
                            grammarWorker.correctPartial(rawCapturedText, process.env.OPENAI_API_KEY)
                              .then(correctedText => {
                                // Check if still relevant
                                if (latestPartialTextForCorrection !== rawCapturedText) {
                                  if (latestPartialTextForCorrection.length < rawCapturedText.length * 0.5) {
                                    console.log(`[HostMode] ⏭️ Skipping outdated grammar (text reset: ${rawCapturedText.length} → ${latestPartialTextForCorrection.length} chars)`);
                                    return;
                                  }
                                }
                                
                                rememberGrammarCorrection(rawCapturedText, correctedText);
                                console.log(`[HostMode] ✅ GRAMMAR (ASYNC, no listeners): "${correctedText.substring(0, 40)}..."`);
                                
                                // Send grammar correction to host client
                                broadcastWithSequence({
                                  type: 'translation',
                                  originalText: rawCapturedText,
                                  correctedText: correctedText,
                                  translatedText: correctedText,
                                  sourceLang: currentSourceLang,
                                  targetLang: currentSourceLang,
                                  timestamp: Date.now(),
                                  isTranscriptionOnly: true,
                                  hasTranslation: false,
                                  hasCorrection: true,
                                  updateType: 'grammar',
                                  isPartial: true // CRITICAL: Grammar updates for partials are still partials
                                }, true, currentSourceLang);
                              })
                              .catch(error => {
                                if (error.name !== 'AbortError') {
                                  console.error(`[HostMode] ❌ Grammar error (${rawCapturedText.length} chars):`, error.message);
                                }
                              });
                          }
                          
                          return;
                        }
                        
                        // Separate same-language targets from translation targets
                        const sameLanguageTargets = targetLanguages.filter(lang => lang === currentSourceLang);
                        const translationTargets = targetLanguages.filter(lang => lang !== currentSourceLang);
                        
                        // ✅ Declare correlation variables before both blocks so they're accessible to translation handler
                        let sourceSeqId = null;
                        let sourceOriginalText = rawCapturedText; // Freeze the exact English you emitted
                        
                        // ✅ ALWAYS create an EN anchor seqId for correlation (even if sameLanguageTargets is empty)
                        const anchorSeqId = broadcastWithSequence({
                          type: 'translation',
                          originalText: rawCapturedText,
                          translatedText: capturedText,
                          sourceLang: currentSourceLang,
                          targetLang: currentSourceLang,
                          timestamp: Date.now(),
                          isTranscriptionOnly: true,
                          hasTranslation: false,
                          hasCorrection: false,
                          isPartial: true
                        }, true, currentSourceLang);
                        if (anchorSeqId > 0) {
                          sourceSeqId = anchorSeqId; // Only set if broadcast succeeded
                        }
                        
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
                        
                        // Handle same-language targets (transcription mode)
                        if (sameLanguageTargets.length > 0) {
                          // Send raw text immediately to same-language listeners
                          for (const targetLang of sameLanguageTargets) {
                            const seqId = broadcastWithSequence({
                              type: 'translation',
                              originalText: rawCapturedText,
                              translatedText: capturedText,
                              sourceLang: currentSourceLang,
                              targetLang: targetLang,
                              timestamp: Date.now(),
                              isTranscriptionOnly: true,
                              hasTranslation: false,
                              hasCorrection: false,
                              isPartial: true // CRITICAL: Explicitly mark as partial to prevent frontend from committing
                            }, true, targetLang);
                            sourceSeqId = seqId; // Capture the last seqId from same-language broadcast
                          }
                          
                          // ✅ sourceOriginalText already set above - freeze the exact English you emitted
                          
                          // Start grammar correction asynchronously (English only, don't wait for it)
                          if (currentSourceLang === 'en') {
                            grammarWorker.correctPartial(rawCapturedText, process.env.OPENAI_API_KEY)
                              .then(correctedText => {
                                // Check if still relevant
                                if (latestPartialTextForCorrection !== rawCapturedText) {
                                  if (latestPartialTextForCorrection.length < rawCapturedText.length * 0.5) {
                                    console.log(`[HostMode] ⏭️ Skipping outdated grammar (text reset: ${rawCapturedText.length} → ${latestPartialTextForCorrection.length} chars)`);
                                    return;
                                  }
                                }
                                
                                rememberGrammarCorrection(rawCapturedText, correctedText);
                                
                                console.log(`[HostMode] ✅ GRAMMAR (ASYNC): "${correctedText.substring(0, 40)}..."`);
                                
                                // CRITICAL: Send grammar update to host client (source language)
                                broadcastWithSequence({
                                  type: 'translation',
                                  originalText: rawCapturedText,
                                  correctedText: correctedText,
                                  translatedText: correctedText,
                                  sourceLang: currentSourceLang,
                                  targetLang: currentSourceLang,
                                  timestamp: Date.now(),
                                  isTranscriptionOnly: true,
                                  hasTranslation: false,
                                  hasCorrection: true,
                                  updateType: 'grammar',
                                  isPartial: true // CRITICAL: Grammar updates for partials are still partials
                                }, true, currentSourceLang);
                                
                                // Send grammar update separately to same-language listeners
                                for (const targetLang of sameLanguageTargets) {
                                  broadcastWithSequence({
                                    type: 'translation',
                                    originalText: rawCapturedText,
                                    correctedText: correctedText,
                                    translatedText: correctedText,
                                    sourceLang: currentSourceLang,
                                    targetLang: targetLang,
                                    timestamp: Date.now(),
                                    isTranscriptionOnly: true,
                                    hasTranslation: false,
                                    hasCorrection: true,
                                    updateType: 'grammar',
                                    isPartial: true // CRITICAL: Grammar updates for partials are still partials
                                  }, true, targetLang);
                                }
                              })
                              .catch(error => {
                                if (error.name !== 'AbortError') {
                                  console.error(`[HostMode] ❌ Grammar error (${rawCapturedText.length} chars):`, error.message);
                                }
                              });
                          }
                        }
                        
                        // Handle translation targets
                        if (translationTargets.length > 0) {
                          if (underRestartCooldown) {
                            console.log(`[HostMode] ⏸️ Skipping REALTIME translation - restart cooldown active (${realtimeTranslationCooldownUntil - Date.now()}ms remaining)`);
                          } else {
                            console.log(`[HostMode] 🔀 Using ${workerType} API for partial translation to ${translationTargets.length} language(s) (${capturedText.length} chars)`);

                            // ✅ Freeze correlation + text for THIS translation request
                            const frozenSourceSeqId = sourceSeqId;     // freeze current anchor
                            const frozenTranslationReadyText = translationReadyText;       // freeze exact text being translated

                            const translationPromise = partialWorker.translateToMultipleLanguages(
                              frozenTranslationReadyText,
                              currentSourceLang,
                              translationTargets,
                              process.env.OPENAI_API_KEY,
                              currentSessionId
                            );

                            // Send translation IMMEDIATELY when ready (don't wait for grammar)
                            translationPromise.then(translations => {
                              // Validate translation results
                              if (!translations || Object.keys(translations).length === 0) {
                                console.warn(`[HostMode] ⚠️ Translation returned empty for ${frozenTranslationReadyText.length} char text`);
                                return;
                              }

                              // CRITICAL: Only update lastPartialTranslation AFTER successful translation
                              lastPartialTranslation = frozenTranslationReadyText;
                              
                              console.log(`[HostMode] ✅ TRANSLATION (IMMEDIATE): Translated to ${Object.keys(translations).length} language(s)`);
                              
                              // Broadcast translation results immediately - sequence IDs handle ordering
                              for (const targetLang of translationTargets) {
                                const translatedText = translations[targetLang];
                                // Validate that translation is different from original (prevent English leak)
                                const isSameAsOriginal = translatedText === frozenTranslationReadyText ||
                                                         translatedText.trim() === frozenTranslationReadyText.trim() ||
                                                         translatedText.toLowerCase() === frozenTranslationReadyText.toLowerCase();

                                if (isSameAsOriginal) {
                                  console.warn(`[HostMode] ⚠️ Translation matches original (English leak detected) for ${targetLang}: "${translatedText.substring(0, 60)}..."`);
                                  continue; // Don't send English as translation
                                }

                                // ✅ HARD INVARIANT: never send translation with blank original
                                const safeOriginal =
                                  (frozenTranslationReadyText && frozenTranslationReadyText.trim()) ||
                                  (sourceOriginalText && sourceOriginalText.trim()) ||
                                  (rawCapturedText && rawCapturedText.trim()) ||
                                  '';
                                
                                if (!safeOriginal) {
                                  console.warn(`[HostMode] 🚫 Dropping translation partial (blank originalText)`, {
                                    frozenSourceSeqId,
                                    targetLang,
                                    translatedPreview: (translatedText || '').slice(0, 80),
                                  });
                                  continue;
                                }

                                // ✅ HARD INVARIANT: never send translation with null sourceSeqId
                                if (frozenSourceSeqId == null || frozenSourceSeqId === 0) {
                                  console.warn(`[HostMode] 🚫 Dropping translation: missing frozenSourceSeqId`, {
                                    targetLang,
                                    originalPreview: safeOriginal.slice(0, 80),
                                    translatedPreview: (translatedText || '').slice(0, 80),
                                  });
                                  continue;
                                }

                                console.log('[DBG_TRANSLATE_EMIT]', { frozenSourceSeqId, targetLang, o: safeOriginal.slice(0,30), t: (translatedText||'').slice(0,30) });

                                broadcastWithSequence({
                                  type: 'translation',
                                  sourceSeqId: frozenSourceSeqId,     // ✅ frozen correlation key
                                  originalText: safeOriginal,
                                  translatedText: translatedText,
                                  sourceLang: currentSourceLang,
                                  targetLang: targetLang,
                                  timestamp: Date.now(),
                                  isTranscriptionOnly: false,
                                  hasTranslation: true,
                                  hasCorrection: false, // Grammar not ready yet
                                  isPartial: true // CRITICAL: Explicitly mark as partial to prevent frontend from committing
                                }, true, targetLang);
                              }
                            }).catch(error => {
                              // Handle translation errors gracefully
                              if (error.name !== 'AbortError') {
                                if (error.message && error.message.includes('cancelled')) {
                                  console.log(`[HostMode] ⏭️ Translation cancelled (newer request took priority)`);
                                } else if (error.message && error.message.includes('timeout')) {
                                  console.warn(`[HostMode] ⚠️ ${workerType} API timeout - translation skipped for this partial`);
                                } else {
                                  console.error(`[HostMode] ❌ Translation error (${workerType} API, ${rawCapturedText.length} chars):`, error.message);
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
                                  console.log(`[HostMode] ⏭️ Skipping outdated grammar (text reset: ${rawCapturedText.length} → ${latestRaw.length} chars)`);
                                  return;
                                }
                              }

                              rememberGrammarCorrection(rawCapturedText, correctedText);
                              console.log(`[HostMode] ✅ GRAMMAR (IMMEDIATE): "${correctedText.substring(0, 40)}..."`);
                              
                              // CRITICAL: Send grammar correction to host client (source language)
                              broadcastWithSequence({
                                type: 'translation',
                                originalText: rawCapturedText,
                                correctedText: correctedText,
                                translatedText: correctedText,
                                sourceLang: currentSourceLang,
                                targetLang: currentSourceLang,
                                timestamp: Date.now(),
                                isTranscriptionOnly: true,
                                hasTranslation: false,
                                hasCorrection: true,
                                updateType: 'grammar', // Flag for grammar-only update
                                isPartial: true // CRITICAL: Grammar updates for partials are still partials
                              }, true, currentSourceLang);
                              
                              // Broadcast grammar correction to same-language listeners only
                              broadcastWithSequence({
                                type: 'translation',
                                originalText: rawCapturedText,
                                correctedText: correctedText,
                                sourceLang: currentSourceLang,
                                targetLang: currentSourceLang,  // ✅ Force source language only
                                timestamp: Date.now(),
                                isTranscriptionOnly: false,
                                hasCorrection: true,
                                updateType: 'grammar', // Flag for grammar-only update
                                isPartial: true // CRITICAL: Grammar updates for partials are still partials
                              }, true, currentSourceLang);
                            }).catch(error => {
                              if (error.name !== 'AbortError') {
                                console.error(`[HostMode] ❌ Grammar error (${rawCapturedText.length} chars):`, error.message);
                              }
                            });
                          }
                        }
                      } catch (error) {
                        console.error(`[HostMode] ❌ Partial processing error (${transcriptText.length} chars):`, error.message);
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
                      if (delayedPartialTimer) {
                        clearTimeout(delayedPartialTimer);
                        delayedPartialTimer = null;
                      }
                      
                      // Immediate execution (no delay) for real-time feel
                      const delayMs = 0;
                      
                      // Capture current epoch before scheduling delayed partial
                      const myEpoch = segmentEpoch;
                      delayedPartialTimer = setTimeout(async () => {
                        // CRITICAL: Check epoch - if we advanced segments since scheduling, drop this delayed partial
                        // This prevents out-of-order emissions when delayed partial fires after a new segment/FINAL
                        if (myEpoch !== segmentEpoch) {
                          console.log(`[HostMode] ⏭️ Dropping delayed partial - epoch mismatch (scheduled: ${myEpoch}, current: ${segmentEpoch})`);
                          delayedPartialTimer = null;
                          return;
                        }
                        
                        // CRITICAL: Always capture LATEST text at timeout execution
                        const latestText = currentPartialText;
                        if (!latestText || latestText.length < 1) {
                          delayedPartialTimer = null;
                          return;
                        }
                        
                        // ✅ Prevent delayed partial broadcast of recovery stubs.
                        // These create the "Ours cordoned off..." flicker in the recovery pipeline.
                        syncForcedFinalBuffer();
                        const recoveryActive = forcedFinalBuffer?.recoveryInProgress && forcedFinalBuffer?.text;

                        if (recoveryActive) {
                          if (isRecoveryStubPartial({ partialText: latestText, forcedBufferText: forcedFinalBuffer.text })) {
                            console.log('[HostMode] ⏭️ Dropping delayed recovery stub partial (prevents flicker)');
                            console.log(`[HostMode]   Stub: "${latestText.substring(0, 60)}..."`);
                            delayedPartialTimer = null;
                            return;
                          }
                        }
                        
                        // Skip only if exact match (no need to retranslate identical text)
                        const isExactMatch = latestText === lastPartialTranslation;
                        
                        if (isExactMatch) {
                          console.log(`[HostMode] ⏭️ Skipping exact match translation`);
                          delayedPartialTimer = null;
                          return;
                        }
                        
                        try {
                          console.log(`[HostMode] ⏱️ Delayed processing partial (${latestText.length} chars): "${latestText.substring(0, 40)}..."`);
                          
                          // Get all target languages needed for listeners
                          const targetLanguages = sessionStore.getSessionLanguages(currentSessionId);
                          
                          if (targetLanguages.length === 0) {
                            // No listeners - just send to host
                            lastPartialTranslation = latestText;
                            lastPartialTranslationTime = Date.now();
                            broadcastWithSequence({
                              type: 'translation',
                              originalText: latestText,
                              translatedText: latestText,
                              sourceLang: currentSourceLang,
                              targetLang: currentSourceLang,
                              timestamp: Date.now(),
                              hasTranslation: false,
                              hasCorrection: false,
                              isPartial: true // CRITICAL: Explicitly mark as partial to prevent frontend from committing
                            }, true);
                            delayedPartialTimer = null;
                            return;
                          }
                          
                          // Separate same-language targets from translation targets
                          const sameLanguageTargets = targetLanguages.filter(lang => lang === currentSourceLang);
                          const translationTargets = targetLanguages.filter(lang => lang !== currentSourceLang);
                          
                          // ✅ Declare correlation variables before both blocks so they're accessible to translation handler
                          let sourceSeqId = null;
                          let sourceOriginalText = latestText; // Freeze the exact English you emitted
                          
                          // ✅ ALWAYS create an EN anchor seqId for correlation (even if sameLanguageTargets is empty)
                          const anchorSeqId = broadcastWithSequence({
                            type: 'translation',
                            originalText: latestText,
                            translatedText: latestText,
                            sourceLang: currentSourceLang,
                            targetLang: currentSourceLang,
                            timestamp: Date.now(),
                            isTranscriptionOnly: true,
                            hasTranslation: false,
                            hasCorrection: false,
                            isPartial: true
                          }, true, currentSourceLang);
                          if (anchorSeqId > 0) {
                            sourceSeqId = anchorSeqId; // Only set if broadcast succeeded
                          }
                          
                          // Handle same-language targets
                          if (sameLanguageTargets.length > 0) {
                            lastPartialTranslation = latestText;
                            lastPartialTranslationTime = Date.now();
                            
                            console.log(`[HostMode] ✅ TRANSCRIPTION (DELAYED): "${latestText.substring(0, 40)}..."`);
                            
                            // Send transcription immediately
                            for (const targetLang of sameLanguageTargets) {
                              const seqId = broadcastWithSequence({
                                type: 'translation',
                                originalText: latestText,
                                translatedText: latestText,
                                sourceLang: currentSourceLang,
                                targetLang: targetLang,
                                timestamp: Date.now(),
                                isTranscriptionOnly: true,
                                hasTranslation: false,
                                hasCorrection: false,
                                isPartial: true // CRITICAL: Explicitly mark as partial to prevent frontend from committing
                              }, true, targetLang);
                              sourceSeqId = seqId; // Capture the last seqId from same-language broadcast
                            }
                            
                            // Start grammar correction asynchronously (English only)
                            if (currentSourceLang === 'en') {
                              grammarWorker.correctPartial(latestText, process.env.OPENAI_API_KEY)
                                .then(correctedText => {
                                  console.log(`[HostMode] ✅ GRAMMAR (DELAYED ASYNC): "${correctedText.substring(0, 40)}..."`);
                                  
                                  // CRITICAL: Send grammar update to host client (source language)
                                  broadcastWithSequence({
                                    type: 'translation',
                                    originalText: latestText,
                                    correctedText: correctedText,
                                    translatedText: correctedText,
                                    sourceLang: currentSourceLang,
                                    targetLang: currentSourceLang,
                                    timestamp: Date.now(),
                                    isTranscriptionOnly: true,
                                    hasTranslation: false,
                                    hasCorrection: true,
                                    updateType: 'grammar',
                                    isPartial: true // CRITICAL: Grammar updates for partials are still partials
                                  }, true, currentSourceLang);
                                  
                                  // Send grammar update to same-language listeners
                                  for (const targetLang of sameLanguageTargets) {
                                    broadcastWithSequence({
                                      type: 'translation',
                                      originalText: latestText,
                                      correctedText: correctedText,
                                      translatedText: correctedText,
                                      sourceLang: currentSourceLang,
                                      targetLang: targetLang,
                                      timestamp: Date.now(),
                                      isTranscriptionOnly: true,
                                      hasTranslation: false,
                                      hasCorrection: true,
                                      updateType: 'grammar',
                                      isPartial: true // CRITICAL: Grammar updates for partials are still partials
                                    }, true, targetLang);
                                  }
                                })
                                .catch(error => {
                                  if (error.name !== 'AbortError') {
                                    console.error(`[HostMode] ❌ Delayed grammar error (${latestText.length} chars):`, error.message);
                                  }
                                });
                            }
                          }
                          
                          // Handle translation targets
                          if (translationTargets.length > 0) {
                            // TRANSLATION MODE: Decouple grammar and translation for lowest latency (grammar only for English)
                            // Route to appropriate worker based on tier
                            const partialWorker = usePremiumTier 
                              ? realtimePartialTranslationWorker 
                              : partialTranslationWorker;
                            const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                            console.log(`[HostMode] 🔀 Using ${workerType} API for delayed partial translation to ${translationTargets.length} language(s) (${latestText.length} chars)`);
                            const underRestartCooldown = usePremiumTier && Date.now() < realtimeTranslationCooldownUntil;
                            
                            // Start grammar correction asynchronously (English only, don't wait for it)
                            const grammarPromise = currentSourceLang === 'en' 
                              ? grammarWorker.correctPartial(latestText, process.env.OPENAI_API_KEY)
                              : Promise.resolve(latestText); // Skip grammar for non-English
                            
                            if (underRestartCooldown) {
                              console.log(`[HostMode] ⏸️ Skipping REALTIME translation (delayed) - restart cooldown active (${realtimeTranslationCooldownUntil - Date.now()}ms remaining)`);
                            } else {
                              // ✅ Freeze correlation + text for THIS translation request
                              const frozenSourceSeqId = sourceSeqId;     // freeze current anchor
                              const frozenLatestText = latestText;       // freeze exact text being translated

                              const translationPromise = partialWorker.translateToMultipleLanguages(
                                frozenLatestText,
                                currentSourceLang,
                                translationTargets,
                                process.env.OPENAI_API_KEY,
                                currentSessionId
                              );

                              // Send translation IMMEDIATELY when ready (don't wait for grammar)
                              translationPromise.then(translations => {
                                // Validate translation results
                                if (!translations || Object.keys(translations).length === 0) {
                                  console.warn(`[HostMode] ⚠️ Delayed translation returned empty for ${frozenLatestText.length} char text`);
                                  return;
                                }

                                // CRITICAL: Update tracking and send translation
                                lastPartialTranslation = frozenLatestText;
                                lastPartialTranslationTime = Date.now();
                                
                                console.log(`[HostMode] ✅ TRANSLATION (DELAYED): Translated to ${Object.keys(translations).length} language(s)`);
                                
                                // Broadcast immediately - sequence IDs handle ordering
                                for (const targetLang of translationTargets) {
                                  const translatedText = translations[targetLang];
                                  // Validate that translation is different from original
                                  const isSameAsOriginal = translatedText === frozenLatestText ||
                                                           translatedText.trim() === frozenLatestText.trim() ||
                                                           translatedText.toLowerCase() === frozenLatestText.toLowerCase();

                                  if (isSameAsOriginal) {
                                    console.warn(`[HostMode] ⚠️ Translation matches original (English leak detected) for ${targetLang}`);
                                    continue; // Don't send English as translation
                                  }

                                  // ✅ HARD INVARIANT: never send translation with blank original
                                  const safeOriginal =
                                    (frozenLatestText && frozenLatestText.trim()) ||
                                    (sourceOriginalText && sourceOriginalText.trim()) ||
                                    '';
                                  
                                  if (!safeOriginal) {
                                    console.warn(`[HostMode] 🚫 Dropping delayed translation partial (blank originalText)`, {
                                      frozenSourceSeqId,
                                      targetLang,
                                      translatedPreview: (translatedText || '').slice(0, 80),
                                    });
                                    continue;
                                  }

                                  // ✅ HARD INVARIANT: never send translation with missing sourceSeqId (covers stale/overwritten cases)
                                  if (frozenSourceSeqId == null || frozenSourceSeqId === 0) {
                                    console.warn(`[HostMode] 🚫 Dropping delayed translation: missing frozenSourceSeqId`, {
                                      targetLang,
                                      originalPreview: safeOriginal.slice(0, 80),
                                      translatedPreview: (translatedText || '').slice(0, 80),
                                    });
                                    continue;
                                  }

                                  console.log('[DBG_TRANSLATE_EMIT]', { frozenSourceSeqId, targetLang, o: safeOriginal.slice(0,30), t: (translatedText||'').slice(0,30) });

                                  broadcastWithSequence({
                                    type: 'translation',
                                    sourceSeqId: frozenSourceSeqId,     // ✅ frozen correlation key
                                    originalText: safeOriginal,
                                    translatedText: translatedText,
                                    sourceLang: currentSourceLang,
                                    targetLang: targetLang,
                                    timestamp: Date.now(),
                                    isTranscriptionOnly: false,
                                    hasTranslation: true,
                                    hasCorrection: false, // Grammar not ready yet
                                    isPartial: true // CRITICAL: Explicitly mark as partial to prevent frontend from committing
                                  }, true, targetLang);
                                }
                              }).catch(error => {
                                // Handle translation errors gracefully
                                if (error.name !== 'AbortError') {
                                  if (error.message && error.message.includes('cancelled')) {
                                    console.log(`[HostMode] ⏭️ Delayed translation cancelled (newer request took priority)`);
                                  } else if (error.message && error.message.includes('timeout')) {
                                    console.warn(`[HostMode] ⚠️ ${workerType} API timeout - translation skipped for this partial`);
                                  } else {
                                    console.error(`[HostMode] ❌ Delayed translation error (${workerType} API, ${latestText.length} chars):`, error.message);
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
                                  console.log(`[HostMode] ✅ GRAMMAR (DELAYED): "${correctedText.substring(0, 40)}..."`);
                                  
                                  // CRITICAL: Send grammar update to host client (source language)
                                  broadcastWithSequence({
                                    type: 'translation',
                                    originalText: latestText,
                                    correctedText: correctedText,
                                    translatedText: correctedText,
                                    sourceLang: currentSourceLang,
                                    targetLang: currentSourceLang,
                                    timestamp: Date.now(),
                                    isTranscriptionOnly: true,
                                    hasTranslation: false,
                                    hasCorrection: true,
                                    updateType: 'grammar',
                                    isPartial: true // CRITICAL: Grammar updates for partials are still partials
                                  }, true, currentSourceLang);
                                  
                                  // Broadcast grammar update to same-language listeners only
                                  broadcastWithSequence({
                                    type: 'translation',
                                    originalText: latestText,
                                    correctedText: correctedText,
                                    sourceLang: currentSourceLang,
                                    targetLang: currentSourceLang,  // ✅ Force source language only
                                    timestamp: Date.now(),
                                    isTranscriptionOnly: false,
                                    hasCorrection: true,
                                    updateType: 'grammar',
                                    isPartial: true // CRITICAL: Grammar updates for partials are still partials
                                  }, true, currentSourceLang);
                                }
                              }).catch(error => {
                                if (error.name !== 'AbortError') {
                                  console.error(`[HostMode] ❌ Delayed grammar error (${latestText.length} chars):`, error.message);
                                }
                              });
                            }
                          }

                          delayedPartialTimer = null;
                        } catch (error) {
                          console.error(`[HostMode] ❌ Delayed partial processing error (${latestText.length} chars):`, error.message);
                          delayedPartialTimer = null;
                        }
                      }, delayMs);
                      // Also update pendingPartialTranslation for backward compatibility
                      pendingPartialTranslation = delayedPartialTimer;
                    }
                  }
                  return;
                }
                
                // Final transcript - delay processing to allow partials to extend it (solo mode logic)
                const isForcedFinal = meta?.forced === true;
                console.log(`[HostMode] 📝 FINAL signal received (${transcriptText.length} chars): "${transcriptText.substring(0, 80)}..."`);
                console.log(`[HostMode] 🔍 FINAL meta: ${JSON.stringify(meta)} - isForcedFinal: ${isForcedFinal}`);
                
                if (isForcedFinal) {
                  console.warn(`[HostMode] ⚠️ Forced FINAL due to stream restart (${transcriptText.length} chars)`);
                  console.log(`[HostMode] 🎯 FORCED FINAL DETECTED - Setting up dual buffer audio recovery system`);
                  console.log(`[HostMode] 🎯 DUAL BUFFER: Forced final detected - recovery system will activate`);
                  realtimeTranslationCooldownUntil = Date.now() + TRANSLATION_RESTART_COOLDOWN_MS;
                  
                  // PHASE 8: Use Forced Commit Engine to clear existing buffer
                  if (forcedCommitEngine.hasForcedFinalBuffer()) {
                    console.log(`[HostMode] 🧹 Clearing existing forced final buffer before creating new one`);
                    forcedCommitEngine.clearForcedFinalBufferTimeout();
                    forcedCommitEngine.clearForcedFinalBuffer();
                    syncForcedFinalBuffer();
                  }
                  
                  // CRITICAL: Use SNAPSHOT not live value (live value may already be from next segment!)
                  // PHASE 8: Get snapshot from tracker
                  const snapshot = partialTracker.getSnapshot();
                  const longestPartialSnapshot = snapshot.longest || '';
                  const longestPartialTimeSnapshot = snapshot.longestTime || 0;
                  
                  const timeSinceLongestForced = longestPartialTimeSnapshot ? (Date.now() - longestPartialTimeSnapshot) : Infinity;
                  if (longestPartialSnapshot && longestPartialSnapshot.length > transcriptText.length && timeSinceLongestForced < 5000) {
                    const forcedTrimmed = transcriptText.trim();
                    const longestTrimmed = longestPartialSnapshot.trim();
                    
                    // Helper function to normalize text for comparison (remove punctuation, lowercase, collapse whitespace)
                    const normalizeForComparison = (text) => {
                      return text.toLowerCase()
                        .replace(/[.,!?;:'"\-()]/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    };
                    
                    // Verify it actually extends the forced final (not from a previous segment)
                    // Use lenient comparison that ignores punctuation differences
                    const forcedNormalized = normalizeForComparison(forcedTrimmed);
                    const longestNormalized = normalizeForComparison(longestTrimmed);
                    
                    // Check if longest normalized starts with forced normalized (ignoring punctuation)
                    // This handles cases where punctuation differs but the words are the same
                    const extendsForced = longestNormalized.startsWith(forcedNormalized);
                    
                    // Also check word-by-word comparison (more robust for punctuation differences)
                    const forcedWords = forcedNormalized.split(/\s+/).filter(w => w.length > 0);
                    const longestWords = longestNormalized.split(/\s+/).filter(w => w.length > 0);
                    const minWords = Math.min(forcedWords.length, longestWords.length);
                    let matchingWords = 0;
                    for (let i = 0; i < minWords; i++) {
                      if (forcedWords[i] === longestWords[i]) {
                        matchingWords++;
                      } else {
                        break;
                      }
                    }
                    // If > 80% of words match and longest is longer, consider it an extension
                    const hasWordOverlap = forcedWords.length > 0 && 
                                          matchingWords >= forcedWords.length * 0.8 &&
                                          longestNormalized.length > forcedNormalized.length;
                    
                    const extendsForcedFinal = extendsForced || hasWordOverlap;
                    
                    if (extendsForcedFinal) {
                      const missingWords = longestPartialSnapshot.substring(transcriptText.length).trim();
                      console.log(`[HostMode] ⚠️ Forced FINAL using LONGEST partial SNAPSHOT (${transcriptText.length} → ${longestPartialSnapshot.length} chars)`);
                      console.log(`[HostMode] 📊 Recovered (forced): "${missingWords}"`);
                      transcriptText = longestPartialSnapshot;
                    } else {
                      console.log(`[HostMode] ⚠️ Ignoring LONGEST partial snapshot - doesn't extend forced final (normalized comparison failed)`);
                      console.log(`[HostMode]   Forced normalized: "${forcedNormalized.substring(0, 60)}..."`);
                      console.log(`[HostMode]   Longest normalized: "${longestNormalized.substring(0, 60)}..."`);
                    }
                  }
                  
                  const endsWithPunctuation = /[.!?…]$/.test(transcriptText.trim());

                  // ALWAYS capture and inject recovery audio for ALL forced finals
                  // This ensures we can recover missing words from decoder gaps
                  // Even if the final ends with punctuation, there may still be missing words
                  // CRITICAL: Don't commit immediately - wait for recovery and grammar correction
                  // The timeout callback will commit after recovery completes (with grammar correction)
                  console.log('[HostMode] ⏳ Buffering forced final until recovery completes (with grammar correction)');
                  console.log(`[HostMode] 🎯 DUAL BUFFER SYSTEM: Setting up audio recovery for forced final`);
                  console.log(`[HostMode] 📝 Forced final text: "${transcriptText.substring(0, 80)}..." (${transcriptText.length} chars, ends with punctuation: ${endsWithPunctuation})`);

                  try {
                    const bufferedText = transcriptText;
                    const forcedFinalTimestamp = Date.now();
                    
                    // Track recovery start time to capture next final for deduplication
                    recoveryStartTime = Date.now();
                    nextFinalAfterRecovery = null; // Reset
                    
                    // PHASE 8: Create forced final buffer using engine (for recovery tracking)
                    // Note: We've already committed the forced final above, so this buffer is just for recovery
                    forcedCommitEngine.createForcedFinalBuffer(transcriptText, forcedFinalTimestamp);
                    syncForcedFinalBuffer();
                    // ✅ Store segmentId in buffer for proper identity tracking
                    if (forcedFinalBuffer) {
                      forcedFinalBuffer.segmentId = `forced_final_${forcedFinalTimestamp}`;
                    }
                    console.log(`[HostMode] ✅ Forced final buffer created for recovery - audio recovery will trigger in ${FORCED_FINAL_MAX_WAIT_MS}ms`);
                    console.log(`[HostMode] 🎯 DUAL BUFFER: Setting up Phase 1 timeout (delay: 0ms) - recovery system initializing`);
                    
                  // PHASE 8: Set up two-phase timeout using engine (same as solo mode)
                  console.log(`[HostMode] 🔧 DEBUG: About to call setForcedFinalBufferTimeout - buffer exists: ${forcedCommitEngine.hasForcedFinalBuffer()}`);
                  forcedCommitEngine.setForcedFinalBufferTimeout(() => {
                      // CRITICAL: Check if buffer still exists (might have been committed by new segment)
                      syncForcedFinalBuffer();
                      if (!forcedCommitEngine.hasForcedFinalBuffer()) {
                        console.log('[HostMode] ⚠️ Forced final buffer already cleared (likely committed by new segment) - skipping recovery');
                        return;
                      }
                      
                      console.log('[HostMode] ⏰ Phase 1: Waiting 1200ms for late partials and POST-final audio accumulation...');
                      console.log(`[HostMode] 🎯 DUAL BUFFER SYSTEM: Phase 1 started - audio buffer active`);
                      console.log(`[HostMode] 🎯 DUAL BUFFER: Phase 1 callback EXECUTED - recovery system is running!`);
                      console.log(`[HostMode] 🔧 DEBUG: Phase 1 timeout callback FIRED - recovery code will execute`);

                      // Phase 1: Wait 1200ms for late partials to arrive AND for POST-final audio to accumulate
                      // CRITICAL: Declare recoveryResolve at the start of setTimeout callback so it's accessible in catch
                      let recoveryResolve = null;
                      
                      setTimeout(async () => {
                        console.warn('[HostMode] ⏰ Phase 2: Late partial window complete - capturing PRE+POST-final audio');
                        
                        // PHASE 8: Sync forced final buffer before accessing
                        syncForcedFinalBuffer();
                        
                        // CRITICAL: Check if buffer still exists (might have been committed by new segment)
                        if (!forcedCommitEngine.hasForcedFinalBuffer()) {
                          console.log('[HostMode] ⚠️ Forced final buffer already cleared (likely committed by new segment or recovery) - skipping recovery commit');
                          return;
                        }
                        
                        // CRITICAL: If recovery is in progress, wait for it to complete before proceeding
                        // This prevents race conditions where timeout fires while recovery is still processing
                        syncForcedFinalBuffer();
                        const buffer = forcedCommitEngine.getForcedFinalBuffer();
                        if (buffer?.recoveryInProgress && buffer?.recoveryPromise) {
                          console.log('[HostMode] ⏳ Recovery still in progress - waiting for completion before timeout commit...');
                          try {
                            await buffer.recoveryPromise;
                            console.log('[HostMode] ✅ Recovery completed - will check if it already committed before timeout commit');
                          } catch (error) {
                            console.error('[HostMode] ❌ Error waiting for recovery:', error.message);
                          }
                          // Re-sync buffer after recovery completes (it may have been cleared)
                          syncForcedFinalBuffer();
                        }

                        // Snapshot any late partials that arrived during the 1200ms wait
                        syncPartialVariables();
                        const partialSnapshot = {
                          longest: longestPartialText,
                          latest: latestPartialText,
                          longestTime: longestPartialTime,
                          latestTime: latestPartialTime
                        };

                        console.log(`[HostMode] 📸 Late partial snapshot: longest=${partialSnapshot.longest?.length || 0} chars, latest=${partialSnapshot.latest?.length || 0} chars`);

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
                            console.log(`[HostMode] ✅ Late partials extended buffered text (${bufferedText.length} → ${partialSnapshot.longest.length} chars)`);
                            console.log(`[HostMode] 📊 Recovered from late partials: "${recoveredWords}"`);
                            finalWithPartials = partialSnapshot.longest;
                          }
                        }

                        // CRITICAL: Before resetting, check if a new segment has started during recovery
                        // If new segment partials arrived (like "Together...."), we should NOT reset yet
                        // because those partials are part of the new segment and need to continue being tracked
                        // This prevents dropping segments when finalization is slow
                        syncPartialVariables(); // Sync to get latest state
                        const hasNewSegmentPartials = longestPartialText && 
                                                      longestPartialText.length > 0 &&
                                                      !longestPartialText.trim().toLowerCase().startsWith(bufferedText.trim().toLowerCase()) &&
                                                      longestPartialTime && 
                                                      (Date.now() - longestPartialTime) < 3000; // Recent partials (< 3 seconds)
                        
                        if (hasNewSegmentPartials) {
                          console.log(`[HostMode] ⚠️ New segment partials detected during recovery - NOT resetting partial tracker yet`);
                          console.log(`[HostMode]   New segment partial: "${longestPartialText.substring(0, 50)}..."`);
                          console.log(`[HostMode]   Forced final: "${bufferedText.substring(0, 50)}..."`);
                          console.log(`[HostMode]   Partial tracker will be reset after forced final is committed`);
                          // Don't reset - let the new segment partials continue to be tracked
                          // The reset will happen when the forced final is committed
                        } else {
                          // No new segment detected - safe to reset for next segment
                          console.log(`[HostMode] 🧹 Resetting partial tracking for next segment`);
                          // PHASE 8: Reset partial tracking using tracker (snapshot already taken above)
                          partialTracker.reset();
                          syncPartialVariables(); // Sync variables after reset
                        }

                        // Calculate how much time has passed since forced final
                        const timeSinceForcedFinal = Date.now() - forcedFinalTimestamp;
                        console.log(`[HostMode] ⏱️ ${timeSinceForcedFinal}ms has passed since forced final`);

                        // ⭐ CRITICAL: Capture 2200ms window that includes BOTH:
                        // - PRE-final audio (1400ms before the final) ← Contains the decoder gap!
                        // - POST-final audio (800ms after the final) ← Captures complete phrases like "self-centered"
                        const captureWindowMs = 2200;
                        console.log(`[HostMode] 🎵 Capturing PRE+POST-final audio: last ${captureWindowMs}ms`);
                        console.log(`[HostMode] 📊 Window covers: [T-${captureWindowMs - timeSinceForcedFinal}ms to T+${timeSinceForcedFinal}ms]`);
                        console.log(`[HostMode] 🎯 This INCLUDES the decoder gap at ~T-200ms where missing words exist!`);

                        const recoveryAudio = speechStream.getRecentAudio(captureWindowMs);
                        console.log(`[HostMode] 🎵 Captured ${recoveryAudio.length} bytes of PRE+POST-final audio`);
                        console.log(`[HostMode] 🎯 DUAL BUFFER SYSTEM: Audio buffer retrieved - ${recoveryAudio.length} bytes available for recovery`);
                        
                        // CRITICAL: If audio buffer is empty (stream ended), commit forced final immediately
                        if (recoveryAudio.length === 0) {
                          console.log('[HostMode] ⚠️ Audio buffer is empty (stream likely ended) - committing forced final immediately without recovery');
                          syncForcedFinalBuffer();
                          if (forcedCommitEngine.hasForcedFinalBuffer()) {
                            const buffer = forcedCommitEngine.getForcedFinalBuffer();
                            const forcedFinalText = buffer.text;
                            
                            // Mark as committed to prevent timeout from also committing
                            if (forcedFinalBuffer) {
                              forcedFinalBuffer.committedByRecovery = true;
                            }
                            
                            // Commit the forced final immediately
                            try {
                              processFinalText(forcedFinalText, { forceFinal: true });
                            } catch (e) {
                              console.error('[HostMode] ❌ Forced-final commit failed (empty audio buffer):', e);
                            }
                            
                            // Clear the buffer
                            forcedCommitEngine.clearForcedFinalBuffer();
                            syncForcedFinalBuffer();
                            
                            console.log('[HostMode] ✅ Forced final committed immediately (no audio to recover)');
                            return; // Skip recovery attempt
                          }
                        }
                        
                        if (recoveryAudio.length === 0) {
                          console.error(`[HostMode] ❌ CRITICAL: Audio buffer is EMPTY! Dual buffer system not working!`);
                          console.error(`[HostMode] ❌ This means audio chunks are not being added to AudioBufferManager`);
                        }

                        // CRITICAL: If audio recovery is in progress, wait for it to complete
                        // PHASE 8: Sync buffer and check recovery status
                        syncForcedFinalBuffer();
                        if (forcedFinalBuffer && forcedFinalBuffer.recoveryInProgress && forcedFinalBuffer.recoveryPromise) {
                          console.log('[HostMode] ⏳ Audio recovery still in progress, waiting for completion...');
                          try {
                            const recoveredText = await forcedFinalBuffer.recoveryPromise;
                            if (recoveredText && recoveredText.length > 0) {
                              console.log(`[HostMode] ✅ Audio recovery completed before timeout, text already updated`);
                            } else {
                              console.log(`[HostMode] ⚠️ Audio recovery completed but no text was recovered`);
                            }
                          } catch (error) {
                            console.error('[HostMode] ❌ Error waiting for audio recovery:', error.message);
                          }
                        }

                        // Use finalWithPartials (which includes any late partials captured in Phase 1)
                        let finalTextToCommit = finalWithPartials;
                        
                        // CRITICAL: bufferedText (captured at line 1566) is the original forced final text
                        // We'll use this as fallback if buffer is cleared before we can commit

                        console.log(`[HostMode] 📊 Text to commit after late partial recovery:`);
                        console.log(`[HostMode]   Text: "${finalTextToCommit}"`);
                        console.log(`[HostMode]   Original forced final (bufferedText): "${bufferedText}"`);

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
                            mode: 'HostMode',
                            recoveryStartTime: recoveryStartTimeRef,
                            nextFinalAfterRecovery: nextFinalAfterRecoveryRef,
                            recoveryAudio
                          });
                          
                          // Update the original variables from the refs
                          recoveryStartTime = recoveryStartTimeRef.value;
                          nextFinalAfterRecovery = nextFinalAfterRecoveryRef.value;
                        } else {
                          // No recovery audio available
                          console.log(`[HostMode] ⚠️ No recovery audio available (${recoveryAudio.length} bytes) - committing without recovery`);
                        }
                        
                        // CRITICAL: Check if recovery already committed before committing from timeout
                        syncForcedFinalBuffer();
                        const bufferStillExists = forcedCommitEngine.hasForcedFinalBuffer();
                        
                        // Check if recovery already committed by checking the buffer's committedByRecovery flag
                        // OR if buffer was cleared but recovery was in progress (recovery clears buffer after committing)
                        let wasCommittedByRecovery = false;
                        if (bufferStillExists) {
                          // Buffer still exists - check its flag
                          const buffer = forcedCommitEngine.getForcedFinalBuffer();
                          wasCommittedByRecovery = buffer?.committedByRecovery === true;
                        } else {
                          // Buffer doesn't exist - check if recovery was in progress
                          // If recovery was in progress and buffer is now cleared, recovery must have committed it
                          // We can't directly check if recovery completed, but we can infer:
                          // - If buffer was cleared AND we're in the timeout callback, recovery likely committed it
                          // - However, buffer could also be cleared by new FINAL or extending partial
                          // So we need a more reliable check: look for recovery promise completion
                          // For now, if buffer doesn't exist, we'll check if there's any indication recovery ran
                          // The safest approach: if buffer doesn't exist, don't commit (recovery or new FINAL already handled it)
                          console.log('[HostMode] ⚠️ Forced final buffer already cleared - checking if recovery already committed...');
                          
                          // If we reach here and buffer is cleared, it means either:
                          // 1. Recovery committed it (and cleared buffer) - DON'T commit again
                          // 2. New FINAL arrived and merged with it - DON'T commit again  
                          // 3. Extending partial cleared it - DON'T commit again
                          // In all cases, we should NOT commit from timeout if buffer is cleared
                          console.log('[HostMode] ⏭️ Skipping timeout commit - buffer already cleared (likely committed by recovery, new FINAL, or extending partial)');
                          return; // Skip commit - something else already handled it
                        }
                        
                        if (wasCommittedByRecovery) {
                          console.log('[HostMode] ⏭️ Skipping timeout commit - recovery already committed this forced final');
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
                          console.error('[HostMode] ❌ No text to commit - forced final text is empty!');
                          // Clear buffer if it still exists
                          if (bufferStillExists) {
                            forcedCommitEngine.clearForcedFinalBuffer();
                            syncForcedFinalBuffer();
                          }
                          return;
                        }
                        
                        // Commit the forced final (with grammar correction via processFinalText)
                        console.log(`[HostMode] 📝 Committing forced final from timeout: "${textToCommit.substring(0, 80)}..." (${textToCommit.length} chars)`);
                        console.log(`[HostMode] 📊 Final text to commit: "${textToCommit}"`);
                        
                        // ✅ Extract segmentId from buffer if available
                        let segmentIdForCommit = null;
                        try {
                          const buf = forcedCommitEngine.getForcedFinalBuffer?.();
                          segmentIdForCommit = buf?.segmentId || null;
                        } catch (_) {}
                        
                        try {
                          processFinalText(textToCommit, { forceFinal: true, segmentId: segmentIdForCommit, pipeline: 'recovery' });
                        } catch (e) {
                          console.error('[HostMode] ❌ Forced-final commit failed (timeout):', e);
                        }
                        
                        // Clear buffer if it still exists
                        if (bufferStillExists) {
                          forcedCommitEngine.clearForcedFinalBuffer();
                          syncForcedFinalBuffer();
                        }
                        
                        // CRITICAL: If we didn't reset the partial tracker earlier (because new segment partials were detected),
                        // reset it now after committing the forced final
                        syncPartialVariables();
                        if (longestPartialText && longestPartialText.length > 0) {
                          // Check if these are new segment partials (don't start with the forced final)
                          const longestTrimmed = longestPartialText.trim().toLowerCase();
                          const forcedFinalTrimmed = textToCommit.trim().toLowerCase();
                          if (!longestTrimmed.startsWith(forcedFinalTrimmed)) {
                            console.log(`[HostMode] 🧹 Resetting partial tracker after forced final commit (new segment partials detected)`);
                            partialTracker.reset();
                            syncPartialVariables();
                          }
                        }
                        
                        // Reset recovery tracking after commit
                        recoveryStartTime = 0;
                        nextFinalAfterRecovery = null;
                      }, 1200);  // Phase 2: Wait 1200ms to capture more POST-final audio (shifts window from [T-1500,T+500] to [T-800,T+1200])
                    }, 0);  // Phase 1: Start immediately

                  } catch (error) {
                    console.error(`[HostMode] ❌ Error setting up forced final buffer timeout:`, error);
                  }
                  
                  // Cancel pending finalization timers (if any) since we're handling it now
                  // PHASE 8: Clear using engine
                  if (finalizationEngine.hasPendingFinalization()) {
                    finalizationEngine.clearPendingFinalizationTimeout();
                    finalizationEngine.clearPendingFinalization();
                    syncPendingFinalization();
                  }
                  
                  return;
                }
                
                // PHASE 8: Check for forced final buffer using engine
                syncForcedFinalBuffer();
                if (forcedCommitEngine.hasForcedFinalBuffer()) {
                  const buffer = forcedCommitEngine.getForcedFinalBuffer();
                  
                  // CRITICAL: If recovery is in progress, check if this FINAL is related to the forced final
                  // Only block if it might be a continuation/extension of the forced final
                  // New segments (unrelated FINALs) should be processed immediately
                  if (buffer.recoveryInProgress && buffer.recoveryPromise) {
                    const forcedFinalText = (buffer.text || '').trim().toLowerCase();
                    const newFinalText = (transcriptText || '').trim().toLowerCase();

                    // Heuristics: is the new FINAL a continuation/overlap of the forced-final segment?
                    const isExtension =
                      newFinalText.length > forcedFinalText.length &&
                      forcedFinalText.length > 0 &&
                      newFinalText.startsWith(forcedFinalText);

                    const isPrefix =
                      forcedFinalText.length > newFinalText.length &&
                      newFinalText.length > 0 &&
                      forcedFinalText.startsWith(newFinalText);

                    const forcedWords = forcedFinalText.split(/\s+/).filter(w => w.length > 2);
                    const newWords = newFinalText.split(/\s+/).filter(w => w.length > 2);
                    const sharedWords = forcedWords.filter(w => newWords.includes(w));
                    const hasWordOverlap =
                      sharedWords.length >= Math.min(2, Math.floor(Math.min(forcedWords.length, newWords.length) * 0.3));

                    const mightBeRelated = isExtension || isPrefix || hasWordOverlap;

                    if (!mightBeRelated) {
                      console.log('[HostMode] ✅ Forced final recovery in progress, but new FINAL is unrelated segment - processing immediately');
                      console.log(`[HostMode]   Forced final: "${buffer.text?.substring(0, 50)}..."`);
                      console.log(`[HostMode]   New FINAL (unrelated): "${transcriptText?.substring(0, 50)}..."`);
                      console.log(`[HostMode]   Heuristics: isExtension=${isExtension}, isPrefix=${isPrefix}, hasWordOverlap=${hasWordOverlap}, mightBeRelated=${mightBeRelated}`);
                      console.log(`[HostMode]   ⚡ FALLING THROUGH - will process transcriptText immediately without waiting for recovery`);

                      // ✅ CRITICAL: Do NOT wait. Do NOT merge with forced-final. Just fall through and
                      // let the normal FINAL handling commit transcriptText as its own segment.
                      // (No return, no await, no touching forced buffer.)
                      // The forced final will be handled by its own recovery promise and timeout independently.
                    } else {
                      console.log('[HostMode] ⏳ Forced final recovery in progress - new FINAL appears related, waiting for completion (maintaining order)...');
                      console.log(`[HostMode]   Forced final: "${buffer.text?.substring(0, 50)}..."`);
                      console.log(`[HostMode]   New FINAL: "${transcriptText?.substring(0, 50)}..."`);
                      console.log(`[HostMode]   Heuristics: isExtension=${isExtension}, isPrefix=${isPrefix}, hasWordOverlap=${hasWordOverlap}, mightBeRelated=${mightBeRelated}`);
                      console.log(`[HostMode]   ⏳ AWAITING recovery promise before processing new FINAL...`);

                      try {
                        const waitStartTime = Date.now();
                        const recoveredText = await buffer.recoveryPromise;
                        const recoveryWaitTime = Date.now() - waitStartTime;
                        console.log(`[HostMode] ✅ Recovery promise resolved after ${recoveryWaitTime}ms`);
                        console.log(`[HostMode]   Recovered text: "${recoveredText?.substring(0, 60) || 'empty'}..."`);

                        // ✅ always commit forced-final first if recovery was related
                        const forcedTextToCommit = (recoveredText && recoveredText.length > 0)
                          ? recoveredText
                          : buffer.text;

                        console.log(`[HostMode] 📝 STEP 1: Committing forced final first: "${forcedTextToCommit.substring(0, 60)}..."`);
                        syncForcedFinalBuffer();
                        if (forcedFinalBuffer) forcedFinalBuffer.committedByRecovery = true;

                        processFinalText(forcedTextToCommit, { forceFinal: true });

                        forcedCommitEngine.clearForcedFinalBufferTimeout();
                        forcedCommitEngine.clearForcedFinalBuffer();
                        syncForcedFinalBuffer();

                        console.log(`[HostMode] 📝 STEP 2: Forced final committed, now continuing with new FINAL: "${transcriptText.substring(0, 60)}..."`);
                        // ✅ now continue: transcriptText will be processed by normal FINAL path below
                        recoveryStartTime = 0;
                        nextFinalAfterRecovery = null;
                      } catch (err) {
                        console.error('[HostMode] ❌ Error waiting for forced final recovery:', err?.message || err);
                        console.error('[HostMode]   Error details:', err);
                        console.error('[HostMode]   Error stack:', err.stack);

                        // On error: clear buffer so you don't stall forever
                        console.log(`[HostMode] 🧹 Clearing forced final buffer due to error, will process new FINAL normally`);
                        forcedCommitEngine.clearForcedFinalBufferTimeout();
                        forcedCommitEngine.clearForcedFinalBuffer();
                        syncForcedFinalBuffer();

                        recoveryStartTime = 0;
                        nextFinalAfterRecovery = null;
                        // continue: process transcriptText normally below
                      }
                    }
                  } else {
                    // No recovery in progress - merge immediately as before
                    console.log('[HostMode] 🔁 Merging buffered forced final with new FINAL transcript');
                    forcedCommitEngine.clearForcedFinalBufferTimeout();
                    const merged = partialTracker.mergeWithOverlap(buffer.text, transcriptText);
                    if (merged) {
                      transcriptText = merged;
                    } else {
                      // Merge failed - use the new FINAL transcript as-is
                      console.warn('[HostMode] ⚠️ Merge failed, using new FINAL transcript');
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
                  console.warn('[HostMode] ⚠️ transcriptText is null or empty after merge operations - skipping final processing');
                  return;
                }
                
                // Log if we're processing an unrelated final after falling through
                syncForcedFinalBuffer();
                if (forcedFinalBuffer && forcedFinalBuffer.recoveryInProgress) {
                  console.log(`[HostMode] 📝 Processing FINAL after unrelated fallthrough: "${transcriptText.substring(0, 60)}..."`);
                  console.log(`[HostMode]   Forced final recovery still in progress - this FINAL will be processed independently`);
                }
                
                // Capture next final if it arrives after recovery started (for deduplication)
                if (recoveryStartTime > 0 && Date.now() > recoveryStartTime) {
                  // This final arrived after recovery started - store it for deduplication
                  if (!nextFinalAfterRecovery) {
                    nextFinalAfterRecovery = {
                      text: transcriptText,
                      timestamp: Date.now()
                    };
                    console.log(`[HostMode] 📌 Captured next final after recovery start: "${transcriptText.substring(0, 60)}..."`);
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
                      console.log(`[HostMode] ✂️ Trimming ${overlapCount} overlapping word(s) from lastSentFinalText: "${lastSentWords.slice(-overlapCount).join(' ')}"`);
                      console.log(`[HostMode]   Before: "${lastSentFinalText.substring(Math.max(0, lastSentFinalText.length - 60))}"`);
                      console.log(`[HostMode]   After:  "${lastSentFinalTextToUse.substring(Math.max(0, lastSentFinalTextToUse.length - 60))}"`);
                    } else {
                      console.log(`[HostMode] ⚠️ All words in lastSentFinalText overlap with new final - this should not happen`);
                    }
                  }
                }
                
                // CRITICAL: Check if this FINAL is a continuation of the last sent FINAL
                // This prevents splitting sentences like "Where two or three" / "Are gathered together"
                let wasContinuationMerged = false;
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
                    console.log(`[HostMode] 🔗 New FINAL continues last sent FINAL: "${lastSentTrimmed.substring(Math.max(0, lastSentTrimmed.length - 40))}" + "${continuation.substring(0, 40)}..."`);
                    console.log(`[HostMode] 📦 Merging consecutive FINALs: "${lastSentTrimmed}" + "${continuation}"`);
                    // Merge them - the new FINAL contains the continuation
                    transcriptText = newFinalTrimmed; // Use the full new FINAL (it already contains the continuation)
                    wasContinuationMerged = true;
                  } else {
                    // Check for overlap - last FINAL might end mid-sentence and new FINAL continues it
                    const merged = mergeWithOverlap(lastSentTrimmed, newFinalTrimmed);
                    if (merged && merged.length > lastSentTrimmed.length + 3) {
                      // Overlap detected - merge them
                      const continuation = merged.substring(lastSentTrimmed.length).trim();
                      console.log(`[HostMode] 🔗 New FINAL continues last sent FINAL via overlap: "${lastSentTrimmed.substring(Math.max(0, lastSentTrimmed.length - 40))}" + "${continuation.substring(0, 40)}..."`);
                      console.log(`[HostMode] 📦 Merging consecutive FINALs via overlap: "${lastSentTrimmed}" + "${continuation}"`);
                      transcriptText = merged;
                      wasContinuationMerged = true;
                    }
                  }
                  
                  // CRITICAL: If continuation was merged, clear pending finalization to prevent duplicate sends
                  // Also update lastSentFinalText immediately so the merged version is used
                  if (wasContinuationMerged) {
                    syncPendingFinalization();
                    if (finalizationEngine.hasPendingFinalization()) {
                      const pending = finalizationEngine.getPendingFinalization();
                      // Check if pending matches the old (unmerged) final - if so, cancel it
                      const pendingTrimmed = pending.text.trim();
                      if (pendingTrimmed === lastSentTrimmed || pendingTrimmed === newFinalTrimmed) {
                        console.log(`[HostMode] 🔄 Cancelling pending finalization (continuation merge occurred)`);
                        finalizationEngine.clearPendingFinalizationTimeout();
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();
                      }
                    }
                    // Update lastSentFinalText to the merged version BEFORE finalization
                    // This ensures if the same continuation logic runs again, it won't create duplicates
                    lastSentFinalText = transcriptText;
                    lastSentFinalTime = Date.now();
                  }
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
                  console.log(`[HostMode] 📝 FINAL is incomplete (ends with "${transcriptText.trim().slice(-1)}" not sentence punctuation) - will wait briefly for extending partials`);
                  console.log(`[HostMode] 📝 Current text: "${transcriptText.substring(Math.max(0, transcriptText.length - 60))}"`);
                  // For incomplete finals, extend wait time to catch extending partials
                  // Short incomplete finals (< 50 chars) likely need more words - wait longer
                  if (transcriptText.length < 50) {
                    WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 2000); // At least 2 seconds for short incomplete phrases
                  } else {
                    WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 1500); // 1.5 seconds for longer incomplete text
                  }
                } else if (!finalEndsWithCompleteSentence) {
                  // Ends with sentence punctuation but not complete sentence - still wait a bit
                  console.log(`[HostMode] 📝 FINAL ends with sentence punctuation but not complete sentence - will commit after standard wait`);
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
                  console.log(`[HostMode] 📝 FINAL ends mid-word - will commit immediately, continuation will be caught in partials`);
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
                      console.log(`[HostMode] ⚠️ Both FINAL and partial end mid-word - using longer partial but may need more time`);
                    }
                    console.log(`[HostMode] ⚠️ FINAL extended by LONGEST partial (${transcriptText.length} → ${longestPartialText.length} chars)`);
                    console.log(`[HostMode] 📊 Recovered from partial: "${missingWords}"`);
                    finalTextToUse = longestPartialText;
                  } else {
                    // Partial doesn't start with final - check for overlap (Google might have missed words)
                    // CRITICAL: Be more aggressive - accept overlap if it adds at least 3 characters
                    const merged = mergeWithOverlap(finalTrimmed, longestTrimmed);
                    if (merged && merged.length > finalTrimmed.length + 3) {
                      // Overlap detected and merged text is longer - likely same segment with missing words
                      console.log(`[HostMode] ⚠️ FINAL merged with LONGEST partial via overlap (${transcriptText.length} → ${merged.length} chars)`);
                      console.log(`[HostMode] 📊 Recovered via overlap: "${merged.substring(finalTrimmed.length)}"`);
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
                      console.log(`[HostMode] ⚠️ Both FINAL and partial end mid-word - using longer partial but may need more time`);
                    }
                    console.log(`[HostMode] ⚠️ FINAL extended by LATEST partial (${transcriptText.length} → ${latestPartialText.length} chars)`);
                    console.log(`[HostMode] 📊 Recovered from partial: "${missingWords}"`);
                    finalTextToUse = latestPartialText;
                  } else {
                    // Partial doesn't start with final - check for overlap (Google might have missed words)
                    // CRITICAL: Be more aggressive - accept overlap if it adds at least 3 characters
                            const merged = partialTracker.mergeWithOverlap(finalTrimmed, latestTrimmed);
                    if (merged && merged.length > finalTrimmed.length + 3) {
                      // Overlap detected and merged text is longer - likely same segment with missing words
                      console.log(`[HostMode] ⚠️ FINAL merged with LATEST partial via overlap (${transcriptText.length} → ${merged.length} chars)`);
                      console.log(`[HostMode] 📊 Recovered via overlap: "${merged.substring(finalTrimmed.length)}"`);
                      finalTextToUse = merged;
                    }
                  }
                }
                
                // If we have a pending finalization, check if this final extends it
                // PHASE 8: Google can send multiple finals for long phrases - accumulate them
                // Use CoreEngine finalization engine
                syncPendingFinalization();
                if (finalizationEngine.hasPendingFinalization()) {
                  const pending = finalizationEngine.getPendingFinalization();
                  // Check if this final (or extended final) extends the pending one
                  if (finalTextToUse.length > pending.text.length && 
                      finalTextToUse.startsWith(pending.text.trim())) {
                    // This final extends the pending one - update it with the extended text
                    console.log(`[HostMode] 📦 Final extends pending (${pending.text.length} → ${finalTextToUse.length} chars)`);
                    // PHASE 8: Update using engine
                    finalizationEngine.updatePendingFinalizationText(finalTextToUse);
                    syncPendingFinalization();
                    // Reset the timeout to give more time for partials
                    // PHASE 8: Clear timeout using engine
                    finalizationEngine.clearPendingFinalizationTimeout();
                    // Recalculate wait time for the longer text
                    if (finalTextToUse.length > VERY_LONG_TEXT_THRESHOLD) {
                      WAIT_FOR_PARTIALS_MS = Math.min(1500, BASE_WAIT_MS + (finalTextToUse.length - VERY_LONG_TEXT_THRESHOLD) * CHAR_DELAY_MS);
                    }
                  } else {
                    // Different final - cancel old one and start new
                    // PHASE 8: Clear using engine
                    finalizationEngine.clearPendingFinalizationTimeout();
                    finalizationEngine.clearPendingFinalization();
                    syncPendingFinalization();
                  }
                }
                
                // Schedule final processing after a delay to catch any remaining partials
                // If pendingFinalization exists and was extended, we'll reschedule it below
                if (!finalizationEngine.hasPendingFinalization()) {
                  // CRITICAL: Don't reset partials here - they're needed during timeout check
                  // Both BASIC and PREMIUM tiers need partials available during the wait period
                  // Partials will be reset AFTER final processing completes (see timeout callback)
                  // PHASE 8: Create using engine
                  finalizationEngine.createPendingFinalization(finalTextToUse, null);
                  syncPendingFinalization();
                }
                
                // Schedule or reschedule the timeout
                // PHASE 8: Use engine to set timeout
                finalizationEngine.setPendingFinalizationTimeout(() => {
                  // PHASE 8: Sync and null check (CRITICAL)
                  syncPendingFinalization();
                  // CRITICAL: Sync partial variables to get fresh data before checking
                  syncPartialVariables();
                  if (!pendingFinalization) {
                    console.warn('[HostMode] ⚠️ Timeout fired but pendingFinalization is null - skipping');
                    return;
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
                    let finalEndsWithCompleteSentence = finalizationEngine.endsWithCompleteSentence(finalTrimmed);
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
                        console.log(`[HostMode] ⚠️ Using LONGEST partial (${pendingFinalization.text.length} → ${longestPartialText.length} chars)`);
                        console.log(`[HostMode] 📊 Recovered: "${missingWords}"`);
                        finalTextToUse = longestPartialText;
                      } else {
                        // Check for overlap - Google might have missed words in the middle
                        // CRITICAL: Be more aggressive - accept overlap if it adds at least 3 characters
                        const overlap = partialTracker.mergeWithOverlap(finalTrimmed, longestTrimmed);
                        if (overlap && overlap.length > finalTrimmed.length + 3) {
                          // Overlap detected - likely same segment with missing words
                          console.log(`[HostMode] ⚠️ Using LONGEST partial with overlap (${pendingFinalization.text.length} → ${overlap.length} chars)`);
                          console.log(`[HostMode] 📊 Recovered via overlap: "${overlap.substring(finalTrimmed.length)}"`);
                          finalTextToUse = overlap;
                        } else {
                          console.log(`[HostMode] ⚠️ Ignoring LONGEST partial - no significant overlap (${overlap ? overlap.length : 0} chars)`);
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
                        console.log(`[HostMode] ⚠️ Using LATEST partial (${pendingFinalization.text.length} → ${latestPartialText.length} chars)`);
                        console.log(`[HostMode] 📊 Recovered: "${missingWords}"`);
                        finalTextToUse = latestPartialText;
                      } else {
                        // Check for overlap - Google might have missed words in the middle
                        // CRITICAL: Be more aggressive - accept overlap if it adds at least 3 characters
                        const overlap = partialTracker.mergeWithOverlap(finalTrimmed, latestTrimmed);
                        if (overlap && overlap.length > finalTrimmed.length + 3) {
                          // Overlap detected - likely same segment with missing words
                          console.log(`[HostMode] ⚠️ Using LATEST partial with overlap (${pendingFinalization.text.length} → ${overlap.length} chars)`);
                          console.log(`[HostMode] 📊 Recovered via overlap: "${overlap.substring(finalTrimmed.length)}"`);
                          finalTextToUse = overlap;
                        } else {
                          console.log(`[HostMode] ⚠️ Ignoring LATEST partial - no significant overlap (${overlap ? overlap.length : 0} chars)`);
                        }
                      }
                    }
                    
                    // CRITICAL: Check if we've exceeded MAX_FINALIZATION_WAIT_MS
                    // If so, commit even if sentence is incomplete (safety net)
                    const timeSinceMaxWait = Date.now() - pendingFinalization.maxWaitTimestamp;
                    finalEndsWithCompleteSentence = finalizationEngine.endsWithCompleteSentence(finalTextToUse);
                    
                    if (!finalEndsWithCompleteSentence && timeSinceMaxWait < MAX_FINALIZATION_WAIT_MS) {
                      // Sentence is incomplete but we haven't hit max wait yet - wait a bit more
                      // CRITICAL: Update pendingFinalization.text with the latest finalTextToUse (may include partials)
                      // PHASE 8: Update using engine
                      finalizationEngine.updatePendingFinalizationText(finalTextToUse);
                      syncPendingFinalization();
                      // More aggressive wait: up to 4 seconds per reschedule, but don't exceed max wait
                      const remainingWait = Math.min(4000, MAX_FINALIZATION_WAIT_MS - timeSinceMaxWait);
                      console.log(`[HostMode] ⏳ Sentence incomplete - waiting ${remainingWait}ms more (${timeSinceMaxWait}ms / ${MAX_FINALIZATION_WAIT_MS}ms)`);
                      // Reschedule the timeout to check again after remaining wait
                      // PHASE 8: Use engine to set timeout
                      finalizationEngine.setPendingFinalizationTimeout(() => {
                        // PHASE 8: Sync and null check (CRITICAL)
                        syncPendingFinalization();
                        // CRITICAL: Sync partial variables to get fresh data before checking
                        syncPartialVariables();
                        if (!pendingFinalization) {
                          console.warn('[HostMode] ⚠️ Timeout fired but pendingFinalization is null - skipping');
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
                            console.log(`[HostMode] ⚠️ Reschedule: Using LONGEST partial (${pendingFinalization.text.length} → ${longestPartialText.length} chars)`);
                            console.log(`[HostMode] 📊 Recovered: "${missingWords}"`);
                            finalTextToUse2 = longestPartialText;
                          } else {
                            const overlap = partialTracker.mergeWithOverlap(finalTrimmed2, longestTrimmed2);
                            if (overlap && overlap.length > finalTrimmed2.length + 3) {
                              console.log(`[HostMode] ⚠️ Reschedule: Using LONGEST partial with overlap (${pendingFinalization.text.length} → ${overlap.length} chars)`);
                              console.log(`[HostMode] 📊 Recovered via overlap: "${overlap.substring(finalTrimmed2.length)}"`);
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
                            console.log(`[HostMode] ⚠️ Reschedule: Using LATEST partial (${pendingFinalization.text.length} → ${latestPartialText.length} chars)`);
                            console.log(`[HostMode] 📊 Recovered: "${missingWords}"`);
                            finalTextToUse2 = latestPartialText;
                          } else {
                            const overlap = partialTracker.mergeWithOverlap(finalTrimmed2, latestTrimmed2);
                            if (overlap && overlap.length > finalTrimmed2.length + 3) {
                              console.log(`[HostMode] ⚠️ Reschedule: Using LATEST partial with overlap (${pendingFinalization.text.length} → ${overlap.length} chars)`);
                              console.log(`[HostMode] 📊 Recovered via overlap: "${overlap.substring(finalTrimmed2.length)}"`);
                              finalTextToUse2 = overlap;
                            }
                          }
                        }
                        
                        const finalEndsWithCompleteSentence2 = finalizationEngine.endsWithCompleteSentence(finalTextToUse2);
                        const timeSinceMaxWait2 = Date.now() - pendingFinalization.maxWaitTimestamp;
                        
                        if (!finalEndsWithCompleteSentence2 && timeSinceMaxWait2 >= MAX_FINALIZATION_WAIT_MS) {
                          console.log(`[HostMode] ⚠️ Max wait exceeded - committing incomplete sentence`);
                        }
                        // Continue with commit using the updated text
                        const textToProcess = finalTextToUse2;
                        const waitTime = Date.now() - pendingFinalization.timestamp;
                        // CRITICAL: Clear pending finalization FIRST to prevent other timeouts from firing
                        // PHASE 8: Clear using engine
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();
                        // CRITICAL: Reset partial tracking AFTER clearing finalization, but BEFORE processing
                        // This ensures no other timeout callbacks can use stale partials
                        // PHASE 8: Reset partial tracking using tracker
                        partialTracker.reset();
                        syncPartialVariables();
                        console.log(`[HostMode] ✅ FINAL Transcript (after ${waitTime}ms wait): "${textToProcess.substring(0, 80)}..."`);
                        processFinalText(textToProcess);
                      }, remainingWait);
                      return; // Don't commit yet
                    }
                    
                    // Reset for next segment AFTER processing
                    const textToProcess = finalTextToUse;
                    const waitTime = Date.now() - pendingFinalization.timestamp;
                    // CRITICAL: Clear pending finalization FIRST to prevent other timeouts from firing
                    // PHASE 8: Clear using engine
                    finalizationEngine.clearPendingFinalization();
                    syncPendingFinalization();
                    // CRITICAL FIX: Reset partial tracking AFTER clearing finalization, but BEFORE processing
                    // This prevents accumulation of old partials from previous sentences
                    // and ensures no other timeout callbacks can use stale partials
                    // PHASE 8: Reset partial tracking using tracker
                    partialTracker.reset();
                    syncPartialVariables();
                    
                    if (!finalEndsWithCompleteSentence) {
                      console.log(`[HostMode] ⚠️ Committing incomplete sentence after ${waitTime}ms wait (max wait: ${MAX_FINALIZATION_WAIT_MS}ms)`);
                    }
                    console.log(`[HostMode] ✅ FINAL Transcript (after ${waitTime}ms wait): "${textToProcess.substring(0, 80)}..."`);
                    
                    // Process final - translate and broadcast to listeners
                    processFinalText(textToProcess);
                  }, WAIT_FOR_PARTIALS_MS);
              });
              
              console.log('[HostMode] ✅ Google Speech stream initialized and ready');
              
              // CRITICAL: Mark session as active so listeners can join
              sessionStore.setHost(currentSessionId, clientWs, null);
              const activeSession = sessionStore.getSession(currentSessionId);
              console.log(`[HostMode] ✅ Session ${activeSession?.sessionCode || currentSessionId} marked as active`);
              
            } catch (error) {
              console.error('[HostMode] Failed to initialize Google Speech stream:', error);
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
              sessionId: currentSessionId,
              message: `Translation session ready: ${currentSourceLang}`
            }));
          }
          break;

        case 'audio':
          // Process audio through Google Speech stream
          if (speechStream) {
            // Measure RTT if client sent timestamp
            if (message.clientTimestamp) {
              const rtt = measureRTT(message.clientTimestamp);
              if (rtt !== null) {
                const avgRTT = rttTracker.getAverageRTT();
                console.log(`[HostMode] 📊 RTT: ${rtt}ms (avg: ${avgRTT !== null ? avgRTT : 'N/A'}ms)`);
              }
            }
            
            // Update audio activity timestamp
            lastAudioTimestamp = Date.now();
            
            // Stream audio to Google Speech for transcription
            await speechStream.processAudio(message.audioData, {
              chunkIndex: message.chunkIndex,
              startMs: message.startMs,
              endMs: message.endMs,
              clientTimestamp: message.clientTimestamp
            });
          } else {
            console.warn('[HostMode] Received audio before stream initialization');
          }
          break;
          
        case 'audio_end':
          console.log('[HostMode] Audio stream ended');
          
          // CRITICAL: If there's a forced final buffer waiting for recovery, commit it immediately
          // The audio buffer will be empty, so recovery won't work anyway
          syncForcedFinalBuffer();
          if (forcedCommitEngine.hasForcedFinalBuffer()) {
            const buffer = forcedCommitEngine.getForcedFinalBuffer();
            console.log('[HostMode] ⚠️ Audio stream ended with forced final buffer - committing immediately (no audio to recover)');
            
            // Cancel recovery timeout since there's no audio to recover
            forcedCommitEngine.clearForcedFinalBufferTimeout();
            
            // Commit the forced final immediately
            const forcedFinalText = buffer.text;
            try {
              processFinalText(forcedFinalText, { forceFinal: true });
            } catch (e) {
              console.error('[HostMode] ❌ Forced-final commit failed (stream end):', e);
            }
            
            // Clear the buffer
            forcedCommitEngine.clearForcedFinalBuffer();
            syncForcedFinalBuffer();
            
            console.log('[HostMode] ✅ Forced final committed due to audio stream end');
          }
          
          if (speechStream) {
            await speechStream.endAudio();
          }
          break;
        
        case 'force_commit':
          // Force commit current transcript (if any)
          console.log('[HostMode] Force commit requested');
          // TODO: Implement force commit logic using CoreEngine
          break;
      }
    } catch (error) {
      console.error("[HostMode] Error processing message:", error);
    }
  });

  // Handle client disconnect
  clientWs.on('close', () => {
    console.log(`[HostMode] Host disconnected from session ${currentSessionId}`);
    
    // CRITICAL: If there's a forced final buffer waiting for recovery, commit it immediately
    // The audio buffer will be cleared, so recovery won't work anyway
    syncForcedFinalBuffer();
    if (forcedCommitEngine.hasForcedFinalBuffer()) {
      const buffer = forcedCommitEngine.getForcedFinalBuffer();
      console.log('[HostMode] ⚠️ Client disconnected with forced final buffer - committing immediately (no audio to recover)');
      
      // Cancel recovery timeout since there's no audio to recover
      forcedCommitEngine.clearForcedFinalBufferTimeout();
      
      // Commit the forced final immediately
      const forcedFinalText = buffer.text;
      try {
        processFinalText(forcedFinalText, { forceFinal: true });
      } catch (e) {
        console.error('[HostMode] ❌ Forced-final commit failed (connection close):', e);
      }
      
      // Clear the buffer
      forcedCommitEngine.clearForcedFinalBuffer();
      syncForcedFinalBuffer();
      
      console.log('[HostMode] ✅ Forced final committed due to client disconnect');
    }
    
    if (speechStream) {
      speechStream.destroy();
      speechStream = null;
    }
    // Reset core engine state
    coreEngine.reset();
  });

  // Handle errors
  clientWs.on('error', (error) => {
    console.error(`[HostMode] WebSocket error for session ${currentSessionId}:`, error);
  });
}

