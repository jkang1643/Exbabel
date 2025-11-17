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
  
  // Sequence tracking and RTT measurement
  let sequenceCounter = 0;
  let latestSeqId = -1;
  let rttMeasurements = []; // Store recent RTT measurements for adaptive finalization
  const MAX_RTT_SAMPLES = 10;
  
  // Finalization state tracking
  let pendingFinalization = null; // { seqId, text, timestamp, timeout, maxWaitTimestamp }
  const MAX_FINALIZATION_WAIT_MS = 3000; // Maximum 3 seconds - safety net to ensure FINAL commits even if timeout fires
  const FINALIZATION_CONFIRMATION_WINDOW = 300; // 300ms confirmation window
  const MIN_SILENCE_MS = 600; // Minimum 600ms silence before finalization (optimized for natural speech pauses)
  const DEFAULT_LOOKAHEAD_MS = 200; // Default 200ms lookahead
  const FORCED_FINAL_MAX_WAIT_MS = 2000; // Time to wait for continuation before committing forced final
  const TRANSLATION_RESTART_COOLDOWN_MS = 400; // Pause realtime translations briefly after stream restart
  
  // Last audio timestamp for silence detection
  let lastAudioTimestamp = null;
  let silenceStartTime = null;
  let forcedFinalBuffer = null; // { text, timeout }
  let realtimeTranslationCooldownUntil = 0;
  
  // Helper: Calculate RTT from client timestamp
  const measureRTT = (clientTimestamp) => {
    if (!clientTimestamp) return null;
    const rtt = Date.now() - clientTimestamp;
    // Filter out negative RTT (clock sync issues) and extremely large values (bad measurements)
    if (rtt < 0 || rtt > 10000) {
      console.warn(`[SoloMode] ⚠️ Invalid RTT measurement: ${rtt}ms (skipping)`);
      return null;
    }
    rttMeasurements.push(rtt);
    if (rttMeasurements.length > MAX_RTT_SAMPLES) {
      rttMeasurements.shift();
    }
    return rtt;
  };
  
  // Helper: Get adaptive lookahead based on RTT
  const getAdaptiveLookahead = () => {
    if (rttMeasurements.length === 0) return DEFAULT_LOOKAHEAD_MS;
    const avgRTT = rttMeasurements.reduce((a, b) => a + b, 0) / rttMeasurements.length;
    // Lookahead = RTT/2, but capped between 200-700ms
    return Math.max(200, Math.min(700, Math.floor(avgRTT / 2)));
  };
  
  // Helper: Send message with sequence info
  const sendWithSequence = (messageData, isPartial = true) => {
    const seqId = sequenceCounter++;
    latestSeqId = Math.max(latestSeqId, seqId);
    
    const message = {
      ...messageData,
      seqId,
      serverTimestamp: Date.now(),
      isPartial,
      type: isPartial ? 'translation' : 'translation'
    };
    
    // DEBUG: Log if correctedText is present
    if (message.correctedText && message.originalText !== message.correctedText) {
      console.log(`[SoloMode] 📤 Sending message with CORRECTION (seq: ${seqId}, isPartial: ${isPartial}):`);
      console.log(`[SoloMode]   originalText: "${message.originalText?.substring(0, 60)}${(message.originalText?.length || 0) > 60 ? '...' : ''}"`);
      console.log(`[SoloMode]   correctedText: "${message.correctedText?.substring(0, 60)}${(message.correctedText?.length || 0) > 60 ? '...' : ''}"`);
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
              let latestPartialTextForCorrection = ''; // Track the absolute latest partial to avoid race conditions
              
              // CRITICAL: Track latest partial to prevent word loss
              let latestPartialText = ''; // Most recent partial text from Google Speech
              let latestPartialTime = 0; // Timestamp of latest partial
              let longestPartialText = ''; // Track the longest partial seen in current segment
              let longestPartialTime = 0; // Timestamp of longest partial

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
          
          const mergeWithOverlap = (previousText = '', currentText = '') => {
            const prev = (previousText || '').trim();
            const curr = (currentText || '').trim();
            if (!prev) return curr;
            if (!curr) return prev;
            if (curr.startsWith(prev)) {
              return curr;
            }
            const maxOverlap = Math.min(prev.length, curr.length, 200);
            for (let overlap = maxOverlap; overlap >= 5; overlap--) {
              const prevSuffix = prev.slice(-overlap);
              const currPrefix = curr.slice(0, overlap);
              if (prevSuffix === currPrefix) {
                return (prev + curr.slice(overlap)).trim();
              }
            }
            return `${prev} ${curr}`.replace(/\s+/g, ' ').trim();
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
              
              // SIMPLE FIX: Just use the longest partial we've seen - no complex delays
              
              // Ultra-low throttle for real-time feel - updates every 1-2 chars
              const THROTTLE_MS = 0; // No throttle - instant translation on every character
              
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
                
                if (isPartial) {
                  if (forcedFinalBuffer) {
                    // CRITICAL: Check if this partial extends the forced final or is a new segment
                    const forcedText = forcedFinalBuffer.text.trim();
                    const partialText = transcriptText.trim();
                    
                    // Check if partial extends the forced final (starts with it or has significant overlap)
                    const extendsForced = partialText.length > forcedText.length && 
                                         (partialText.startsWith(forcedText) || 
                                          (forcedText.length > 10 && partialText.substring(0, forcedText.length) === forcedText));
                    
                    if (extendsForced) {
                      // Partial extends the forced final - merge and commit
                      console.log('[SoloMode] 🔁 New partial extends forced final - merging and committing');
                      clearTimeout(forcedFinalBuffer.timeout);
                      const mergedFinal = mergeWithOverlap(forcedFinalBuffer.text, transcriptText);
                      processFinalText(mergedFinal, { forceFinal: true });
                      forcedFinalBuffer = null;
                      // Continue processing the extended partial normally
                    } else {
                      // New segment detected - commit forced final separately
                      console.log('[SoloMode] 🔀 New segment detected - committing forced final separately');
                      clearTimeout(forcedFinalBuffer.timeout);
                      processFinalText(forcedFinalBuffer.text, { forceFinal: true });
                      forcedFinalBuffer = null;
                      // Continue processing the new partial as a new segment
                    }
                  }
                  // Track latest partial for correction race condition prevention
                  latestPartialTextForCorrection = transcriptText;
                  const translationSeedText = applyCachedCorrections(transcriptText);
                  
                  // Track latest partial
                  if (!latestPartialText || transcriptText.length > latestPartialText.length) {
                    latestPartialText = transcriptText;
                    latestPartialTime = Date.now();
                  }
                  
                  // CRITICAL FIX: Track the LONGEST partial we've seen
                  // This prevents word loss when finals come before all words are captured
                  if (!longestPartialText || transcriptText.length > longestPartialText.length) {
                    longestPartialText = transcriptText;
                    longestPartialTime = Date.now();
                    console.log(`[SoloMode] 📏 New longest partial: ${longestPartialText.length} chars`);
                  }
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
                    
                    // CRITICAL: If FINAL doesn't end with punctuation/space and partial is very short,
                    // it might be a continuation of a cut-off word (e.g., "as" + "ar" from "secular")
                    // Google Speech may have cut off "secular" and only heard "ar" (misheard as "our")
                    const finalEndsWithPunctuationOrSpace = /[.!?…\s]$/.test(finalText);
                    const isVeryShortPartial = partialText.length < 20; // Very short partials (< 20 chars) are likely continuations
                    const mightBeContinuation = !finalEndsWithPunctuationOrSpace && isVeryShortPartial && timeSinceFinal < 2500;
                    
                    // If partial might be a continuation, wait longer and don't treat as new segment yet
                    // Continue tracking the partial so it can grow into the complete word
                    if (mightBeContinuation && !extendsFinal) {
                      console.log(`[SoloMode] ⚠️ Short partial after incomplete FINAL - likely continuation (FINAL: "${finalText}", partial: "${partialText}")`);
                      console.log(`[SoloMode] ⏳ Extending wait to see if partial grows into complete word/phrase`);
                      // Extend timeout significantly to wait for complete word/phrase
                      clearTimeout(pendingFinalization.timeout);
                      const remainingWait = Math.max(1000, 2500 - timeSinceFinal); // Wait at least 1000ms more
                      console.log(`[SoloMode] ⏱️ Extending finalization wait by ${remainingWait}ms (waiting for complete word/phrase)`);
                      // Reschedule - will check for longer partials when timeout fires
                      pendingFinalization.timeout = setTimeout(() => {
                        const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                        const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;
                        let finalTextToUse = pendingFinalization.text;
                        const finalTrimmed = pendingFinalization.text.trim();
                        
                        // Check for longest partial that extends the final
                        if (longestPartialText && longestPartialText.length > pendingFinalization.text.length && timeSinceLongest < 10000) {
                          const longestTrimmed = longestPartialText.trim();
                          if (longestTrimmed.startsWith(finalTrimmed) || 
                              (finalTrimmed.length > 10 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
                            const missingWords = longestPartialText.substring(pendingFinalization.text.length).trim();
                            console.log(`[SoloMode] ⚠️ Using LONGEST partial after continuation wait (${pendingFinalization.text.length} → ${longestPartialText.length} chars)`);
                            console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                            finalTextToUse = longestPartialText;
                          } else {
                            // Try overlap merge - might have missing words in middle
                            const merged = mergeWithOverlap(finalTrimmed, longestTrimmed);
                            if (merged.length > finalTrimmed.length + 5 && merged.length > longestTrimmed.length * 0.7) {
                              console.log(`[SoloMode] ⚠️ Merged via overlap after continuation wait: "${merged}"`);
                              finalTextToUse = merged;
                            }
                          }
                        } else if (latestPartialText && latestPartialText.length > pendingFinalization.text.length && timeSinceLatest < 5000) {
                          const latestTrimmed = latestPartialText.trim();
                          if (latestTrimmed.startsWith(finalTrimmed) || 
                              (finalTrimmed.length > 10 && latestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
                            const missingWords = latestPartialText.substring(pendingFinalization.text.length).trim();
                            console.log(`[SoloMode] ⚠️ Using LATEST partial after continuation wait (${pendingFinalization.text.length} → ${latestPartialText.length} chars)`);
                            console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                            finalTextToUse = latestPartialText;
                          } else {
                            // Try overlap merge
                            const merged = mergeWithOverlap(finalTrimmed, latestTrimmed);
                            if (merged.length > finalTrimmed.length + 5 && merged.length > latestTrimmed.length * 0.7) {
                              console.log(`[SoloMode] ⚠️ Merged via overlap after continuation wait: "${merged}"`);
                              finalTextToUse = merged;
                            }
                          }
                        }
                        
                        const textToProcess = finalTextToUse;
                        latestPartialText = '';
                        longestPartialText = '';
                        const waitTime = Date.now() - pendingFinalization.timestamp;
                        pendingFinalization = null;
                        console.log(`[SoloMode] ✅ FINAL Transcript (after continuation wait): "${textToProcess.substring(0, 80)}..."`);
                        processFinalText(textToProcess);
                      }, remainingWait);
                      // Continue tracking this partial (don't return - let it be tracked normally below)
                    }
                    
                    // If partials are still arriving and extending the final, update the pending text and extend the timeout
                    if (timeSinceFinal < 2000 && extendsFinal) {
                      // CRITICAL: Update the pending finalization text with the extended partial
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
                      }
                      // Clear existing timeout and reschedule with fresh delay
                      clearTimeout(pendingFinalization.timeout);
                      const remainingWait = Math.max(800, 2000 - timeSinceFinal); // At least 800ms more, up to 2000ms total
                      console.log(`[SoloMode] ⏱️ Extending finalization wait by ${remainingWait}ms (partial still growing: ${textToUpdate.length} chars)`);
                      // Reschedule with the same processing logic
                      pendingFinalization.timeout = setTimeout(() => {
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
                        latestPartialText = '';
                        longestPartialText = '';
                        const waitTime = Date.now() - pendingFinalization.timestamp;
                        pendingFinalization = null;
                        console.log(`[SoloMode] ✅ FINAL Transcript (after ${waitTime}ms wait): "${textToProcess.substring(0, 80)}..."`);
                        // Process final (reuse the async function logic from the main timeout)
                        processFinalText(textToProcess);
                      }, remainingWait);
                    } else if (!extendsFinal && timeSinceFinal > 600) {
                      // New segment detected - COMMIT the pending FINAL immediately
                      // CRITICAL: When a new segment starts, the previous FINAL is complete
                      // We should commit it now, not keep waiting for more partials
                      console.log(`[SoloMode] 🔀 New segment detected during finalization (${timeSinceFinal}ms since final) - COMMITTING FINAL NOW`);
                      console.log(`[SoloMode] 📊 Pending final: "${pendingFinalization.text.substring(0, 100)}..."`);
                      console.log(`[SoloMode] 📊 Longest partial: "${longestPartialText?.substring(0, 100) || 'none'}..."`);
                      
                      clearTimeout(pendingFinalization.timeout);
                      
                      // Use longest available partial if it extends the final
                      let textToProcess = pendingFinalization.text;
                      const finalTrimmed = pendingFinalization.text.trim();
                      
                      // Check if longest partial extends the final
                      if (longestPartialText && longestPartialText.length > pendingFinalization.text.length) {
                        const longestTrimmed = longestPartialText.trim();
                        if (longestTrimmed.startsWith(finalTrimmed) || 
                            (finalTrimmed.length > 10 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
                          console.log(`[SoloMode] ⚠️ Using LONGEST partial (${pendingFinalization.text.length} → ${longestPartialText.length} chars)`);
                          textToProcess = longestPartialText;
                        }
                      } else if (latestPartialText && latestPartialText.length > pendingFinalization.text.length) {
                        const latestTrimmed = latestPartialText.trim();
                        if (latestTrimmed.startsWith(finalTrimmed) || 
                            (finalTrimmed.length > 10 && latestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
                          console.log(`[SoloMode] ⚠️ Using LATEST partial (${pendingFinalization.text.length} → ${latestPartialText.length} chars)`);
                          textToProcess = latestPartialText;
                        }
                      }
                      
                      // Reset and commit immediately
                      latestPartialText = '';
                      longestPartialText = '';
                      latestPartialTime = 0;
                      longestPartialTime = 0;
                      pendingFinalization = null;
                      console.log(`[SoloMode] ✅ FINAL (new segment detected - committing now): "${textToProcess.substring(0, 100)}..."`);
                      processFinalText(textToProcess);
                      // Continue processing the new partial as a new segment
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
                  
                  if (isForcedFinal) {
                    console.warn(`[SoloMode] ⚠️ Forced FINAL due to stream restart (${transcriptText.length} chars)`);
                    realtimeTranslationCooldownUntil = Date.now() + TRANSLATION_RESTART_COOLDOWN_MS;
                    
                    if (forcedFinalBuffer && forcedFinalBuffer.timeout) {
                      clearTimeout(forcedFinalBuffer.timeout);
                      forcedFinalBuffer = null;
                    }
                    
                    // Use the longest partial if it captured more text AND actually extends the forced final
                    const timeSinceLongestForced = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                    if (longestPartialText && longestPartialText.length > transcriptText.length && timeSinceLongestForced < 5000) {
                      const forcedTrimmed = transcriptText.trim();
                      const longestTrimmed = longestPartialText.trim();
                      // Verify it actually extends the forced final (not from a previous segment)
                      if (longestTrimmed.startsWith(forcedTrimmed) || 
                          (forcedTrimmed.length > 10 && longestTrimmed.substring(0, forcedTrimmed.length) === forcedTrimmed)) {
                        const missingWords = longestPartialText.substring(transcriptText.length).trim();
                        console.log(`[SoloMode] ⚠️ Forced FINAL using LONGEST partial (${transcriptText.length} → ${longestPartialText.length} chars)`);
                        console.log(`[SoloMode] 📊 Recovered (forced): "${missingWords}"`);
                        transcriptText = longestPartialText;
                      } else {
                        console.log(`[SoloMode] ⚠️ Ignoring LONGEST partial for forced final - appears to be from different segment`);
                      }
                    }
                    
                    const endsWithPunctuation = /[.!?…]$/.test(transcriptText.trim());
                    if (endsWithPunctuation) {
                      console.log('[SoloMode] ✅ Forced final already complete - committing immediately');
                      processFinalText(transcriptText, { forceFinal: true });
                    } else {
                      console.log('[SoloMode] ⏳ Buffering forced final until continuation arrives or timeout elapses');
                      const bufferedText = transcriptText;
                      forcedFinalBuffer = {
                        text: transcriptText,
                        timestamp: Date.now(),
                        timeout: setTimeout(() => {
                          console.warn('[SoloMode] ⏰ Forced final buffer timeout - committing buffered text');
                          processFinalText(bufferedText, { forceFinal: true });
                          forcedFinalBuffer = null;
                        }, FORCED_FINAL_MAX_WAIT_MS)
                      };
                    }
                    
                    // Cancel pending finalization timers (if any) since we're handling it now
                    if (pendingFinalization && pendingFinalization.timeout) {
                      clearTimeout(pendingFinalization.timeout);
                    }
                    pendingFinalization = null;
                    
                    return;
                  }
                  
                  if (forcedFinalBuffer) {
                    console.log('[SoloMode] 🔁 Merging buffered forced final with new FINAL transcript');
                    clearTimeout(forcedFinalBuffer.timeout);
                    transcriptText = mergeWithOverlap(forcedFinalBuffer.text, transcriptText);
                    forcedFinalBuffer = null;
                  }
                  // CRITICAL: For long text, wait proportionally longer before processing final
                  // Google Speech may send final signal but still have partials for the last few words in flight
                  // Very long text (>300 chars) needs more time for all partials to arrive
                  // EXTENDED: Account for translation latency (150-300ms for Realtime Mini) + partial arrival time
                  // INCREASED: Longer waits to prevent word loss between segments
                  // CRITICAL: Google Speech may send incomplete FINALs (missing words) - wait longer to catch corrections
                  const BASE_WAIT_MS = 1000; // Increased from 800ms to 1000ms to catch incomplete FINALs
                  const LONG_TEXT_THRESHOLD = 200;
                  const VERY_LONG_TEXT_THRESHOLD = 300;
                  const CHAR_DELAY_MS = 3; // Increased from 2ms to 3ms per character for very long text

                  let WAIT_FOR_PARTIALS_MS;
                  if (transcriptText.length > VERY_LONG_TEXT_THRESHOLD) {
                    // Very long text: base wait + proportional delay (up to 3500ms max, increased from 3000ms)
                    WAIT_FOR_PARTIALS_MS = Math.min(3500, BASE_WAIT_MS + (transcriptText.length - VERY_LONG_TEXT_THRESHOLD) * CHAR_DELAY_MS);
                  } else if (transcriptText.length > LONG_TEXT_THRESHOLD) {
                    // Long text: fixed longer wait (increased from 1500ms to 1800ms)
                    WAIT_FOR_PARTIALS_MS = 1800;
                  } else {
                    // Short text: base wait (increased from 800ms to 1000ms)
                    WAIT_FOR_PARTIALS_MS = BASE_WAIT_MS;
                  }
                  
                  // CRITICAL: If FINAL doesn't end with punctuation, it might be incomplete
                  // Google Speech may have missed words - wait longer to see if partials or corrected FINALs arrive
                  const finalEndsWithPunctuation = /[.!?…]$/.test(transcriptText.trim());
                  if (!finalEndsWithPunctuation) {
                    // FINAL doesn't end with punctuation - might be incomplete, wait longer
                    WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 1500); // At least 1500ms for incomplete-looking FINALs
                    console.log(`[SoloMode] ⚠️ FINAL doesn't end with punctuation - extending wait to ${WAIT_FOR_PARTIALS_MS}ms to catch incomplete recognition`);
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
                    // Increase wait time to catch complete word
                    WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 1200); // At least 1200ms for mid-word finals
                  }
                  
                  // Check if longest partial extends the final
                  // CRITICAL: Google Speech may send incomplete FINALs (missing words like "secular")
                  // Always check partials even if FINAL appears complete - partials may have more complete text
                  if (longestPartialText && longestPartialText.length > transcriptText.length && timeSinceLongest < 10000) {
                    const longestTrimmed = longestPartialText.trim();
                    if (longestTrimmed.startsWith(finalTrimmed) || 
                        (finalTrimmed.length > 10 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
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
                      const merged = mergeWithOverlap(finalTrimmed, longestTrimmed);
                      if (merged.length > finalTrimmed.length + 5 && merged.length > longestTrimmed.length * 0.7) {
                        // Significant overlap and merged text is longer - likely same segment with missing words
                        console.log(`[SoloMode] ⚠️ FINAL merged with LONGEST partial via overlap (${transcriptText.length} → ${merged.length} chars)`);
                        console.log(`[SoloMode] 📊 Recovered via overlap: "${merged.substring(finalTrimmed.length)}"`);
                        finalTextToUse = merged;
                      }
                    }
                  } else if (latestPartialText && latestPartialText.length > transcriptText.length && timeSinceLatest < 5000) {
                    // Fallback to latest partial if longest is too old
                    const latestTrimmed = latestPartialText.trim();
                    if (latestTrimmed.startsWith(finalTrimmed) || 
                        (finalTrimmed.length > 10 && latestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
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
                      const merged = mergeWithOverlap(finalTrimmed, latestTrimmed);
                      if (merged.length > finalTrimmed.length + 5 && merged.length > latestTrimmed.length * 0.7) {
                        // Significant overlap and merged text is longer - likely same segment with missing words
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
                      pendingFinalization.text = finalTextToUse;
                      pendingFinalization.timestamp = Date.now();
                      // Reset the timeout to give more time for partials
                      clearTimeout(pendingFinalization.timeout);
                      // Recalculate wait time for the longer text
                      if (finalTextToUse.length > VERY_LONG_TEXT_THRESHOLD) {
                        WAIT_FOR_PARTIALS_MS = Math.min(1500, BASE_WAIT_MS + (finalTextToUse.length - VERY_LONG_TEXT_THRESHOLD) * CHAR_DELAY_MS);
                      }
                    } else {
                      // Different final - cancel old one and start new
                      clearTimeout(pendingFinalization.timeout);
                      pendingFinalization = null;
                    }
                  }
                  
                  // Schedule final processing after a delay to catch any remaining partials
                  // If pendingFinalization exists and was extended, we'll reschedule it below
                  if (!pendingFinalization) {
                    if (!usePremiumTier) {
                      // BASIC (GPT-4o mini) pipeline still needs immediate window reset
                      latestPartialText = '';
                      longestPartialText = '';
                      latestPartialTime = 0;
                      longestPartialTime = 0;
                    }
                    // PREMIUM (Realtime Mini) delays reset until final processing completes
                    pendingFinalization = {
                      seqId: null,
                      text: finalTextToUse, // Use the extended text if available
                      timestamp: Date.now(),
                      maxWaitTimestamp: Date.now(), // Track when FINAL was first received - ensures commit after MAX_FINALIZATION_WAIT_MS
                      timeout: null
                    };
                  }
                  
                  // Schedule or reschedule the timeout
                  pendingFinalization.timeout = setTimeout(() => {
                      // After waiting, check again for longer partials
                      // CRITICAL: Google Speech may send FINALs that are incomplete (missing words)
                      // Always prefer partials that extend the FINAL, even if FINAL appears "complete"
                      const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                      const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;
                      
                      // Use the longest available partial (within reasonable time window)
                      // CRITICAL: Only use if it actually extends the final (not from a previous segment)
                      let finalTextToUse = pendingFinalization.text;
                      const finalTrimmed = pendingFinalization.text.trim();
                      
                      // Check if FINAL ends mid-sentence or mid-phrase (not with punctuation)
                      // If so, be more aggressive about using partials
                      const finalEndsWithPunctuation = /[.!?…]$/.test(finalTrimmed);
                      const shouldPreferPartials = !finalEndsWithPunctuation || longestPartialText?.length > pendingFinalization.text.length + 10;
                      
                      if (longestPartialText && longestPartialText.length > pendingFinalization.text.length && timeSinceLongest < 10000) {
                        const longestTrimmed = longestPartialText.trim();
                        // Verify it actually extends the final (starts with it or has significant overlap)
                        if (longestTrimmed.startsWith(finalTrimmed) || 
                            (finalTrimmed.length > 10 && longestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
                          const missingWords = longestPartialText.substring(pendingFinalization.text.length).trim();
                          console.log(`[SoloMode] ⚠️ Using LONGEST partial (${pendingFinalization.text.length} → ${longestPartialText.length} chars)`);
                          console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                          finalTextToUse = longestPartialText;
                        } else {
                          // Check for overlap - Google might have missed words in the middle
                          const overlap = mergeWithOverlap(finalTrimmed, longestTrimmed);
                          if (overlap.length > finalTrimmed.length && overlap.length > longestTrimmed.length * 0.8) {
                            // Significant overlap suggests same segment with missing words
                            console.log(`[SoloMode] ⚠️ Using LONGEST partial with overlap (${pendingFinalization.text.length} → ${overlap.length} chars)`);
                            console.log(`[SoloMode] 📊 Recovered via overlap: "${overlap.substring(finalTrimmed.length)}"`);
                            finalTextToUse = overlap;
                          } else {
                            console.log(`[SoloMode] ⚠️ Ignoring LONGEST partial - appears to be from different segment`);
                          }
                        }
                      } else if (latestPartialText && latestPartialText.length > pendingFinalization.text.length && timeSinceLatest < 5000) {
                        // Fallback to latest partial if longest is too old
                        const latestTrimmed = latestPartialText.trim();
                        // Verify it actually extends the final
                        if (latestTrimmed.startsWith(finalTrimmed) || 
                            (finalTrimmed.length > 10 && latestTrimmed.substring(0, finalTrimmed.length) === finalTrimmed)) {
                          const missingWords = latestPartialText.substring(pendingFinalization.text.length).trim();
                          console.log(`[SoloMode] ⚠️ Using LATEST partial (${pendingFinalization.text.length} → ${latestPartialText.length} chars)`);
                          console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                          finalTextToUse = latestPartialText;
                        } else {
                          // Check for overlap - Google might have missed words in the middle
                          const overlap = mergeWithOverlap(finalTrimmed, latestTrimmed);
                          if (overlap.length > finalTrimmed.length && overlap.length > latestTrimmed.length * 0.8) {
                            // Significant overlap suggests same segment with missing words
                            console.log(`[SoloMode] ⚠️ Using LATEST partial with overlap (${pendingFinalization.text.length} → ${overlap.length} chars)`);
                            console.log(`[SoloMode] 📊 Recovered via overlap: "${overlap.substring(finalTrimmed.length)}"`);
                            finalTextToUse = overlap;
                          } else {
                            console.log(`[SoloMode] ⚠️ Ignoring LATEST partial - appears to be from different segment`);
                          }
                        }
                      }
                      
                      // Reset for next segment AFTER processing
                      const textToProcess = finalTextToUse;
                      const waitTime = Date.now() - pendingFinalization.timestamp;
                      // CRITICAL FIX: Reset partial tracking AFTER final is scheduled for processing
                      // This prevents accumulation of old partials from previous sentences
                      latestPartialText = '';
                      longestPartialText = '';
                      latestPartialTime = 0;
                      longestPartialTime = 0;
                      pendingFinalization = null;
                      
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
                console.log(`[SoloMode] 📊 RTT: ${rtt}ms (avg: ${rttMeasurements.length > 0 ? Math.round(rttMeasurements.reduce((a, b) => a + b, 0) / rttMeasurements.length) : 'N/A'}ms)`);
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
          // Frontend requests to force-commit current turn (simulated pause)
          console.log('[SoloMode] 🔄 Force commit requested by frontend');
          if (speechStream) {
            await speechStream.forceCommit();
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

