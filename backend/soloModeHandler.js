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
import { partialTranslationWorker, finalTranslationWorker } from './translationWorkers.js';
import { realtimePartialTranslationWorker, realtimeFinalTranslationWorker } from './translationWorkersRealtime.js';
import { grammarWorker } from './grammarWorker.js';
import { CoreEngine } from '../core/engine/coreEngine.js';
// PHASE 7: Using CoreEngine which coordinates all extracted engines
// Individual engines are still accessible via coreEngine properties if needed

export async function handleSoloMode(clientWs) {
  console.log("[SoloMode] ⚡ Connection using Google Speech + OpenAI Translation");

  let speechStream = null;
  let currentSourceLang = 'en';
  let currentTargetLang = 'es';
  let usePremiumTier = false; // Tier selection: false = basic (Chat API), true = premium (Realtime API)
  let legacySessionId = `session_${Date.now()}`;
  
  // MULTI-SESSION OPTIMIZATION: Track this session for fair-share allocation
  // This allows the rate limiter to distribute capacity fairly across sessions
  const sessionId = legacySessionId;
  
  // PHASE 7: Core Engine Orchestrator - coordinates all extracted engines
  // Initialize core engine (replaces individual engine instances)
  const coreEngine = new CoreEngine();
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
    // Use timeline tracker to create sequenced message
    const { message, seqId } = timelineTracker.createSequencedMessage(messageData, isPartial);
    
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
    console.log(`[SoloMode] 📤 Sending message (seq: ${seqId}, isPartial: ${isPartial})`);
    
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

  // Handle client messages
  clientWs.on("message", async (msg) => {
    try {
      const message = JSON.parse(msg.toString());
      console.log("[SoloMode] Client message:", message.type);

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
          // Update language preferences and tier
          const prevSourceLang = currentSourceLang;
          const prevTargetLang = currentTargetLang;
          
          console.log(`[SoloMode] Init received - sourceLang: ${message.sourceLang}, targetLang: ${message.targetLang}, tier: ${message.tier || 'basic'}`);
          
          if (message.sourceLang) {
            currentSourceLang = message.sourceLang;
          }
          if (message.targetLang) {
            currentTargetLang = message.targetLang;
          }
          if (message.tier !== undefined) {
            const newTier = message.tier === 'premium' || message.tier === true;
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
              
              // Initialize with source language for transcription
              await speechStream.initialize(currentSourceLang);
              
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
              let lastSentFinalTime = 0; // Timestamp when last FINAL was sent
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
              
              // Helper function to process final text (defined here so it can access closure variables)
              const processFinalText = (textToProcess, options = {}) => {
                (async () => {
                  try {
                    if (isTranscriptionOnly) {
                      // Same language - just send transcript with grammar correction (English only)
                      if (currentSourceLang === 'en') {
                        try {
                          const correctedText = await grammarWorker.correctFinal(textToProcess, process.env.OPENAI_API_KEY);
                          sendWithSequence({
                            type: 'translation',
                            originalText: textToProcess,
                            correctedText: correctedText,
                            translatedText: correctedText, // Use corrected text as the display text
                            timestamp: Date.now(),
                            hasCorrection: true,
                            isTranscriptionOnly: true,
                            forceFinal: !!options.forceFinal
                          }, false);
                          
                          // CRITICAL: Update last sent FINAL tracking after sending
                          lastSentFinalText = textToProcess;
                          lastSentFinalTime = Date.now();
                          
                          // CRITICAL: ALWAYS check for partials that extend this just-sent FINAL
                          checkForExtendingPartialsAfterFinal(textToProcess);
                        } catch (error) {
                          console.error('[SoloMode] Grammar correction error:', error);
                          sendWithSequence({
                            type: 'translation',
                            originalText: textToProcess,
                            correctedText: textToProcess,
                            translatedText: textToProcess,
                            timestamp: Date.now(),
                            hasCorrection: false,
                            isTranscriptionOnly: true,
                            forceFinal: !!options.forceFinal
                          }, false);
                        }
                      } else {
                        // Non-English transcription - no grammar correction
                        sendWithSequence({
                          type: 'translation',
                          originalText: textToProcess,
                          correctedText: textToProcess,
                          translatedText: textToProcess,
                          timestamp: Date.now(),
                          hasCorrection: false,
                          isTranscriptionOnly: true,
                          forceFinal: !!options.forceFinal
                        }, false);
                        
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
                          console.log(`[SoloMode] 🔀 Using ${workerType} API for final translation (${correctedText.length} chars)`);
                          translatedText = await finalWorker.translateFinal(
                            correctedText, // Use corrected text for translation
                            currentSourceLang,
                            currentTargetLang,
                            process.env.OPENAI_API_KEY,
                            sessionId // MULTI-SESSION: Pass sessionId for fair-share allocation
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

                        sendWithSequence({
                          type: 'translation',
                          originalText: textToProcess, // Use final text (may include recovered words from partials)
                          correctedText: correctedText, // Grammar-corrected text (updates when available)
                          translatedText: translatedText, // Translation of CORRECTED text
                          timestamp: Date.now(),
                          hasTranslation: translatedText && !translatedText.startsWith('[Translation error'),
                          hasCorrection: hasCorrection,
                          isTranscriptionOnly: false,
                          forceFinal: !!options.forceFinal
                        }, false);
                        
                        // CRITICAL: Update last sent FINAL tracking after sending
                        lastSentFinalText = textToProcess;
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
                          forceFinal: !!options.forceFinal
                        }, false);
                        
                        // CRITICAL: Update last sent FINAL tracking after sending (even on error, if we have text)
                        if (error.skipRequest || finalText !== `[Translation error: ${error.message}]`) {
                          lastSentFinalText = textToProcess;
                          lastSentFinalTime = Date.now();
                          
                          // CRITICAL: ALWAYS check for partials that extend this just-sent FINAL
                          checkForExtendingPartialsAfterFinal(textToProcess);
                        }
                      }
                    }
                  } catch (error) {
                    console.error(`[SoloMode] Error processing final:`, error);
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
                console.log(`[SoloMode] 📥 RESULT RECEIVED: ${isPartial ? 'PARTIAL' : 'FINAL'} "${transcriptText.substring(0, 60)}..." (meta: ${JSON.stringify(meta)})`);

                if (isPartial) {
                  // PHASE 6: Use Forced Commit Engine to check for forced final extensions
                  syncForcedFinalBuffer(); // Sync variable from engine
                  if (forcedCommitEngine.hasForcedFinalBuffer()) {
                    // CRITICAL: Check if this partial extends the forced final or is a new segment
                    const extension = forcedCommitEngine.checkPartialExtendsForcedFinal(transcriptText);
                    
                    if (extension && extension.extends) {
                      // Partial extends the forced final - merge and commit
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
                      console.log('[SoloMode] 🔀 New segment detected - will let POST-final recovery complete first');
                      // DON'T clear timeout or set to null - let it run!
                      // The timeout will commit the final after POST-final audio recovery
                      // Continue processing the new partial as a new segment
                    }
                  }
                  // PHASE 4: Update partial tracking using Partial Tracker
                  partialTracker.updatePartial(transcriptText);
                  syncPartialVariables(); // Sync variables for compatibility
                  const translationSeedText = applyCachedCorrections(transcriptText);
                  // Live partial transcript - send original immediately with sequence ID
                  // Note: This is the initial send before grammar/translation, so use raw text
                  const seqId = sendWithSequence({
                    type: 'translation',
                    originalText: transcriptText, // Raw STT text (shown immediately)
                    translatedText: isTranscriptionOnly ? transcriptText : undefined, // Only set if transcription-only mode
                    timestamp: Date.now(),
                    isTranscriptionOnly: isTranscriptionOnly,
                    hasTranslation: false, // Flag that translation is pending
                    hasCorrection: false // Flag that correction is pending
                  }, true);
                  
                  // CRITICAL: If we have pending finalization, check if this partial extends it or is a new segment
                  if (pendingFinalization) {
                    const timeSinceFinal = Date.now() - pendingFinalization.timestamp;
                    const finalText = pendingFinalization.text.trim();
                    const partialText = transcriptText.trim();
                    
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
                    // If final doesn't end with complete sentence, wait longer for continuation (up to 5 seconds)
                    const mightBeContinuation = !finalEndsWithCompleteSentence && isVeryShortPartial && timeSinceFinal < 5000;
                    
                    // If partial might be a continuation, wait longer and don't treat as new segment yet
                    // Continue tracking the partial so it can grow into the complete word
                    // CRITICAL: Check max wait time - don't extend wait if we've already waited too long
                    const timeSinceMaxWait = Date.now() - pendingFinalization.maxWaitTimestamp;
                    if (mightBeContinuation && !extendsFinal && timeSinceMaxWait < MAX_FINALIZATION_WAIT_MS - 1000) {
                      console.log(`[SoloMode] ⚠️ Short partial after incomplete FINAL - likely continuation (FINAL: "${finalText}", partial: "${partialText}")`);
                      console.log(`[SoloMode] ⏳ Extending wait to see if partial grows into complete word/phrase`);
                      // Extend timeout significantly to wait for complete word/phrase
                      // PHASE 5: Clear timeout using engine
                      finalizationEngine.clearPendingFinalizationTimeout();
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
                        }

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
                      
                      // Only wait if: final is incomplete AND we haven't hit max wait AND it's been less than 2000ms
                      // This prevents indefinite waiting while still allowing short waits for continuations
                      if (!finalEndsWithCompleteSentence && timeSinceFinal < 2000 && timeSinceMaxWait < MAX_FINALIZATION_WAIT_MS - 1000) {
                        // Final doesn't end with complete sentence and not enough time has passed - wait more
                        console.log(`[SoloMode] ⏳ New segment detected but final incomplete - waiting longer (${timeSinceFinal}ms < 2000ms, ${timeSinceMaxWait}ms / ${MAX_FINALIZATION_WAIT_MS}ms)`);
                        // Continue tracking - don't commit yet
                      } else {
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

                      // PHASE 6: Create forced final buffer using engine
                      forcedCommitEngine.createForcedFinalBuffer(transcriptText, forcedFinalTimestamp);
                      syncForcedFinalBuffer(); // Sync variable for compatibility

                      // PHASE 6: Set up two-phase timeout using engine
                      forcedCommitEngine.setForcedFinalBufferTimeout(() => {
                          console.log('[SoloMode] ⏰ Phase 1: Waiting 1200ms for late partials and POST-final audio accumulation...');

                          // Phase 1: Wait 1200ms for late partials to arrive AND for POST-final audio to accumulate
                          setTimeout(async () => {
                            console.warn('[SoloMode] ⏰ Phase 2: Late partial window complete - capturing PRE+POST-final audio');
                            
                            // PHASE 6: Sync forced final buffer before accessing
                            syncForcedFinalBuffer();

                          // Snapshot any late partials that arrived during the 1200ms wait
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
                          console.log(`[SoloMode] 🧹 Resetting partial tracking for next segment`);
                          // PHASE 4: Reset partial tracking using tracker
                          partialTracker.reset();
                          syncPartialVariables(); // Sync variables after reset

                          // Calculate how much time has passed since forced final
                          const timeSinceForcedFinal = Date.now() - forcedFinalTimestamp;
                          console.log(`[SoloMode] ⏱️ ${timeSinceForcedFinal}ms has passed since forced final`);

                          // ⭐ CRITICAL: Capture 2200ms window that includes BOTH:
                          // - PRE-final audio (1400ms before the final) ← Contains the decoder gap!
                          // - POST-final audio (800ms after the final) ← Captures complete phrases like "self-centered"
                          const captureWindowMs = 2200;
                          console.log(`[SoloMode] 🎵 Capturing PRE+POST-final audio: last ${captureWindowMs}ms`);
                          console.log(`[SoloMode] 📊 Window covers: [T-${captureWindowMs - timeSinceForcedFinal}ms to T+${timeSinceForcedFinal}ms]`);
                          console.log(`[SoloMode] 🎯 This INCLUDES the decoder gap at ~T-200ms where missing words exist!`);

                          const recoveryAudio = speechStream.getRecentAudio(captureWindowMs);
                          console.log(`[SoloMode] 🎵 Captured ${recoveryAudio.length} bytes of PRE+POST-final audio`);

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

                          console.log(`[SoloMode] 📊 Text to commit after late partial recovery:`);
                          console.log(`[SoloMode]   Text: "${finalTextToCommit}"`);

                          // ⭐ NOW: Send the PRE+POST-final audio to recovery stream
                          // This audio includes the decoder gap at T-200ms where "spent" exists!
                          if (recoveryAudio.length > 0) {
                            console.log(`[SoloMode] 🎵 Starting decoder gap recovery with PRE+POST-final audio: ${recoveryAudio.length} bytes`);

                            try {
                              console.log(`[SoloMode] 🔄 ENTERED recovery try block - about to import GoogleSpeechStream...`);
                              console.log(`[SoloMode] 🔄 Importing GoogleSpeechStream...`);
                              const { GoogleSpeechStream } = await import('./googleSpeechStream.js');

                              const tempStream = new GoogleSpeechStream();
                              await tempStream.initialize(currentSourceLang, { disablePunctuation: true });

                              // CRITICAL: Disable auto-restart for recovery stream
                              // We want it to end naturally after processing our audio
                              tempStream.shouldAutoRestart = false;

                              console.log(`[SoloMode] ✅ Temporary recovery stream initialized (auto-restart disabled)`);

                              // Wait for stream to be FULLY ready (not just exist)
                              console.log(`[SoloMode] ⏳ Waiting for recovery stream to be ready...`);
                              let streamReadyTimeout = 0;
                              while (!tempStream.isStreamReady() && streamReadyTimeout < 2000) {
                                await new Promise(resolve => setTimeout(resolve, 50));
                                streamReadyTimeout += 50;
                              }

                              if (!tempStream.isStreamReady()) {
                                console.log(`[SoloMode] ❌ Recovery stream not ready after 2000ms!`);
                                console.log(`[SoloMode] Stream state:`, {
                                  exists: !!tempStream.recognizeStream,
                                  writable: tempStream.recognizeStream?.writable,
                                  destroyed: tempStream.recognizeStream?.destroyed,
                                  isActive: tempStream.isActive,
                                  isRestarting: tempStream.isRestarting
                                });
                                throw new Error('Recognition stream not ready');
                              }

                              console.log(`[SoloMode] ✅ Recovery stream ready after ${streamReadyTimeout}ms`);
                              await new Promise(resolve => setTimeout(resolve, 100));
                              console.log(`[SoloMode] ✅ Additional 100ms wait complete`);

                              // Set up result handler and create promise to wait for stream completion
                              let recoveredText = '';
                              let lastPartialText = '';
                              let allPartials = [];

                              // CRITICAL: Create promise that waits for Google's 'end' event
                              const streamCompletionPromise = new Promise((resolve) => {
                                tempStream.onResult((text, isPartial) => {
                                  console.log(`[SoloMode] 📥 Recovery stream ${isPartial ? 'PARTIAL' : 'FINAL'}: "${text}"`);
                                  if (!isPartial) {
                                    recoveredText = text;
                                  } else {
                                    allPartials.push(text);
                                    lastPartialText = text;
                                  }
                                });

                                // Wait for Google to finish processing (stream 'end' event)
                                tempStream.recognizeStream.on('end', () => {
                                  console.log(`[SoloMode] 🏁 Recovery stream 'end' event received from Google`);
                                  resolve();
                                });

                                // Also handle errors
                                tempStream.recognizeStream.on('error', (err) => {
                                  console.error(`[SoloMode] ❌ Recovery stream error:`, err);
                                  resolve(); // Resolve anyway to prevent hanging
                                });
                              });

                              // Send the PRE+POST-final audio DIRECTLY to recognition stream
                              // BYPASS jitter buffer - send entire audio as one write for recovery
                              console.log(`[SoloMode] 📤 Sending ${recoveryAudio.length} bytes directly to recovery stream (bypassing jitter buffer)...`);

                              // Write directly to the recognition stream
                              if (tempStream.recognizeStream && tempStream.isStreamReady()) {
                                tempStream.recognizeStream.write(recoveryAudio);
                                console.log(`[SoloMode] ✅ Audio written directly to recognition stream`);

                                // CRITICAL: End write side IMMEDIATELY after writing
                                // This tells Google "no more audio coming, finalize what you have"
                                tempStream.recognizeStream.end();
                                console.log(`[SoloMode] ✅ Write side closed - waiting for Google to process and send results...`);
                              } else {
                                console.error(`[SoloMode] ❌ Recovery stream not ready for direct write!`);
                                throw new Error('Recovery stream not ready');
                              }

                              // Wait for Google to process and send back results
                              // This waits for the actual 'end' event, not a timer
                              console.log(`[SoloMode] ⏳ Waiting for Google to decode and send results (stream 'end' event)...`);

                              // Add timeout to prevent infinite hang
                              const timeoutPromise = new Promise((resolve) => {
                                setTimeout(() => {
                                  console.warn(`[SoloMode] ⚠️ Recovery stream timeout after 5000ms`);
                                  resolve();
                                }, 5000);
                              });

                              await Promise.race([streamCompletionPromise, timeoutPromise]);
                              console.log(`[SoloMode] ✅ Google decode wait complete`);

                              // Use last partial if no final
                              if (!recoveredText && lastPartialText) {
                                recoveredText = lastPartialText;
                              }

                              console.log(`[SoloMode] 📊 === DECODER GAP RECOVERY RESULTS ===`);
                              console.log(`[SoloMode]   Total partials: ${allPartials.length}`);
                              console.log(`[SoloMode]   All partials: ${JSON.stringify(allPartials)}`);
                              console.log(`[SoloMode]   Final text: "${recoveredText}"`);
                              console.log(`[SoloMode]   Audio sent: ${recoveryAudio.length} bytes`);

                              // Clean up
                              tempStream.destroy();

                              // Find the missing words by comparing recovered vs buffered
                              if (recoveredText && recoveredText.length > 0) {
                                console.log(`[SoloMode] ✅ Recovery stream transcribed: "${recoveredText}"`);

                                // SMART MERGE LOGIC: Find overlap and extract new continuation words
                                // Example: finalWithPartials="...life is best spent for", recovered="best spent fulfilling our own"
                                // We need to: find "best spent" overlap, extract "fulfilling our own", append to finalWithPartials

                                const bufferedTrimmed = finalWithPartials.trim();
                                const recoveredTrimmed = recoveredText.trim();
                                const bufferedWords = bufferedTrimmed.split(/\s+/);
                                const recoveredWords = recoveredTrimmed.split(/\s+/);

                                console.log(`[SoloMode] 🔍 Attempting smart merge:`);
                                console.log(`[SoloMode]   Buffered (${bufferedWords.length} words): "${bufferedTrimmed.substring(Math.max(0, bufferedTrimmed.length - 60))}"`);
                                console.log(`[SoloMode]   Recovered (${recoveredWords.length} words): "${recoveredTrimmed}"`);

                                let mergedSuccessfully = false;

                                // PRODUCTION-GRADE MERGE ALGORITHM: Single-word overlap strategy
                                // Used by real ASR platforms - simple, stable, handles all edge cases
                                // Goal: Find last overlapping word, append only what comes after it

                                console.log(`[SoloMode] 🔍 Merge algorithm:`);
                                console.log(`[SoloMode]   Buffered (${bufferedWords.length} words): "${bufferedTrimmed.substring(Math.max(0, bufferedTrimmed.length - 60))}"`);
                                console.log(`[SoloMode]   Recovered (${recoveredWords.length} words): "${recoveredTrimmed}"`);

                                // Step 1: Find the last overlapping word
                                // Scan from END of buffered words, look for first match in recovery
                                let matchIndex = -1;
                                let matchedWord = null;

                                for (let i = bufferedWords.length - 1; i >= 0; i--) {
                                  const bufferedWord = bufferedWords[i].toLowerCase().replace(/[.,!?;:\-'"()]/g, '');

                                  // Look for this word anywhere in recovery (normalized)
                                  for (let j = 0; j < recoveredWords.length; j++) {
                                    const recoveredWord = recoveredWords[j].toLowerCase().replace(/[.,!?;:\-'"()]/g, '');

                                    if (bufferedWord === recoveredWord && bufferedWord.length > 0) {
                                      matchIndex = j;  // Index in RECOVERY where overlap occurs
                                      matchedWord = bufferedWords[i];
                                      break;
                                    }
                                  }

                                  if (matchIndex !== -1) {
                                    break;  // Found the last overlapping word
                                  }
                                }

                                // Step 2: Merge based on overlap
                                if (matchIndex !== -1) {
                                  // Found overlap - append only words AFTER the match
                                  const tail = recoveredWords.slice(matchIndex + 1);

                                  if (tail.length > 0) {
                                    // Append new words to buffered text
                                    finalTextToCommit = bufferedTrimmed + ' ' + tail.join(' ');
                                    console.log(`[SoloMode] 🎯 Decoder gap recovery: Found overlap at word "${matchedWord}"`);
                                    console.log(`[SoloMode]   Match position in recovery: word ${matchIndex + 1}/${recoveredWords.length}`);
                                    console.log(`[SoloMode]   New words to append: "${tail.join(' ')}"`);
                                    console.log(`[SoloMode]   Before: "${bufferedTrimmed}"`);
                                    console.log(`[SoloMode]   After:  "${finalTextToCommit}"`);
                                    mergedSuccessfully = true;
                                  } else {
                                    // Recovery only confirms what we have
                                    console.log(`[SoloMode] ✅ Recovery confirms buffered ending (overlap at "${matchedWord}", no new words)`);
                                    mergedSuccessfully = true;
                                  }
                                } else {
                                  // Tier 1 failed - no exact overlap found
                                  // Try Tier 2: Fuzzy matching fallback (handles ASR word rewrites)
                                  console.log(`[SoloMode] ⚠️ No exact overlap found - trying fuzzy matching...`);

                                  // Helper: Calculate Levenshtein distance (edit distance)
                                  function levenshtein(a, b) {
                                    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
                                    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
                                    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
                                    for (let j = 1; j <= b.length; j++) {
                                      for (let i = 1; i <= a.length; i++) {
                                        const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
                                        matrix[j][i] = Math.min(
                                          matrix[j][i - 1] + 1,       // insertion
                                          matrix[j - 1][i] + 1,       // deletion
                                          matrix[j - 1][i - 1] + indicator  // substitution
                                        );
                                      }
                                    }
                                    return matrix[b.length][a.length];
                                  }

                                  // Helper: Find best fuzzy match using Levenshtein distance
                                  function fuzzyAnchor(finalWords, recoveryWords) {
                                    let best = { score: 0, finalWord: null, recoveryIndex: -1 };

                                    // Check last 6 words from buffered (most likely to overlap)
                                    const startIdx = Math.max(0, finalWords.length - 6);

                                    for (let i = finalWords.length - 1; i >= startIdx; i--) {
                                      const fw = finalWords[i].toLowerCase().replace(/[.,!?;:\-'"()]/g, '');

                                      // Skip very short words (likely articles/prepositions - unreliable anchors)
                                      if (fw.length < 2) continue;

                                      for (let j = 0; j < recoveryWords.length; j++) {
                                        const rw = recoveryWords[j].toLowerCase().replace(/[.,!?;:\-'"()]/g, '');

                                        if (rw.length < 2) continue;

                                        // Calculate similarity: 1 - (distance / max_length)
                                        const lev = levenshtein(fw, rw);
                                        const maxLen = Math.max(fw.length, rw.length);
                                        const similarity = 1 - (lev / maxLen);

                                        if (similarity > best.score) {
                                          best = {
                                            score: similarity,
                                            finalWord: finalWords[i],
                                            recoveryWord: recoveryWords[j],
                                            recoveryIndex: j
                                          };
                                        }
                                      }
                                    }

                                    return best;
                                  }

                                  // Try fuzzy matching with conservative threshold
                                  const FUZZY_THRESHOLD = 0.72; // Require 72% similarity
                                  const fuzzyMatch = fuzzyAnchor(bufferedWords, recoveredWords);

                                  if (fuzzyMatch.score >= FUZZY_THRESHOLD) {
                                    // Fuzzy match found - use it as anchor
                                    const tail = recoveredWords.slice(fuzzyMatch.recoveryIndex + 1);

                                    if (tail.length > 0) {
                                      finalTextToCommit = bufferedTrimmed + ' ' + tail.join(' ');
                                      console.log(`[SoloMode] 🎯 Fuzzy match found: "${fuzzyMatch.finalWord}" ≈ "${fuzzyMatch.recoveryWord}" (${(fuzzyMatch.score * 100).toFixed(0)}% similar)`);
                                      console.log(`[SoloMode]   Match position in recovery: word ${fuzzyMatch.recoveryIndex + 1}/${recoveredWords.length}`);
                                      console.log(`[SoloMode]   New words to append: "${tail.join(' ')}"`);
                                      console.log(`[SoloMode]   Before: "${bufferedTrimmed}"`);
                                      console.log(`[SoloMode]   After:  "${finalTextToCommit}"`);
                                      mergedSuccessfully = true;
                                    } else {
                                      console.log(`[SoloMode] ✅ Fuzzy match confirms buffered ending (no new words)`);
                                      mergedSuccessfully = true;
                                    }
                                  } else {
                                    // Tier 3: No overlap at all (exact or fuzzy) - append entire recovery
                                    // This prevents word loss when recovery captures completely new content
                                    console.log(`[SoloMode] ⚠️ No fuzzy match above threshold (best: ${(fuzzyMatch.score * 100).toFixed(0)}% < ${FUZZY_THRESHOLD * 100}%)`);
                                    console.log(`[SoloMode] 📎 Appending entire recovery to prevent word loss`);
                                    finalTextToCommit = bufferedTrimmed + ' ' + recoveredTrimmed;
                                    console.log(`[SoloMode]   Before: "${bufferedTrimmed}"`);
                                    console.log(`[SoloMode]   After:  "${finalTextToCommit}"`);
                                    mergedSuccessfully = true;
                                  }
                                }

                                // Normalize spacing
                                if (mergedSuccessfully) {
                                  finalTextToCommit = finalTextToCommit.trim();
                                }
                              }

                            } catch (error) {
                              console.error(`[SoloMode] ❌ Decoder gap recovery failed:`, error.message);
                              console.error(`[SoloMode] ❌ Error stack:`, error.stack);
                              console.error(`[SoloMode] ❌ Full error object:`, error);
                            }
                          }
                          console.log(`[SoloMode] 📝 Committing forced final: "${finalTextToCommit.substring(0, 80)}..." (${finalTextToCommit.length} chars)`);
                          processFinalText(finalTextToCommit, { forceFinal: true });
                          // PHASE 6: Clear forced final buffer using engine
                          forcedCommitEngine.clearForcedFinalBuffer();
                          syncForcedFinalBuffer();
                        }, 1200);  // Phase 2: Wait 1200ms to capture more POST-final audio (shifts window from [T-1500,T+500] to [T-800,T+1200])
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
                    console.log('[SoloMode] 🔁 Merging buffered forced final with new FINAL transcript');
                    forcedCommitEngine.clearForcedFinalBufferTimeout();
                    const buffer = forcedCommitEngine.getForcedFinalBuffer();
                    const merged = mergeWithOverlap(buffer.text, transcriptText);
                    if (merged) {
                      transcriptText = merged;
                    } else {
                      // Merge failed - use the new FINAL transcript as-is
                      console.warn('[SoloMode] ⚠️ Merge failed, using new FINAL transcript');
                    }
                    forcedCommitEngine.clearForcedFinalBuffer();
                    syncForcedFinalBuffer();
                  }
                  
                  // CRITICAL: Null check after merge operations
                  if (!transcriptText || transcriptText.length === 0) {
                    console.warn('[SoloMode] ⚠️ transcriptText is null or empty after merge operations - skipping final processing');
                    return;
                  }
                  
                  // CRITICAL: Check if this FINAL is a continuation of the last sent FINAL
                  // This prevents splitting sentences like "Where two or three" / "Are gathered together"
                  if (lastSentFinalText && (Date.now() - lastSentFinalTime) < FINAL_CONTINUATION_WINDOW_MS) {
                    const lastSentTrimmed = lastSentFinalText.trim();
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
                  
                  // CRITICAL: Sentence-aware finalization - wait for complete sentences
                  // If FINAL doesn't end with a complete sentence, wait longer for continuation
                  // But be more reasonable - don't wait too long as it causes delays
                  const finalEndsWithCompleteSentence = endsWithCompleteSentence(transcriptText);
                  if (!finalEndsWithCompleteSentence) {
                    // FINAL doesn't end with complete sentence - wait longer for continuation
                    // Reduced from 4-8 seconds to 1.5-3 seconds to prevent excessive delays
                    const SENTENCE_WAIT_MS = Math.max(1500, Math.min(3000, transcriptText.length * 10)); // 1.5-3 seconds based on length
                    WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, SENTENCE_WAIT_MS);
                    console.log(`[SoloMode] ⚠️ FINAL doesn't end with complete sentence - extending wait to ${WAIT_FOR_PARTIALS_MS}ms to catch sentence completion`);
                    console.log(`[SoloMode] 📝 Current text: "${transcriptText.substring(Math.max(0, transcriptText.length - 60))}"`);
                  } else {
                    // FINAL ends with complete sentence - still check for punctuation for backward compatibility
                    const finalEndsWithPunctuation = /[.!?…]$/.test(transcriptText.trim());
                    if (!finalEndsWithPunctuation) {
                      // Has sentence ending but not standard punctuation - still wait a bit
                      WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 1000);
                      console.log(`[SoloMode] ⚠️ FINAL doesn't end with standard punctuation - extending wait to ${WAIT_FOR_PARTIALS_MS}ms`);
                    }
                  }
                  
                  // CRITICAL: Before setting up finalization, check if we have longer partials that extend this final
                  // This ensures we don't lose words like "gathered" that might be in a partial but not in the FINAL
                  // ALSO: Check if final ends mid-word - if so, wait for complete word in partials
                  let finalTextToUse = transcriptText;
                  const finalTrimmed = transcriptText.trim();
                  const finalEndsCompleteWord = endsWithCompleteWord(finalTrimmed);
                  const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                  const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;
                  
                  // If final doesn't end with complete word, prioritize partials that contain the complete word
                  if (!finalEndsCompleteWord) {
                    console.log(`[SoloMode] ⚠️ FINAL ends mid-word - waiting for complete word in partials`);
                    // Increase wait time to catch complete word - reduced from 1200ms to 800ms
                    WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 800); // At least 800ms for mid-word finals
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
          console.log('[SoloMode] Audio stream ended');
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
    
    if (speechStream) {
      speechStream.destroy();
      speechStream = null;
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

