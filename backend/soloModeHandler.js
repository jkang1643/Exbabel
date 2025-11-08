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
import { grammarWorker } from './grammarWorker.js';

export async function handleSoloMode(clientWs) {
  console.log("[SoloMode] ⚡ Connection using Google Speech + OpenAI Translation");

  let speechStream = null;
  let currentSourceLang = 'en';
  let currentTargetLang = 'es';
  let legacySessionId = `session_${Date.now()}`;
  
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
          // Update language preferences
          const prevSourceLang = currentSourceLang;
          const prevTargetLang = currentTargetLang;
          
          console.log(`[SoloMode] Init received - sourceLang: ${message.sourceLang}, targetLang: ${message.targetLang}`);
          
          if (message.sourceLang) {
            currentSourceLang = message.sourceLang;
          }
          if (message.targetLang) {
            currentTargetLang = message.targetLang;
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
                    translatedText: transcriptText, // Default to source text
                    timestamp: Date.now(),
                    isTranscriptionOnly: isTranscriptionOnly,
                    hasTranslation: false, // Flag that translation is pending
                    hasCorrection: false // Flag that correction is pending
                  }, true);
                  
                  // Cancel any pending finalization since we have new partials
                  if (pendingFinalization) {
                    clearTimeout(pendingFinalization.timeout);
                    pendingFinalization = null;
                  }
                  
                  // Update last audio timestamp (we have new audio activity)
                  lastAudioTimestamp = Date.now();
                  silenceStartTime = null;
                  
                  // ULTRA-FAST: Start translation immediately on ANY text (even 1 char)
                  if (!isTranscriptionOnly && transcriptText.length >= 1) {
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
                        
                        // OPTIMIZATION: Decouple grammar and translation for lowest latency
                        // Fire both in parallel, but send results independently
                        const grammarPromise = grammarWorker.correctPartial(capturedText, process.env.OPENAI_API_KEY);
                        const translationPromise = partialTranslationWorker.translatePartial(
                          capturedText,
                          currentSourceLang,
                          currentTargetLang,
                          process.env.OPENAI_API_KEY
                        );

                        // Send translation IMMEDIATELY when ready (don't wait for grammar)
                        translationPromise.then(translatedText => {
                          // Validate translation result
                          if (!translatedText || translatedText.trim().length === 0) {
                            console.warn(`[SoloMode] ⚠️ Translation returned empty for ${capturedText.length} char text`);
                            return;
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
                          console.error(`[SoloMode] ❌ Translation error (${capturedText.length} chars):`, error.message);
                        });

                        // Send grammar correction separately when ready
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
                          
                          // OPTIMIZATION: Decouple grammar and translation for lowest latency
                          const grammarPromise = grammarWorker.correctPartial(latestText, process.env.OPENAI_API_KEY);
                          const translationPromise = partialTranslationWorker.translatePartial(
                            latestText,
                            currentSourceLang,
                            currentTargetLang,
                            process.env.OPENAI_API_KEY
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
                            console.error(`[SoloMode] ❌ Delayed translation error (${latestText.length} chars):`, error.message);
                          });

                          // Send grammar correction separately when ready
                          grammarPromise.then(correctedText => {
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
                          }).catch(error => {
                            if (error.name !== 'AbortError') {
                              console.error(`[SoloMode] ❌ Delayed grammar error (${latestText.length} chars):`, error.message);
                            }
                          });

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
                  
                  // SIMPLE FIX: Use longest partial if it's longer (within last 5 seconds)
                  const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                  
                  if (longestPartialText && longestPartialText.length > transcriptText.length && timeSinceLongest < 5000) {
                    const missingWords = longestPartialText.substring(transcriptText.length).trim();
                    console.log(`[SoloMode] ⚠️ Using LONGEST partial (${transcriptText.length} → ${longestPartialText.length} chars)`);
                    console.log(`[SoloMode] 📊 Recovered: "${missingWords}"`);
                    transcriptText = longestPartialText;
                  }
                  
                  // Reset for next segment
                  latestPartialText = '';
                  longestPartialText = '';
                  
                  console.log(`[SoloMode] ✅ FINAL Transcript: "${transcriptText.substring(0, 80)}..."`);
                  
                  // Process final immediately - translate and send to client
                  (async () => {
                    try {
                      if (isTranscriptionOnly) {
                        // Same language - just send transcript with grammar correction
                        try {
                          const correctedText = await grammarWorker.correctFinal(transcriptText, process.env.OPENAI_API_KEY);
                          sendWithSequence({
                            type: 'translation',
                            originalText: transcriptText,
                            correctedText: correctedText,
                            translatedText: correctedText, // Use corrected text as the display text
                            timestamp: Date.now(),
                            hasCorrection: true
                          }, false);
                        } catch (error) {
                          console.error('[SoloMode] Grammar correction error:', error);
                          sendWithSequence({
                            type: 'translation',
                            originalText: transcriptText,
                            correctedText: transcriptText,
                            translatedText: transcriptText,
                            timestamp: Date.now(),
                            hasCorrection: false
                          }, false);
                        }
                      } else {
                        // Different language - KEEP COUPLED FOR FINALS (history needs complete data)
                        try {
                          // CRITICAL FIX: Get grammar correction FIRST, then translate the CORRECTED text
                          // This ensures the translation matches the corrected English text
                          let correctedText = transcriptText;
                          try {
                            correctedText = await grammarWorker.correctFinal(transcriptText, process.env.OPENAI_API_KEY);
                          } catch (grammarError) {
                            console.warn(`[SoloMode] Grammar correction failed, using original text:`, grammarError.message);
                            correctedText = transcriptText; // Fallback to original on error
                          }

                          // Translate the CORRECTED text (not the original)
                          // This ensures Spanish matches the corrected English
                          let translatedText;
                          try {
                            translatedText = await finalTranslationWorker.translateFinal(
                              correctedText, // Use corrected text for translation
                              currentSourceLang,
                              currentTargetLang,
                              process.env.OPENAI_API_KEY
                            );
                          } catch (translationError) {
                            console.error(`[SoloMode] Translation failed:`, translationError.message);
                            translatedText = `[Translation error: ${translationError.message}]`;
                          }

                          const hasCorrection = correctedText !== transcriptText;

                          // Log FINAL with correction details
                          console.log(`[SoloMode] 📤 Sending FINAL (coupled for history integrity):`);
                          console.log(`[SoloMode]   originalText: "${transcriptText}"`);
                          console.log(`[SoloMode]   correctedText: "${correctedText}"`);
                          console.log(`[SoloMode]   translatedText: "${translatedText}"`);
                          console.log(`[SoloMode]   hasCorrection: ${hasCorrection}`);
                          console.log(`[SoloMode]   correction changed text: ${hasCorrection}`);

                          sendWithSequence({
                            type: 'translation',
                            originalText: transcriptText, // Raw STT text
                            correctedText: correctedText, // Grammar-corrected text (updates when available)
                            translatedText: translatedText, // Translation of CORRECTED text
                            timestamp: Date.now(),
                            hasTranslation: translatedText && !translatedText.startsWith('[Translation error'),
                            hasCorrection: hasCorrection
                          }, false);
                        } catch (error) {
                          console.error(`[SoloMode] Final processing error:`, error);
                          sendWithSequence({
                            type: 'translation',
                            originalText: transcriptText,
                            correctedText: transcriptText, // No correction on error
                            translatedText: `[Translation error: ${error.message}]`,
                            timestamp: Date.now(),
                            hasTranslation: false,
                            hasCorrection: false
                          }, false);
                        }
                      }
                    } catch (error) {
                      console.error(`[SoloMode] Error processing final:`, error);
                    }
                  })();
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

