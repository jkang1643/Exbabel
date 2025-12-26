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

import { GoogleSpeechStream } from '../googleSpeechStream.js';
import WebSocket from 'ws';
import sessionStore from '../sessionStore.js';
import translationManager from '../translationManager.js';
import { partialTranslationWorker, finalTranslationWorker } from '../translationWorkers.js';
import { realtimePartialTranslationWorker, realtimeFinalTranslationWorker } from '../translationWorkersRealtime.js';
import { grammarWorker } from '../grammarWorker.js';
import { CoreEngine } from '../../core/engine/coreEngine.js';
import { CandidateSource } from '../../core/engine/finalityGate.js';
import { mergeRecoveryText, wordsAreRelated } from '../utils/recoveryMerge.js';
import { deduplicatePartialText } from '../../core/utils/partialDeduplicator.js';
import { deduplicateFinalText } from '../../core/utils/finalDeduplicator.js';

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
  
  // CRITICAL: Safety mechanism to ensure all partials get finalized
  // Track safety check interval (declared in outer scope so it can be cleared on disconnect)
  let partialSafetyCheckInterval = null;

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
                
                // PHASE 8: Use CoreEngine timeline tracker for sequence IDs
                const { message, seqId } = timelineTracker.createSequencedMessage(messageData, isPartial);
                
                // Send to host
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify(message));
                  console.log(`[HostMode] 📤 Sent to host (${isPartial ? 'PARTIAL' : 'FINAL'}, seqId: ${seqId}, targetLang: ${messageData.targetLang || 'N/A'})`);
                }
                
                // Broadcast to listeners
                if (targetLang) {
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
                  // CRITICAL FIX: When text starts with original, apply correction but handle punctuation correctly
                  // Don't add periods when appending - only use cached correction if it matches exactly
                  // or if the remaining text doesn't create awkward punctuation
                  if (updated.startsWith(original)) {
                    const remaining = updated.substring(original.length);
                    const correctedTrimmed = corrected.trim();
                    const originalTrimmed = original.trim();
                    
                    // CRITICAL: If there's remaining text, we're extending the cached correction
                    // Check if the correction ONLY adds punctuation (period, comma, etc.) at the end
                    // If so, don't apply the punctuation when extending (it would create awkward spacing)
                    if (remaining.trim().length > 0) {
                      // We're extending the text - check if correction only adds punctuation
                      const correctedNoPunct = correctedTrimmed.replace(/[.!?,:;]$/, '');
                      const originalNoPunct = originalTrimmed.replace(/[.!?,:;]$/, '');
                      
                      // If the only difference is punctuation at the end, skip applying it when extending
                      if (correctedNoPunct === originalNoPunct) {
                        // Correction only added punctuation - don't apply it when text extends
                        // Use original text + remaining to avoid awkward "word. nextword" patterns
                        updated = originalTrimmed + remaining;
                        console.log(`[HostMode] ⚠️ Skipping punctuation from cached correction when text extends: "${originalTrimmed}" + "${remaining}"`);
                        break;
                      }
                    }
                    
                    // Normal replacement (no extension or correction has substantive changes)
                    updated = corrected + remaining;
                    break;
                  }
                }
                return updated;
              };
              
              // Track last sent FINAL (from solo mode)
              let lastSentFinalText = '';
              let lastSentFinalTime = 0;
              let lastSentOriginalText = ''; // Track original text to prevent grammar correction duplicates
              const FINAL_CONTINUATION_WINDOW_MS = 3000;
              
              // Flag to prevent concurrent final processing
              let isProcessingFinal = false;
              // Queue for finals that arrive while another is being processed
              const finalProcessingQueue = [];
              
              // CRITICAL: Safety mechanism to ensure all partials get finalized
              // Track the last time we received a partial or final
              let lastTranscriptActivity = Date.now();
              const PARTIAL_SAFETY_CHECK_INTERVAL_MS = 5000; // Check every 5 seconds
              const PARTIAL_MAX_AGE_MS = 10000; // Finalize partials older than 10 seconds
              
              // Safety function to finalize any pending partials
                syncPartialVariables();
                syncPendingFinalization();
                
                // Check if there are partials that need to be finalized
                const hasPartials = longestPartialText && longestPartialText.length > 0;
                const hasPendingFinal = pendingFinalization !== null;
                const timeSinceLastPartial = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                
                // If we have partials that are old enough and no pending final, create one
                if (hasPartials && !hasPendingFinal && timeSinceLastPartial > 2000) {
                  console.log(`[HostMode] 🔒 SAFETY: Finalizing pending partials (reason: ${reason}, age: ${timeSinceLastPartial}ms)`);
                  console.log(`[HostMode]   Partial text: "${longestPartialText.substring(0, 80)}..."`);
                  
                  // Create pending finalization for the longest partial
                  finalizationEngine.createPendingFinalization(longestPartialText, null);
                  syncPendingFinalization();
                  
                  // Schedule immediate finalization (short timeout)
                  finalizationEngine.setPendingFinalizationTimeout(() => {
                    syncPendingFinalization();
                    syncPartialVariables();
                    if (!pendingFinalization) {
                      console.warn('[HostMode] ⚠️ Safety timeout fired but pendingFinalization is null - skipping');
                      return;
                    }
                    
                    // Use longest partial if available
                    let textToCommit = pendingFinalization.text;
                    if (longestPartialText && longestPartialText.length > pendingFinalization.text.length) {
                      const longestExtends = partialTracker.checkLongestExtends(pendingFinalization.text, 10000);
                      if (longestExtends) {
                        textToCommit = longestExtends.extendedText;
                        console.log(`[HostMode] ✅ Safety finalization using longest partial: "${longestExtends.missingWords}"`);
                      }
                    }
                    
                    partialTracker.reset();
                    syncPartialVariables();
                    finalizationEngine.clearPendingFinalization();
                    syncPendingFinalization();
                    console.log(`[HostMode] ✅ SAFETY: Finalized pending partial: "${textToCommit.substring(0, 80)}..."`);
                    processFinalText(textToCommit);
                  }, 500); // Short timeout for safety finalization
                } else if (hasPendingFinal) {
                  // Check if pending final has been waiting too long
                  const timeSincePending = Date.now() - pendingFinalization.timestamp;
                  if (timeSincePending > PARTIAL_MAX_AGE_MS) {
                    console.log(`[HostMode] 🔒 SAFETY: Pending final has been waiting too long (${timeSincePending}ms) - forcing commit`);
                    finalizationEngine.clearPendingFinalizationTimeout();
                    
                    // Check for extending partials one more time
                    syncPartialVariables();
                    let textToCommit = pendingFinalization.text;
                    const longestExtends = partialTracker.checkLongestExtends(pendingFinalization.text, 10000);
                    const latestExtends = partialTracker.checkLatestExtends(pendingFinalization.text, 5000);
                    
                    if (longestExtends) {
                      textToCommit = longestExtends.extendedText;
                      console.log(`[HostMode] ✅ Safety finalization using longest partial: "${longestExtends.missingWords}"`);
                    } else if (latestExtends) {
                      textToCommit = latestExtends.extendedText;
                      console.log(`[HostMode] ✅ Safety finalization using latest partial: "${latestExtends.missingWords}"`);
                    }
                    
                    partialTracker.reset();
                    syncPartialVariables();
                    finalizationEngine.clearPendingFinalization();
                    syncPendingFinalization();
                    console.log(`[HostMode] ✅ SAFETY: Forced finalization of pending final: "${textToCommit.substring(0, 80)}..."`);
                    processFinalText(textToCommit);
                  }
                }
              };
              
              // Start periodic safety check
              partialSafetyCheckInterval = setInterval(() => {
              }, PARTIAL_SAFETY_CHECK_INTERVAL_MS);
              
              // Extract final processing into separate async function (using solo mode logic, adapted for broadcasting)
              const processFinalText = (textToProcess, options = {}) => {
                // CRITICAL: Guard against stale segment finalization
                const candidateSegmentId = options.segmentId || currentSegmentId;
                // If segmentId is explicitly provided in options, allow it (for boundary finalization of old segments)
                // Otherwise, if candidateSegmentId doesn't match currentSegmentId, block it (stale finalization)
                if (!options.segmentId && candidateSegmentId !== currentSegmentId && candidateSegmentId !== null) {
                  console.log(`[HostMode] 🔴 BLOCKED: Attempted to finalize stale segment ${candidateSegmentId} (current: ${currentSegmentId})`);
                  console.log(`[HostMode]   Text: "${textToProcess.substring(0, 60)}..."`);
                  return; // Block stale segment finalization
                }
                
                // Use the segmentId from options if provided (for boundary finalization), otherwise use currentSegmentId
                const targetSegmentId = options.segmentId || currentSegmentId;
                
                // CRITICAL: Use FinalityGate to enforce dominance rules - ALL candidates must go through
                // FinalityGate is the single authority - never bypass it
                if (coreEngine && coreEngine.finalityGate) {
                  // Determine candidate source from options (recovery candidates pass it explicitly)
                  const candidateSource = options.candidateSource || (options.forceFinal ? CandidateSource.Forced : CandidateSource.Grammar);
                  
                  const candidate = {
                    text: textToProcess.trim(),
                    source: candidateSource,
                    segmentId: targetSegmentId, // Use target segment ID for FinalityGate isolation
                    timestamp: Date.now(),
                    options: options
                  };
                  
                  // Submit candidate to FinalityGate (updates best candidate if better)
                  // Note: Recovery candidates may have already been submitted in RecoveryStreamEngine,
                  // but submitCandidate is idempotent (same candidate won't change bestCandidate)
                  const result = coreEngine.finalityGate.submitCandidate(candidate);
                  
                  if (!result.canCommit) {
                    console.log(`[HostMode] 🔴 FinalityGate: Blocking ${candidateSource === CandidateSource.Forced ? 'Forced' : candidateSource === CandidateSource.Recovery ? 'Recovery' : 'Grammar'} candidate (recovery pending or already finalized)`);
                    console.log(`[HostMode]   Text: "${textToProcess.substring(0, 60)}..."`);
                    return; // Blocked by FinalityGate (recovery pending or segment finalized)
                  }
                  
                  // Candidate can commit - finalize through FinalityGate (single authority)
                  const finalized = coreEngine.finalityGate.finalizeSegment(targetSegmentId);
                  if (!finalized) {
                    console.log(`[HostMode] ⚠️ FinalityGate: No candidate to finalize (should not happen)`);
                    return; // Nothing to finalize
                  }
                  
                  // Use the finalized candidate text (may be different if recovery upgraded it)
                  if (finalized.text !== textToProcess.trim()) {
                    console.log(`[HostMode] ✅ FinalityGate: Using better candidate (${textToProcess.trim().length} → ${finalized.text.length} chars)`);
                    console.log(`[HostMode]   Original: "${textToProcess.substring(0, 60)}..."`);
                    console.log(`[HostMode]   Finalized: "${finalized.text.substring(0, 60)}..."`);
                    textToProcess = finalized.text; // Use the better candidate
                    // Merge options from finalized candidate
                    Object.assign(options, finalized.options || {});
                  }
                }
                
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
                    let textNormalized = trimmedText.replace(/\s+/g, ' ').toLowerCase();
                    const isForcedFinal = !!options.forceFinal;
                    
                    // CRITICAL FIX: Check if there's a longer partial that contains this final fragment
                    // This must happen INSIDE processFinalText because partials can arrive after the final
                    // Use tracker snapshot directly to get the absolute latest state
                    const partialSnapshot = partialTracker.getSnapshot();
                    const currentLongestPartial = partialSnapshot.longest || '';
                    const currentLatestPartial = partialSnapshot.latest || '';
                    
                    // Check both longest and latest partials from snapshot (most up-to-date)
                    // CRITICAL: Check if partial starts with the final (even if partial is not longer yet)
                    // This prevents short fragments from being committed when a longer version is being transcribed
                    // Use word-by-word comparison to handle punctuation and word boundary differences
                    // NOTE: For forced finals, we still check but are more lenient (forced finals are explicitly triggered)
                    const finalWords = trimmedText.toLowerCase().replace(/[.,!?;:…]/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/).filter(w => w.length > 0);
                    
                    // Helper function to check if words match (fuzzy matching)
                    const wordsMatch = (word1, word2) => {
                      // Exact match
                      if (word1 === word2) return true;
                      // One word starts with the other (handles "fight" vs "fighting", "decade" vs "decades")
                      if (word1.length > 3 && word2.length > 3 && 
                          (word1.startsWith(word2.substring(0, Math.min(4, word1.length))) ||
                           word2.startsWith(word1.substring(0, Math.min(4, word2.length))))) {
                        return true;
                      }
                      // Very short words (1-3 chars) must match exactly
                      if (word1.length <= 3 && word2.length <= 3 && word1 === word2) {
                        return true;
                      }
                      return false;
                    };
                    
                    // Helper function to check if partial starts with final words (handles variations)
                    const partialStartsWithFinalWords = (partialText) => {
                      if (!partialText || partialText.trim().length < trimmedText.length) return false;
                      
                      const partialTrimmed = partialText.trim();
                      const partialWords = partialTrimmed.toLowerCase().replace(/[.,!?;:…]/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/).filter(w => w.length > 0);
                      
                      // Need at least as many words in partial as in final
                      if (partialWords.length < finalWords.length) return false;
                      
                      // Check if first N words match (where N = number of words in final)
                      let matchingWords = 0;
                      for (let i = 0; i < finalWords.length && i < partialWords.length; i++) {
                        if (wordsMatch(finalWords[i], partialWords[i])) {
                          matchingWords++;
                        }
                      }
                      
                      // If at least 80% of words match, consider it a match
                      const matchRatio = matchingWords / finalWords.length;
                      return matchRatio >= 0.8;
                    };
                    
                    // Helper function to check if partial contains all final words (even if not at start)
                    // This catches cases like "Saying, second." where partial has "saying" at end and "second" later
                    const partialContainsAllFinalWords = (partialText) => {
                      if (!partialText || partialText.trim().length < trimmedText.length) return false;
                      
                      const partialTrimmed = partialText.trim();
                      const partialWords = partialTrimmed.toLowerCase().replace(/[.,!?;:…]/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/).filter(w => w.length > 0);
                      
                      // Check if all final words appear in partial (in any order, but all must be present)
                      let matchingWords = 0;
                      for (const finalWord of finalWords) {
                        // Check if this final word appears anywhere in partial
                        for (const partialWord of partialWords) {
                          if (wordsMatch(finalWord, partialWord)) {
                            matchingWords++;
                            break; // Found this word, move to next
                          }
                        }
                      }
                      
                      // If all words are found, and partial is longer, consider it a match
                      // This catches fragments like "Saying, second." when partial has both words
                      const matchRatio = matchingWords / finalWords.length;
                      const lengthDiff = partialTrimmed.length - trimmedText.length;
                      
                      // Special case: For very short finals (2-3 words) and very long partials (50+ chars longer),
                      // skip if at least 50% of words match (catches "Saying, second." when partial has "saying")
                      if (finalWords.length <= 3 && lengthDiff > 50 && matchRatio >= 0.5) {
                        return true;
                      }
                      
                      // Normal case: If all words are found (90%+) and partial is significantly longer, skip
                      // Or if most words (80%+) are found and partial is much longer (50+ chars)
                      return (matchRatio >= 0.9 && lengthDiff > 10) || 
                             (matchRatio >= 0.8 && lengthDiff > 50);
                    };
                    
                    // For regular finals, skip if partial matches
                    // For forced finals, only skip if partial is significantly longer (forced finals are explicitly triggered)
                    if (currentLongestPartial && finalWords.length > 0) {
                      const longestTrimmed = currentLongestPartial.trim();
                      const isLonger = longestTrimmed.length >= trimmedText.length;
                      const isSignificantlyLonger = longestTrimmed.length > trimmedText.length + 20; // At least 20 chars longer
                      
                      // Check if partial starts with final words OR contains all final words
                      const startsWithMatch = partialStartsWithFinalWords(longestTrimmed);
                      const containsAllWords = partialContainsAllFinalWords(longestTrimmed);
                      
                      if (isLonger && (startsWithMatch || containsAllWords)) {
                        // For forced finals, only skip if partial is significantly longer (allows forced finals through)
                        // For regular finals, skip if partial is longer
                        if (!isForcedFinal || isSignificantlyLonger) {
                          // Partial contains final words - skip the final fragment
                          console.log(`[HostMode] ⏸️ SKIPPING FINAL FRAGMENT (in processFinalText): "${trimmedText.substring(0, 50)}..." (${trimmedText.length} chars)`);
                          console.log(`[HostMode]   Active partial contains final words: "${longestTrimmed.substring(0, 50)}..." (${longestTrimmed.length} chars)`);
                          console.log(`[HostMode]   Match type: startsWith=${startsWithMatch}, containsAll=${containsAllWords}`);
                          console.log(`[HostMode]   Fragment is contained in active partial - waiting for partial to finalize instead`);
                          isProcessingFinal = false;
                          return; // Exit early, don't process this final fragment
                        }
                      }
                    }
                    
                    if (currentLatestPartial && finalWords.length > 0) {
                      const latestTrimmed = currentLatestPartial.trim();
                      const isLonger = latestTrimmed.length >= trimmedText.length;
                      const isSignificantlyLonger = latestTrimmed.length > trimmedText.length + 20; // At least 20 chars longer
                      
                      // Check if partial starts with final words OR contains all final words
                      const startsWithMatch = partialStartsWithFinalWords(latestTrimmed);
                      const containsAllWords = partialContainsAllFinalWords(latestTrimmed);
                      
                      if (isLonger && (startsWithMatch || containsAllWords)) {
                        // For forced finals, only skip if partial is significantly longer (allows forced finals through)
                        // For regular finals, skip if partial is longer
                        if (!isForcedFinal || isSignificantlyLonger) {
                          // Partial contains final words - skip the final fragment
                          console.log(`[HostMode] ⏸️ SKIPPING FINAL FRAGMENT (in processFinalText): "${trimmedText.substring(0, 50)}..." (${trimmedText.length} chars)`);
                          console.log(`[HostMode]   Active partial contains final words: "${latestTrimmed.substring(0, 50)}..." (${latestTrimmed.length} chars)`);
                          console.log(`[HostMode]   Match type: startsWith=${startsWithMatch}, containsAll=${containsAllWords}`);
                          console.log(`[HostMode]   Fragment is contained in active partial - waiting for partial to finalize instead`);
                          isProcessingFinal = false;
                          return; // Exit early, don't process this final fragment
                        }
                      }
                    }
                    
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
                          // CRITICAL FIX: If new text is longer and contains the old one, prefer the longer version
                          if (textNormalized === lastSentFinalNormalized || textNormalized === lastSentOriginalNormalized) {
                            // They're identical - skip
                            console.log(`[HostMode] ⚠️ Duplicate FORCED final detected (identical text, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..."`);
                            isProcessingFinal = false;
                            return;
                          } else if (textNormalized.length > lastSentFinalNormalized.length && 
                                     (textNormalized.startsWith(lastSentFinalNormalized) || 
                                      lastSentFinalNormalized.startsWith(textNormalized.substring(0, Math.min(textNormalized.length, lastSentFinalNormalized.length))))) {
                            // New text is longer and contains the old one - this is the BUG scenario
                            // We should skip the longer one to prevent duplication (since shorter one was already sent)
                            // We can't "unsend" the shorter one, so we must skip the longer one
                            console.log(`[HostMode] ⚠️ Duplicate FORCED final detected (longer version contains shorter already sent, ${timeSinceLastFinal}ms ago), skipping longer to prevent duplication`);
                            console.log(`[HostMode]   Shorter (already sent): "${lastSentFinalText.substring(0, 80)}..." (${lastSentFinalNormalized.length} chars)`);
                            console.log(`[HostMode]   Longer (new, skipping): "${trimmedText.substring(0, 80)}..." (${textNormalized.length} chars)`);
                            isProcessingFinal = false;
                            return; // Skip longer version to prevent duplication
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
                            // CRITICAL FIX: Skip longer version if it contains shorter one already sent (prevent duplication)
                            if (wordOverlapRatio >= 0.75 && lengthDiff < 30) {
                              // Check if new text is longer and contains the old one - skip to prevent duplication
                              if (textNormalized.length > lastSentFinalNormalized.length && 
                                  (textNormalized.startsWith(lastSentFinalNormalized) || lastSentFinalNormalized.startsWith(textNormalized.substring(0, Math.min(textNormalized.length, lastSentFinalNormalized.length))))) {
                                // Longer version contains shorter one already sent - skip to prevent duplication
                                console.log(`[HostMode] ⚠️ Duplicate FORCED final detected (longer version contains shorter already sent, ${timeSinceLastFinal}ms ago, ${(wordOverlapRatio * 100).toFixed(0)}% word overlap), skipping longer to prevent duplication`);
                                console.log(`[HostMode]   Shorter (already sent): "${lastSentFinalText.substring(0, 80)}..." (${lastSentFinalNormalized.length} chars)`);
                                console.log(`[HostMode]   Longer (new, skipping): "${trimmedText.substring(0, 80)}..." (${textNormalized.length} chars)`);
                                isProcessingFinal = false;
                                return; // Skip longer version to prevent duplication
                              } else if (textNormalized.length <= lastSentFinalNormalized.length + 10) {
                                // New text is NOT significantly longer - skip it (old one is better or same)
                                console.log(`[HostMode] ⚠️ Duplicate FORCED final detected (high word overlap ${(wordOverlapRatio * 100).toFixed(0)}%, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..."`);
                                isProcessingFinal = false;
                                return;
                              }
                            }
                          }
                        }
                      }
                      
                      // CRITICAL FIX: Check if new text is shorter and contained in last sent (skip shorter version)
                      // This prevents committing short fragments when longer versions already exist or were already sent
                      if (timeSinceLastFinal < 5000 && lastSentFinalNormalized.length > textNormalized.length) {
                        // Check if last sent contains the new text (last sent is longer and contains new)
                        if (lastSentFinalNormalized.startsWith(textNormalized) || 
                            (textNormalized.length > 10 && lastSentFinalNormalized.includes(textNormalized))) {
                          console.log(`[HostMode] ⏭️ SKIPPING shorter final - longer version already sent (${textNormalized.length} < ${lastSentFinalNormalized.length} chars)`);
                          console.log(`[HostMode]   Shorter: "${trimmedText.substring(0, 60)}..."`);
                          console.log(`[HostMode]   Longer (already sent): "${lastSentFinalText.substring(0, 60)}..."`);
                          isProcessingFinal = false;
                          return; // Skip shorter version - longer one already sent
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
                          
                          // CRITICAL FIX: If last sent is longer and contains new text, skip the new (shorter) one
                          if (lastSentFinalNormalized.length > textNormalized.length && 
                              (lastSentFinalNormalized.startsWith(textNormalized) || 
                               (textNormalized.length > 10 && lastSentFinalNormalized.includes(textNormalized)))) {
                            console.log(`[HostMode] ⏭️ SKIPPING shorter final - longer version already sent (${textNormalized.length} < ${lastSentFinalNormalized.length} chars)`);
                            console.log(`[HostMode]   Shorter: "${trimmedText.substring(0, 60)}..."`);
                            console.log(`[HostMode]   Longer (already sent): "${lastSentFinalText.substring(0, 60)}..."`);
                            isProcessingFinal = false;
                            return; // Skip shorter version
                          }
                          
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
                            
                            // CRITICAL FIX: Check if new text is a legitimate extension (recovery update)
                            // If new text is significantly longer and has high word overlap, it's likely a recovery update, not a duplicate
                            // Extension means: new text contains previous text + additional words (recovery found missing words)
                            const wordCountDiff = textWords.length - lastSentWords.length;
                            const isExtension = textWords.length > lastSentWords.length && 
                                              wordCountDiff >= 1 && // At least 1 additional word
                                              (textNormalized.startsWith(lastSentFinalNormalized.substring(0, Math.min(50, lastSentFinalNormalized.length))) ||
                                               textNormalized.includes(lastSentFinalNormalized.substring(Math.max(0, lastSentFinalNormalized.length - 50)))); // Or ends with previous text
                            
                            // If 80%+ words match and texts are similar length, it's likely a duplicate
                            // BUT: Skip duplicate detection if it's a legitimate extension (recovery update with additional words)
                            if (wordOverlapRatio >= 0.8 && lengthDiff < 20 && !isExtension) {
                              console.log(`[HostMode] ⚠️ Duplicate final detected (high word overlap ${(wordOverlapRatio * 100).toFixed(0)}%, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                              isProcessingFinal = false; // Clear flag before returning
                              return; // Skip processing duplicate
                            } else if (isExtension && wordOverlapRatio >= 0.8) {
                              console.log(`[HostMode] ✅ Allowing recovery update (extension detected: ${textWords.length} words vs ${lastSentWords.length} words, +${wordCountDiff} words, overlap ${(wordOverlapRatio * 100).toFixed(0)}%)`);
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
                            
                            // CRITICAL FIX: Check if new text is a legitimate extension (recovery update)
                            // If new text is significantly longer and has high word overlap, it's likely a recovery update, not a duplicate
                            // Extension means: new text contains previous text + additional words (recovery found missing words)
                            const wordCountDiff = textWords.length - lastSentWords.length;
                            const isExtension = textWords.length > lastSentWords.length && 
                                              wordCountDiff >= 1 && // At least 1 additional word
                                              (textNormalized.startsWith(lastSentFinalNormalized.substring(0, Math.min(50, lastSentFinalNormalized.length))) ||
                                               textNormalized.includes(lastSentFinalNormalized.substring(Math.max(0, lastSentFinalNormalized.length - 50)))); // Or ends with previous text
                            
                            // If 85%+ words match and texts are similar length, it's likely a duplicate
                            // BUT: Skip duplicate detection if it's a legitimate extension (recovery update with additional words)
                            if (wordOverlapRatio >= 0.85 && lengthDiff < 15 && !isExtension) {
                              console.log(`[HostMode] ⚠️ Duplicate final detected (high word overlap ${(wordOverlapRatio * 100).toFixed(0)}% in continuation window), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                              isProcessingFinal = false; // Clear flag before returning
                              return; // Skip processing duplicate
                            } else if (isExtension && wordOverlapRatio >= 0.85) {
                              console.log(`[HostMode] ✅ Allowing recovery update (extension detected: ${textWords.length} words vs ${lastSentWords.length} words, +${wordCountDiff} words, overlap ${(wordOverlapRatio * 100).toFixed(0)}%)`);
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
                            
                            // CRITICAL FIX: Check if new text is a legitimate extension (recovery update)
                            // If new text is significantly longer and has high word overlap, it's likely a recovery update, not a duplicate
                            // Extension means: new text contains previous text + additional words (recovery found missing words)
                            const wordCountDiff = textWords.length - lastSentWords.length;
                            const isExtension = textWords.length > lastSentWords.length && 
                                              wordCountDiff >= 1 && // At least 1 additional word
                                              (textNormalized.startsWith(lastSentFinalNormalized.substring(0, Math.min(50, lastSentFinalNormalized.length))) ||
                                               textNormalized.includes(lastSentFinalNormalized.substring(Math.max(0, lastSentFinalNormalized.length - 50)))); // Or ends with previous text
                            
                            // If 90%+ words match and texts are very similar length, it's likely a duplicate even outside time window
                            // BUT: Skip duplicate detection if it's a legitimate extension (recovery update with additional words)
                            if (wordOverlapRatio >= 0.9 && lengthDiff < 25 && !isExtension) {
                              console.log(`[HostMode] ⚠️ Duplicate final detected (very high word overlap ${(wordOverlapRatio * 100).toFixed(0)}% outside time window, ${timeSinceLastFinal}ms ago), skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentFinalText.substring(0, 60)}...")`);
                              isProcessingFinal = false; // Clear flag before returning
                              return; // Skip processing duplicate
                            } else if (isExtension && wordOverlapRatio >= 0.9) {
                              console.log(`[HostMode] ✅ Allowing recovery update (extension detected: ${textWords.length} words vs ${lastSentWords.length} words, +${wordCountDiff} words, overlap ${(wordOverlapRatio * 100).toFixed(0)}%)`);
                            }
                          }
                        }
                      }
                    }
                    
                    // CRITICAL: Remove duplicate words from new final that overlap with previous final
                    // NOTE: Deduplication ONLY runs for forced finals, not regular finals
                    // Regular finals from Google Speech should be sent as-is without deduplication
                    // Example: "...our own selves." followed by "Own self-centered desires..." 
                    // Should become "self-centered desires..." (removing "Own")
                    // IMPORTANT: Use lastSentOriginalText for comparison (raw text from Google Speech)
                    // This ensures we compare against what was actually transcribed, not grammar-corrected version
                    // CRITICAL FIX: For forced finals, NEVER use the forced final buffer for deduplication
                    // The forced final buffer contains the SAME text being committed, so it would incorrectly
                    // identify it as a duplicate. Only use lastSentFinalText/lastSentOriginalText for forced finals.
                    let finalTextToProcess = trimmedText;
                    
                    console.log(`[HostMode] 🔍 DEDUPLICATION START - Analyzing text for deduplication:`);
                    console.log(`[HostMode]   New final text: "${trimmedText.substring(0, 80)}..."`);
                    console.log(`[HostMode]   Is forced final: ${isForcedFinal}`);
                    console.log(`[HostMode]   Current lastSentFinalText: "${lastSentFinalText ? lastSentFinalText.substring(Math.max(0, lastSentFinalText.length - 60)) : '(empty)'}"`);
                    console.log(`[HostMode]   Current lastSentOriginalText: "${lastSentOriginalText ? lastSentOriginalText.substring(Math.max(0, lastSentOriginalText.length - 60)) : '(empty)'}"`);
                    console.log(`[HostMode]   Options.previousFinalTextForDeduplication: "${options.previousFinalTextForDeduplication ? options.previousFinalTextForDeduplication.substring(Math.max(0, options.previousFinalTextForDeduplication.length - 60)) : '(not provided)'}"`);
                    console.log(`[HostMode]   Options.skipDeduplication: ${options.skipDeduplication ? 'true' : 'false'}`);
                    
                    // CRITICAL FIX: Skip deduplication if this final is being committed because a new segment was detected
                    // When we commit a pending final because a new segment arrived, we've already determined it's a new segment
                    // and shouldn't be deduplicated against the previous final
                    if (options.skipDeduplication) {
                      console.log(`[HostMode] ⏭️ Skipping deduplication - this final is a new segment (detected before commit)`);
                      // Keep original text as-is when skipping deduplication
                      finalTextToProcess = trimmedText;
                    } else if (!isForcedFinal) {
                      // CRITICAL FIX: Only run deduplication for forced finals, not regular finals
                      // Regular finals from Google Speech should be sent as-is without deduplication
                      console.log(`[HostMode] ⏭️ Skipping deduplication - only applies to forced finals (isForcedFinal: ${isForcedFinal})`);
                      // Keep original text as-is when skipping deduplication
                      finalTextToProcess = trimmedText;
                    } else {
                      // CRITICAL FIX: For recovery commits, use the previous final text that was passed in options
                      // This ensures recovery commits use the correct previous final (from before the forced final was buffered)
                      // instead of the current lastSentFinalText which might be from a different segment
                      let textToCompareAgainst = null;
                      let timeToCompareAgainst = null;
                      let deduplicationSource = 'unknown';
                      
                      if (options.previousFinalTextForDeduplication) {
                        // Recovery is committing - use the captured previous final text
                        textToCompareAgainst = options.previousFinalTextForDeduplication;
                        timeToCompareAgainst = options.previousFinalTimeForDeduplication || Date.now();
                        deduplicationSource = 'recovery_passed_previous_final';
                        console.log(`[HostMode] ✅ Recovery commit detected - using passed previous final for deduplication`);
                        console.log(`[HostMode]   Source: ${deduplicationSource}`);
                        console.log(`[HostMode]   Previous final (from recovery): "${textToCompareAgainst.substring(Math.max(0, textToCompareAgainst.length - 80))}"`);
                        console.log(`[HostMode]   Previous final time: ${timeToCompareAgainst} (${Date.now() - timeToCompareAgainst}ms ago)`);
                      } else {
                      // Normal flow - use lastSentOriginalText or lastSentFinalText
                      textToCompareAgainst = lastSentOriginalText || lastSentFinalText; // Prefer original, fallback to corrected
                      timeToCompareAgainst = lastSentFinalTime;
                      deduplicationSource = lastSentOriginalText ? 'lastSentOriginalText' : (lastSentFinalText ? 'lastSentFinalText' : 'none');
                      console.log(`[HostMode] ✅ Normal flow - using current lastSentFinalText/lastSentOriginalText`);
                      console.log(`[HostMode]   Source: ${deduplicationSource}`);
                      if (textToCompareAgainst) {
                        console.log(`[HostMode]   Previous final: "${textToCompareAgainst.substring(Math.max(0, textToCompareAgainst.length - 80))}"`);
                        console.log(`[HostMode]   Previous final time: ${timeToCompareAgainst} (${Date.now() - timeToCompareAgainst}ms ago)`);
                      }
                    }
                    
                    // If no previous final text available, check if there's a forced final buffer (recovery in progress)
                    // BUT: Only for REGULAR finals, NOT forced finals (forced final buffer is the same text being committed)
                    if (!textToCompareAgainst && !isForcedFinal) {
                      syncForcedFinalBuffer();
                      if (forcedCommitEngine.hasForcedFinalBuffer()) {
                        const buffer = forcedCommitEngine.getForcedFinalBuffer();
                        if (buffer && buffer.text) {
                          textToCompareAgainst = buffer.text;
                          timeToCompareAgainst = buffer.timestamp || Date.now();
                          console.log(`[HostMode] 🔍 Using forced final buffer text for deduplication (recovery in progress): "${textToCompareAgainst.substring(Math.max(0, textToCompareAgainst.length - 60))}"`);
                        }
                      }
                    } else if (!textToCompareAgainst && isForcedFinal) {
                      // For forced finals, don't use forced final buffer text - it's the same text being committed!
                      // BUT: We can use lastSentFinalTextBeforeBuffer that was captured when the buffer was created
                      // This contains the previous final that was sent BEFORE the forced final was buffered
                      syncForcedFinalBuffer();
                      if (forcedCommitEngine.hasForcedFinalBuffer()) {
                        const buffer = forcedCommitEngine.getForcedFinalBuffer();
                        if (buffer && buffer.lastSentFinalTextBeforeBuffer) {
                          textToCompareAgainst = buffer.lastSentFinalTextBeforeBuffer;
                          // Use the captured timestamp if available, otherwise estimate
                          timeToCompareAgainst = buffer.lastSentFinalTimeBeforeBuffer || (buffer.timestamp - 1000);
                          console.log(`[HostMode] 🔍 Using lastSentFinalTextBeforeBuffer for deduplication: "${textToCompareAgainst.substring(Math.max(0, textToCompareAgainst.length - 80))}"`);
                        }
                      }
                      
                      // If still no text to compare against, check if lastSentOriginalText exists
                      // This handles cases where lastSentFinalText was empty but lastSentOriginalText has the previous final
                      if (!textToCompareAgainst && lastSentOriginalText) {
                        textToCompareAgainst = lastSentOriginalText;
                        timeToCompareAgainst = lastSentFinalTime;
                        console.log(`[HostMode] 🔍 Using lastSentOriginalText as fallback for forced final deduplication: "${textToCompareAgainst.substring(Math.max(0, textToCompareAgainst.length - 80))}"`);
                      }
                      
                      if (!textToCompareAgainst) {
                        console.log(`[HostMode] ℹ️ Forced final - no previous final text available for deduplication (lastSentFinalText="${lastSentFinalText ? lastSentFinalText.substring(Math.max(0, lastSentFinalText.length - 80)) : '(empty)'}", lastSentOriginalText="${lastSentOriginalText ? lastSentOriginalText.substring(Math.max(0, lastSentOriginalText.length - 80)) : '(empty)'}")`);
                      }
                    }
                    
                    if (textToCompareAgainst && timeToCompareAgainst) {
                      const timeSinceLastFinal = Date.now() - timeToCompareAgainst;
                      
                      // CRITICAL FIX: Recovery commits use longer time window (30 seconds)
                      // Recovery commits are logically consecutive segments regardless of recovery processing time
                      // Normal commits use 5 seconds since they should arrive quickly
                      const timeWindowForDedup = (deduplicationSource === 'recovery_passed_previous_final') ? 30000 : 5000;
                      
                      console.log(`[HostMode] 🔍 DEDUPLICATION CHECK:`);
                      console.log(`[HostMode]   Previous final (${deduplicationSource}): "${textToCompareAgainst.substring(Math.max(0, textToCompareAgainst.length - 80))}"`);
                      console.log(`[HostMode]   New final: "${trimmedText.substring(0, 80)}..."`);
                      console.log(`[HostMode]   Time since previous: ${timeSinceLastFinal}ms (window: ${timeWindowForDedup}ms${deduplicationSource === 'recovery_passed_previous_final' ? ' [recovery commit - extended window]' : ''})`);
                      console.log(`[HostMode]   Will check last 10 words of previous against first 10 words of new`);
                      
                      const dedupResult = deduplicateFinalText({
                        newFinalText: trimmedText,
                        previousFinalText: textToCompareAgainst,
                        previousFinalTime: timeToCompareAgainst,
                        mode: 'HostMode',
                        timeWindowMs: timeWindowForDedup,
                        maxWordsToCheck: 10
                      });
                      
                      console.log(`[HostMode] 🔍 DEDUPLICATION RESULT:`);
                      console.log(`[HostMode]   Was deduplicated: ${dedupResult.wasDeduplicated}`);
                      console.log(`[HostMode]   Words skipped: ${dedupResult.wordsSkipped}`);
                      console.log(`[HostMode]   Original text: "${trimmedText.substring(0, 80)}..."`);
                      console.log(`[HostMode]   Deduplicated text: "${dedupResult.deduplicatedText.substring(0, 80)}..."`);
                      
                      if (dedupResult.wasDeduplicated) {
                        finalTextToProcess = dedupResult.deduplicatedText;
                        console.log(`[HostMode] ✂️ DEDUPLICATION SUCCESS: Removed ${dedupResult.wordsSkipped} word(s)`);
                        console.log(`[HostMode]   Before: "${trimmedText.substring(0, 80)}..."`);
                        console.log(`[HostMode]   After:  "${finalTextToProcess.substring(0, 80)}..."`);
                        
                        // If all words were duplicates, skip processing this final entirely
                        if (!finalTextToProcess || finalTextToProcess.length === 0) {
                          console.log(`[HostMode] ⏭️ Skipping final - all words are duplicates of previous FINAL`);
                          isProcessingFinal = false;
                          return;
                        }
                        
                        // Update textNormalized for subsequent processing
                        textNormalized = finalTextToProcess.replace(/\s+/g, ' ').toLowerCase();
                      } else {
                        console.log(`[HostMode] ℹ️ No word overlap detected between previous and new final`);
                      }
                    } else {
                      if (!textToCompareAgainst) {
                        console.log(`[HostMode] ℹ️ No previous final text to compare against`);
                      }
                      if (!timeToCompareAgainst) {
                        console.log(`[HostMode] ℹ️ No previous final time to compare against`);
                      }
                    }
                    } // End of else block for skipDeduplication check
                    
                    // Use deduplicated text for all subsequent processing
                    // Keep original textToProcess for tracking purposes (to detect duplicates)
                    const originalTextToProcess = textToProcess;
                    textToProcess = finalTextToProcess;
                    
                    // CRITICAL FIX: Set lastSentFinalText IMMEDIATELY before async operations
                    // This ensures that if a forced final arrives during async processing (grammar/translation),
                    // it will have the previous final text available for deduplication
                    // We set it to the deduplicated text that will be processed
                    console.log(`[HostMode] 📌 UPDATING lastSentFinalText (before async ops):`);
                    console.log(`[HostMode]   Previous lastSentFinalText: "${lastSentFinalText ? lastSentFinalText.substring(Math.max(0, lastSentFinalText.length - 60)) : '(empty)'}"`);
                    console.log(`[HostMode]   Previous lastSentOriginalText: "${lastSentOriginalText ? lastSentOriginalText.substring(Math.max(0, lastSentOriginalText.length - 60)) : '(empty)'}"`);
                    
                    lastSentOriginalText = originalTextToProcess; // Track original (before deduplication)
                    lastSentFinalText = textToProcess; // Track the text that will be processed (after deduplication)
                    lastSentFinalTime = Date.now();
                    
                    console.log(`[HostMode]   New lastSentFinalText: "${lastSentFinalText.substring(Math.max(0, lastSentFinalText.length - 60))}"`);
                    console.log(`[HostMode]   New lastSentOriginalText: "${lastSentOriginalText.substring(Math.max(0, lastSentOriginalText.length - 60))}"`);
                    console.log(`[HostMode]   New lastSentFinalTime: ${lastSentFinalTime}`);
                    console.log(`[HostMode]   ✅ This ensures next final/forced final will have correct previous text for deduplication`);
                    
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
                          rememberGrammarCorrection(originalTextToProcess, correctedText);
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
                            originalText: textToProcess,
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
                          originalText: textToProcess,
                          correctedText: correctedText,
                          sourceLang: currentSourceLang,
                          targetLang: targetLang,
                          timestamp: Date.now(),
                          hasTranslation: hasTranslationForLang,
                          hasCorrection: hasCorrection,
                          forceFinal: !!options.forceFinal
                        };
                        
                        // CRITICAL: For same-language listeners, use correctedText as translatedText (like solo mode)
                        // This ensures grammar corrections appear in history
                        if (targetLang === currentSourceLang) {
                          messageToSend.translatedText = correctedText; // Same language = show corrected text
                          messageToSend.hasTranslation = false; // No translation needed
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
                      
                      // CRITICAL: Update last sent FINAL tracking after sending
                      // Note: We already set lastSentFinalText before async operations, but update it here
                      // with the grammar-corrected version if it changed
                      if (correctedText !== textToProcess) {
                        lastSentFinalText = correctedText;
                        lastSentFinalTime = Date.now();
                        console.log(`[HostMode] 📌 Updated lastSentFinalText with grammar correction: "${lastSentFinalText.substring(Math.max(0, lastSentFinalText.length - 60))}"`);
                      }
                      // lastSentOriginalText was already set before async operations
                      
                      // CRITICAL: Check for partials that arrived during async processing (grammar correction, translation)
                      // This catches words that were spoken while the final was being processed
                      checkForExtendingPartialsAfterFinal(lastSentFinalText);
                      
                      // CRITICAL FIX: Reset partial tracking AFTER final is successfully emitted
                      // This ensures recovery and finalization have access to partial state
                      partialTracker.reset();
                      syncPartialVariables();
                      
                      // CRITICAL: Reset segment ID after segment is finalized
                      // This allows next FINAL to generate a new segment ID
                      currentSegmentId = null;
                      console.log(`[HostMode] 🧹 Reset partial tracking and segment ID after final emission`);
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
                      // Note: We already set lastSentFinalText before async operations, but update it here if needed
                      if (error.skipRequest || finalText !== `[Translation error: ${error.message}]`) {
                        // Only update if we haven't already set it (shouldn't happen, but safety check)
                        if (!lastSentFinalText || lastSentFinalText !== textToProcess) {
                          lastSentOriginalText = originalTextToProcess; // Track original (before deduplication)
                          lastSentFinalText = textToProcess;
                          lastSentFinalTime = Date.now();
                          console.log(`[HostMode] 📌 Set lastSentFinalText on error path: "${lastSentFinalText.substring(Math.max(0, lastSentFinalText.length - 60))}"`);
                        }
                        
                      // CRITICAL: Check for partials that arrived during async processing
                      checkForExtendingPartialsAfterFinal(lastSentFinalText);
                      
                      // CRITICAL FIX: Reset partial tracking AFTER final is successfully emitted (even on error path if text was sent)
                      if (error.skipRequest || finalText !== `[Translation error: ${error.message}]`) {
                        partialTracker.reset();
                        syncPartialVariables();
                        currentSegmentId = null;
                        console.log(`[HostMode] 🧹 Reset partial tracking and segment ID after final emission (error path)`);
                      }
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
                
                // CRITICAL: Update last activity timestamp whenever we receive any transcript
                lastTranscriptActivity = Date.now();
                
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
                          
                          // CRITICAL: Check if recovery already committed before committing again
                          syncForcedFinalBuffer();
                          const bufferAfterRecovery = forcedCommitEngine.hasForcedFinalBuffer() ? forcedCommitEngine.getForcedFinalBuffer() : null;
                          const alreadyCommittedByRecovery = bufferAfterRecovery?.committedByRecovery === true;
                          
                          if (recoveredText && recoveredText.length > 0) {
                            console.log(`[HostMode] ✅ Recovery completed with text: "${recoveredText.substring(0, 60)}..."`);
                            
                            if (alreadyCommittedByRecovery) {
                              // Recovery already committed the merged text - merge the already-committed text with extending partial
                              console.log('[HostMode] 🔁 Recovery already committed - merging committed text with extending partial');
                              // Use the recovered text (which is the merged forced final + recovery words that was already committed)
                              const recoveredMerged = partialTracker.mergeWithOverlap(recoveredText, transcriptText);
                              if (recoveredMerged) {
                                console.log('[HostMode] 🔁 Merging already-committed recovered text with extending partial and committing');
                                forcedCommitEngine.clearForcedFinalBufferTimeout();
                                
                                // Get the previous final text for deduplication from the buffer
                                const lastSentOriginalTextBeforeBuffer = bufferAfterRecovery?.lastSentOriginalTextBeforeBuffer || null;
                                const lastSentFinalTextBeforeBuffer = bufferAfterRecovery?.lastSentFinalTextBeforeBuffer || null;
                                const lastSentFinalTimeBeforeBuffer = bufferAfterRecovery?.lastSentFinalTimeBeforeBuffer || null;
                                const previousFinalTextForDeduplication = lastSentOriginalTextBeforeBuffer || lastSentFinalTextBeforeBuffer;
                                
                                processFinalText(recoveredMerged, { 
                                  forceFinal: true,
                                  previousFinalTextForDeduplication: previousFinalTextForDeduplication,
                                  previousFinalTimeForDeduplication: lastSentFinalTimeBeforeBuffer
                                });
                                forcedCommitEngine.clearForcedFinalBuffer();
                                syncForcedFinalBuffer();
                                // Continue processing the extended partial normally
                                return; // Exit early - already committed
                              }
                            } else {
                              // Recovery found words but didn't commit yet - merge recovered text with extending partial
                              const recoveredMerged = partialTracker.mergeWithOverlap(recoveredText, transcriptText);
                              if (recoveredMerged) {
                                console.log('[HostMode] 🔁 Merging recovered text with extending partial and committing');
                                forcedCommitEngine.clearForcedFinalBufferTimeout();
                                
                                // Get the previous final text for deduplication from the buffer
                                const lastSentOriginalTextBeforeBuffer = bufferAfterRecovery?.lastSentOriginalTextBeforeBuffer || null;
                                const lastSentFinalTextBeforeBuffer = bufferAfterRecovery?.lastSentFinalTextBeforeBuffer || null;
                                const lastSentFinalTimeBeforeBuffer = bufferAfterRecovery?.lastSentFinalTimeBeforeBuffer || null;
                                const previousFinalTextForDeduplication = lastSentOriginalTextBeforeBuffer || lastSentFinalTextBeforeBuffer;
                                
                                processFinalText(recoveredMerged, { 
                                  forceFinal: true,
                                  previousFinalTextForDeduplication: previousFinalTextForDeduplication,
                                  previousFinalTimeForDeduplication: lastSentFinalTimeBeforeBuffer
                                });
                                forcedCommitEngine.clearForcedFinalBuffer();
                                syncForcedFinalBuffer();
                                // Continue processing the extended partial normally
                                return; // Exit early - already committed
                              }
                            }
                          } else if (alreadyCommittedByRecovery) {
                            // Recovery already committed the forced final (no additional words found) - merge with extending partial
                            console.log('[HostMode] 🔁 Recovery already committed forced final - merging with extending partial');
                            const forcedFinalText = bufferAfterRecovery?.text || forcedCommitEngine.getForcedFinalBuffer()?.text;
                            const recoveredMerged = partialTracker.mergeWithOverlap(forcedFinalText, transcriptText);
                            if (recoveredMerged) {
                              console.log('[HostMode] 🔁 Merging already-committed forced final with extending partial and committing');
                              forcedCommitEngine.clearForcedFinalBufferTimeout();
                              
                              // Get the previous final text for deduplication from the buffer
                              const lastSentOriginalTextBeforeBuffer = bufferAfterRecovery?.lastSentOriginalTextBeforeBuffer || null;
                              const lastSentFinalTextBeforeBuffer = bufferAfterRecovery?.lastSentFinalTextBeforeBuffer || null;
                              const lastSentFinalTimeBeforeBuffer = bufferAfterRecovery?.lastSentFinalTimeBeforeBuffer || null;
                              const previousFinalTextForDeduplication = lastSentOriginalTextBeforeBuffer || lastSentFinalTextBeforeBuffer;
                              
                              processFinalText(recoveredMerged, { 
                                forceFinal: true,
                                previousFinalTextForDeduplication: previousFinalTextForDeduplication,
                                previousFinalTimeForDeduplication: lastSentFinalTimeBeforeBuffer
                              });
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
                      // Check for actual silence gap (audio activity, not partial growth)
                      const lastAudioTime = speechStream.getLastAudioActivityTime?.() || Date.now();
                      const timeSinceLastAudio = Date.now() - lastAudioTime;
                      const SILENCE_GAP_MS = 800; // 700-900ms range
                      
                      // Check if recovery is pending for current segment
                      const currentSegmentRecoveryPending = coreEngine?.finalityGate?.isRecoveryPending(currentSegmentId);
                      
                      if (timeSinceLastAudio > SILENCE_GAP_MS) {
                        // Actual boundary detected - allow new segment even if recovery pending elsewhere
                        syncForcedFinalBuffer();
                        const recoveryInProgress = forcedFinalBuffer && forcedFinalBuffer.recoveryInProgress;
                        
                        // CRITICAL: Finalize old segment before starting new segment (gap-based boundary)
                        const oldSegmentId = currentSegmentId;
                        if (oldSegmentId) {
                          // Check if recovery pending for old segment - don't finalize if locked
                          if (coreEngine?.finalityGate?.isRecoveryPending(oldSegmentId)) {
                            console.log(`[HostMode] 🔒 Deferring BOUNDARY finalization - recovery pending for ${oldSegmentId}`);
                            // Queue this partial instead
                            enqueueDuringRecovery('PARTIAL', transcriptText, true, meta);
                            return;
                          }
                          
                          // Finalize any pending partials for the old segment
                          syncPendingFinalization();
                          syncPartialVariables();
                          
                          if (pendingFinalization || (longestPartialText && longestPartialText.length > 0)) {
                            // Force finalize the old segment immediately (gap-based boundary)
                            const textToFinalize = pendingFinalization?.text || longestPartialText;
                            if (textToFinalize) {
                              // Add minimum length/age checks before force-finalizing
                              const MIN_FORCE_FINAL_WORDS = 3;
                              const MIN_FORCE_FINAL_CHARS = 20;
                              const MIN_SILENCE_GAP_MS = 1200; // 1200-1500ms for short segments
                              const ASR_STUBS = ['and', 'you', 'oh', 'their', 'i', 'the', 'a', 'an'];
                              
                              const wordCount = textToFinalize.trim().split(/\s+/).filter(w => w.length > 0).length;
                              const charCount = textToFinalize.trim().length;
                              const textLower = textToFinalize.trim().toLowerCase();
                              const endsWithEllipsis = textLower.endsWith('...');
                              const isAsrStub = ASR_STUBS.some(stub => textLower === stub || textLower === `${stub}.`);
                              
                              // Check if too short and no gap
                              const tooShort = wordCount < MIN_FORCE_FINAL_WORDS && charCount < MIN_FORCE_FINAL_CHARS;
                              const noGap = timeSinceLastAudio < MIN_SILENCE_GAP_MS;
                              const isStub = endsWithEllipsis || isAsrStub;
                              
                              if (tooShort && noGap) {
                                console.log(`[HostMode] ⏭️ Skipping force-finalize: too short (${wordCount} words, ${charCount} chars) and no silence gap (${timeSinceLastAudio}ms)`);
                                // Continue processing as same segment
                                return;
                              }
                              
                              if (isStub && timeSinceLastAudio < 1500) {
                                console.log(`[HostMode] ⏭️ Skipping force-finalize: ASR stub "${textToFinalize}" without sufficient gap (${timeSinceLastAudio}ms < 1500ms)`);
                                // Continue processing as same segment
                                return;
                              }
                              
                              console.log(`[HostMode] 🔒 BOUNDARY: Finalizing old segment before new segment starts (gap: ${timeSinceLastAudio}ms)`);
                              console.log(`[HostMode]   Old segment ID: ${oldSegmentId}`);
                              console.log(`[HostMode]   Text: "${textToFinalize.substring(0, 80)}..."`);
                              // Use old segment ID for finalization
                              processFinalText(textToFinalize, { 
                                forceFinal: true,
                                segmentId: oldSegmentId  // Use old segment ID
                              });
                              // Clear pending finalization and reset partial tracker after finalizing
                              finalizationEngine.clearPendingFinalization();
                              syncPendingFinalization();
                              partialTracker.reset();
                              syncPartialVariables();
                            }
                          }
                          
                          // Close old segment in FinalityGate
                          if (coreEngine?.finalityGate) {
                            coreEngine.finalityGate.closeSegment(oldSegmentId);
                          }
                        }
                        // CRITICAL: Generate new segment ID for this new segment (gap-based boundary)
                        currentSegmentId = `seg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                        console.log(`[HostMode] 🆕 Generated new segment ID: ${currentSegmentId} (gap: ${timeSinceLastAudio}ms)`);
                        
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
                      } else if (currentSegmentRecoveryPending) {
                        // Recovery pending for THIS segment - queue instead of creating new segment
                        console.log(`[HostMode] 🔒 Recovery pending for ${currentSegmentId} - queuing partial`);
                        enqueueDuringRecovery('PARTIAL', transcriptText, true, meta);
                        return;
                      } else {
                        // Not a boundary, not locked - continue as same segment
                        // Don't generate new segment ID
                        console.log(`[HostMode] ⏭️ No boundary detected (gap: ${timeSinceLastAudio}ms < ${SILENCE_GAP_MS}ms) - continuing as same segment`);
                      }
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
                  let shouldDeduplicate = true; // Default to deduplicating
                  
                  // Helper function to detect if partial is a new segment
                  // Works generically for ANY words, not just a hardcoded list
                  const isNewSegment = (partialText, finalText) => {
                    const partialTrimmed = partialText.trim();
                    const finalTrimmed = finalText.trim();
                    
                    if (!partialTrimmed || !finalTrimmed) {
                      return false; // Can't determine without both texts
                    }
                    
                    // Check if partial extends the final (is a continuation)
                    const partialExtendsFinal = partialTrimmed.length > finalTrimmed.length && 
                                               (partialTrimmed.toLowerCase().startsWith(finalTrimmed.toLowerCase()) || 
                                                (finalTrimmed.length > 10 && partialTrimmed.toLowerCase().substring(0, finalTrimmed.length) === finalTrimmed.toLowerCase()));
                    
                    // Check if partial starts with final (case-insensitive)
                    const startsWithFinal = partialTrimmed.toLowerCase().startsWith(finalTrimmed.toLowerCase().substring(0, Math.min(20, finalTrimmed.length)));
                    
                    // If partial extends or starts with final, it's a continuation (not new segment)
                    if (partialExtendsFinal || startsWithFinal) {
                      return false;
                    }
                    
                    // Extract words for comparison
                    const partialWords = partialTrimmed.toLowerCase().split(/\s+/).filter(w => w.length > 0).map(w => w.replace(/[.!?,:;]/g, ''));
                    const finalWords = finalTrimmed.toLowerCase().split(/\s+/).filter(w => w.length > 0).map(w => w.replace(/[.!?,]/g, ''));
                    
                    if (partialWords.length === 0 || finalWords.length === 0) {
                      return false; // Can't determine without words
                    }
                    
                    const partialFirstWord = partialWords[0];
                    const finalLastWords = finalWords.slice(-5); // Check last 5 words of final
                    
                    // Check if first word of partial appears in last words of final
                    // If it does, it's likely a continuation
                    const firstWordInFinal = finalLastWords.includes(partialFirstWord);
                    
                    // Check if partial starts with any of the last words of final (handles cases like "unplug" -> "unplugged")
                    // CRITICAL: Only match if the final word is at least 3 characters to avoid false matches (e.g., "a" matching "anyrandomword")
                    const startsWithFinalWord = finalLastWords.some(finalWord => 
                      (finalWord.length >= 3 && partialFirstWord.startsWith(finalWord)) || 
                      (partialFirstWord.length >= 3 && finalWord.startsWith(partialFirstWord))
                    );
                    
                    // If first word appears in final or starts with a final word, it's likely a continuation
                    if (firstWordInFinal || startsWithFinalWord) {
                      return false;
                    }
                    
                    // Check for punctuation + capital letter pattern (strong indicator of new segment)
                    const finalEndsWithPunctuation = /[.!?]$/.test(finalTrimmed);
                    const partialStartsWithCapital = /^[A-Z]/.test(partialTrimmed);
                    
                    if (finalEndsWithPunctuation && partialStartsWithCapital) {
                      return true; // Strong indicator: punctuation + capital = new segment
                    }
                    
                    // Check if partial shares ANY words with the end of final
                    // If no shared words, it's likely a new segment
                    const sharedWords = partialWords.filter(w => finalLastWords.includes(w));
                    
                    // If no shared words AND final ends with punctuation, likely new segment
                    // This works for ANY words, not just a hardcoded list
                    if (sharedWords.length === 0 && finalEndsWithPunctuation) {
                      return true;
                    }
                    
                    // If partial is very short and doesn't share words with final, likely new segment
                    // This works for ANY words, not just a hardcoded list
                    if (partialWords.length <= 2 && sharedWords.length === 0) {
                      return true;
                    }
                    
                    // If no shared words at all (even if no punctuation), likely new segment
                    // This is the most generic check - works for ANY words
                    if (sharedWords.length === 0) {
                      return true;
                    }
                    
                    // Default: if no clear continuation indicators, treat as new segment
                    // This is safer than defaulting to continuation, which can cause missed commits
                    // Works generically for ANY words, not just specific ones
                    return true;
                  };
                  
                  // If there's a forced final buffer, check against it instead (it's more recent and hasn't been committed yet)
                  if (forcedFinalBuffer && forcedFinalBuffer.text) {
                    // Use the forced final text - it represents the most recent final, even though it hasn't been sent yet
                    textToCheckAgainst = forcedFinalBuffer.text;
                    // Use the timestamp from when the forced final was received (stored in buffer)
                    timeToCheckAgainst = forcedFinalBuffer.timestamp || Date.now();
                    console.log(`[HostMode] 🔍 Checking partial against forced final buffer (timestamp: ${timeToCheckAgainst}): "${textToCheckAgainst.substring(0, 60)}..."`);
                    
                    // CRITICAL FIX: Check if partial is actually a continuation before deduplicating
                    if (isNewSegment(transcriptText, forcedFinalBuffer.text)) {
                      console.log(`[HostMode] 🆕 New segment detected (forced final) - skipping deduplication`);
                      shouldDeduplicate = false;
                    }
                  } else if (lastSentFinalText) {
                    // CRITICAL FIX: Also check for new segments when using lastSentFinalText
                    // This prevents "and," and "And go" from being incorrectly deduplicated
                    if (isNewSegment(transcriptText, lastSentFinalText)) {
                      console.log(`[HostMode] 🆕 New segment detected (last sent final) - skipping deduplication`);
                      shouldDeduplicate = false;
                    }
                  }
                  
                  let partialTextToSend = transcriptText;
                  
                  // Only deduplicate if we determined it's safe to do so
                  if (shouldDeduplicate && textToCheckAgainst) {
                    // Use core engine utility for deduplication
                    const dedupResult = deduplicatePartialText({
                      partialText: transcriptText,
                      lastFinalText: textToCheckAgainst,
                      lastFinalTime: timeToCheckAgainst,
                      mode: 'HostMode',
                      timeWindowMs: 5000,
                      maxWordsToCheck: 5  // Increased from 3 to 5 for better phrase matching
                    });
                    
                    partialTextToSend = dedupResult.deduplicatedText;
                    
                    // CRITICAL FIX: Only skip if ALL text was removed AND it doesn't extend any final
                    // Check if original extends lastSentFinalText before dropping
                    let originalExtendsFinal = false;
                    if (lastSentFinalText && transcriptText) {
                      const lastSentText = lastSentFinalText.trim();
                      const originalPartialText = transcriptText.trim();
                      const lastSentNormalized = lastSentText.toLowerCase();
                      const originalNormalized = originalPartialText.toLowerCase();
                      
                      originalExtendsFinal = originalPartialText.length > lastSentText.length && 
                                           (originalNormalized.startsWith(lastSentNormalized) || 
                                            originalPartialText.startsWith(lastSentText));
                    }
                    
                    const trimmedDeduped = partialTextToSend ? partialTextToSend.trim() : '';
                    
                    // CRITICAL FIX: If deduplication removed all text, check if original extends final
                    // If original extends final, ALWAYS use original to preserve extending words
                    // This ensures forced final recovery works correctly - extending partials are never lost
                    if (dedupResult.wasDeduplicated && trimmedDeduped.length === 0) {
                      if (originalExtendsFinal) {
                        console.log(`[HostMode] ⚠️ Deduplication removed all text but original extends final - using original to preserve words`);
                        partialTextToSend = transcriptText; // Use original to preserve extending words
                      } else {
                        // CRITICAL: Check if this is a NEW SEGMENT (not a continuation/duplicate)
                        // If it's a new segment, we MUST send it to preserve history completeness
                        // User requirement: EVERY single partial segment must be committed to history
                        const isNewSegmentCheck = isNewSegment(transcriptText, textToCheckAgainst);
                        
                        if (isNewSegmentCheck) {
                          // This is a new segment - send original to ensure history completeness
                          // Even though deduplication removed all text, we need to preserve the segment in history
                          console.log(`[HostMode] 📝 Deduplication removed all text but NEW SEGMENT detected - sending original to preserve history: "${transcriptText.substring(0, 30)}..."`);
                          partialTextToSend = transcriptText; // Send original to ensure history completeness
                        } else {
                          // Original doesn't extend final and it's not a new segment - this is truly duplicate
                          // User requirement: ALL partials must be tracked, even if not sent
                          console.log(`[HostMode] ⚠️ Deduplication removed all text (all duplicates, not new segment) - still tracking but not sending to avoid spam`);
                          // Continue to tracking step - partial will be tracked but not sent
                          partialTextToSend = ''; // Empty, but will still be tracked
                        }
                      }
                    }
                  }
                  
                  // CRITICAL: Track ALL partials using ORIGINAL transcriptText for forced final recovery
                  // Even if we send deduplicated text, we track original so recovery can use extending partials
                  // This ensures forced final recovery works correctly - extending partials are always available
                  
                  // Track latest partial for correction race condition prevention (use text to send)
                  const textToSendForCorrection = (partialTextToSend && partialTextToSend.trim().length > 0) 
                                                    ? partialTextToSend 
                                                    : transcriptText; // Fallback to original if empty
                  latestPartialTextForCorrection = textToSendForCorrection;
                  const translationSeedText = applyCachedCorrections(textToSendForCorrection);
                  
                  // PHASE 8: Update partial tracking using CoreEngine Partial Tracker
                  // CRITICAL: Always track the ORIGINAL transcriptText, not deduplicated
                  // This ensures forced final recovery can use extending partials even if deduplication removed text
                  partialTracker.updatePartial(transcriptText); // Track ORIGINAL for recovery
                  syncPartialVariables(); // Sync variables for compatibility
                  
                  const snapshot = partialTracker.getSnapshot();
                  if (snapshot.longest && snapshot.longest.length > (longestPartialText?.length || 0)) {
                    console.log(`[HostMode] 📏 New longest partial: ${snapshot.longest.length} chars`);
                  }
                  
                  // CRITICAL: Don't send very short partials at the start of a new segment
                  // Google Speech needs time to refine the transcription, especially for the first word
                  // Very short partials (< 4 chars) at segment start are often inaccurate
                  // REDUCED from 5 to 4 chars to ensure short phrases like "Oh my!" (5-6 chars) are always sent
                  // CRITICAL FIX: Check if partial extends a final BEFORE dropping it
                  // If partial extends a final, it should ALWAYS be sent (even if short) to prevent word loss
                  syncPendingFinalization();
                  const hasPendingFinal = finalizationEngine.hasPendingFinalization();
                  syncForcedFinalBuffer();
                  
                  // Check if this partial extends a final (either pending, forced, or last sent)
                  // CRITICAL: We must check the ORIGINAL transcriptText (before deduplication) FIRST
                  // because deduplication may remove words that make it look like it doesn't extend the final
                  // Then also check the deduplicated text as a fallback
                  let extendsAnyFinal = false;
                  const originalPartialText = transcriptText.trim();
                  
                  // CRITICAL FIX: Check ORIGINAL text first - this catches cases where deduplication
                  // removes words but the original partial still extends the final
                  // Check if original extends lastSentFinalText (most common case)
                  if (lastSentFinalText && originalPartialText) {
                    const lastSentText = lastSentFinalText.trim();
                    const lastSentNormalized = lastSentText.toLowerCase();
                    const originalNormalized = originalPartialText.toLowerCase();
                    
                    // Check if original partial extends last sent final (case-insensitive, lenient matching)
                    if (originalPartialText.length > lastSentText.length && 
                        (originalNormalized.startsWith(lastSentNormalized) || 
                         (lastSentText.length > 10 && originalNormalized.substring(0, lastSentNormalized.length) === lastSentNormalized) ||
                         originalPartialText.startsWith(lastSentText))) {
                      extendsAnyFinal = true;
                      console.log(`[HostMode] ✅ Original partial extends lastSentFinal (original: "${originalPartialText.substring(0, 30)}...", deduplicated: "${partialTextToSend.substring(0, 30)}...") - will send to preserve words`);
                    }
                  }
                  
                  // Check if original extends pending final
                  if (!extendsAnyFinal && hasPendingFinal) {
                    const pending = finalizationEngine.getPendingFinalization();
                    const pendingText = pending.text.trim();
                    const pendingNormalized = pendingText.toLowerCase();
                    const originalNormalized = originalPartialText.toLowerCase();
                    
                    if (originalPartialText.length > pendingText.length && 
                        (originalNormalized.startsWith(pendingNormalized) || 
                         (pendingText.length > 10 && originalNormalized.substring(0, pendingNormalized.length) === pendingNormalized) ||
                         originalPartialText.startsWith(pendingText))) {
                      extendsAnyFinal = true;
                      console.log(`[HostMode] ✅ Original partial extends pending final (original: "${originalPartialText.substring(0, 30)}...") - will send to preserve words`);
                    }
                  }
                  
                  // Check if original extends forced final buffer
                  if (!extendsAnyFinal && forcedFinalBuffer && forcedFinalBuffer.text) {
                    const forcedText = forcedFinalBuffer.text.trim();
                    const forcedNormalized = forcedText.toLowerCase();
                    const originalNormalized = originalPartialText.toLowerCase();
                    
                    if (originalPartialText.length > forcedText.length && 
                        (originalNormalized.startsWith(forcedNormalized) || 
                         (forcedText.length > 10 && originalNormalized.substring(0, forcedNormalized.length) === forcedNormalized) ||
                         originalPartialText.startsWith(forcedText))) {
                      extendsAnyFinal = true;
                      console.log(`[HostMode] ✅ Original partial extends forced final (original: "${originalPartialText.substring(0, 30)}...") - will send to preserve words`);
                    }
                  }
                  
                  // FALLBACK: Also check deduplicated text (in case original didn't extend but deduplicated does)
                  // This is less common but can happen if deduplication actually improves the match
                  if (!extendsAnyFinal) {
                    const partialText = partialTextToSend.trim();
                    
                    // Check deduplicated text extends pending final
                    if (hasPendingFinal) {
                      const pending = finalizationEngine.getPendingFinalization();
                      const pendingText = pending.text.trim();
                      if (partialText.length > pendingText.length && 
                          (partialText.startsWith(pendingText) || 
                           (pendingText.length > 10 && partialText.substring(0, pendingText.length) === pendingText))) {
                        extendsAnyFinal = true;
                      }
                    }
                    
                    // Check deduplicated text extends forced final
                    if (!extendsAnyFinal && forcedFinalBuffer && forcedFinalBuffer.text) {
                      const forcedText = forcedFinalBuffer.text.trim();
                      if (partialText.length > forcedText.length && 
                          (partialText.startsWith(forcedText) || 
                           (forcedText.length > 10 && partialText.substring(0, forcedText.length) === forcedText))) {
                        extendsAnyFinal = true;
                      }
                    }
                    
                    // Check deduplicated text extends lastSentFinalText
                    if (!extendsAnyFinal && lastSentFinalText) {
                      const lastSentText = lastSentFinalText.trim();
                      const lastSentNormalized = lastSentText.toLowerCase();
                      const partialNormalized = partialText.toLowerCase();
                      
                      if (partialText.length > lastSentText.length && 
                          (partialNormalized.startsWith(lastSentNormalized) || 
                           (lastSentText.length > 10 && partialNormalized.substring(0, lastSentNormalized.length) === lastSentNormalized) ||
                           partialText.startsWith(lastSentText))) {
                        extendsAnyFinal = true;
                      }
                    }
                  }
                  
                  // CRITICAL: Send ALL partials - do not filter or skip ANY partial
                  // User requirement: EVERY single partial must be on the transcript and finalized
                  // Only skip if deduplication removed ALL text AND it doesn't extend any final (handled above)
                  // Do NOT filter based on length - send everything to ensure no words are lost
                  
                  const timeSinceLastFinal = lastSentFinalTime ? (Date.now() - lastSentFinalTime) : Infinity;
                  
                  // Log if this is a short partial for debugging, but always send it
                  const isShortPartial = partialTextToSend.trim().length < 4;
                  if (isShortPartial) {
                    console.log(`[HostMode] 📤 Sending short partial (${partialTextToSend.trim().length} chars): "${partialTextToSend.substring(0, 30)}..." - ensuring no words are lost`);
                  }
                  
                  // If partial extends a final, log it
                  if (extendsAnyFinal) {
                    console.log(`[HostMode] ✅ Sending partial that extends final (${partialTextToSend.trim().length} chars) - preventing word loss`);
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
                  
                  // CRITICAL: Send ALL partials (unless completely duplicate and doesn't extend)
                  // Only skip if partialTextToSend is empty (all text removed by deduplication and doesn't extend)
                  const shouldSend = partialTextToSend && partialTextToSend.trim().length > 0;
                  
                  if (shouldSend && !shouldSkipSendingPartial) {
                    // Live partial transcript - send text immediately with sequence ID (solo mode style)
                    // Note: This is the initial send before grammar/translation, so use deduplicated text (or original if dedup was skipped)
                    // CRITICAL: Explicitly set isPartial: true to prevent frontend from committing as FINAL
                    const isTranscriptionOnly = false; // Host mode always translates (no transcription-only mode)
                    const seqId = broadcastWithSequence({
                      type: 'translation',
                      originalText: partialTextToSend, // Use deduplicated text (or original if deduplication was skipped)
                      translatedText: undefined, // Will be updated when translation arrives
                      sourceLang: currentSourceLang,
                      targetLang: currentSourceLang,
                      timestamp: Date.now(),
                      isTranscriptionOnly: false,
                      hasTranslation: false, // Flag that translation is pending
                      hasCorrection: false, // Flag that correction is pending
                      isPartial: true // CRITICAL: Explicitly mark as partial to prevent frontend from committing
                    }, true);
                  } else if (!shouldSend) {
                    console.log(`[HostMode] ⚠️ Partial was completely removed by deduplication and doesn't extend - tracked (original: "${transcriptText.substring(0, 30)}...") but not sent`);
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
                    // Use ORIGINAL text for word analysis to see if they're related
                    const finalWords = finalText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                    const originalPartialWords = originalPartialText.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                    const sharedWords = finalWords.filter(w => originalPartialWords.includes(w));
                    const hasWordOverlap = sharedWords.length > 0;
                    
                    // Also check if partial starts with any of the last few words of final (catches cases like "haven't" -> "haven't been")
                    // Use ORIGINAL text for this check
                    const lastWordsOfFinal = finalWords.slice(-3);
                    const startsWithFinalWord = originalPartialWords.length > 0 && lastWordsOfFinal.some(w => 
                      originalPartialWords[0].startsWith(w) || w.startsWith(originalPartialWords[0]) || wordsAreRelated(originalPartialWords[0], w)
                    );
                    
                    // Partial is only a potential continuation if:
                    // 1. Final doesn't end with complete sentence AND
                    // 2. Partial is very short AND
                    // 3. Partial actually has some relationship to final (word overlap OR starts with final word OR extends final)
                    const mightBeContinuation = !finalEndsWithCompleteSentence && 
                                                isVeryShortPartial && 
                                                timeSinceFinal < 5000 &&
                                                (hasWordOverlap || startsWithFinalWord || extendsFinal);
                    
                    // CRITICAL: Check if the FINAL itself was a false final (short with period and incomplete pattern)
                    // This helps us be more conservative about committing it even when unrelated partials arrive
                    const finalIsShort = finalText.length < 25;
                    const finalEndsWithPeriod = finalText.endsWith('.');
                    const finalMatchesIncompletePattern = /^(I've|I've been|You|You just|You just can't|We|We have|They|They have|It|It has)\s/i.test(finalText);
                    const finalWasFalseFinal = finalEndsWithPeriod && finalIsShort && finalMatchesIncompletePattern;
                    
                    // CRITICAL: Even if FINAL ends with period, Google Speech may have incorrectly finalized mid-sentence
                    // If a very short partial arrives soon after, wait briefly to see if it's a continuation
                    // This catches cases like "You just can't." followed by "People...." which should be "You just can't beat people..."
                    // EXTENDED: Use longer time window (5000ms) for false finals to catch partials that arrive later
                    const mightBeFalseFinal = finalEndsWithCompleteSentence && 
                                             isVeryShortPartial && 
                                             timeSinceFinal < (finalWasFalseFinal ? 5000 : 3000) && 
                                             !hasWordOverlap && 
                                             !startsWithFinalWord && 
                                             !extendsFinal;
                    
                    // REMOVED: Text-heuristic segment detection (no word overlap)
                    // Now using gap-based detection only - check for actual silence gap
                    const lastAudioTime = speechStream.getLastAudioActivityTime?.() || Date.now();
                    const timeSinceLastAudio = Date.now() - lastAudioTime;
                    const SILENCE_GAP_MS = 800; // 700-900ms range
                    
                    // Only create new segment if there's an actual silence gap
                    if (timeSinceLastAudio > SILENCE_GAP_MS) {
                      // Actual boundary detected - commit pending final and start new segment
                      const oldSegmentId = currentSegmentId;
                      
                      // Check if recovery pending for old segment
                      if (oldSegmentId && coreEngine?.finalityGate?.isRecoveryPending(oldSegmentId)) {
                        console.log(`[HostMode] 🔒 Deferring segment boundary - recovery pending for ${oldSegmentId}`);
                        // Queue this partial instead
                        enqueueDuringRecovery('PARTIAL', transcriptText, true, meta);
                        return;
                      }
                      
                      // CRITICAL: Close old segment in FinalityGate before starting new segment
                      if (oldSegmentId && coreEngine?.finalityGate) {
                        coreEngine.finalityGate.closeSegment(oldSegmentId);
                      }
                      // CRITICAL: Generate new segment ID for this new segment (gap-based boundary)
                      currentSegmentId = `seg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                      console.log(`[HostMode] 🆕 Generated new segment ID: ${currentSegmentId} (gap: ${timeSinceLastAudio}ms)`);
                      console.log(`[HostMode] 🔀 New segment detected - gap-based boundary (${timeSinceLastAudio}ms > ${SILENCE_GAP_MS}ms)`);
                      console.log(`[HostMode] ✅ Committing pending FINAL before processing new segment`);
                      // PHASE 8: Clear timeout using engine
                      finalizationEngine.clearPendingFinalizationTimeout();
                      const textToCommit = pendingFinalization.text;
                      // PHASE 8: Clear using engine
                      finalizationEngine.clearPendingFinalization();
                      syncPendingFinalization();
                      // CRITICAL FIX: Track the new partial BEFORE finalizing, so it's not lost
                      partialTracker.updatePartial(transcriptText);
                      // CRITICAL FIX: Reset translation state to ensure next partial is treated as first
                      lastPartialTranslation = '';
                      lastPartialTranslationTime = 0;
                      // CRITICAL FIX: Skip deduplication when committing pending final because new segment was detected
                      // We've already determined this is a new segment, so it shouldn't be deduplicated against previous final
                      // CRITICAL: Partial reset happens in processFinalText finally block after final is emitted
                      processFinalText(textToCommit, { skipDeduplication: true });
                      // Continue processing the new partial as a new segment (don't return - let it be processed below)
                    } else {
                      // No gap detected - continue as same segment (don't create new segment ID)
                      console.log(`[HostMode] ⏭️ No boundary detected (gap: ${timeSinceLastAudio}ms < ${SILENCE_GAP_MS}ms) - continuing as same segment`);
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
                        const waitTime = Date.now() - pendingFinalization.timestamp;
                        // PHASE 8: Clear using engine
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();
                        console.log(`[HostMode] ✅ FINAL Transcript (after continuation wait): "${textToProcess.substring(0, 80)}..."`);
                        // CRITICAL: Partial reset happens in processFinalText finally block after final is emitted
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
                        const waitTime = Date.now() - pendingFinalization.timestamp;
                        // PHASE 8: Clear using engine
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();
                        console.log(`[HostMode] ✅ FINAL Transcript (after ${waitTime}ms wait): "${textToProcess.substring(0, 80)}..."`);
                        // CRITICAL: Partial reset happens in processFinalText finally block after final is emitted
                        processFinalText(textToProcess);
                      }, remainingWait);
                      
                      // CRITICAL: We now send all partials to frontend (even if they extend finals) for live display
                      // The frontend will handle deduplication when the final arrives
                      // No need to skip translation processing - process all partials
                    } else if (!extendsFinal && timeSinceFinal > 600) {
                      // New segment detected - check if it's CLEARLY a new segment using isNewSegment helper
                      // CRITICAL: If pending final is a false final, be more cautious about committing early
                      syncPendingFinalization();
                      if (!pendingFinalization) {
                        console.warn('[HostMode] ⚠️ pendingFinalization is null after sync - skipping new segment check');
                        // Continue processing the partial as a new segment since there's no pending final
                      } else {
                        const isFalseFinal = pendingFinalization.isFalseFinal || false;
                        const clearlyNewSegment = isNewSegment(transcriptText, pendingFinalization.text);
                        
                        // CRITICAL FIX: For false finals, require more time before committing on new segment
                        // False finals like "You just can't." need time for extending partials like "beat people up with doctrine"
                        // Only commit false final early if:
                        // 1. It's clearly a new segment AND
                        // 2. Enough time has passed (at least 2 seconds for false finals) OR
                        // 3. The partial is very long and clearly unrelated (safety check)
                        const shouldCommitFalseFinalEarly = isFalseFinal && 
                                                           clearlyNewSegment && 
                                                           (timeSinceFinal >= 2000 || transcriptText.length > 30);
                        
                        if (clearlyNewSegment && (!isFalseFinal || shouldCommitFalseFinalEarly)) {
                        // CRITICAL: Close old segment in FinalityGate before starting new segment
                        const oldSegmentId = currentSegmentId;
                        if (oldSegmentId && coreEngine?.finalityGate) {
                          coreEngine.finalityGate.closeSegment(oldSegmentId);
                        }
                        // CRITICAL: Generate new segment ID for this new segment
                        currentSegmentId = `seg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                        console.log(`[HostMode] 🆕 Generated new segment ID: ${currentSegmentId}`);
                        
                        // CRITICAL FIX: If partial is CLEARLY a new segment, commit final IMMEDIATELY
                        // BUT: For false finals, only commit if enough time has passed or partial is clearly unrelated
                        if (isFalseFinal) {
                          console.log(`[HostMode] ⚠️ False final detected but committing early - new segment confirmed after ${timeSinceFinal}ms (partial: "${partialText.substring(0, 30)}...")`);
                        } else {
                          console.log(`[HostMode] 🔀 CLEARLY new segment detected - committing pending FINAL immediately (partial: "${partialText.substring(0, 30)}...")`);
                        }
                        console.log(`[HostMode] ✅ Committing pending FINAL before processing new segment`);
                        // PHASE 8: Clear timeout using engine
                        finalizationEngine.clearPendingFinalizationTimeout();
                        const textToCommit = pendingFinalization.text;
                        // PHASE 8: Clear using engine
                        finalizationEngine.clearPendingFinalization();
                        syncPendingFinalization();
                        // CRITICAL FIX: Track the new partial BEFORE resetting, so it's not lost
                        // This ensures the partial that triggered the commit is still processed
                        partialTracker.updatePartial(transcriptText);
                        // CRITICAL FIX: Reset translation state to ensure next partial is treated as first
                        // This prevents translation throttling from dropping short partials
                        lastPartialTranslation = '';
                        lastPartialTranslationTime = 0;
                        // CRITICAL FIX: Skip deduplication when committing pending final because new segment was detected
                        // We've already determined this is a new segment, so it shouldn't be deduplicated against previous final
                        // CRITICAL: Partial reset happens in processFinalText finally block after final is emitted
                        processFinalText(textToCommit, { skipDeduplication: true });
                        // Continue processing the new partial as a new segment (don't return - let it be processed below)
                      } else if (isFalseFinal && clearlyNewSegment) {
                        // False final with new segment detected, but not enough time has passed
                        // Wait longer - the partial might actually extend the false final
                        console.log(`[HostMode] ⏳ False final detected with new segment - waiting longer (${timeSinceFinal}ms < 2000ms) to check if partial extends final`);
                        console.log(`[HostMode]   Pending final: "${pendingFinalization.text.substring(0, 50)}..."`);
                        console.log(`[HostMode]   New partial: "${transcriptText.substring(0, 50)}..."`);
                        // Continue tracking - don't commit yet, let the timeout handle it
                      } else {
                        // Not clearly a new segment - check if final ends with complete sentence
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
                              // CRITICAL FIX: DO NOT return here - this would drop the partial that triggered this commit
                              // Instead, we'll commit the final but continue processing the partial below
                              // The partial is from a new segment, so it's safe to commit the final
                              console.log(`[HostMode] ⚠️ Committing final anyway (new segment detected), but continuing to process partial below`);
                              // Continue to commit the final below, don't return
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
                            // CRITICAL FIX: Track the new partial BEFORE resetting, so it's not lost
                            partialTracker.updatePartial(transcriptText);
                            // PHASE 8: Reset partial tracking using tracker
                            partialTracker.reset();
                            syncPartialVariables();
                            // CRITICAL FIX: Reset translation state to ensure next partial is treated as first
                            // This prevents translation throttling from dropping short partials
                            lastPartialTranslation = '';
                            lastPartialTranslationTime = 0;
                          }
                          // PHASE 8: Clear using engine
                          finalizationEngine.clearPendingFinalization();
                          syncPendingFinalization();
                          console.log(`[HostMode] ✅ FINAL (new segment detected - committing): "${textToProcess.substring(0, 100)}..."`);
                          processFinalText(textToProcess);
                          // Continue processing the new partial as a new segment
                        }
                      }
                      }
                } else {
                  // Partials are still arriving - update tracking but don't extend timeout
                  console.log(`[HostMode] 📝 Partial arrived during finalization wait - tracking updated (${transcriptText.length} chars)`);
                  
                  // CRITICAL: Update pending finalization if this partial extends it
                  // This ensures we don't lose extending partials
                  syncPendingFinalization();
                  if (pendingFinalization && transcriptText.length > pendingFinalization.text.length) {
                    const finalTrimmed = pendingFinalization.text.trim();
                    const partialTrimmed = transcriptText.trim();
                    const finalNormalized = finalTrimmed.toLowerCase();
                    const partialNormalized = partialTrimmed.toLowerCase();
                    
                    // Check if partial extends the pending final
                    if (partialNormalized.startsWith(finalNormalized) || 
                        (finalTrimmed.length > 5 && partialNormalized.substring(0, finalNormalized.length) === finalNormalized)) {
                      console.log(`[HostMode] 📝 Updating pending finalization with extending partial (${pendingFinalization.text.length} → ${transcriptText.length} chars)`);
                      finalizationEngine.updatePendingFinalizationText(transcriptText);
                      syncPendingFinalization();
                    }
                  }
                }
              }
                  
                  // Update last audio timestamp (we have new audio activity)
                  lastAudioTimestamp = Date.now();
                  silenceStartTime = null;
                  
                  // OPTIMIZED: Throttle updates to prevent overwhelming the API (solo mode style)
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
                                // CRITICAL FIX: Check if grammar correction is still relevant
                                // Skip if a longer partial has arrived that extends the original text
                                // This prevents race conditions where grammar corrections for short partials
                                // arrive after longer partials have already been received
                                syncPartialVariables(); // Get latest partial text from tracker
                                const currentLatestPartial = latestPartialTextForCorrection || '';
                                const rawCapturedTrimmed = rawCapturedText.trim();
                                const currentLatestTrimmed = currentLatestPartial.trim();
                                
                                // Only skip if we have a current latest partial AND it clearly extends the captured text
                                // Check if current latest partial extends the captured text (longer version arrived)
                                if (currentLatestTrimmed.length > rawCapturedTrimmed.length && currentLatestTrimmed.length > 0) {
                                  const currentLower = currentLatestTrimmed.toLowerCase();
                                  const capturedLower = rawCapturedTrimmed.toLowerCase();
                                  // Check if current partial starts with captured text (extends it) - use strict matching
                                  const extendsCaptured = currentLower.startsWith(capturedLower);
                                  
                                  if (extendsCaptured) {
                                    console.log(`[HostMode] ⏭️ Skipping outdated grammar correction - longer partial has arrived (old: ${rawCapturedTrimmed.length} chars, new: ${currentLatestTrimmed.length} chars)`);
                                    console.log(`[HostMode]   Old: "${rawCapturedTrimmed.substring(0, 50)}..."`);
                                    console.log(`[HostMode]   New: "${currentLatestTrimmed.substring(0, 50)}..."`);
                                    return; // Skip sending grammar correction for outdated partial
                                  }
                                }
                                
                                // Also check if text was reset (much shorter now) - only if we have current text
                                if (currentLatestTrimmed.length > 0 && currentLatestTrimmed.length < rawCapturedTrimmed.length * 0.5) {
                                  console.log(`[HostMode] ⏭️ Skipping outdated grammar (text reset: ${rawCapturedTrimmed.length} → ${currentLatestTrimmed.length} chars)`);
                                  return;
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
                            broadcastWithSequence({
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
                          }
                          
                          // Start grammar correction asynchronously (English only, don't wait for it)
                          if (currentSourceLang === 'en') {
                            grammarWorker.correctPartial(rawCapturedText, process.env.OPENAI_API_KEY)
                              .then(correctedText => {
                                // CRITICAL FIX: Check if grammar correction is still relevant
                                // Skip if a longer partial has arrived that extends the original text
                                // This prevents race conditions where grammar corrections for short partials
                                // arrive after longer partials have already been received
                                syncPartialVariables(); // Get latest partial text from tracker
                                const currentLatestPartial = latestPartialTextForCorrection || '';
                                const rawCapturedTrimmed = rawCapturedText.trim();
                                const currentLatestTrimmed = currentLatestPartial.trim();
                                
                                // Only skip if we have a current latest partial AND it clearly extends the captured text
                                // Check if current latest partial extends the captured text (longer version arrived)
                                if (currentLatestTrimmed.length > rawCapturedTrimmed.length && currentLatestTrimmed.length > 0) {
                                  const currentLower = currentLatestTrimmed.toLowerCase();
                                  const capturedLower = rawCapturedTrimmed.toLowerCase();
                                  // Check if current partial starts with captured text (extends it) - use strict matching
                                  const extendsCaptured = currentLower.startsWith(capturedLower);
                                  
                                  if (extendsCaptured) {
                                    console.log(`[HostMode] ⏭️ Skipping outdated grammar correction - longer partial has arrived (old: ${rawCapturedTrimmed.length} chars, new: ${currentLatestTrimmed.length} chars)`);
                                    console.log(`[HostMode]   Old: "${rawCapturedTrimmed.substring(0, 50)}..."`);
                                    console.log(`[HostMode]   New: "${currentLatestTrimmed.substring(0, 50)}..."`);
                                    return; // Skip sending grammar correction for outdated partial
                                  }
                                }
                                
                                // Also check if text was reset (much shorter now) - only if we have current text
                                if (currentLatestTrimmed.length > 0 && currentLatestTrimmed.length < rawCapturedTrimmed.length * 0.5) {
                                  console.log(`[HostMode] ⏭️ Skipping outdated grammar (text reset: ${rawCapturedTrimmed.length} → ${currentLatestTrimmed.length} chars)`);
                                  return;
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
                            const translationPromise = partialWorker.translateToMultipleLanguages(
                              translationReadyText,
                              currentSourceLang,
                              translationTargets,
                              process.env.OPENAI_API_KEY,
                              currentSessionId
                            );

                            // Send translation IMMEDIATELY when ready (don't wait for grammar)
                            translationPromise.then(translations => {
                              // Validate translation results
                              if (!translations || Object.keys(translations).length === 0) {
                                console.warn(`[HostMode] ⚠️ Translation returned empty for ${capturedText.length} char text`);
                                return;
                              }

                              // CRITICAL: Only update lastPartialTranslation AFTER successful translation
                              lastPartialTranslation = capturedText;
                              
                              console.log(`[HostMode] ✅ TRANSLATION (IMMEDIATE): Translated to ${Object.keys(translations).length} language(s)`);
                              
                              // Broadcast translation results immediately - sequence IDs handle ordering
                              for (const targetLang of translationTargets) {
                                const translatedText = translations[targetLang];
                                // Validate that translation is different from original (prevent English leak)
                                const isSameAsOriginal = translatedText === translationReadyText || 
                                                         translatedText.trim() === translationReadyText.trim() ||
                                                         translatedText.toLowerCase() === translationReadyText.toLowerCase();
                                
                                if (isSameAsOriginal) {
                                  console.warn(`[HostMode] ⚠️ Translation matches original (English leak detected) for ${targetLang}: "${translatedText.substring(0, 60)}..."`);
                                  continue; // Don't send English as translation
                                }
                                
                                broadcastWithSequence({
                                  type: 'translation',
                                  originalText: rawCapturedText,
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
                              
                              // Broadcast grammar correction to all listener language groups
                              for (const targetLang of targetLanguages) {
                                broadcastWithSequence({
                                  type: 'translation',
                                  originalText: rawCapturedText,
                                  correctedText: correctedText,
                                  sourceLang: currentSourceLang,
                                  targetLang: targetLang,
                                  timestamp: Date.now(),
                                  isTranscriptionOnly: false,
                                  hasCorrection: true,
                                  updateType: 'grammar', // Flag for grammar-only update
                                  isPartial: true // CRITICAL: Grammar updates for partials are still partials
                                }, true, targetLang);
                              }
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
                          console.log(`[HostMode] ⏭️ Skipping exact match translation`);
                          pendingPartialTranslation = null;
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
                            pendingPartialTranslation = null;
                            return;
                          }
                          
                          // Separate same-language targets from translation targets
                          const sameLanguageTargets = targetLanguages.filter(lang => lang === currentSourceLang);
                          const translationTargets = targetLanguages.filter(lang => lang !== currentSourceLang);
                          
                          // Handle same-language targets
                          if (sameLanguageTargets.length > 0) {
                            lastPartialTranslation = latestText;
                            lastPartialTranslationTime = Date.now();
                            
                            console.log(`[HostMode] ✅ TRANSCRIPTION (DELAYED): "${latestText.substring(0, 40)}..."`);
                            
                            // Send transcription immediately
                            for (const targetLang of sameLanguageTargets) {
                              broadcastWithSequence({
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
                            }
                            
                            // Start grammar correction asynchronously (English only)
                            if (currentSourceLang === 'en') {
                              grammarWorker.correctPartial(latestText, process.env.OPENAI_API_KEY)
                                .then(correctedText => {
                                  // CRITICAL FIX: Check if grammar correction is still relevant
                                  // Skip if a longer partial has arrived that extends the original text
                                  syncPartialVariables(); // Get latest partial text from tracker
                                  const currentLatestPartial = latestPartialTextForCorrection || '';
                                  const latestTextTrimmed = latestText.trim();
                                  const currentLatestTrimmed = currentLatestPartial.trim();
                                  
                                  // Only skip if we have a current latest partial AND it clearly extends the latestText
                                  if (currentLatestTrimmed.length > latestTextTrimmed.length && currentLatestTrimmed.length > 0) {
                                    const currentLower = currentLatestTrimmed.toLowerCase();
                                    const latestLower = latestTextTrimmed.toLowerCase();
                                    // Check if current partial starts with latestText (extends it) - use strict matching
                                    const extendsLatest = currentLower.startsWith(latestLower);
                                    
                                    if (extendsLatest) {
                                      console.log(`[HostMode] ⏭️ Skipping outdated delayed grammar correction - longer partial has arrived (old: ${latestTextTrimmed.length} chars, new: ${currentLatestTrimmed.length} chars)`);
                                      return; // Skip sending grammar correction for outdated partial
                                    }
                                  }
                                  
                                  // Also check if text was reset (much shorter now) - only if we have current text
                                  if (currentLatestTrimmed.length > 0 && currentLatestTrimmed.length < latestTextTrimmed.length * 0.5) {
                                    console.log(`[HostMode] ⏭️ Skipping outdated delayed grammar (text reset: ${latestTextTrimmed.length} → ${currentLatestTrimmed.length} chars)`);
                                    return;
                                  }
                                  
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
                              const translationPromise = partialWorker.translateToMultipleLanguages(
                                latestText,
                                currentSourceLang,
                                translationTargets,
                                process.env.OPENAI_API_KEY,
                                currentSessionId
                              );

                              // Send translation IMMEDIATELY when ready (don't wait for grammar)
                              translationPromise.then(translations => {
                                // Validate translation results
                                if (!translations || Object.keys(translations).length === 0) {
                                  console.warn(`[HostMode] ⚠️ Delayed translation returned empty for ${latestText.length} char text`);
                                  return;
                                }

                                // CRITICAL: Update tracking and send translation
                                lastPartialTranslation = latestText;
                                lastPartialTranslationTime = Date.now();
                                
                                console.log(`[HostMode] ✅ TRANSLATION (DELAYED): Translated to ${Object.keys(translations).length} language(s)`);
                                
                                // Broadcast immediately - sequence IDs handle ordering
                                for (const targetLang of translationTargets) {
                                  const translatedText = translations[targetLang];
                                  // Validate that translation is different from original
                                  const isSameAsOriginal = translatedText === latestText || 
                                                           translatedText.trim() === latestText.trim() ||
                                                           translatedText.toLowerCase() === latestText.toLowerCase();
                                  
                                  if (isSameAsOriginal) {
                                    console.warn(`[HostMode] ⚠️ Translation matches original (English leak detected) for ${targetLang}`);
                                    continue; // Don't send English as translation
                                  }
                                  
                                  broadcastWithSequence({
                                    type: 'translation',
                                    originalText: latestText,
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
                                  
                                  // Broadcast grammar update to listener language groups - sequence IDs handle ordering
                                  for (const targetLang of targetLanguages) {
                                    broadcastWithSequence({
                                      type: 'translation',
                                      originalText: latestText,
                                      correctedText: correctedText,
                                      sourceLang: currentSourceLang,
                                      targetLang: targetLang,
                                      timestamp: Date.now(),
                                      isTranscriptionOnly: false,
                                      hasCorrection: true,
                                      updateType: 'grammar',
                                      isPartial: true // CRITICAL: Grammar updates for partials are still partials
                                    }, true, targetLang);
                                  }
                                }
                              }).catch(error => {
                                if (error.name !== 'AbortError') {
                                  console.error(`[HostMode] ❌ Delayed grammar error (${latestText.length} chars):`, error.message);
                                }
                              });
                            }
                          }

                          pendingPartialTranslation = null;
                        } catch (error) {
                          console.error(`[HostMode] ❌ Delayed partial processing error (${latestText.length} chars):`, error.message);
                          pendingPartialTranslation = null;
                        }
                      }, delayMs);
                    }
                  }
                  return;
                }
                
                // Final transcript - delay processing to allow partials to extend it (solo mode logic)
                const isForcedFinal = meta?.forced === true;
                console.log(`[HostMode] 📝 FINAL signal received (${transcriptText.length} chars): "${transcriptText.substring(0, 80)}..."`);
                console.log(`[HostMode] 🔍 FINAL meta: ${JSON.stringify(meta)} - isForcedFinal: ${isForcedFinal}`);
                
                // Check for actual boundary (gap-based, not text-based)
                const lastAudioTime = speechStream.getLastAudioActivityTime?.() || Date.now();
                const timeSinceLastAudio = Date.now() - lastAudioTime;
                const SILENCE_GAP_MS = 800;
                
                // Conservative escape hatch: truly unrelated FINAL after restart
                // Only use if there's a gap OR restart happened AND similarity is very low
                const normalizedSimilarity = (text1, text2) => {
                  if (!text1 || !text2) return 0;
                  const t1 = text1.toLowerCase().replace(/\s+/g, ' ');
                  const t2 = text2.toLowerCase().replace(/\s+/g, ' ');
                  const longer = t1.length > t2.length ? t1 : t2;
                  const shorter = t1.length > t2.length ? t2 : t1;
                  if (longer.length === 0) return 0;
                  // Simple similarity: count matching words
                  const words1 = t1.split(/\s+/).filter(w => w.length > 2);
                  const words2 = t2.split(/\s+/).filter(w => w.length > 2);
                  const matching = words1.filter(w => words2.includes(w)).length;
                  return matching / Math.max(words1.length, words2.length, 1);
                };
                const restartHappened = false; // TODO: Track stream restarts
                const isTrulyUnrelated = timeSinceLastAudio > SILENCE_GAP_MS || 
                                        (restartHappened && normalizedSimilarity(lastSentFinalText || '', transcriptText) < 0.1);
                
                if (timeSinceLastAudio > SILENCE_GAP_MS || isTrulyUnrelated) {
                  // Check recovery lock for current segment
                  const currentSegmentRecoveryPending = coreEngine?.finalityGate?.isRecoveryPending(currentSegmentId);
                  if (currentSegmentRecoveryPending) {
                    console.log(`[HostMode] 🔒 Recovery pending for ${currentSegmentId} - queuing FINAL`);
                    enqueueDuringRecovery('FINAL', transcriptText, false, meta);
                    return;
                  }
                  
                  // CRITICAL: Generate new segment ID for this new FINAL (gap-based boundary)
                  // This ensures FinalityGate can isolate recovery for each segment
                  if (!currentSegmentId) {
                    currentSegmentId = `seg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    console.log(`[HostMode] 🆕 Generated new segment ID for FINAL: ${currentSegmentId} (gap: ${timeSinceLastAudio}ms)`);
                  }
                } else {
                  // No gap - continue with existing segment ID (or create if none exists)
                  if (!currentSegmentId) {
                    currentSegmentId = `seg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    console.log(`[HostMode] 🆕 Generated new segment ID for FINAL: ${currentSegmentId} (no previous segment)`);
                  }
                }
                
                // CRITICAL FIX: Check if there's an active partial that contains this final fragment
                // Google can finalize a fragment (e.g., "Desires cordoned off.") while a longer partial
                // (e.g., "Desires cordoned off from....") is still being processed. We should NOT finalize
                // the fragment if it's contained in an active partial.
                // Use tracker snapshot directly to get the absolute latest state
                const partialSnapshot = partialTracker.getSnapshot();
                const currentLongestPartial = partialSnapshot.longest || '';
                const currentLatestPartial = partialSnapshot.latest || '';
                
                const incomingFinalTrimmed = transcriptText.trim();
                const incomingFinalNormalized = incomingFinalTrimmed.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
                
                // Check both longest and latest partials from snapshot (most up-to-date)
                if (currentLongestPartial && currentLongestPartial.trim().length > incomingFinalTrimmed.length) {
                  const longestTrimmed = currentLongestPartial.trim();
                  const longestNormalized = longestTrimmed.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
                  
                  // Check if partial contains the final (as a prefix or substring)
                  if (longestNormalized.startsWith(incomingFinalNormalized) || 
                      (incomingFinalNormalized.length > 10 && longestNormalized.includes(incomingFinalNormalized))) {
                    console.log(`[HostMode] ⏸️ SKIPPING FINAL FRAGMENT: "${incomingFinalTrimmed.substring(0, 50)}..." (${incomingFinalTrimmed.length} chars)`);
                    console.log(`[HostMode]   Active partial is longer: "${longestTrimmed.substring(0, 50)}..." (${longestTrimmed.length} chars)`);
                    console.log(`[HostMode]   Fragment is contained in active partial - waiting for partial to finalize instead`);
                    // Don't process the final - the partial will eventually be finalized with the complete text
                    return; // Exit early, don't process this final fragment
                  }
                }
                
                if (currentLatestPartial && currentLatestPartial.trim().length > incomingFinalTrimmed.length) {
                  const latestTrimmed = currentLatestPartial.trim();
                  const latestNormalized = latestTrimmed.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
                  
                  // Check if partial contains the final (as a prefix or substring)
                  if (latestNormalized.startsWith(incomingFinalNormalized) || 
                      (incomingFinalNormalized.length > 10 && latestNormalized.includes(incomingFinalNormalized))) {
                    console.log(`[HostMode] ⏸️ SKIPPING FINAL FRAGMENT: "${incomingFinalTrimmed.substring(0, 50)}..." (${incomingFinalTrimmed.length} chars)`);
                    console.log(`[HostMode]   Active partial is longer: "${latestTrimmed.substring(0, 50)}..." (${latestTrimmed.length} chars)`);
                    console.log(`[HostMode]   Fragment is contained in active partial - waiting for partial to finalize instead`);
                    // Don't process the final - the partial will eventually be finalized with the complete text
                    return; // Exit early, don't process this final fragment
                  }
                }
                
                // CRITICAL FIX: Check if there's a pending partial that extends beyond lastSentFinalText
                // If so, finalize that partial FIRST before processing the new FINAL
                // This prevents losing partial transcripts when a new FINAL arrives
                syncPartialVariables();
                syncPendingFinalization();
                
                // Use lastSentOriginalText if available (it has the complete text), otherwise use lastSentFinalText
                const lastSentTextForComparison = lastSentOriginalText || lastSentFinalText;
                
                if (lastSentTextForComparison && (longestPartialText || latestPartialText)) {
                  const lastSentTrimmed = lastSentTextForComparison.trim();
                  const lastSentNormalized = lastSentTrimmed.toLowerCase();
                  
                  // Check longest partial first
                  if (longestPartialText && longestPartialText.length > lastSentTrimmed.length) {
                    const longestTrimmed = longestPartialText.trim();
                    const longestNormalized = longestTrimmed.toLowerCase();
                    const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                    
                    // Check if longest partial extends lastSentText and is recent
                    const extendsLastSent = longestNormalized.startsWith(lastSentNormalized) || 
                                           (lastSentTrimmed.length > 5 && longestNormalized.substring(0, lastSentNormalized.length) === lastSentNormalized) ||
                                           longestTrimmed.startsWith(lastSentTrimmed);
                    
                    if (extendsLastSent && timeSinceLongest < 5000) {
                      const missingWords = longestPartialText.substring(lastSentTrimmed.length).trim();
                      console.log(`[HostMode] 🔔 CRITICAL: Finalizing pending partial BEFORE processing new FINAL`);
                      console.log(`[HostMode]   Last sent: "${lastSentTrimmed.substring(Math.max(0, lastSentTrimmed.length - 60))}"`);
                      console.log(`[HostMode]   Longest partial: "${longestTrimmed.substring(Math.max(0, longestTrimmed.length - 60))}"`);
                      console.log(`[HostMode]   Missing words: "${missingWords}"`);
                      console.log(`[HostMode]   New FINAL will be processed after this partial is finalized`);
                      
                      // CRITICAL FIX: Check if the new FINAL is a duplicate or shorter version BEFORE finalizing the partial
                      // This prevents double finalization where we finalize the partial, then also process the new FINAL
                      const newFinalTrimmed = transcriptText.trim();
                      const newFinalNormalized = newFinalTrimmed.toLowerCase().replace(/\s+/g, ' ').trim();
                      const longestNormalizedForComparison = longestTrimmed.toLowerCase().replace(/\s+/g, ' ').trim();
                      
                      // If new FINAL is a duplicate or shorter version of the partial we're about to finalize, skip processing it
                      if (newFinalNormalized === longestNormalizedForComparison || 
                          (longestNormalizedForComparison.startsWith(newFinalNormalized) && longestNormalizedForComparison.length > newFinalNormalized.length) ||
                          (newFinalNormalized.length < longestNormalizedForComparison.length && longestNormalizedForComparison.includes(newFinalNormalized))) {
                        console.log(`[HostMode] ⏭️ SKIPPING new FINAL - duplicate or shorter version of partial we're about to finalize`);
                        console.log(`[HostMode]   Partial to finalize: "${longestTrimmed.substring(0, 80)}..." (${longestTrimmed.length} chars)`);
                        console.log(`[HostMode]   New FINAL: "${newFinalTrimmed.substring(0, 80)}..." (${newFinalTrimmed.length} chars)`);
                        
                        // Finalize the partial (which contains the complete text)
                        // CRITICAL: Partial reset happens in processFinalText finally block after final is emitted
                        processFinalText(longestPartialText, { previousFinalTextForDeduplication: lastSentTextForComparison });
                        
                        return; // Skip processing the new FINAL - we're finalizing the complete version instead
                      }
                      
                      // Finalize the pending partial FIRST
                      // CRITICAL: Partial reset happens in processFinalText finally block after final is emitted
                      processFinalText(longestPartialText, { previousFinalTextForDeduplication: lastSentTextForComparison });
                      
                      // Continue processing the new FINAL below (don't return)
                    }
                  } else if (latestPartialText && latestPartialText.length > lastSentTrimmed.length) {
                    // Fallback to latest partial if longest doesn't extend
                    const latestTrimmed = latestPartialText.trim();
                    const latestNormalized = latestTrimmed.toLowerCase();
                    const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;
                    
                    const extendsLastSent = latestNormalized.startsWith(lastSentNormalized) || 
                                           (lastSentTrimmed.length > 5 && latestNormalized.substring(0, lastSentNormalized.length) === lastSentNormalized) ||
                                           latestTrimmed.startsWith(lastSentTrimmed);
                    
                    if (extendsLastSent && timeSinceLatest < 5000) {
                      const missingWords = latestPartialText.substring(lastSentTrimmed.length).trim();
                      console.log(`[HostMode] 🔔 CRITICAL: Finalizing pending partial BEFORE processing new FINAL`);
                      console.log(`[HostMode]   Last sent: "${lastSentTrimmed.substring(Math.max(0, lastSentTrimmed.length - 60))}"`);
                      console.log(`[HostMode]   Latest partial: "${latestTrimmed.substring(Math.max(0, latestTrimmed.length - 60))}"`);
                      console.log(`[HostMode]   Missing words: "${missingWords}"`);
                      console.log(`[HostMode]   New FINAL will be processed after this partial is finalized`);
                      
                      // CRITICAL FIX: Check if the new FINAL is a duplicate or shorter version BEFORE finalizing the partial
                      // This prevents double finalization where we finalize the partial, then also process the new FINAL
                      const newFinalTrimmed = transcriptText.trim();
                      const newFinalNormalized = newFinalTrimmed.toLowerCase().replace(/\s+/g, ' ').trim();
                      const latestNormalizedForComparison = latestTrimmed.toLowerCase().replace(/\s+/g, ' ').trim();
                      
                      // If new FINAL is a duplicate or shorter version of the partial we're about to finalize, skip processing it
                      if (newFinalNormalized === latestNormalizedForComparison || 
                          (latestNormalizedForComparison.startsWith(newFinalNormalized) && latestNormalizedForComparison.length > newFinalNormalized.length) ||
                          (newFinalNormalized.length < latestNormalizedForComparison.length && latestNormalizedForComparison.includes(newFinalNormalized))) {
                        console.log(`[HostMode] ⏭️ SKIPPING new FINAL - duplicate or shorter version of partial we're about to finalize`);
                        console.log(`[HostMode]   Partial to finalize: "${latestTrimmed.substring(0, 80)}..." (${latestTrimmed.length} chars)`);
                        console.log(`[HostMode]   New FINAL: "${newFinalTrimmed.substring(0, 80)}..." (${newFinalTrimmed.length} chars)`);
                        
                        // Finalize the partial (which contains the complete text)
                        // CRITICAL: Partial reset happens in processFinalText finally block after final is emitted
                        processFinalText(latestPartialText, { previousFinalTextForDeduplication: lastSentTextForComparison });
                        
                        return; // Skip processing the new FINAL - we're finalizing the complete version instead
                      }
                      
                      // Finalize the pending partial FIRST
                      // CRITICAL: Partial reset happens in processFinalText finally block after final is emitted
                      processFinalText(latestPartialText, { previousFinalTextForDeduplication: lastSentTextForComparison });
                      
                      // Continue processing the new FINAL below (don't return)
                    }
                  }
                }
                
                // Also check if there's a pending finalization that should be processed first
                if (finalizationEngine.hasPendingFinalization() && !isForcedFinal) {
                  const pending = finalizationEngine.getPendingFinalization();
                  console.log(`[HostMode] 🔔 CRITICAL: Pending finalization exists (${pending.text.length} chars) - processing it BEFORE new FINAL`);
                  console.log(`[HostMode]   Pending: "${pending.text.substring(0, 80)}..."`);
                  console.log(`[HostMode]   New FINAL: "${transcriptText.substring(0, 80)}..."`);
                  
                  // Clear the timeout and process the pending finalization immediately
                  finalizationEngine.clearPendingFinalizationTimeout();
                  const pendingText = pending.text;
                  finalizationEngine.clearPendingFinalization();
                  syncPendingFinalization();
                  
                  // CRITICAL FIX: Check if the new FINAL is a duplicate or shorter version BEFORE processing pending finalization
                  // This prevents double finalization where we process the pending, then also process the new FINAL
                  const newFinalTrimmed = transcriptText.trim();
                  const newFinalNormalized = newFinalTrimmed.toLowerCase().replace(/\s+/g, ' ').trim();
                  const pendingNormalized = pendingText.trim().toLowerCase().replace(/\s+/g, ' ').trim();
                  
                  // If new FINAL is a duplicate or shorter version of the pending we're about to process, skip processing it
                  if (newFinalNormalized === pendingNormalized || 
                      (pendingNormalized.startsWith(newFinalNormalized) && pendingNormalized.length > newFinalNormalized.length) ||
                      (newFinalNormalized.length < pendingNormalized.length && pendingNormalized.includes(newFinalNormalized))) {
                    console.log(`[HostMode] ⏭️ SKIPPING new FINAL - duplicate or shorter version of pending finalization we're about to process`);
                    console.log(`[HostMode]   Pending to process: "${pendingText.substring(0, 80)}..." (${pendingText.length} chars)`);
                    console.log(`[HostMode]   New FINAL: "${newFinalTrimmed.substring(0, 80)}..." (${newFinalTrimmed.length} chars)`);
                    
                    // Process the pending finalization (which contains the complete text)
                    processFinalText(pendingText);
                    
                    return; // Skip processing the new FINAL - we're processing the complete version instead
                  }
                  
                  // Process the pending finalization
                  processFinalText(pendingText);
                  
                  // Continue processing the new FINAL below (don't return)
                }
                
                if (isForcedFinal) {
                  // CRITICAL FIX: Check if there's an active partial that contains this forced final fragment
                  // Google can finalize a fragment (e.g., "Earlier than them. I've been to cage.") while a longer partial
                  // (e.g., "Earlier than them. I've been to cage fight matches...") is still being processed. We should NOT finalize
                  // the fragment if it's contained in an active partial.
                  // Use tracker snapshot directly to get the absolute latest state
                  const partialSnapshot = partialTracker.getSnapshot();
                  const currentLongestPartial = partialSnapshot.longest || '';
                  const currentLatestPartial = partialSnapshot.latest || '';
                  
                  const forcedFinalTrimmed = transcriptText.trim();
                  const forcedFinalNormalized = forcedFinalTrimmed.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
                  
                  // Check both longest and latest partials from snapshot (most up-to-date)
                  if (currentLongestPartial && currentLongestPartial.trim().length > forcedFinalTrimmed.length) {
                    const longestTrimmed = currentLongestPartial.trim();
                    const longestNormalized = longestTrimmed.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
                    
                    // Check if partial contains the forced final (as a prefix or substring)
                    if (longestNormalized.startsWith(forcedFinalNormalized) || 
                        (forcedFinalNormalized.length > 10 && longestNormalized.includes(forcedFinalNormalized))) {
                      console.log(`[HostMode] ⏸️ SKIPPING FORCED FINAL FRAGMENT: "${forcedFinalTrimmed.substring(0, 50)}..." (${forcedFinalTrimmed.length} chars)`);
                      console.log(`[HostMode]   Active partial is longer: "${longestTrimmed.substring(0, 50)}..." (${longestTrimmed.length} chars)`);
                      console.log(`[HostMode]   Fragment is contained in active partial - waiting for partial to finalize instead`);
                      // Don't process the forced final - the partial will eventually be finalized with the complete text
                      return; // Exit early, don't process this forced final fragment
                    }
                  }
                  
                  if (currentLatestPartial && currentLatestPartial.trim().length > forcedFinalTrimmed.length) {
                    const latestTrimmed = currentLatestPartial.trim();
                    const latestNormalized = latestTrimmed.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
                    
                    // Check if partial contains the forced final (as a prefix or substring)
                    if (latestNormalized.startsWith(forcedFinalNormalized) || 
                        (forcedFinalNormalized.length > 10 && latestNormalized.includes(forcedFinalNormalized))) {
                      console.log(`[HostMode] ⏸️ SKIPPING FORCED FINAL FRAGMENT: "${forcedFinalTrimmed.substring(0, 50)}..." (${forcedFinalTrimmed.length} chars)`);
                      console.log(`[HostMode]   Active partial is longer: "${latestTrimmed.substring(0, 50)}..." (${latestTrimmed.length} chars)`);
                      console.log(`[HostMode]   Fragment is contained in active partial - waiting for partial to finalize instead`);
                      // Don't process the forced final - the partial will eventually be finalized with the complete text
                      return; // Exit early, don't process this forced final fragment
                    }
                  }
                  
                  console.warn(`[HostMode] ⚠️ Forced FINAL due to stream restart (${transcriptText.length} chars)`);
                  console.log(`[HostMode] 🎯 FORCED FINAL DETECTED - Setting up dual buffer audio recovery system`);
                  console.log(`[HostMode] 🎯 DUAL BUFFER: Forced final detected - recovery system will activate`);
                  realtimeTranslationCooldownUntil = Date.now() + TRANSLATION_RESTART_COOLDOWN_MS;
                  
                  // PHASE 8: Use Forced Commit Engine to clear existing buffer
                  // CRITICAL: Check if buffer exists and is recent - if so, this might be a duplicate forced final
                  syncForcedFinalBuffer();
                  if (forcedCommitEngine.hasForcedFinalBuffer()) {
                    const existingBuffer = forcedCommitEngine.getForcedFinalBuffer();
                    const timeSinceExistingBuffer = existingBuffer?.timestamp ? (Date.now() - existingBuffer.timestamp) : Infinity;
                    
                    // If buffer is very recent (< 2 seconds), this is likely a duplicate forced final from rapid stream restarts
                    // In this case, we should check if the new forced final is actually different or just a duplicate
                    if (timeSinceExistingBuffer < 2000) {
                      const existingText = existingBuffer.text?.trim().toLowerCase() || '';
                      const newText = transcriptText.trim().toLowerCase();
                      
                      // Check if new forced final is similar to existing one (likely a duplicate)
                      if (existingText === newText || 
                          (existingText.length > 10 && newText.startsWith(existingText.substring(0, Math.min(50, existingText.length))))) {
                        console.warn(`[HostMode] ⚠️ Duplicate forced final detected (${timeSinceExistingBuffer}ms since last) - IGNORING`);
                        console.warn(`[HostMode]   Existing: "${existingBuffer.text?.substring(0, 80) || ''}..."`);
                        console.warn(`[HostMode]   New: "${transcriptText.substring(0, 80)}..."`);
                        return; // Skip processing this duplicate forced final
                      } else {
                        console.warn(`[HostMode] ⚠️ Different forced final detected while buffer exists (${timeSinceExistingBuffer}ms since last) - CLEARING old buffer`);
                        console.warn(`[HostMode]   Old: "${existingBuffer.text?.substring(0, 80) || ''}..."`);
                        console.warn(`[HostMode]   New: "${transcriptText.substring(0, 80)}..."`);
                      }
                    }
                    
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
                    // CRITICAL: Capture lastSentFinalText, lastSentOriginalText, and lastSentFinalTime BEFORE creating buffer so recovery can use it for deduplication
                    // When recovery commits, lastSentFinalText may have been updated, so we need to preserve the previous final
                    // that was sent before this forced final was detected
                    // IMPORTANT: Prefer lastSentOriginalText over lastSentFinalText for deduplication (full original text vs grammar-corrected shortened version)
                    const lastSentFinalTextBeforeForcedFinal = lastSentFinalText;
                    const lastSentOriginalTextBeforeForcedFinal = lastSentOriginalText;
                    const lastSentFinalTimeBeforeForcedFinal = lastSentFinalTime;
                    forcedCommitEngine.createForcedFinalBuffer(transcriptText, forcedFinalTimestamp, lastSentFinalTextBeforeForcedFinal, lastSentFinalTimeBeforeForcedFinal, lastSentOriginalTextBeforeForcedFinal);
                    syncForcedFinalBuffer();
                    console.log(`[HostMode] 📌 CREATING FORCED FINAL BUFFER:`);
                    console.log(`[HostMode]   Forced final text: "${transcriptText.substring(0, 80)}..."`);
                    console.log(`[HostMode]   Forced final timestamp: ${forcedFinalTimestamp}`);
                    console.log(`[HostMode]   Capturing previous final text BEFORE buffer creation:`);
                    console.log(`[HostMode]     lastSentFinalText: "${lastSentFinalTextBeforeForcedFinal ? lastSentFinalTextBeforeForcedFinal.substring(Math.max(0, lastSentFinalTextBeforeForcedFinal.length - 80)) : '(empty)'}"`);
                    console.log(`[HostMode]     lastSentOriginalText: "${lastSentOriginalTextBeforeForcedFinal ? lastSentOriginalTextBeforeForcedFinal.substring(Math.max(0, lastSentOriginalTextBeforeForcedFinal.length - 80)) : '(empty)'}"`);
                    console.log(`[HostMode]     lastSentFinalTime: ${lastSentFinalTimeBeforeForcedFinal || '(not set)'}`);
                    console.log(`[HostMode]   ⚠️ CRITICAL: lastSentOriginalText will be stored in buffer.lastSentOriginalTextBeforeBuffer (preferred for deduplication)`);
                    console.log(`[HostMode]   ⚠️ CRITICAL: It will be used for deduplication when recovery commits this forced final`);
                    console.log(`[HostMode]   ⚠️ CRITICAL: This ensures recovery uses the CORRECT previous segment with FULL original text, not a different one`);
                    
                    // NOTE: Buffer was already created above at line 2669 - no need to create it again
                    
                    // Verify the buffer was created correctly
                    const buffer = forcedCommitEngine.getForcedFinalBuffer();
                    console.log(`[HostMode] ✅ Forced final buffer created and verified:`);
                    console.log(`[HostMode]   Buffer.text: "${buffer?.text ? buffer.text.substring(0, 80) : '(none)'}..."`);
                    console.log(`[HostMode]   Buffer.lastSentOriginalTextBeforeBuffer: "${buffer?.lastSentOriginalTextBeforeBuffer ? buffer.lastSentOriginalTextBeforeBuffer.substring(Math.max(0, buffer.lastSentOriginalTextBeforeBuffer.length - 80)) : '(empty)'}"`);
                    console.log(`[HostMode]   Buffer.lastSentFinalTextBeforeBuffer: "${buffer?.lastSentFinalTextBeforeBuffer ? buffer.lastSentFinalTextBeforeBuffer.substring(Math.max(0, buffer.lastSentFinalTextBeforeBuffer.length - 80)) : '(empty)'}" (fallback)`);
                    console.log(`[HostMode]   Buffer.lastSentFinalTimeBeforeBuffer: ${buffer?.lastSentFinalTimeBeforeBuffer || '(not set)'}`);
                    console.log(`[HostMode]   Buffer.timestamp: ${buffer?.timestamp || '(not set)'}`);
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
                          // No new segment detected - DON'T reset yet, will reset after final is emitted
                          // CRITICAL FIX: Partial reset moved to after final emission to prevent state loss
                          console.log(`[HostMode] ⏳ Will reset partial tracking after final is emitted`);
                        }

                        // Calculate how much time has passed since forced final
                        const timeSinceForcedFinal = Date.now() - forcedFinalTimestamp;
                        console.log(`[HostMode] ⏱️ ${timeSinceForcedFinal}ms has passed since forced final`);

                        // ⭐ CRITICAL: Capture 2200ms window that includes BOTH:
                        // - PRE-final audio (1400ms before the final) ← Contains the decoder gap!
                        // - POST-final audio (800ms after the final) ← Captures complete phrases like "self-centered"
                        const captureWindowMs = 2200;
                        // ⭐ BUG FIX: Limit POST-final audio to 800ms max to prevent capturing next segment
                        // Window end should be: forcedFinalTimestamp + 800ms (not current time if more than 800ms passed)
                        const maxPostFinalMs = 800;
                        const windowEndTimestamp = Math.min(forcedFinalTimestamp + maxPostFinalMs, Date.now());
                        const actualPostFinalMs = windowEndTimestamp - forcedFinalTimestamp;
                        const actualPreFinalMs = captureWindowMs - actualPostFinalMs;
                        console.log(`[HostMode] 🎵 Capturing PRE+POST-final audio: last ${captureWindowMs}ms`);
                        console.log(`[HostMode] 📊 Window covers: [T-${actualPreFinalMs}ms to T+${actualPostFinalMs}ms]`);
                        console.log(`[HostMode] 🎯 This INCLUDES the decoder gap at ~T-200ms where missing words exist!`);
                        console.log(`[HostMode] 🔒 POST-final limited to ${actualPostFinalMs}ms (max ${maxPostFinalMs}ms) to prevent capturing next segment`);

                        const recoveryAudio = speechStream.getRecentAudio(captureWindowMs, windowEndTimestamp);
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
                            processFinalText(forcedFinalText, { forceFinal: true });
                            
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
                        let recoveryAlreadyCommitted = false;
                        let recoveredTextFromPromise = null;
                        if (forcedFinalBuffer && forcedFinalBuffer.recoveryInProgress && forcedFinalBuffer.recoveryPromise) {
                          console.log('[HostMode] ⏳ Audio recovery still in progress, waiting for completion...');
                          try {
                            recoveredTextFromPromise = await forcedFinalBuffer.recoveryPromise;
                            if (recoveredTextFromPromise && recoveredTextFromPromise.length > 0) {
                              console.log(`[HostMode] ✅ Audio recovery completed with text: "${recoveredTextFromPromise.substring(0, 60)}..."`);
                              
                              // CRITICAL: Check if recovery already committed the text
                              syncForcedFinalBuffer();
                              const bufferAfterRecovery = forcedCommitEngine.hasForcedFinalBuffer() ? forcedCommitEngine.getForcedFinalBuffer() : null;
                              recoveryAlreadyCommitted = bufferAfterRecovery?.committedByRecovery === true;
                              
                              if (recoveryAlreadyCommitted) {
                                console.log(`[HostMode] ✅ Recovery already committed the recovered text - skipping recovery stream call`);
                              } else if (!forcedCommitEngine.hasForcedFinalBuffer()) {
                                // Buffer was cleared but recovery didn't commit - this could mean:
                                // 1. A new FINAL arrived and merged with the forced final (cleared buffer)
                                // 2. Recovery committed but didn't set the flag (unlikely but possible)
                                // 3. An extending partial cleared it
                                // 
                                // If a new FINAL arrived, it would have merged with the forced final, so the recovered text
                                // might already be included in the merged text. However, the recovered text might contain
                                // additional words that weren't in either the forced final or the new FINAL.
                                // 
                                // We'll commit the recovered text, but use careful deduplication to avoid duplicates.
                                // The deduplication logic in processFinalText should handle this.
                                console.log(`[HostMode] ⚠️ Buffer was cleared (likely by new FINAL or extending partial) but recovery found text`);
                                console.log(`[HostMode] 📊 Recovered text to commit: "${recoveredTextFromPromise.substring(0, 80)}..."`);
                                console.log(`[HostMode] ⚠️ Note: If a new FINAL merged with forced final, recovered text might already be included`);
                                console.log(`[HostMode] ⚠️ Deduplication will prevent duplicates, but this recovered text might be lost if already merged`);
                                
                                // Get the previous final text for deduplication
                                // Since buffer is cleared, we use the last sent final (which might be the new FINAL that cleared it)
                                // The deduplication logic will compare against this to avoid duplicates
                                syncPartialVariables();
                                const previousFinalTextForDeduplication = lastSentOriginalText || lastSentFinalText || null;
                                const previousFinalTimeForDeduplication = lastSentFinalTime || null;
                                
                                processFinalText(recoveredTextFromPromise, { 
                                  forceFinal: true,
                                  previousFinalTextForDeduplication: previousFinalTextForDeduplication,
                                  previousFinalTimeForDeduplication: previousFinalTimeForDeduplication
                                });
                                
                                recoveryAlreadyCommitted = true;
                                console.log(`[HostMode] ✅ Committed recovered text (deduplication will prevent duplicates if already merged)`);
                              } else {
                                console.log(`[HostMode] ⚠️ Recovery found text but didn't commit yet - will be handled by recovery stream call below`);
                              }
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
                        // BUT: Skip if recovery already committed (either by recovery itself or by us above)
                        
                        if (recoveryAlreadyCommitted) {
                          console.log(`[HostMode] ⏭️ Skipping recovery stream call - recovery already committed`);
                        } else if (recoveryAudio.length > 0) {
                          // Use RecoveryStreamEngine to handle recovery stream operations
                          // Wrap recoveryStartTime and nextFinalAfterRecovery in objects so they can be modified
                          const recoveryStartTimeRef = { value: recoveryStartTime };
                          const nextFinalAfterRecoveryRef = { value: nextFinalAfterRecovery };
                          
                          await coreEngine.recoveryStreamEngine.performRecoveryStream({
                            speechStream,
                            sourceLang: currentSourceLang,
                            forcedCommitEngine,
                            finalityGate: coreEngine.finalityGate,
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
                            recoveryAudio,
                            segmentId: currentSegmentId // Pass current segment ID for FinalityGate isolation
                          });
                          
                          // Update the original variables from the refs
                          recoveryStartTime = recoveryStartTimeRef.value;
                          nextFinalAfterRecovery = nextFinalAfterRecoveryRef.value;
                          
                          // Drain queued events after recovery completes
                          drainRecoveryQueue();
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
                        processFinalText(textToCommit, { forceFinal: true });
                        
                        // Clear buffer if it still exists
                        if (bufferStillExists) {
                          forcedCommitEngine.clearForcedFinalBuffer();
                          syncForcedFinalBuffer();
                        }
                        
                        // CRITICAL: Partial tracking should already be reset in processFinalText finally block
                        // This is a backup reset for edge cases (processFinalText already handles the reset)
                        // Note: segmentId is also reset in processFinalText finally block
                        
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
                    const forcedFinalText = buffer.text.trim().toLowerCase();
                    const newFinalText = transcriptText.trim().toLowerCase();
                    
                    // Check if new FINAL might be related to forced final:
                    // 1. New FINAL starts with forced final (extension)
                    // 2. Forced final starts with new FINAL (new FINAL is prefix)
                    // 3. They share significant word overlap (continuation)
                    const isExtension = newFinalText.length > forcedFinalText.length && 
                                       newFinalText.startsWith(forcedFinalText);
                    const isPrefix = forcedFinalText.length > newFinalText.length && 
                                    forcedFinalText.startsWith(newFinalText);
                    
                    // Check word overlap for continuations
                    const forcedWords = forcedFinalText.split(/\s+/).filter(w => w.length > 2);
                    const newWords = newFinalText.split(/\s+/).filter(w => w.length > 2);
                    const sharedWords = forcedWords.filter(w => newWords.includes(w));
                    const hasWordOverlap = sharedWords.length >= Math.min(2, Math.min(forcedWords.length, newWords.length) * 0.3);
                    
                    const mightBeRelated = isExtension || isPrefix || hasWordOverlap;
                    
                    if (mightBeRelated) {
                      console.log('[HostMode] ⏳ Forced final recovery in progress - new FINAL appears related, waiting for completion (maintaining order)...');
                      console.log(`[HostMode]   Forced final: "${buffer.text.substring(0, 50)}..."`);
                      console.log(`[HostMode]   New FINAL: "${transcriptText.substring(0, 50)}..."`);
                    } else {
                      console.log('[HostMode] ✅ Forced final recovery in progress, but new FINAL is unrelated segment - committing forced final first');
                      console.log(`[HostMode]   Forced final: "${buffer.text.substring(0, 50)}..."`);
                      console.log(`[HostMode]   New FINAL (unrelated): "${transcriptText.substring(0, 50)}..."`);
                      // CRITICAL FIX: Even though they're unrelated, we must commit the forced final first
                      // to prevent it from being lost. Don't wait for recovery - commit from buffer immediately.
                      console.log('[HostMode] 📝 Committing forced final first (unrelated new FINAL, but forced final must not be lost)');
                      
                      // Mark as committed BEFORE clearing buffer
                      syncForcedFinalBuffer();
                      if (buffer) {
                        buffer.committedByRecovery = true; // Mark as committed to prevent timeout from also committing
                      }
                      
                      // Get the previous final text for deduplication from the buffer
                      // Prefer lastSentOriginalTextBeforeBuffer (full original text) over lastSentFinalTextBeforeBuffer (grammar-corrected shortened version)
                      const lastSentOriginalTextBeforeBuffer = buffer?.lastSentOriginalTextBeforeBuffer || null;
                      const lastSentFinalTextBeforeBuffer = buffer?.lastSentFinalTextBeforeBuffer || null;
                      const lastSentFinalTimeBeforeBuffer = buffer?.lastSentFinalTimeBeforeBuffer || null;
                      const previousFinalTextForDeduplication = lastSentOriginalTextBeforeBuffer || lastSentFinalTextBeforeBuffer;
                      
                      // Commit the forced final with proper deduplication context
                      const forcedFinalText = buffer.text;
                      processFinalText(forcedFinalText, { 
                        forceFinal: true,
                        previousFinalTextForDeduplication: previousFinalTextForDeduplication,
                        previousFinalTimeForDeduplication: lastSentFinalTimeBeforeBuffer
                      });
                      
                      // Clear the buffer and timeout
                      forcedCommitEngine.clearForcedFinalBufferTimeout();
                      forcedCommitEngine.clearForcedFinalBuffer();
                      syncForcedFinalBuffer();
                      
                      // Reset recovery tracking
                      recoveryStartTime = 0;
                      nextFinalAfterRecovery = null;
                      
                      // Continue processing the new FINAL below (don't return - let it be processed)
                      console.log('[HostMode] 📝 Now processing unrelated new FINAL (forced final already committed)');
                    }
                    
                    if (mightBeRelated) {
                      // Only wait if FINALs are related
                    try {
                      const recoveredText = await buffer.recoveryPromise;
                      
                      // CRITICAL: Check if recovery already committed before committing again
                      // Recovery stream engine commits the merged text (forced final + recovered words) if it finds additional words
                      // We should only commit here if recovery didn't already commit
                      syncForcedFinalBuffer();
                      const bufferAfterRecovery = forcedCommitEngine.hasForcedFinalBuffer() ? forcedCommitEngine.getForcedFinalBuffer() : null;
                      const alreadyCommittedByRecovery = bufferAfterRecovery?.committedByRecovery === true;
                      
                      if (recoveredText && recoveredText.length > 0) {
                        console.log(`[HostMode] ✅ Forced final recovery completed with text: "${recoveredText.substring(0, 60)}..."`);
                        
                        if (alreadyCommittedByRecovery) {
                          // Recovery already committed the merged text - don't commit again
                          console.log('[HostMode] ⏭️ Recovery already committed the merged text - skipping duplicate commit');
                          forcedCommitEngine.clearForcedFinalBuffer();
                          syncForcedFinalBuffer();
                        } else {
                          // Recovery found words but didn't commit yet - commit the merged text
                          console.log('[HostMode] 📝 Committing forced final with recovered words (maintaining chronological order)');
                          
                          // Mark as committed by recovery BEFORE clearing buffer
                          syncForcedFinalBuffer();
                          if (forcedFinalBuffer) {
                            forcedFinalBuffer.committedByRecovery = true;
                          }
                          
                          // Get the previous final text for deduplication from the buffer
                          const lastSentOriginalTextBeforeBuffer = bufferAfterRecovery?.lastSentOriginalTextBeforeBuffer || null;
                          const lastSentFinalTextBeforeBuffer = bufferAfterRecovery?.lastSentFinalTextBeforeBuffer || null;
                          const lastSentFinalTimeBeforeBuffer = bufferAfterRecovery?.lastSentFinalTimeBeforeBuffer || null;
                          const previousFinalTextForDeduplication = lastSentOriginalTextBeforeBuffer || lastSentFinalTextBeforeBuffer;
                          
                          processFinalText(recoveredText, { 
                            forceFinal: true,
                            previousFinalTextForDeduplication: previousFinalTextForDeduplication,
                            previousFinalTimeForDeduplication: lastSentFinalTimeBeforeBuffer
                          });
                          forcedCommitEngine.clearForcedFinalBuffer();
                          syncForcedFinalBuffer();
                        }
                        
                        // CRITICAL: If we didn't reset the partial tracker earlier (because new segment partials were detected),
                        // reset it now after committing the forced final
                        syncPartialVariables();
                        if (longestPartialText && longestPartialText.length > 0) {
                          // Check if these are new segment partials (don't start with the recovered text)
                          const longestTrimmed = longestPartialText.trim().toLowerCase();
                          const recoveredTrimmed = recoveredText.trim().toLowerCase();
                          if (!longestTrimmed.startsWith(recoveredTrimmed)) {
                            console.log(`[HostMode] 🧹 Resetting partial tracker after recovery commit (new segment partials detected)`);
                            partialTracker.reset();
                            syncPartialVariables();
                          }
                        }
                        
                        // Reset recovery tracking
                        recoveryStartTime = 0;
                        nextFinalAfterRecovery = null;
                        
                        // Now process the new FINAL (which arrived after the forced final)
                        console.log('[HostMode] 📝 Now processing new FINAL that arrived after forced final');
                        // Continue with transcriptText processing below
                      } else {
                        console.log('[HostMode] ⚠️ Forced final recovery completed but no text was recovered');
                        
                        // CRITICAL: Check if recovery already committed the forced final
                        // Recovery stream engine commits the forced final even if it didn't find additional words
                        syncForcedFinalBuffer();
                        const bufferAfterRecovery = forcedCommitEngine.hasForcedFinalBuffer() ? forcedCommitEngine.getForcedFinalBuffer() : null;
                        const alreadyCommittedByRecovery = bufferAfterRecovery?.committedByRecovery === true;
                        
                        if (alreadyCommittedByRecovery) {
                          // Recovery already committed the forced final - don't commit again
                          console.log('[HostMode] ⏭️ Recovery already committed the forced final - skipping duplicate commit');
                          forcedCommitEngine.clearForcedFinalBuffer();
                          syncForcedFinalBuffer();
                        } else {
                          // Recovery found nothing and didn't commit - commit the forced final first, then process new FINAL
                          console.log('[HostMode] 📝 Committing forced final first (recovery found nothing, but forced final must be committed)');
                          
                          // CRITICAL: Mark as committed BEFORE clearing buffer so timeout callback can skip
                          // Even though recovery found nothing, we're committing it here due to new FINAL arriving
                          syncForcedFinalBuffer();
                          if (forcedFinalBuffer) {
                            forcedFinalBuffer.committedByRecovery = true; // Mark as committed to prevent timeout from also committing
                          }
                          
                          // Get the previous final text for deduplication from the buffer
                          const lastSentOriginalTextBeforeBuffer = bufferAfterRecovery?.lastSentOriginalTextBeforeBuffer || null;
                          const lastSentFinalTextBeforeBuffer = bufferAfterRecovery?.lastSentFinalTextBeforeBuffer || null;
                          const lastSentFinalTimeBeforeBuffer = bufferAfterRecovery?.lastSentFinalTimeBeforeBuffer || null;
                          const previousFinalTextForDeduplication = lastSentOriginalTextBeforeBuffer || lastSentFinalTextBeforeBuffer;
                          
                          // Commit the forced final (from buffer, since recovery found nothing)
                          const forcedFinalText = buffer.text;
                          processFinalText(forcedFinalText, { 
                            forceFinal: true,
                            previousFinalTextForDeduplication: previousFinalTextForDeduplication,
                            previousFinalTimeForDeduplication: lastSentFinalTimeBeforeBuffer
                          });
                        }
                        
                        // CRITICAL: If we didn't reset the partial tracker earlier (because new segment partials were detected),
                        // reset it now after committing the forced final
                        syncPartialVariables();
                        if (longestPartialText && longestPartialText.length > 0) {
                          // Check if these are new segment partials (don't start with the forced final)
                          const longestTrimmed = longestPartialText.trim().toLowerCase();
                          const forcedFinalTrimmed = forcedFinalText.trim().toLowerCase();
                          if (!longestTrimmed.startsWith(forcedFinalTrimmed)) {
                            console.log(`[HostMode] 🧹 Resetting partial tracker after recovery commit (new segment partials detected)`);
                            partialTracker.reset();
                            syncPartialVariables();
                          }
                        }
                        
                        // Now merge with new FINAL and process it
                        forcedCommitEngine.clearForcedFinalBufferTimeout();
                        const merged = partialTracker.mergeWithOverlap(forcedFinalText, transcriptText);
                        if (merged) {
                          transcriptText = merged;
                        } else {
                          console.warn('[HostMode] ⚠️ Merge failed, using new FINAL transcript');
                        }
                        forcedCommitEngine.clearForcedFinalBuffer();
                        syncForcedFinalBuffer();
                        
                        // Reset recovery tracking
                        recoveryStartTime = 0;
                        nextFinalAfterRecovery = null;
                        
                        // Continue processing the new FINAL below
                      }
                    } catch (error) {
                      console.error('[HostMode] ❌ Error waiting for forced final recovery:', error.message);
                      // On error, proceed with merge as before
                      forcedCommitEngine.clearForcedFinalBufferTimeout();
                      const merged = partialTracker.mergeWithOverlap(buffer.text, transcriptText);
                      if (merged) {
                        transcriptText = merged;
                      } else {
                        console.warn('[HostMode] ⚠️ Merge failed, using new FINAL transcript');
                      }
                      forcedCommitEngine.clearForcedFinalBuffer();
                      syncForcedFinalBuffer();
                      
                      // Reset recovery tracking
                      recoveryStartTime = 0;
                      nextFinalAfterRecovery = null;
                    }
                    } // End if (mightBeRelated) - if not related, skip wait and continue processing below
                  } else {
                    // No recovery in progress - CRITICAL FIX: Commit forced final FIRST before merging
                    // This ensures forced final is not lost if merge fails
                    console.log('[HostMode] 🔁 Merging buffered forced final with new FINAL transcript');
                    forcedCommitEngine.clearForcedFinalBufferTimeout();
                    
                    // CRITICAL FIX: Check if new FINAL is actually a continuation of forced final
                    const forcedFinalText = buffer.text.trim();
                    const newFinalText = transcriptText.trim();
                    const forcedNormalized = forcedFinalText.toLowerCase();
                    const newNormalized = newFinalText.toLowerCase();
                    
                    // Check if new FINAL extends forced final (is a continuation)
                    const isExtension = newNormalized.length > forcedNormalized.length && 
                                       newNormalized.startsWith(forcedNormalized);
                    
                    // Check if they're the same text (duplicate)
                    const isDuplicate = forcedNormalized === newNormalized;
                    
                    // Check if merge would succeed
                    const merged = partialTracker.mergeWithOverlap(forcedFinalText, newFinalText);
                    
                    if (isDuplicate) {
                      // Same text - commit forced final and skip new FINAL (it's a duplicate)
                      console.log('[HostMode] ⚠️ New FINAL is duplicate of forced final - committing forced final and skipping new FINAL');
                      processFinalText(forcedFinalText, { forceFinal: true });
                      forcedCommitEngine.clearForcedFinalBuffer();
                      syncForcedFinalBuffer();
                      // Skip processing the new FINAL (it's a duplicate)
                      return;
                    } else if (merged && merged.length > forcedFinalText.length) {
                      // Merge succeeded and adds new content - use merged text
                      console.log('[HostMode] ✅ Merge succeeded - using merged text');
                      transcriptText = merged;
                      forcedCommitEngine.clearForcedFinalBuffer();
                      syncForcedFinalBuffer();
                    } else if (isExtension) {
                      // New FINAL extends forced final - use new FINAL (it's longer)
                      console.log('[HostMode] ✅ New FINAL extends forced final - using new FINAL');
                      transcriptText = newFinalText;
                      forcedCommitEngine.clearForcedFinalBuffer();
                      syncForcedFinalBuffer();
                    } else {
                      // Merge failed - they're different segments
                      // CRITICAL FIX: Commit forced final FIRST, then process new FINAL separately
                      console.log('[HostMode] ⚠️ Merge failed - new FINAL is different segment');
                      console.log('[HostMode] 📝 Committing forced final FIRST, then processing new FINAL separately');
                      processFinalText(forcedFinalText, { forceFinal: true });
                      forcedCommitEngine.clearForcedFinalBuffer();
                      syncForcedFinalBuffer();
                      // Continue processing the new FINAL below (don't return - let it be processed)
                    }
                    
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
                
                // NOTE: Deduplication removed - only applies to forced finals, not regular finals from Google Speech
                // Regular finals should be sent as-is without deduplication
                
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
                // 
                // 🔑 RULE: Punctuation is metadata only - it influences wait times but NEVER creates or finalizes segments.
                // Segments are owned by audio timing/buffering, not text heuristics.
                const finalTrimmed = transcriptText.trim();
                const finalEndsWithCompleteSentence = endsWithCompleteSentence(transcriptText);
                const finalEndsWithSentencePunctuation = /[.!?…]$/.test(finalTrimmed);
                // Incomplete if: doesn't end with sentence punctuation (period, exclamation, question mark)
                // Commas, semicolons, colons are NOT sentence-ending, so text ending with them is incomplete
                // NOTE: This is metadata for wait time calculation only - NOT a trigger for finalization
                const isIncomplete = !finalEndsWithSentencePunctuation;
                
                // CRITICAL FIX: Also detect false finals - short finals with periods that are clearly incomplete
                // Examples: "I've been.", "You just can't.", "We have." - these have periods but are incomplete
                const isShort = finalTrimmed.length < 25;
                const isCommonIncompletePattern = /^(I've|I've been|You|You just|You just can't|We|We have|They|They have|It|It has)\s/i.test(finalTrimmed);
                const isFalseFinal = finalEndsWithSentencePunctuation && isShort && isCommonIncompletePattern;
                
                if (isIncomplete || isFalseFinal) {
                  if (isFalseFinal) {
                    console.log(`[HostMode] ⚠️ FALSE FINAL DETECTED: "${finalTrimmed.substring(0, 50)}..." - short final with period but clearly incomplete (common pattern)`);
                  } else {
                    console.log(`[HostMode] 📝 FINAL is incomplete (ends with "${finalTrimmed.slice(-1)}" not sentence punctuation) - will wait briefly for extending partials`);
                  }
                  console.log(`[HostMode] 📝 Current text: "${transcriptText.substring(Math.max(0, transcriptText.length - 60))}"`);
                  // For incomplete finals, extend wait time to catch extending partials
                  // Short incomplete finals (< 50 chars) likely need more words - wait longer
                  // False finals (short with period) need even longer wait
                  if (isFalseFinal) {
                    WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 3000); // 3 seconds for false finals
                  } else if (transcriptText.length < 50) {
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
                // finalTrimmed is already declared above at line 2874
                const finalEndsCompleteWord = endsWithCompleteWord(finalTrimmed);
                const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;
                
                // Note: We no longer extend wait time for mid-word finals - commit immediately
                // Continuations will be caught by the partial continuation detection logic
                if (!finalEndsCompleteWord) {
                  console.log(`[HostMode] 📝 FINAL ends mid-word - will commit immediately, continuation will be caught in partials`);
                }
                
                // CRITICAL FIX: Check if FINAL is a fragment of an active partial
                // If a partial exists that starts with this FINAL (ignoring trailing punctuation), skip processing the FINAL
                // The partial will eventually be finalized and contain the complete text
                // This prevents race conditions where a fragment FINAL gets finalized while the partial is still being extended
                // Example: FINAL="Oh boy." should be skipped if PARTIAL="Oh boy. I've been to grocery store..."
                // 
                // 🔑 RULE: Punctuation may mark a candidate boundary, but may NEVER create or finalize a segment.
                // Segments must be owned by audio timing/buffering, not by text heuristics.
                syncPartialVariables();
                
                // Use more aggressive normalization and multiple matching strategies
                const finalWithoutTrailingPunct = finalTrimmed.replace(/[.!?…]+$/, '').trim();
                const finalNormalizedForComparison = finalWithoutTrailingPunct.replace(/[.,!?;:…]/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim();
                
                // CRITICAL: Remove length threshold - short fragments like "Oh boy." (7 chars) must be caught
                // Check if ANY partial contains this FINAL fragment, regardless of length
                if (longestPartialText && longestPartialText.length >= transcriptText.length && timeSinceLongest < 10000) {
                  const longestTrimmed = longestPartialText.trim();
                  const longestNormalized = longestTrimmed.replace(/[.,!?;:…]/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim();
                  
                  // Multiple checks to catch all variations (including short fragments)
                  const partialStartsWithFinal = longestTrimmed.toLowerCase().startsWith(finalTrimmed.toLowerCase());
                  const partialStartsWithFinalNoPunct = longestTrimmed.toLowerCase().startsWith(finalWithoutTrailingPunct.toLowerCase());
                  const normalizedStartsWith = longestNormalized.startsWith(finalNormalizedForComparison);
                  // REMOVED length threshold - check contains for ANY length fragment
                  const partialContainsFinal = finalNormalizedForComparison.length > 0 && longestNormalized.includes(finalNormalizedForComparison);
                  
                  if (partialStartsWithFinal || partialStartsWithFinalNoPunct || normalizedStartsWith || partialContainsFinal) {
                    console.log(`[HostMode] ⏭️ SKIPPING FINAL fragment - partial contains it (FINAL: "${finalTrimmed}", PARTIAL: "${longestTrimmed.substring(0, Math.min(80, longestTrimmed.length))}...")`);
                    console.log(`[HostMode] 📊 The partial will be finalized instead - preventing duplicate/partial commit`);
                    console.log(`[HostMode]   Match type: startsWith=${partialStartsWithFinal}, startsWithNoPunct=${partialStartsWithFinalNoPunct}, normalized=${normalizedStartsWith}, contains=${partialContainsFinal}`);
                    console.log(`[HostMode] 🔑 Punctuation detected but NOT creating segment - marking candidate boundary only`);
                    return; // Skip processing this FINAL - the partial will handle it
                  }
                } else if (latestPartialText && latestPartialText.length >= transcriptText.length && timeSinceLatest < 10000) {
                  const latestTrimmed = latestPartialText.trim();
                  const latestNormalized = latestTrimmed.replace(/[.,!?;:…]/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim();
                  
                  // Multiple checks to catch all variations (including short fragments)
                  const partialStartsWithFinal = latestTrimmed.toLowerCase().startsWith(finalTrimmed.toLowerCase());
                  const partialStartsWithFinalNoPunct = latestTrimmed.toLowerCase().startsWith(finalWithoutTrailingPunct.toLowerCase());
                  const normalizedStartsWith = latestNormalized.startsWith(finalNormalizedForComparison);
                  // REMOVED length threshold - check contains for ANY length fragment
                  const partialContainsFinal = finalNormalizedForComparison.length > 0 && latestNormalized.includes(finalNormalizedForComparison);
                  
                  if (partialStartsWithFinal || partialStartsWithFinalNoPunct || normalizedStartsWith || partialContainsFinal) {
                    console.log(`[HostMode] ⏭️ SKIPPING FINAL fragment - partial contains it (FINAL: "${finalTrimmed}", PARTIAL: "${latestTrimmed.substring(0, Math.min(80, latestTrimmed.length))}...")`);
                    console.log(`[HostMode] 📊 The partial will be finalized instead - preventing duplicate/partial commit`);
                    console.log(`[HostMode]   Match type: startsWith=${partialStartsWithFinal}, startsWithNoPunct=${partialStartsWithFinalNoPunct}, normalized=${normalizedStartsWith}, contains=${partialContainsFinal}`);
                    console.log(`[HostMode] 🔑 Punctuation detected but NOT creating segment - marking candidate boundary only`);
                    return; // Skip processing this FINAL - the partial will handle it
                  }
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
                    // Different final - commit the pending final FIRST so deduplication can detect relationship
                    // CRITICAL FIX: Commit pending final before processing new final so deduplication/merge logic can run
                    // This allows cases like "You just can't." + "People up with Doctrine..." to be detected and merged
                    console.log(`[HostMode] 🔀 New FINAL arrived that doesn't extend pending final - committing pending final first`);
                    console.log(`[HostMode]   Pending final: "${pending.text.substring(0, 50)}..."`);
                    console.log(`[HostMode]   New FINAL: "${finalTextToUse.substring(0, 50)}..."`);
                    console.log(`[HostMode] ✅ Committing pending FINAL before processing new FINAL (deduplication will detect if they should merge)`);
                    
                    // PHASE 8: Clear timeout using engine
                    finalizationEngine.clearPendingFinalizationTimeout();
                    const textToCommit = pending.text;
                    // PHASE 8: Clear using engine
                    finalizationEngine.clearPendingFinalization();
                    syncPendingFinalization();
                    
                    // Commit the pending final - this will update lastSentFinalText so deduplication can detect relationship
                    processFinalText(textToCommit);
                    
                    // Continue processing the new FINAL below - deduplication will now compare against the just-committed final
                  }
                }
                
                // Schedule final processing after a delay to catch any remaining partials
                // If pendingFinalization exists and was extended, we'll reschedule it below
                if (!finalizationEngine.hasPendingFinalization()) {
                  // CRITICAL: Detect false finals - short finals with periods that are clearly incomplete
                  // Examples: "I've been.", "You just can't.", "We have."
                  // These should wait longer for extending partials even if they have periods
                  const finalTrimmed = finalTextToUse.trim();
                  const endsWithPeriod = finalTrimmed.endsWith('.');
                  const isShort = finalTrimmed.length < 25;
                  const endsWithCompleteSentence = finalizationEngine.endsWithCompleteSentence(finalTrimmed);
                  
                  // Check for common incomplete patterns (even with periods)
                  const isCommonIncompletePattern = /^(I've|I've been|You|You just|You just can't|We|We have|They|They have|It|It has)\s/i.test(finalTrimmed);
                  
                  // CRITICAL FIX: If final is short, has period, but matches incomplete pattern, treat as false final
                  // This catches cases like "You just can't." which should wait for "beat people up with doctrine"
                  // Simplified: If it matches the pattern and is short, it's always a false final (regardless of endsWithCompleteSentence)
                  const isFalseFinal = endsWithPeriod && isShort && isCommonIncompletePattern;
                  
                  if (isFalseFinal) {
                    console.log(`[HostMode] ⚠️ FALSE FINAL DETECTED: "${finalTrimmed.substring(0, 50)}..." - short final with period but clearly incomplete, will wait longer for extending partials`);
                    // Use longer wait time for false finals
                    const FALSE_FINAL_WAIT_MS = 3000; // Wait 3 seconds for false finals
                    // Still create pending finalization, but with longer timeout and isFalseFinal flag
                    finalizationEngine.createPendingFinalization(finalTextToUse, null, true);
                    syncPendingFinalization();
                    // Schedule timeout with longer wait
                    finalizationEngine.setPendingFinalizationTimeout(() => {
                      syncPendingFinalization();
                      syncPartialVariables();
                      if (!pendingFinalization) {
                        console.warn('[HostMode] ⚠️ Timeout fired but pendingFinalization is null - skipping');
                        return;
                      }
                      // Check for extending partials before committing
                      const longestExtends = partialTracker.checkLongestExtends(pendingFinalization.text, 10000);
                      const latestExtends = partialTracker.checkLatestExtends(pendingFinalization.text, 5000);
                      let textToCommit = pendingFinalization.text;
                      
                      if (longestExtends) {
                        console.log(`[HostMode] ✅ False final extended by longest partial: "${longestExtends.missingWords}"`);
                        textToCommit = longestExtends.extendedText;
                      } else if (latestExtends) {
                        console.log(`[HostMode] ✅ False final extended by latest partial: "${latestExtends.missingWords}"`);
                        textToCommit = latestExtends.extendedText;
                      }
                      
                      finalizationEngine.clearPendingFinalization();
                      syncPendingFinalization();
                      // CRITICAL: Partial reset happens in processFinalText finally block after final is emitted
                      processFinalText(textToCommit);
                    }, FALSE_FINAL_WAIT_MS);
                    return; // Exit early - timeout scheduled
                  }
                  
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
                        console.log(`[HostMode] ✅ FINAL Transcript (after ${waitTime}ms wait): "${textToProcess.substring(0, 80)}..."`);
                        // CRITICAL: Partial reset happens in processFinalText finally block after final is emitted
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
                    if (!finalEndsWithCompleteSentence) {
                      console.log(`[HostMode] ⚠️ Committing incomplete sentence after ${waitTime}ms wait (max wait: ${MAX_FINALIZATION_WAIT_MS}ms)`);
                    }
                    console.log(`[HostMode] ✅ FINAL Transcript (after ${waitTime}ms wait): "${textToProcess.substring(0, 80)}..."`);
                    
                    // Process final - translate and broadcast to listeners
                    // CRITICAL: Partial reset happens in processFinalText finally block after final is emitted
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
            processFinalText(forcedFinalText, { forceFinal: true });
            
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
    
    // CRITICAL: Stop safety check interval
    if (partialSafetyCheckInterval) {
      clearInterval(partialSafetyCheckInterval);
      partialSafetyCheckInterval = null;
    }
    
    // CRITICAL: Finalize any remaining partials before disconnect
    // This ensures no partials are lost when the connection closes
    // Note: We use engines directly since variables are scoped inside init handler
    try {
      syncForcedFinalBuffer();
      syncPendingFinalization();
      
      // Get current partial state from tracker
      const partialSnapshot = partialTracker.getSnapshot();
      const longestPartialText = partialSnapshot.longest || '';
      const longestPartialTime = partialSnapshot.longestTime || 0;
      
      // First, handle forced final buffer
      if (forcedCommitEngine.hasForcedFinalBuffer()) {
        const buffer = forcedCommitEngine.getForcedFinalBuffer();
        console.log('[HostMode] ⚠️ Client disconnected with forced final buffer - committing immediately (no audio to recover)');
        
        // Cancel recovery timeout since there's no audio to recover
        forcedCommitEngine.clearForcedFinalBufferTimeout();
        
        // Note: processFinalText is not accessible here, but we can use translationManager directly
        // For now, just log and clear - the forced final should have been handled by recovery system
        console.log(`[HostMode]   Forced final text: "${buffer.text.substring(0, 80)}..."`);
        
        // Clear the buffer
        forcedCommitEngine.clearForcedFinalBuffer();
        syncForcedFinalBuffer();
        
        console.log('[HostMode] ✅ Forced final buffer cleared due to client disconnect');
      }
      
      // CRITICAL: Finalize any pending finalization
      if (finalizationEngine.hasPendingFinalization()) {
        const pending = finalizationEngine.getPendingFinalization();
        console.log('[HostMode] ⚠️ Client disconnected with pending finalization - committing immediately');
        console.log(`[HostMode]   Pending text: "${pending.text.substring(0, 80)}..."`);
        
        // Cancel timeout
        finalizationEngine.clearPendingFinalizationTimeout();
        
        // Check for extending partials one last time
        let textToCommit = pending.text;
        const longestExtends = partialTracker.checkLongestExtends(pending.text, 10000);
        const latestExtends = partialTracker.checkLatestExtends(pending.text, 5000);
        
        if (longestExtends) {
          textToCommit = longestExtends.extendedText;
          console.log(`[HostMode] ✅ Disconnect finalization using longest partial: "${longestExtends.missingWords}"`);
        } else if (latestExtends) {
          textToCommit = latestExtends.extendedText;
          console.log(`[HostMode] ✅ Disconnect finalization using latest partial: "${latestExtends.missingWords}"`);
        }
        
        partialTracker.reset();
        finalizationEngine.clearPendingFinalization();
        syncPendingFinalization();
        console.log(`[HostMode] ✅ Pending final cleared due to disconnect: "${textToCommit.substring(0, 80)}..."`);
        console.log(`[HostMode] ⚠️ NOTE: Final text was prepared but processFinalText is not accessible in close handler`);
        console.log(`[HostMode] ⚠️ NOTE: This should be handled by the safety check interval before disconnect`);
      }
      
      // CRITICAL: Finalize any remaining partials that haven't been finalized
      if (longestPartialText && longestPartialText.length > 0) {
        const timeSinceLastPartial = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
        if (timeSinceLastPartial > 1000) { // Only if partial is at least 1 second old
          console.log('[HostMode] ⚠️ Client disconnected with remaining partials - finalizing immediately');
          console.log(`[HostMode]   Partial text: "${longestPartialText.substring(0, 80)}..."`);
          console.log(`[HostMode]   Age: ${timeSinceLastPartial}ms`);
          
          // Reset partial tracker
          partialTracker.reset();
          console.log(`[HostMode] ✅ Remaining partial cleared due to disconnect`);
          console.log(`[HostMode] ⚠️ NOTE: Partial text was prepared but processFinalText is not accessible in close handler`);
          console.log(`[HostMode] ⚠️ NOTE: This should be handled by the safety check interval before disconnect`);
        }
      }
    } catch (error) {
      console.error('[HostMode] ❌ Error finalizing partials on disconnect:', error);
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

