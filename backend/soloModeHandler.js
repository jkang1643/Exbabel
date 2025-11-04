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
              
              // Adaptive throttle based on text length - reduced for faster updates
              const getAdaptiveThrottle = (textLength) => {
                if (textLength > 500) return 200; // Very long text: 200ms throttle
                if (textLength > 300) return 250; // Long text: 250ms throttle
                if (textLength > 200) return 300; // Medium text: 300ms throttle
                return 400; // Short text: 400ms throttle (reduced from 800ms)
              };
              
              // Set up result callback - handles both partials and finals
              speechStream.onResult(async (transcriptText, isPartial) => {
                if (!clientWs || clientWs.readyState !== WebSocket.OPEN) return;
                
                if (isPartial) {
                  // Live partial transcript - send original immediately with sequence ID
                  const seqId = sendWithSequence({
                    type: 'translation',
                    originalText: transcriptText,
                    translatedText: transcriptText, // Default to source text
                    timestamp: Date.now(),
                    isTranscriptionOnly: isTranscriptionOnly,
                    hasTranslation: false // Flag that translation is pending
                  }, true);
                  
                  // Cancel any pending finalization since we have new partials
                  if (pendingFinalization) {
                    clearTimeout(pendingFinalization.timeout);
                    pendingFinalization = null;
                  }
                  
                  // Update last audio timestamp (we have new audio activity)
                  lastAudioTimestamp = Date.now();
                  silenceStartTime = null;
                  
                  // If translation needed and different from source lang
                  if (!isTranscriptionOnly && transcriptText.length > 10) {
                    // Update current partial text (used for delayed translations)
                    currentPartialText = transcriptText;
                    
                    const now = Date.now();
                    const timeSinceLastTranslation = now - lastPartialTranslationTime;
                    const adaptiveThrottle = getAdaptiveThrottle(transcriptText.length);
                    
                    // Check if text has grown significantly since last translation
                    // (20% growth or 100 chars, whichever is smaller)
                    // Special handling for initial translation (lastPartialTranslation empty)
                    const textGrowth = transcriptText.length - lastPartialTranslation.length;
                    let growthThreshold = 100; // Default threshold
                    if (lastPartialTranslation.length > 0) {
                      growthThreshold = Math.min(100, Math.max(50, Math.floor(lastPartialTranslation.length * 0.2)));
                    }
                    const textGrewSignificantly = textGrowth >= growthThreshold && transcriptText.length > lastPartialTranslation.length;
                    
                    // For long text (>300 chars), always translate more aggressively to keep up
                    const isLongText = transcriptText.length > 300;
                    
                    // For long text, check if content changed even if length is same
                    // Compare first 200 chars to detect content changes in long text
                    let longTextNeedsUpdate = false;
                    if (isLongText && lastPartialTranslation.length > 0) {
                      const prefixMatch = transcriptText.substring(0, 200) === lastPartialTranslation.substring(0, 200);
                      longTextNeedsUpdate = !prefixMatch || transcriptText.length !== lastPartialTranslation.length;
                    } else if (isLongText && lastPartialTranslation.length === 0) {
                      // First translation of long text - always translate
                      longTextNeedsUpdate = true;
                    }
                    
                    // For very long text (>500 chars), reduce throttle even more aggressively
                    const isVeryLongText = transcriptText.length > 500;
                    const effectiveThrottle = isVeryLongText ? Math.min(adaptiveThrottle, 300) : adaptiveThrottle;
                    
                    // CRITICAL: For long text, always translate if different - don't block on lastPartialTranslation
                    // The comparison might fail if previous translation failed silently
                    const textsAreDifferent = transcriptText !== lastPartialTranslation;
                    const isStale = lastPartialTranslationTime === 0 || (Date.now() - lastPartialTranslationTime > 5000);
                    
                    // Force immediate translation if:
                    // 1. Text grew significantly (20% or threshold chars)
                    // 2. Throttle time passed (with more aggressive threshold for long text)
                    // 3. Long text that needs update (different length or content changed)
                    // 4. Very long text - always translate if different (max 300ms delay)
                    // 5. Long text and stale (no translation in 5s) - force retry
                    // CRITICAL: For long text, translate even if textsAreDifferent is false (might be caught up)
                    // This ensures continuous updates for long passages
                    const shouldTranslateNow = timeSinceLastTranslation >= effectiveThrottle || 
                                               textGrewSignificantly || 
                                               longTextNeedsUpdate ||
                                               (isVeryLongText && textsAreDifferent) ||
                                               (isLongText && isStale) ||
                                               (isLongText && timeSinceLastTranslation >= 2000); // Force update every 2s for long text
                    
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
                        console.log(`[SoloMode] 🔄 Translating partial (${transcriptText.length} chars, throttle: ${adaptiveThrottle}ms): "${transcriptText.substring(0, 40)}..."`);
                        // Use dedicated partial translation worker (fast, low-latency, gpt-4o-mini)
                        const translatedText = await partialTranslationWorker.translatePartial(
                          transcriptText,
                          currentSourceLang,
                          currentTargetLang,
                          process.env.OPENAI_API_KEY
                        );
                        console.log(`[SoloMode] ✅ TRANSLATION RECEIVED (${translatedText.length} chars): "${translatedText}"`);
                        
                        // Validate translation result
                        if (!translatedText || translatedText.trim().length === 0) {
                          console.warn(`[SoloMode] ⚠️ Translation returned empty for ${transcriptText.length} char text - NOT updating lastPartialTranslation`);
                          // Don't send empty translation - it will cause UI to stop updating
                          // Don't update lastPartialTranslation - allows retry on next update
                        } else {
                          // CRITICAL: Only update lastPartialTranslation AFTER successful translation
                          lastPartialTranslation = transcriptText;
                          
                          // Send updated translation with sequence ID
                          sendWithSequence({
                            type: 'translation',
                            originalText: transcriptText,
                            translatedText: translatedText,
                            timestamp: Date.now(),
                            isTranscriptionOnly: false,
                            hasTranslation: true // Flag that this includes translation
                          }, true);
                          console.log(`[SoloMode] ✅ Sent translation (${translatedText.length} chars) for original (${transcriptText.length} chars)`);
                        }
                      } catch (error) {
                        console.error(`[SoloMode] ❌ Partial translation error (${transcriptText.length} chars):`, error.message);
                        // CRITICAL: Don't update lastPartialTranslation on error - allows retry
                        // Continue processing - don't stop translations on error
                      }
                    } else {
                      // Schedule delayed translation with adaptive throttle
                      // Always cancel and reschedule to ensure we translate the latest text
                      if (pendingPartialTranslation) {
                        clearTimeout(pendingPartialTranslation);
                        pendingPartialTranslation = null;
                      }
                      
                      // Use shorter delay for longer text (reduced for faster updates)
                      const maxDelay = transcriptText.length > 500 ? 250 : 350;
                      const delayMs = Math.min(effectiveThrottle, maxDelay);
                      
                      pendingPartialTranslation = setTimeout(async () => {
                        // CRITICAL: Always capture LATEST text at timeout execution
                        const latestText = currentPartialText;
                        if (!latestText || latestText.length < 10) {
                          pendingPartialTranslation = null;
                          return;
                        }
                        
                        // For long text, ALWAYS translate regardless of exact match
                        // This ensures continuous updates throughout long passages
                        const isLongTextNow = latestText.length > 300;
                        const veryRecentlyTranslated = lastPartialTranslationTime && (Date.now() - lastPartialTranslationTime < 200);
                        const isExactMatch = latestText === lastPartialTranslation;
                        
                        // Only skip if it's short text AND exact match AND very recent (<200ms)
                        // For long text, always translate to ensure continuous updates
                        if (isExactMatch && !isLongTextNow && veryRecentlyTranslated) {
                          console.log(`[SoloMode] ⏭️ Skipping exact match translation (short text, very recent)`);
                          pendingPartialTranslation = null;
                          return;
                        }
                        
                        try {
                          console.log(`[SoloMode] ⏱️ Delayed translating partial (${latestText.length} chars): "${latestText.substring(0, 40)}..."`);
                          // Use dedicated partial translation worker (fast, low-latency, gpt-4o-mini)
                          const translatedText = await partialTranslationWorker.translatePartial(
                            latestText,
                            currentSourceLang,
                            currentTargetLang,
                            process.env.OPENAI_API_KEY
                          );
                          
                          // Validate translation result
                          if (!translatedText || translatedText.trim().length === 0) {
                            console.warn(`[SoloMode] ⚠️ Delayed translation returned empty for ${latestText.length} char text`);
                            // Don't update lastPartialTranslation if translation failed - allow retry
                            pendingPartialTranslation = null;
                          } else {
                            // CRITICAL: Always update tracking and send translation for long text
                            // This ensures continuous updates throughout the entire passage
                            lastPartialTranslation = latestText;
                            lastPartialTranslationTime = Date.now();
                            
                            sendWithSequence({
                              type: 'translation',
                              originalText: latestText,
                              translatedText: translatedText,
                              timestamp: Date.now(),
                              isTranscriptionOnly: false,
                              hasTranslation: true // Flag that this includes translation
                            }, true);
                            console.log(`[SoloMode] ✅ Sent delayed translation (${translatedText.length} chars) for original (${latestText.length} chars)`);
                            pendingPartialTranslation = null;
                          }
                        } catch (error) {
                          console.error(`[SoloMode] ❌ Delayed partial translation error (${latestText.length} chars):`, error.message);
                          // Don't update lastPartialTranslation on error - allows retry on next partial
                          pendingPartialTranslation = null;
                        }
                      }, delayMs);
                    }
                  }
                } else {
                  // Final transcript from Google Speech - send immediately (restored simple approach)
                  console.log(`[SoloMode] 📝 FINAL Transcript (raw): "${transcriptText.substring(0, 50)}..."`);
                  
                  // Cancel any pending finalization timeout (in case we had delayed finalization)
                  if (pendingFinalization && pendingFinalization.timeout) {
                    clearTimeout(pendingFinalization.timeout);
                    pendingFinalization = null;
                  }
                  
                  // Process final immediately - translate and send to client
                  (async () => {
                    try {
                      if (isTranscriptionOnly) {
                        // Same language - just send transcript
                        console.log(`[SoloMode] ✅ Sending final transcript: "${transcriptText.substring(0, 50)}..."`);
                        sendWithSequence({
                          type: 'translation',
                          originalText: '',
                          translatedText: transcriptText,
                          timestamp: Date.now()
                        }, false);
                      } else {
                        // Different language - translate the transcript
                        try {
                          // Use dedicated final translation worker (high-quality, GPT-4o)
                          const translatedText = await finalTranslationWorker.translateFinal(
                            transcriptText,
                            currentSourceLang,
                            currentTargetLang,
                            process.env.OPENAI_API_KEY
                          );
                          
                          console.log(`[SoloMode] ✅ Sending final translation: "${translatedText.substring(0, 50)}..." (original: "${transcriptText.substring(0, 50)}...")`);
                          
                          sendWithSequence({
                            type: 'translation',
                            originalText: transcriptText,
                            translatedText: translatedText,
                            timestamp: Date.now()
                          }, false);
                        } catch (error) {
                          console.error(`[SoloMode] Final translation error:`, error);
                          // Send transcript as fallback
                          sendWithSequence({
                            type: 'translation',
                            originalText: transcriptText,
                            translatedText: `[Translation error: ${error.message}]`,
                            timestamp: Date.now()
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

