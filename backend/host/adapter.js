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
import { mergeRecoveryText, wordsAreRelated } from '../utils/recoveryMerge.js';

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
              
              // Helper function to broadcast message to host and listeners (uses CoreEngine for sequencing)
              const broadcastWithSequence = (messageData, isPartial = true, targetLang = null) => {
                if (!currentSessionId) {
                  console.error(`[HostMode] ❌ ERROR: currentSessionId is not defined! Cannot broadcast message.`);
                  return -1;
                }
                
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
                    type: messageData.type || 'translation'
                  };
                } else {
                  // Generate new seqId for new messages
                  const sequenced = timelineTracker.createSequencedMessage(messageData, isPartial);
                  message = sequenced.message;
                  seqId = sequenced.seqId;
                }
                
                // Send to host
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify(message));
                  const updateType = message.updateType ? ` (${message.updateType} update)` : '';
                  console.log(`[HostMode] 📤 Sent to host (${isPartial ? 'PARTIAL' : 'FINAL'}, seqId: ${seqId}, targetLang: ${messageData.targetLang || 'N/A'}${updateType})`);
                }
                
                // Broadcast to listeners
                if (targetLang) {
                  // Broadcast to specific language group
                  const updateType = message.updateType ? ` (${message.updateType} update)` : '';
                  console.log(`[HostMode] 📡 Broadcasting to ${targetLang} listeners (${isPartial ? 'PARTIAL' : 'FINAL'}, seqId: ${seqId}${updateType})`);
                  sessionStore.broadcastToListeners(currentSessionId, message, targetLang);
                } else {
                  // Broadcast to all listeners
                  const updateType = message.updateType ? ` (${message.updateType} update)` : '';
                  console.log(`[HostMode] 📡 Broadcasting to ALL listeners (${isPartial ? 'PARTIAL' : 'FINAL'}, seqId: ${seqId}${updateType})`);
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
              let lastSentFinalTime = 0;
              let lastSentOriginalText = ''; // Track original text to prevent grammar correction duplicates
              const FINAL_CONTINUATION_WINDOW_MS = 3000;
              
              // Flag to prevent concurrent final processing
              let isProcessingFinal = false;
              // Queue for finals that arrive while another is being processed
              const finalProcessingQueue = [];
              
              // Extract final processing into separate async function (using solo mode logic, adapted for broadcasting)
              const processFinalText = (textToProcess, options = {}) => {
                // If already processing, queue this final instead of skipping
                if (isProcessingFinal) {
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
                    
                    // OPTIMIZATION: For forced finals, send immediately without waiting for grammar/translation
                    // Then update asynchronously when ready (reduces commit latency from 4-5s to ~1-1.5s)
                    const isForcedFinal = !!options.forceFinal;
                    
                    if (isForcedFinal) {
                      // Get all target languages needed for listeners
                      const targetLanguages = sessionStore.getSessionLanguages(currentSessionId);
                      console.log(`[HostMode] ⚡ FORCED FINAL: Sending immediately to ${targetLanguages.length} language(s) (no grammar/translation wait)`);
                      
                      // Send forced final immediately with original text only to all languages
                      const immediateSeqIds = {};
                      
                      // Send to host first
                      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                        const hostSeqId = broadcastWithSequence({
                          type: 'translation',
                          originalText: textToProcess,
                          correctedText: textToProcess, // Will be updated asynchronously
                          translatedText: textToProcess, // Will be updated asynchronously
                          sourceLang: currentSourceLang,
                          targetLang: currentSourceLang,
                          timestamp: Date.now(),
                          hasTranslation: false, // Will be updated asynchronously
                          hasCorrection: false, // Will be updated asynchronously
                          forceFinal: true
                        }, false);
                        immediateSeqIds[currentSourceLang] = hostSeqId;
                      }
                      
                      // Send to all listener languages
                      for (const targetLang of targetLanguages) {
                        const seqId = broadcastWithSequence({
                          type: 'translation',
                          originalText: textToProcess,
                          correctedText: textToProcess, // Will be updated asynchronously
                          translatedText: textToProcess, // Will be updated asynchronously
                          sourceLang: currentSourceLang,
                          targetLang: targetLang,
                          timestamp: Date.now(),
                          hasTranslation: false, // Will be updated asynchronously
                          hasCorrection: false, // Will be updated asynchronously
                          forceFinal: true
                        }, false, targetLang);
                        immediateSeqIds[targetLang] = seqId;
                      }
                      
                      // Update tracking immediately
                      lastSentOriginalText = textToProcess;
                      lastSentFinalText = textToProcess;
                      lastSentFinalTime = Date.now();
                      
                      // Asynchronously process grammar/translation and send updates
                      (async () => {
                        try {
                          let correctedText = textToProcess;
                          
                          // Grammar correction (English only)
                          if (currentSourceLang === 'en') {
                            try {
                              correctedText = await grammarWorker.correctFinal(textToProcess, process.env.OPENAI_API_KEY);
                              rememberGrammarCorrection(textToProcess, correctedText);
                              
                              if (correctedText !== textToProcess) {
                                // Send grammar update to all languages with same seqId
                                if (clientWs && clientWs.readyState === WebSocket.OPEN && immediateSeqIds[currentSourceLang]) {
                                  broadcastWithSequence({
                                    type: 'translation',
                                    originalText: textToProcess,
                                    correctedText: correctedText,
                                    translatedText: textToProcess, // Translation not ready yet
                                    sourceLang: currentSourceLang,
                                    targetLang: currentSourceLang,
                                    timestamp: Date.now(),
                                    hasCorrection: true,
                                    forceFinal: true,
                                    updateType: 'grammar',
                                    seqId: immediateSeqIds[currentSourceLang]
                                  }, false);
                                }
                                
                                for (const targetLang of targetLanguages) {
                                  if (immediateSeqIds[targetLang]) {
                                    broadcastWithSequence({
                                      type: 'translation',
                                      originalText: textToProcess,
                                      correctedText: correctedText,
                                      translatedText: textToProcess, // Translation not ready yet
                                      sourceLang: currentSourceLang,
                                      targetLang: targetLang,
                                      timestamp: Date.now(),
                                      hasCorrection: true,
                                      forceFinal: true,
                                      updateType: 'grammar',
                                      seqId: immediateSeqIds[targetLang]
                                    }, false, targetLang);
                                  }
                                }
                              }
                            } catch (grammarError) {
                              console.warn(`[HostMode] Grammar correction failed (async):`, grammarError.message);
                            }
                          }
                          
                          // Translation to all target languages
                          if (targetLanguages.length > 0) {
                            const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                            try {
                              const finalWorker = usePremiumTier 
                                ? realtimeFinalTranslationWorker 
                                : finalTranslationWorker;
                              console.log(`[HostMode] 🔀 Using ${workerType} API for forced final translation (async, ${correctedText.length} chars) to ${targetLanguages.length} language(s)`);
                              const translations = await finalWorker.translateToMultipleLanguages(
                                correctedText,
                                currentSourceLang,
                                targetLanguages,
                                process.env.OPENAI_API_KEY,
                                currentSessionId
                              );
                              
                              // Send translation updates to all languages with same seqId
                              for (const targetLang of targetLanguages) {
                                if (!immediateSeqIds[targetLang]) continue;
                                
                                const translatedText = translations[targetLang];
                                const hasTranslationForLang = translatedText && 
                                                              translatedText.trim() &&
                                                              !translatedText.startsWith('[Translation error') &&
                                                              translatedText !== textToProcess &&
                                                              translatedText !== correctedText;
                                
                                if (hasTranslationForLang) {
                                  broadcastWithSequence({
                                    type: 'translation',
                                    originalText: textToProcess,
                                    correctedText: correctedText,
                                    translatedText: translatedText,
                                    sourceLang: currentSourceLang,
                                    targetLang: targetLang,
                                    timestamp: Date.now(),
                                    hasTranslation: true,
                                    hasCorrection: correctedText !== textToProcess,
                                    forceFinal: true,
                                    updateType: 'translation',
                                    seqId: immediateSeqIds[targetLang]
                                  }, false, targetLang);
                                }
                              }
                              
                              // Also update host if same language
                              if (clientWs && clientWs.readyState === WebSocket.OPEN && immediateSeqIds[currentSourceLang]) {
                                const hostTranslation = translations[currentSourceLang] || correctedText;
                                broadcastWithSequence({
                                  type: 'translation',
                                  originalText: textToProcess,
                                  correctedText: correctedText,
                                  translatedText: hostTranslation,
                                  sourceLang: currentSourceLang,
                                  targetLang: currentSourceLang,
                                  timestamp: Date.now(),
                                  hasTranslation: false, // Same language = no translation
                                  hasCorrection: correctedText !== textToProcess,
                                  forceFinal: true,
                                  updateType: 'translation',
                                  seqId: immediateSeqIds[currentSourceLang]
                                }, false);
                              }
                            } catch (translationError) {
                              console.error(`[HostMode] Translation failed (async):`, translationError.message);
                            }
                          }
                        } catch (error) {
                          console.error(`[HostMode] Async update error:`, error);
                        }
                      })();
                      
                      return; // Exit early - async updates will handle the rest
                    }
                    
                    // Regular finals - keep existing behavior (wait for grammar/translation)
                    const isTranscriptionOnly = false; // Host mode always translates
                    
                    // Different language - KEEP COUPLED FOR FINALS (history needs complete data)
                    let correctedText = textToProcess; // Declare outside try for catch block access
                    try {
                      // CRITICAL FIX: Get grammar correction FIRST (English only), then translate the CORRECTED text
                      // This ensures the translation matches the corrected English text
                      // Use Promise.race to prevent grammar correction from blocking too long
                      if (currentSourceLang === 'en') {
                        try {
                          // Set a timeout for grammar correction (max 2 seconds) to prevent blocking
                          const grammarTimeout = new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Grammar correction timeout')), 2000)
                          );
                          
                          correctedText = await Promise.race([
                            grammarWorker.correctFinal(textToProcess, process.env.OPENAI_API_KEY),
                            grammarTimeout
                          ]);
                          
                          rememberGrammarCorrection(textToProcess, correctedText);
                        } catch (grammarError) {
                          if (grammarError.message === 'Grammar correction timeout') {
                            console.warn(`[HostMode] Grammar correction timed out after 2s, using original text`);
                          } else {
                            console.warn(`[HostMode] Grammar correction failed, using original text:`, grammarError.message);
                          }
                          correctedText = textToProcess; // Fallback to original on error/timeout
                        }
                      } else {
                        // Non-English source - skip grammar correction
                        correctedText = textToProcess;
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
                            forceFinal: false
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
                          forceFinal: false
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
                      // Track both original and corrected text to prevent duplicates
                      lastSentOriginalText = textToProcess; // Always track the original
                      lastSentFinalText = correctedText !== textToProcess ? correctedText : textToProcess;
                      lastSentFinalTime = Date.now();
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
                        forceFinal: false
                      }, false);
                      
                      // CRITICAL: Update last sent FINAL tracking after sending (even on error, if we have text)
                      if (error.skipRequest || finalText !== `[Translation error: ${error.message}]`) {
                        lastSentOriginalText = textToProcess; // Track original
                        lastSentFinalText = textToProcess;
                        lastSentFinalTime = Date.now();
                      }
                    } finally {
                      // CRITICAL: Always clear the processing flag when done
                      isProcessingFinal = false;
                      
                      // Process next queued final if any
                      if (finalProcessingQueue.length > 0) {
                        const next = finalProcessingQueue.shift();
                        console.log(`[HostMode] 🔄 Processing queued final: "${next.textToProcess.substring(0, 60)}..."`);
                        // Recursively process the next queued final
                        processFinalText(next.textToProcess, next.options);
                      }
                    }
                  } catch (error) {
                    console.error(`[HostMode] Error processing final:`, error);
                    // CRITICAL: Clear flag on outer error too
                    isProcessingFinal = false;
                    
                    // Process next queued final even on error
                    if (finalProcessingQueue.length > 0) {
                      const next = finalProcessingQueue.shift();
                      console.log(`[HostMode] 🔄 Processing queued final after error: "${next.textToProcess.substring(0, 60)}..."`);
                      processFinalText(next.textToProcess, next.options);
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
                              processFinalText(recoveredMerged, { forceFinal: true });
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
                  
                  // Track latest partial for correction race condition prevention
                  latestPartialTextForCorrection = transcriptText;
                  const translationSeedText = applyCachedCorrections(transcriptText);
                  
                  // PHASE 8: Update partial tracking using CoreEngine Partial Tracker
                  partialTracker.updatePartial(transcriptText);
                  syncPartialVariables(); // Sync variables for compatibility
                  
                  const snapshot = partialTracker.getSnapshot();
                  if (snapshot.longest && snapshot.longest.length > (longestPartialText?.length || 0)) {
                    console.log(`[HostMode] 📏 New longest partial: ${snapshot.longest.length} chars`);
                  }
                  
                  // CRITICAL: Check if this partial duplicates words from the previous FINAL
                  // This prevents cases like "desires" in FINAL followed by "Desires" in PARTIAL
                  let partialTextToSend = transcriptText;
                  if (lastSentFinalText && lastSentFinalTime) {
                    const timeSinceLastFinal = Date.now() - lastSentFinalTime;
                    // Only check if FINAL was sent recently (within 5 seconds)
                    if (timeSinceLastFinal < 5000) {
                      const lastSentFinalNormalized = lastSentFinalText.replace(/\s+/g, ' ').toLowerCase();
                      const partialNormalized = transcriptText.replace(/\s+/g, ' ').toLowerCase();
                      
                      // Get last few words from previous FINAL (check last 3-5 words)
                      const lastSentWords = lastSentFinalNormalized.split(/\s+/).filter(w => w.length > 2);
                      const partialWords = partialNormalized.split(/\s+/).filter(w => w.length > 2);
                      
                      // Check if partial starts with words that are related to the end of previous FINAL
                      if (lastSentWords.length > 0 && partialWords.length > 0) {
                        const lastWordsFromFinal = lastSentWords.slice(-3); // Last 3 words from FINAL
                        const firstWordsFromPartial = partialWords.slice(0, 3); // First 3 words from PARTIAL
                        
                        // Check if the first word(s) of partial match the last word(s) of final
                        // This catches cases like "desires" at end of FINAL followed by "Desires" at start of PARTIAL
                        let wordsToSkip = 0;
                        
                        // Check backwards: first word of partial vs last word of final, second vs second-to-last, etc.
                        for (let i = 0; i < Math.min(firstWordsFromPartial.length, lastWordsFromFinal.length); i++) {
                          const partialWord = firstWordsFromPartial[i];
                          const finalWord = lastWordsFromFinal[lastWordsFromFinal.length - 1 - i];
                          
                          if (wordsAreRelated(partialWord, finalWord)) {
                            wordsToSkip++;
                            console.log(`[HostMode] ⚠️ Partial word "${partialWord}" (position ${i}) matches final word "${finalWord}" (position ${lastWordsFromFinal.length - 1 - i})`);
                          } else {
                            // Stop checking once we find a non-match
                            break;
                          }
                        }
                        
                        if (wordsToSkip > 0) {
                          // Skip the duplicate words
                          const partialWordsArray = transcriptText.split(/\s+/);
                          partialTextToSend = partialWordsArray.slice(wordsToSkip).join(' ').trim();
                          console.log(`[HostMode] ✂️ Trimmed ${wordsToSkip} duplicate word(s) from partial: "${transcriptText.substring(0, 50)}..." → "${partialTextToSend.substring(0, 50)}..."`);
                          
                          // If nothing left after trimming, skip sending this partial entirely
                          if (!partialTextToSend || partialTextToSend.length < 3) {
                            console.log(`[HostMode] ⏭️ Skipping partial - all words are duplicates of previous FINAL`);
                            return; // Skip this partial entirely
                          }
                        }
                      }
                    }
                  }
                  
                  // CRITICAL: Don't send very short partials at the start of a new segment
                  // Google Speech needs time to refine the transcription, especially for the first word
                  // Very short partials (< 15 chars) at segment start are often inaccurate
                  const isVeryShortPartial = partialTextToSend.trim().length < 15;
                  syncPendingFinalization();
                  const hasPendingFinal = finalizationEngine.hasPendingFinalization();
                  syncForcedFinalBuffer();
                  const timeSinceLastFinal = lastSentFinalTime ? (Date.now() - lastSentFinalTime) : Infinity;
                  // New segment start if: no pending final AND (no forced final buffer OR forced final recovery not in progress) AND recent final (< 2 seconds)
                  const isNewSegmentStart = !hasPendingFinal && 
                                            (!forcedFinalBuffer || !forcedFinalBuffer.recoveryInProgress) &&
                                            timeSinceLastFinal < 2000;
                  
                  if (isVeryShortPartial && isNewSegmentStart) {
                    console.log(`[HostMode] ⏳ Delaying very short partial at segment start (${partialTextToSend.trim().length} chars, ${timeSinceLastFinal}ms since last final): "${partialTextToSend.substring(0, 30)}..." - waiting for transcription to stabilize`);
                    // Don't send yet - wait for partial to grow
                    // Continue tracking so we can send it once it's longer
                    return; // Skip sending this partial
                  }
                  
                  // Live partial transcript - send original immediately with sequence ID (solo mode style)
                  // Note: This is the initial send before grammar/translation, so use raw text
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
                    hasCorrection: false // Flag that correction is pending
                  }, true);
                  
                  // CRITICAL: If we have pending finalization, check if this partial extends it or is a new segment
                  // PHASE 8: Sync pendingFinalization before accessing
                  syncPendingFinalization();
                  if (finalizationEngine.hasPendingFinalization()) {
                    const pending = finalizationEngine.getPendingFinalization();
                    const timeSinceFinal = Date.now() - pending.timestamp;
                    const finalText = pending.text.trim();
                    const partialText = transcriptText.trim();
                    
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
                      // Mark that we've extended the wait
                      syncPendingFinalization();
                      if (pendingFinalization) {
                        pendingFinalization.extendedWaitCount = (pendingFinalization.extendedWaitCount || 0) + 1;
                      }
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
                        } else {
                          // No extending partial found via checkLongestExtends/checkLatestExtends
                          // But we might have partials that are continuations (don't start with final)
                          // Check longestPartialText and latestPartialText directly for overlap merge
                          syncPartialVariables();
                          if (longestPartialText && longestPartialText.length > 0) {
                            const longestTrimmed = longestPartialText.trim();
                            const merged = partialTracker.mergeWithOverlap(finalTrimmed, longestTrimmed);
                            if (merged && merged.length > finalTrimmed.length + 3) {
                              console.log(`[HostMode] ⚠️ Found continuation via overlap merge after wait (${pendingFinalization.text.length} → ${merged.length} chars)`);
                              console.log(`[HostMode] 📊 Merged: "${finalTrimmed}" + "${longestTrimmed}" = "${merged}"`);
                              finalTextToUse = merged;
                            }
                          } else if (latestPartialText && latestPartialText.length > 0) {
                            const latestTrimmed = latestPartialText.trim();
                            const merged = partialTracker.mergeWithOverlap(finalTrimmed, latestTrimmed);
                            if (merged && merged.length > finalTrimmed.length + 3) {
                              console.log(`[HostMode] ⚠️ Found continuation via overlap merge after wait (${pendingFinalization.text.length} → ${merged.length} chars)`);
                              console.log(`[HostMode] 📊 Merged: "${finalTrimmed}" + "${latestTrimmed}" = "${merged}"`);
                              finalTextToUse = merged;
                            }
                          }
                        }
                        
                        // CRITICAL: Always finalize, even if no extending partial found
                        // The final text might be incomplete, but we need to commit it to prevent loss
                        
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
                      // Continue tracking this partial (don't return - let it be tracked normally below)
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
                    } else if (!extendsFinal && timeSinceFinal > 600) {
                      // New segment detected - but check if final ends with complete sentence first
                      // If final doesn't end with complete sentence, wait longer before committing
                      syncPendingFinalization();
                      const finalEndsWithCompleteSentence = pendingFinalization ? finalizationEngine.endsWithCompleteSentence(pendingFinalization.text) : false;
                      // CRITICAL FIX: If we've already extended the wait once (from "short partial after incomplete FINAL"),
                      // and a new partial arrives that doesn't extend the final, commit immediately to prevent indefinite waiting
                      const hasExtendedWait = pendingFinalization ? (pendingFinalization.extendedWaitCount || 0) > 0 : false;
                      const shouldWait = !finalEndsWithCompleteSentence && timeSinceFinal < 3000 && !hasExtendedWait;
                      
                      if (shouldWait) {
                        // Final doesn't end with complete sentence and not enough time has passed - wait more
                        console.log(`[HostMode] ⏳ New segment detected but final incomplete - waiting longer (${timeSinceFinal}ms < 3000ms)`);
                        // Continue tracking - don't commit yet
                      } else {
                        if (hasExtendedWait) {
                          console.log(`[HostMode] ⚠️ Already extended wait once - committing FINAL to prevent indefinite waiting`);
                        }
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
                        
                        // Check saved partials first - ONLY if they start with the final
                        if (savedLongestPartial && savedLongestPartial.length > pendingFinalization.text.length) {
                          const savedLongestTrimmed = savedLongestPartial.trim();
                          if (savedLongestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[HostMode] ⚠️ Using SAVED LONGEST partial (${pendingFinalization.text.length} → ${savedLongestPartial.length} chars)`);
                            textToProcess = savedLongestPartial;
                          }
                        } else if (savedLatestPartial && savedLatestPartial.length > pendingFinalization.text.length) {
                          const savedLatestTrimmed = savedLatestPartial.trim();
                          if (savedLatestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[HostMode] ⚠️ Using SAVED LATEST partial (${pendingFinalization.text.length} → ${savedLatestPartial.length} chars)`);
                            textToProcess = savedLatestPartial;
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
                          } else {
                            console.log(`[HostMode] ⚠️ Ignoring CURRENT LONGEST partial - doesn't start with final (new segment detected)`);
                          }
                        } else if (latestPartialText && latestPartialText.length > textToProcess.length) {
                          const latestTrimmed = latestPartialText.trim();
                          // CRITICAL: Must start with final to prevent mixing segments
                          if (latestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[HostMode] ⚠️ Using CURRENT LATEST partial (${textToProcess.length} → ${latestPartialText.length} chars)`);
                            textToProcess = latestPartialText;
                          } else {
                            console.log(`[HostMode] ⚠️ Ignoring CURRENT LATEST partial - doesn't start with final (new segment detected)`);
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
                            hasCorrection: false
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
                                  updateType: 'grammar'
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
                              hasCorrection: false
                            }, true, targetLang);
                          }
                          
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
                                  updateType: 'grammar'
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
                                    updateType: 'grammar'
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
                                  hasCorrection: false // Grammar not ready yet
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
                                updateType: 'grammar' // Flag for grammar-only update
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
                                  updateType: 'grammar' // Flag for grammar-only update
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
                              hasCorrection: false
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
                                hasCorrection: false
                              }, true, targetLang);
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
                                    updateType: 'grammar'
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
                                      updateType: 'grammar'
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
                                    hasCorrection: false // Grammar not ready yet
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
                                    updateType: 'grammar'
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
                                      updateType: 'grammar'
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
                    // Verify it actually extends the forced final (not from a previous segment)
                    if (longestTrimmed.startsWith(forcedTrimmed) ||
                        (forcedTrimmed.length > 10 && longestTrimmed.substring(0, forcedTrimmed.length) === forcedTrimmed)) {
                      const missingWords = longestPartialSnapshot.substring(transcriptText.length).trim();
                      console.log(`[HostMode] ⚠️ Forced FINAL using LONGEST partial SNAPSHOT (${transcriptText.length} → ${longestPartialSnapshot.length} chars)`);
                      console.log(`[HostMode] 📊 Recovered (forced): "${missingWords}"`);
                      transcriptText = longestPartialSnapshot;
                    } else {
                      console.log(`[HostMode] ⚠️ Ignoring LONGEST partial snapshot - doesn't extend forced final`);
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
                      
                      console.log(`[HostMode] ⏰ Phase 1: Waiting ${forcedCommitEngine.PHASE_2_WAIT_MS}ms for late partials and POST-final audio accumulation...`);
                      console.log(`[HostMode] 🎯 DUAL BUFFER SYSTEM: Phase 1 started - audio buffer active`);
                      console.log(`[HostMode] 🎯 DUAL BUFFER: Phase 1 callback EXECUTED - recovery system is running!`);
                      console.log(`[HostMode] 🔧 DEBUG: Phase 1 timeout callback FIRED - recovery code will execute`);

                      // Phase 1: Wait for late partials to arrive AND for POST-final audio to accumulate
                      // CRITICAL: Declare recoveryResolve at the start of setTimeout callback so it's accessible in catch
                      let recoveryResolve = null;
                      
                      setTimeout(async () => {
                        console.warn('[HostMode] ⏰ Phase 2: Late partial window complete - capturing PRE+POST-final audio');
                        
                        // PHASE 8: Sync forced final buffer before accessing
                        syncForcedFinalBuffer();
                        
                        // CRITICAL: Check if buffer still exists (might have been committed by new segment)
                        if (!forcedCommitEngine.hasForcedFinalBuffer()) {
                          console.log('[HostMode] ⚠️ Forced final buffer already cleared (likely committed by new segment) - skipping recovery commit');
                          return;
                        }

                        // Snapshot any late partials that arrived during the wait period
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

                        // NOW reset partial tracking for next segment (clean slate for recovery)
                        // CRITICAL: Use snapshotAndReset to prevent race conditions where new partials
                        // arrive between snapshot and reset, which could mix segments
                        console.log(`[HostMode] 🧹 Resetting partial tracking for next segment`);
                        // PHASE 8: Reset partial tracking using tracker (snapshot already taken above)
                        partialTracker.reset();
                        syncPartialVariables(); // Sync variables after reset

                        // Calculate how much time has passed since forced final
                        const timeSinceForcedFinal = Date.now() - forcedFinalTimestamp;
                        console.log(`[HostMode] ⏱️ ${timeSinceForcedFinal}ms has passed since forced final`);

                        // ⭐ CRITICAL: Capture 2200ms window that includes BOTH:
                        // - PRE-final audio (1400ms before the final) ← Contains the decoder gap!
                        // - POST-final audio (800ms after the final) ← Captures complete phrases like "self-centered"
                        const captureWindowMs = forcedCommitEngine.CAPTURE_WINDOW_MS;
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
                          console.log(`[HostMode] 🎵 Starting decoder gap recovery with PRE+POST-final audio: ${recoveryAudio.length} bytes`);

                          try {
                            console.log(`[HostMode] 🔄 ENTERED recovery try block - about to import GoogleSpeechStream...`);
                            console.log(`[HostMode] 🔄 Importing GoogleSpeechStream...`);
                            const { GoogleSpeechStream } = await import('../googleSpeechStream.js');

                            const tempStream = new GoogleSpeechStream();
                            await tempStream.initialize(currentSourceLang, { 
                              disablePunctuation: true,
                              forceEnhanced: true  // Always use enhanced model for recovery streams
                            });

                            // CRITICAL: Disable auto-restart for recovery stream
                            // We want it to end naturally after processing our audio
                            tempStream.shouldAutoRestart = false;

                            console.log(`[HostMode] ✅ Temporary recovery stream initialized (auto-restart disabled)`);

                            // Wait for stream to be FULLY ready (not just exist)
                            console.log(`[HostMode] ⏳ Waiting for recovery stream to be ready...`);
                            const STREAM_READY_POLL_INTERVAL_MS = 25; // Optimized for faster detection
                            const STREAM_READY_MAX_WAIT_MS = 1500; // Optimized for latency
                            let streamReadyTimeout = 0;
                            while (!tempStream.isStreamReady() && streamReadyTimeout < STREAM_READY_MAX_WAIT_MS) {
                              await new Promise(resolve => setTimeout(resolve, STREAM_READY_POLL_INTERVAL_MS));
                              streamReadyTimeout += STREAM_READY_POLL_INTERVAL_MS;
                            }

                            if (!tempStream.isStreamReady()) {
                              console.log(`[HostMode] ❌ Recovery stream not ready after ${STREAM_READY_MAX_WAIT_MS}ms!`);
                              console.log(`[HostMode] Stream state:`, {
                                exists: !!tempStream.recognizeStream,
                                writable: tempStream.recognizeStream?.writable,
                                destroyed: tempStream.recognizeStream?.destroyed,
                                isActive: tempStream.isActive,
                                isRestarting: tempStream.isRestarting
                              });
                              throw new Error('Recognition stream not ready');
                            }

                            console.log(`[HostMode] ✅ Recovery stream ready after ${streamReadyTimeout}ms`);
                            await new Promise(resolve => setTimeout(resolve, 50)); // Optimized for latency
                            console.log(`[HostMode] ✅ Additional 50ms wait complete`);

                            // CRITICAL: Create recovery promise NOW (after stream is ready) so new segments can wait for it
                            // recoveryResolve is already declared at the start of setTimeout callback
                            const recoveryPromise = new Promise((resolve) => {
                              recoveryResolve = resolve;
                            });
                            
                            // Store recovery promise in buffer
                            syncForcedFinalBuffer();
                            if (forcedFinalBuffer) {
                              forcedCommitEngine.setRecoveryInProgress(true, recoveryPromise);
                              syncForcedFinalBuffer();
                              console.log('[HostMode] 🔄 Recovery promise created and stored in buffer');
                            }

                            // Set up result handler and create promise to wait for stream completion
                            let recoveredText = '';
                            let lastPartialText = '';
                            let allPartials = [];

                            // CRITICAL: Create promise that waits for Google's 'end' event
                            const streamCompletionPromise = new Promise((resolve) => {
                              tempStream.onResult((text, isPartial) => {
                                console.log(`[HostMode] 📥 Recovery stream ${isPartial ? 'PARTIAL' : 'FINAL'}: "${text}"`);
                                if (!isPartial) {
                                  recoveredText = text;
                                } else {
                                  allPartials.push(text);
                                  lastPartialText = text;
                                }
                              });

                              // Wait for Google to finish processing (stream 'end' event)
                              tempStream.recognizeStream.on('end', () => {
                                console.log(`[HostMode] 🏁 Recovery stream 'end' event received from Google`);
                                resolve();
                              });

                              // Also handle errors
                              tempStream.recognizeStream.on('error', (err) => {
                                console.error(`[HostMode] ❌ Recovery stream error:`, err);
                                resolve(); // Resolve anyway to prevent hanging
                              });
                            });

                            // Send the PRE+POST-final audio DIRECTLY to recognition stream
                            // BYPASS jitter buffer - send entire audio as one write for recovery
                            console.log(`[HostMode] 📤 Sending ${recoveryAudio.length} bytes directly to recovery stream (bypassing jitter buffer)...`);

                            // Write directly to the recognition stream
                            if (tempStream.recognizeStream && tempStream.isStreamReady()) {
                              tempStream.recognizeStream.write(recoveryAudio);
                              console.log(`[HostMode] ✅ Audio written directly to recognition stream`);

                              // CRITICAL: End write side IMMEDIATELY after writing
                              // This tells Google "no more audio coming, finalize what you have"
                              tempStream.recognizeStream.end();
                              console.log(`[HostMode] ✅ Write side closed - waiting for Google to process and send results...`);
                            } else {
                              console.error(`[HostMode] ❌ Recovery stream not ready for direct write!`);
                              throw new Error('Recovery stream not ready');
                            }

                            // Wait for Google to process and send back results
                            // This waits for the actual 'end' event, not a timer
                            console.log(`[HostMode] ⏳ Waiting for Google to decode and send results (stream 'end' event)...`);

                            // Add timeout to prevent infinite hang (optimized for latency)
                            const RECOVERY_STREAM_TIMEOUT_MS = 4000;
                            const timeoutPromise = new Promise((resolve) => {
                              setTimeout(() => {
                                console.warn(`[HostMode] ⚠️ Recovery stream timeout after ${RECOVERY_STREAM_TIMEOUT_MS}ms`);
                                resolve();
                              }, RECOVERY_STREAM_TIMEOUT_MS);
                            });

                            await Promise.race([streamCompletionPromise, timeoutPromise]);
                            console.log(`[HostMode] ✅ Google decode wait complete`);

                            // Use last partial if no final
                            if (!recoveredText && lastPartialText) {
                              recoveredText = lastPartialText;
                            }

                            console.log(`[HostMode] 📊 === DECODER GAP RECOVERY RESULTS ===`);
                            console.log(`[HostMode]   Total partials: ${allPartials.length}`);
                            console.log(`[HostMode]   All partials: ${JSON.stringify(allPartials)}`);
                            console.log(`[HostMode]   Final text: "${recoveredText}"`);
                            console.log(`[HostMode]   Audio sent: ${recoveryAudio.length} bytes`);

                            // Clean up
                            tempStream.destroy();

                            // Find the missing words by comparing recovered vs buffered
                            // Update finalTextToCommit (declared at line 1642) with recovered text
                            let finalRecoveredText = '';
                            let mergeResult = null;
                            if (recoveredText && recoveredText.length > 0) {
                              console.log(`[HostMode] ✅ Recovery stream transcribed: "${recoveredText}"`);

                              // Use shared merge utility for improved merge logic
                              syncPartialVariables();
                              mergeResult = mergeRecoveryText(
                                finalWithPartials,
                                recoveredText,
                                {
                                  nextPartialText: latestPartialText,
                                  nextFinalText: nextFinalAfterRecovery?.text,
                                  mode: 'HostMode'
                                }
                              );

                              // Use merge result
                              if (mergeResult.merged) {
                                finalTextToCommit = mergeResult.mergedText;
                                finalRecoveredText = mergeResult.mergedText; // Store for promise resolution
                                console.log(`[HostMode] 📋 Merge result: ${mergeResult.reason}`);
                              } else {
                                // Fallback to buffered text if merge failed
                                finalTextToCommit = finalWithPartials;
                                console.log(`[HostMode] ⚠️ Merge failed: ${mergeResult.reason}`);
                              }
                            } else {
                              console.log(`[HostMode] ⚠️ Recovery stream returned no text`);
                            }

                            // CRITICAL: If recovery found additional words, commit them as an update
                            // The forced final was already committed immediately when detected
                            // Recovery just adds the missing words we found
                            // Special handling for "full append" case (no overlap - entire recovery appended)
                            const originalBufferedText = finalWithPartials;
                            const isFullAppend = mergeResult?.reason?.startsWith('No overlap - full append');
                            const hasAdditionalWords = finalTextToCommit !== originalBufferedText && finalTextToCommit.length > originalBufferedText.length;
                            
                            if (isFullAppend || hasAdditionalWords) {
                              // Check if buffer still exists before committing recovery update
                              syncForcedFinalBuffer();
                              if (forcedCommitEngine.hasForcedFinalBuffer()) {
                                const additionalWords = finalTextToCommit.substring(originalBufferedText.length).trim();
                                if (isFullAppend) {
                                  console.log(`[HostMode] 📎 Full append case detected - appending entire recovery text`);
                                }
                                console.log(`[HostMode] ✅ Recovery found additional words: "${additionalWords}"`);
                                console.log(`[HostMode] 📊 Committing recovery update: "${finalTextToCommit.substring(0, 80)}..."`);
                                
                                // Mark as committed by recovery BEFORE clearing buffer
                                syncForcedFinalBuffer();
                                if (forcedFinalBuffer) {
                                  forcedFinalBuffer.committedByRecovery = true;
                                }
                                
                                // Commit the full recovered text (forced final + recovery words)
                                processFinalText(finalTextToCommit, { forceFinal: true });
                                forcedCommitEngine.clearForcedFinalBuffer();
                                syncForcedFinalBuffer();
                                
                                // Reset recovery tracking after commit
                                recoveryStartTime = 0;
                                nextFinalAfterRecovery = null;
                                
                                // Mark that we've already committed, so timeout callback can skip
                                console.log(`[HostMode] ✅ Recovery commit completed - timeout callback will skip`);
                              } else {
                                console.log(`[HostMode] ⚠️ Buffer already cleared - recovery found words but cannot commit update`);
                              }
                            } else {
                              console.log(`[HostMode] ⚠️ No new text recovered - will commit forced final with grammar correction via timeout`);
                              // Don't clear buffer - let timeout callback commit the forced final (with grammar correction)
                              // The timeout will handle committing the original forced final text
                            }

                            // CRITICAL: Resolve recovery promise with recovered text (or empty if nothing found)
                            // This allows other code (like new FINALs) to wait for recovery to complete
                            if (recoveryResolve) {
                              console.log(`[HostMode] ✅ Resolving recovery promise with recovered text: "${finalRecoveredText || ''}"`);
                              recoveryResolve(finalRecoveredText || '');
                            }

                          } catch (error) {
                            console.error(`[HostMode] ❌ Decoder gap recovery failed:`, error.message);
                            console.error(`[HostMode] ❌ Error stack:`, error.stack);
                            console.error(`[HostMode] ❌ Full error object:`, error);
                            
                            // CRITICAL: Resolve recovery promise even on error (with empty string)
                            // This prevents other code from hanging while waiting for recovery
                            if (recoveryResolve) {
                              console.log(`[HostMode] ⚠️ Resolving recovery promise with empty text due to error`);
                              recoveryResolve('');
                            } else {
                              console.warn('[HostMode] ⚠️ recoveryResolve not available in catch block - this should not happen');
                            }
                          } finally {
                            // Mark recovery as complete
                            syncForcedFinalBuffer();
                            if (forcedCommitEngine.hasForcedFinalBuffer()) {
                              forcedCommitEngine.setRecoveryInProgress(false, null);
                              syncForcedFinalBuffer();
                            }
                          }
                        } else {
                          // No recovery audio available
                          console.log(`[HostMode] ⚠️ No recovery audio available (${recoveryAudio.length} bytes) - committing without recovery`);
                        }
                        
                        // CRITICAL: Check if recovery already committed before committing from timeout
                        syncForcedFinalBuffer();
                        const bufferStillExists = forcedCommitEngine.hasForcedFinalBuffer();
                        const wasCommittedByRecovery = forcedFinalBuffer?.committedByRecovery === true;
                        
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
                        
                        if (!bufferStillExists) {
                          console.log('[HostMode] ⚠️ Forced final buffer already cleared - but committing forced final to ensure it is not lost');
                          // Buffer was cleared (likely by extending partial or new FINAL), but we should still commit
                          // the forced final text to ensure it's not lost (recovery didn't commit it, so timeout must)
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
                        
                        // Reset recovery tracking after commit
                        recoveryStartTime = 0;
                        nextFinalAfterRecovery = null;
                      }, forcedCommitEngine.PHASE_2_WAIT_MS);  // Phase 2: Wait to capture POST-final audio (800ms) + late partials buffer (200ms)
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
                  
                  // CRITICAL: If recovery is in progress, wait for it to complete first
                  // This ensures forced finals are committed in chronological order
                  if (buffer.recoveryInProgress && buffer.recoveryPromise) {
                    console.log('[HostMode] ⏳ Forced final recovery in progress - waiting for completion before processing new FINAL (maintaining order)...');
                    try {
                      const recoveredText = await buffer.recoveryPromise;
                      if (recoveredText && recoveredText.length > 0) {
                        console.log(`[HostMode] ✅ Forced final recovery completed with text: "${recoveredText.substring(0, 60)}..."`);
                        // Recovery found words - commit the forced final first
                        console.log('[HostMode] 📝 Committing forced final first (maintaining chronological order)');
                        
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
                        console.log('[HostMode] 📝 Now processing new FINAL that arrived after forced final');
                        // Continue with transcriptText processing below
                      } else {
                        console.log('[HostMode] ⚠️ Forced final recovery completed but no text was recovered');
                        // Recovery found nothing - need to commit the forced final first, then process new FINAL
                        console.log('[HostMode] 📝 Committing forced final first (recovery found nothing, but forced final must be committed)');
                        
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
      processFinalText(forcedFinalText, { forceFinal: true });
      
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

