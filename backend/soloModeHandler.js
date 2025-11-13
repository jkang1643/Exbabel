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
  let pendingFinalization = null; // { seqId, text, timestamp, timeout }
  const FINALIZATION_CONFIRMATION_WINDOW = 300; // 300ms confirmation window
  const MIN_SILENCE_MS = 600; // Minimum 600ms silence before finalization (optimized for natural speech pauses)
  const DEFAULT_LOOKAHEAD_MS = 200; // Default 200ms lookahead
  
  // Last audio timestamp for silence detection
  let lastAudioTimestamp = null;
  let silenceStartTime = null;
  
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
              
              // SIMPLE FIX: Just use the longest partial we've seen - no complex delays
              
              // Ultra-low throttle for real-time feel - updates every 1-2 chars
              const THROTTLE_MS = 0; // No throttle - instant translation on every character
              
              // Helper function to process final text (defined here so it can access closure variables)
              const processFinalText = (textToProcess) => {
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
                            isTranscriptionOnly: true
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
                            isTranscriptionOnly: true
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
                          isTranscriptionOnly: true
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
                          isTranscriptionOnly: false
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
                          isTranscriptionOnly: false
                        }, false);
                      }
                    }
                  } catch (error) {
                    console.error(`[SoloMode] Error processing final:`, error);
                  }
                })();
              };
              
              // Set up result callback - handles both partials and finals
              speechStream.onResult(async (transcriptText, isPartial) => {
                if (!clientWs || clientWs.readyState !== WebSocket.OPEN) return;
                
                if (isPartial) {
                  // Track latest partial for correction race condition prevention
                  latestPartialTextForCorrection = transcriptText;
                  
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
                  
                  // CRITICAL: If we have pending finalization, extend the timeout if partials keep arriving
                  // This ensures we wait long enough for all partials, especially for very long text
                  if (pendingFinalization) {
                    const timeSinceFinal = Date.now() - pendingFinalization.timestamp;
                    // If partials are still arriving and we haven't waited long enough, extend the timeout
                    if (timeSinceFinal < 1000 && transcriptText.length > pendingFinalization.text.length) {
                      // Clear existing timeout and reschedule with fresh delay
                      clearTimeout(pendingFinalization.timeout);
                      const remainingWait = Math.max(300, 1000 - timeSinceFinal); // At least 300ms more
                      console.log(`[SoloMode] ⏱️ Extending finalization wait by ${remainingWait}ms (partial still growing: ${transcriptText.length} chars)`);
                      // Reschedule with the same processing logic
                      pendingFinalization.timeout = setTimeout(() => {
                        const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                        const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;
                        let finalTextToUse = pendingFinalization.text;
                        if (longestPartialText && longestPartialText.length > pendingFinalization.text.length && timeSinceLongest < 10000) {
                          finalTextToUse = longestPartialText;
                        } else if (latestPartialText && latestPartialText.length > pendingFinalization.text.length && timeSinceLatest < 5000) {
                          finalTextToUse = latestPartialText;
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
                    const capturedText = transcriptText;
                    if (currentSourceLang === 'en') {
                      grammarWorker.correctPartial(capturedText, process.env.OPENAI_API_KEY)
                        .then(correctedText => {
                          // Check if still relevant
                          if (latestPartialTextForCorrection !== capturedText) {
                            if (latestPartialTextForCorrection.length < capturedText.length * 0.5) {
                              console.log(`[SoloMode] ⏭️ Skipping outdated grammar (text reset: ${capturedText.length} → ${latestPartialTextForCorrection.length} chars)`);
                              return;
                            }
                          }
                          
                          console.log(`[SoloMode] ✅ GRAMMAR (ASYNC): "${correctedText.substring(0, 40)}..."`);
                          
                          // Send grammar update separately
                          sendWithSequence({
                            type: 'translation',
                            originalText: capturedText,
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
                            console.error(`[SoloMode] ❌ Grammar error (${capturedText.length} chars):`, error.message);
                          }
                        });
                    }
                    return; // Skip translation processing for transcription mode
                  }
                  
                  // ULTRA-FAST: Start translation immediately on ANY text (even 1 char)
                  if (transcriptText.length >= 1) {
                    // Update current partial text (used for delayed translations)
                    currentPartialText = transcriptText;
                    
                    const now = Date.now();
                    const timeSinceLastTranslation = now - lastPartialTranslationTime;
                    
                    // Ultra-fast growth-based updates: update every 1 character for real-time feel
                    const textGrowth = transcriptText.length - lastPartialTranslation.length;
                    const GROWTH_THRESHOLD = 1; // Update on every single character for maximum responsiveness
                    const textGrewSignificantly = textGrowth >= GROWTH_THRESHOLD && transcriptText.length > lastPartialTranslation.length;
                    
                    // Ultra-fast logic: translate immediately on ANY growth or first translation
                    const isFirstTranslation = lastPartialTranslation.length === 0;
                    const shouldTranslateNow = isFirstTranslation || // INSTANT on first text
                                               textGrewSignificantly; // Text grew by 1+ character - translate immediately
                    
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
                        const capturedText = transcriptText; // Capture the text we're processing
                        
                        // OPTIMIZATION: For same-language (transcription mode), send immediately without API calls
                        const isTranscriptionMode = currentSourceLang === currentTargetLang;
                        
                        if (isTranscriptionMode) {
                          // TRANSCRIPTION MODE: Send raw text immediately, no translation API call needed
                          lastPartialTranslation = capturedText;
                          
                          console.log(`[SoloMode] ✅ TRANSCRIPTION (IMMEDIATE): "${capturedText.substring(0, 40)}..."`);
                          
                          // Send transcription immediately - same speed as translation mode
                          sendWithSequence({
                            type: 'translation',
                            originalText: capturedText,
                            translatedText: capturedText,
                            timestamp: Date.now(),
                            isTranscriptionOnly: true,
                            hasTranslation: false, // No translation needed
                            hasCorrection: false // Will be updated asynchronously
                          }, true);
                          
                          // Start grammar correction asynchronously (English only, don't wait for it)
                          if (currentSourceLang === 'en') {
                            grammarWorker.correctPartial(capturedText, process.env.OPENAI_API_KEY)
                              .then(correctedText => {
                                // Check if still relevant
                                if (latestPartialTextForCorrection !== capturedText) {
                                  if (latestPartialTextForCorrection.length < capturedText.length * 0.5) {
                                    console.log(`[SoloMode] ⏭️ Skipping outdated grammar (text reset: ${capturedText.length} → ${latestPartialTextForCorrection.length} chars)`);
                                    return;
                                  }
                                }
                                
                                console.log(`[SoloMode] ✅ GRAMMAR (ASYNC): "${correctedText.substring(0, 40)}..."`);
                                
                                // Send grammar update separately
                                sendWithSequence({
                                  type: 'translation',
                                  originalText: capturedText,
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
                                  console.error(`[SoloMode] ❌ Grammar error (${capturedText.length} chars):`, error.message);
                                }
                              });
                          }
                        } else {
                          // TRANSLATION MODE: Decouple grammar and translation for lowest latency
                          // Fire both in parallel, but send results independently (grammar only for English)
                          // Route to appropriate worker based on tier
                          const grammarPromise = currentSourceLang === 'en' 
                            ? grammarWorker.correctPartial(capturedText, process.env.OPENAI_API_KEY)
                            : Promise.resolve(capturedText); // Skip grammar for non-English
                          const partialWorker = usePremiumTier 
                            ? realtimePartialTranslationWorker 
                            : partialTranslationWorker;
                          const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                          console.log(`[SoloMode] 🔀 Using ${workerType} API for partial translation (${capturedText.length} chars)`);
                          const translationPromise = partialWorker.translatePartial(
                            capturedText,
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
                            const isSameAsOriginal = translatedText === capturedText || 
                                                     translatedText.trim() === capturedText.trim() ||
                                                     translatedText.toLowerCase() === capturedText.toLowerCase();
                            
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
                              originalText: capturedText,
                              translatedText: translatedText,
                              timestamp: Date.now(),
                              isTranscriptionOnly: false,
                              hasTranslation: true,
                              hasCorrection: false // Grammar not ready yet
                            }, true);
                          }).catch(error => {
                            // Handle translation errors gracefully
                            if (error.name !== 'AbortError') {
                              if (error.message && error.message.includes('truncated')) {
                                // Translation was truncated - log warning but don't send incomplete translation
                                console.warn(`[SoloMode] ⚠️ Partial translation truncated (${capturedText.length} chars) - waiting for longer partial`);
                              } else if (error.message && error.message.includes('timeout')) {
                                console.warn(`[SoloMode] ⚠️ ${workerType} API timeout - translation skipped for this partial`);
                                // Don't send error message to frontend - just skip this translation
                              } else {
                                console.error(`[SoloMode] ❌ Translation error (${workerType} API, ${capturedText.length} chars):`, error.message);
                              }
                            }
                            // Don't send anything on error - keep last partial translation
                          });

                          // Send grammar correction separately when ready (English only)
                          if (currentSourceLang === 'en') {
                            grammarPromise.then(correctedText => {
                              // Check if still relevant (more lenient check - only skip if text shrunk significantly)
                              if (latestPartialTextForCorrection !== capturedText) {
                                // Only skip if new text is significantly shorter (text was reset)
                                if (latestPartialTextForCorrection.length < capturedText.length * 0.5) {
                                  console.log(`[SoloMode] ⏭️ Skipping outdated grammar (text reset: ${capturedText.length} → ${latestPartialTextForCorrection.length} chars)`);
                                  return;
                                }
                                // Otherwise send it - extending text is fine, grammar still applies to the beginning
                              }

                              console.log(`[SoloMode] ✅ GRAMMAR (IMMEDIATE): "${correctedText.substring(0, 40)}..."`);
                              
                              // Send grammar update separately
                              sendWithSequence({
                                type: 'translation',
                                originalText: capturedText,
                                correctedText: correctedText,
                                timestamp: Date.now(),
                                isTranscriptionOnly: false,
                                hasCorrection: true,
                                updateType: 'grammar' // Flag for grammar-only update
                              }, true);
                            }).catch(error => {
                              // Grammar errors are non-critical, just log
                              if (error.name !== 'AbortError') {
                                console.error(`[SoloMode] ❌ Grammar error (${capturedText.length} chars):`, error.message);
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
                                if (error.message && error.message.includes('timeout')) {
                                  console.warn(`[SoloMode] ⚠️ ${workerType} API timeout - translation skipped for this partial`);
                                } else {
                                  console.error(`[SoloMode] ❌ Delayed translation error (${workerType} API, ${latestText.length} chars):`, error.message);
                                }
                              }
                              // Don't send anything on error
                            });

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
                  // Final transcript from Google Speech
                  console.log(`[SoloMode] 📝 FINAL signal received (${transcriptText.length} chars): "${transcriptText.substring(0, 80)}..."`);
                  
                  // CRITICAL: For long text, wait proportionally longer before processing final
                  // Google Speech may send final signal but still have partials for the last few words in flight
                  // Very long text (>300 chars) needs more time for all partials to arrive
                  const BASE_WAIT_MS = 300;
                  const LONG_TEXT_THRESHOLD = 200;
                  const VERY_LONG_TEXT_THRESHOLD = 300;
                  const CHAR_DELAY_MS = 2; // 2ms per character for very long text
                  
                  let WAIT_FOR_PARTIALS_MS;
                  if (transcriptText.length > VERY_LONG_TEXT_THRESHOLD) {
                    // Very long text: base wait + proportional delay (up to 1500ms max)
                    WAIT_FOR_PARTIALS_MS = Math.min(1500, BASE_WAIT_MS + (transcriptText.length - VERY_LONG_TEXT_THRESHOLD) * CHAR_DELAY_MS);
                  } else if (transcriptText.length > LONG_TEXT_THRESHOLD) {
                    // Long text: fixed longer wait
                    WAIT_FOR_PARTIALS_MS = 800;
                  } else {
                    // Short text: base wait
                    WAIT_FOR_PARTIALS_MS = BASE_WAIT_MS;
                  }
                  
                  // If we have a pending finalization, check if this final extends it
                  // Google can send multiple finals for long phrases - accumulate them
                  if (pendingFinalization) {
                    // Check if this final extends the pending one (common for long phrases)
                    if (transcriptText.length > pendingFinalization.text.length && 
                        transcriptText.startsWith(pendingFinalization.text.trim())) {
                      // This final extends the pending one - update it
                      console.log(`[SoloMode] 📦 Final extends pending (${pendingFinalization.text.length} → ${transcriptText.length} chars)`);
                      pendingFinalization.text = transcriptText;
                      pendingFinalization.timestamp = Date.now();
                      // Reset the timeout to give more time for partials
                      clearTimeout(pendingFinalization.timeout);
                      // Recalculate wait time for the longer text
                      if (transcriptText.length > VERY_LONG_TEXT_THRESHOLD) {
                        WAIT_FOR_PARTIALS_MS = Math.min(1500, BASE_WAIT_MS + (transcriptText.length - VERY_LONG_TEXT_THRESHOLD) * CHAR_DELAY_MS);
                      }
                    } else {
                      // Different final - cancel old one and start new
                      clearTimeout(pendingFinalization.timeout);
                    }
                  }
                  
                  // Schedule final processing after a delay to catch any remaining partials
                  // If pendingFinalization exists and was extended, we'll reschedule it below
                  if (!pendingFinalization || transcriptText.length <= pendingFinalization.text.length) {
                    pendingFinalization = {
                      seqId: null,
                      text: transcriptText,
                      timestamp: Date.now(),
                      timeout: null
                    };
                  }
                  
                  // Schedule or reschedule the timeout
                  pendingFinalization.timeout = setTimeout(() => {
                      // After waiting, check again for longer partials
                      const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                      const timeSinceLatest = latestPartialTime ? (Date.now() - latestPartialTime) : Infinity;
                      
                      // Use the longest available partial (within reasonable time window)
                      let finalTextToUse = pendingFinalization.text;
                      if (longestPartialText && longestPartialText.length > pendingFinalization.text.length && timeSinceLongest < 10000) {
                        const missingWords = longestPartialText.substring(pendingFinalization.text.length).trim();
                        console.log(`[SoloMode] ⚠️ Using LONGEST partial (${pendingFinalization.text.length} → ${longestPartialText.length} chars)`);
                        console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                        finalTextToUse = longestPartialText;
                      } else if (latestPartialText && latestPartialText.length > pendingFinalization.text.length && timeSinceLatest < 5000) {
                        // Fallback to latest partial if longest is too old
                        const missingWords = latestPartialText.substring(pendingFinalization.text.length).trim();
                        console.log(`[SoloMode] ⚠️ Using LATEST partial (${pendingFinalization.text.length} → ${latestPartialText.length} chars)`);
                        console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                        finalTextToUse = latestPartialText;
                      }
                      
                      // Reset for next segment AFTER processing
                      const textToProcess = finalTextToUse;
                      const waitTime = Date.now() - pendingFinalization.timestamp;
                      latestPartialText = '';
                      longestPartialText = '';
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

