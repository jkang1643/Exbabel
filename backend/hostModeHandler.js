/**
 * Host Mode Handler - Uses Google Cloud Speech for transcription + OpenAI for translation
 * 
 * ARCHITECTURE:
 * - Google Cloud Speech-to-Text for streaming transcription with live partials
 * - OpenAI Chat API for translation of final transcripts
 * - Live partial results broadcast to all listeners immediately
 * - Final results translated and broadcast to each language group
 */

import { GoogleSpeechStream } from './googleSpeechStream.js';
import WebSocket from 'ws';
import sessionStore from './sessionStore.js';
import translationManager from './translationManager.js';
import { partialTranslationWorker, finalTranslationWorker } from './translationWorkers.js';
import { realtimePartialTranslationWorker, realtimeFinalTranslationWorker } from './translationWorkersRealtime.js';
import { grammarWorker } from './grammarWorker.js';

export async function handleHostConnection(clientWs, sessionId) {
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

  let speechStream = null;
  let currentSourceLang = 'en';
  let usePremiumTier = false; // Tier selection: false = basic (Chat API), true = premium (Realtime API)

  // Handle client messages
  clientWs.on('message', async (msg) => {
    try {
      const message = JSON.parse(msg.toString());

      switch (message.type) {
        case 'init':
          if (message.sourceLang) {
            currentSourceLang = message.sourceLang;
            sessionStore.updateSourceLanguage(sessionId, currentSourceLang);
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
          
          console.log(`[HostMode] Session ${sessionId} initialized with source language: ${currentSourceLang}`);
          
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
                sessionStore.broadcastToListeners(sessionId, {
                  type: 'warning',
                  message: 'Service restarting, please wait...'
                });
              });
              
              // Translation throttling for partials - reduced for faster updates
              let lastPartialTranslations = {}; // Track last translation per language
              let lastPartialTranslationTime = 0;
              let pendingPartialTranslation = null;
              const PARTIAL_TRANSLATION_THROTTLE = 0; // REAL-TIME INSTANT: 0ms for maximum speed (was 25ms, originally 800ms) - SAFE: Cancellation prevents spam
              
              // CRITICAL: Track latest and longest partial to prevent word loss
              let latestPartialText = ''; // Most recent partial text from Google Speech
              let latestPartialTime = 0; // Timestamp of latest partial
              let longestPartialText = ''; // Track the longest partial seen in current segment
              let longestPartialTime = 0; // Timestamp of longest partial
              let latestPartialTextForCorrection = ''; // Track latest partial for grammar correction relevance check
              let lastFinalText = ''; // Track the last final text sent
              let lastFinalTime = 0; // Timestamp of last final
              let partialTrackingResetTimeout = null; // Timeout to reset partial tracking after final
              
              // PENDING FINAL TRACKING: Track finals that are waiting to be processed
              // This allows partials to extend them before we commit
              let pendingFinal = null; // {text, timeout, timestamp, isForced, startTime}
              let pendingFinalTimeout = null;
              
              // RECENTLY FINALIZED WINDOW: Keep 2-3 previous lines editable for backpatching
              // This allows late-arriving tokens to be merged into previous segments
              const recentlyFinalized = []; // Array of {text, timestamp, sequenceId}
              const RECENTLY_FINALIZED_WINDOW = 1500; // 1.5 seconds - keep lines editable
              const MAX_RECENT_FINALS = 3; // Keep last 3 finalized segments
              
              // GRACE PERIOD: Keep tracking partials for 3 seconds after a final to catch continuation words
              const PARTIAL_TRACKING_GRACE_PERIOD = 3000; // 3 seconds (increased to catch slower continuations)
              
              // FINAL COMMIT DELAY: Wait before processing finals to allow extending partials
              // Google Speech finalizes based on stability, not sentence completion
              // This delay gives partials time to arrive and extend the final
              // VAD Pause Finalization: 0ms (already stable)
              // Forced Commit: 600-900ms (captures trailing words)
              const FINAL_COMMIT_DELAY_NATURAL = 0; // Natural finalization (VAD pause) - already stable
              const FINAL_COMMIT_DELAY_FORCED = 750; // Forced commit - needs buffer to catch trailing words
              
              // Helper function to tokenize text for overlap matching
              const tokenize = (text) => {
                return text.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0);
              };
              
              // Helper function to calculate token overlap similarity
              const calculateTokenOverlap = (tokens1, tokens2, minOverlap = 2) => {
                if (!tokens1 || !tokens2 || tokens1.length === 0 || tokens2.length === 0) return 0;
                
                // Check if tokens2 starts with end of tokens1
                const maxCheck = Math.min(tokens1.length, tokens2.length, 6); // Check up to 6 tokens
                for (let i = maxCheck; i >= minOverlap; i--) {
                  const endTokens1 = tokens1.slice(-i);
                  const startTokens2 = tokens2.slice(0, i);
                  
                  // Exact match
                  if (endTokens1.join(' ') === startTokens2.join(' ')) {
                    return i / Math.max(tokens1.length, tokens2.length); // Normalized similarity
                  }
                  
                  // Fuzzy match - check if most tokens match
                  let matches = 0;
                  for (let j = 0; j < i; j++) {
                    if (endTokens1[j] === startTokens2[j] || 
                        endTokens1[j].includes(startTokens2[j]) || 
                        startTokens2[j].includes(endTokens1[j])) {
                      matches++;
                    }
                  }
                  if (matches >= i * 0.7) { // 70% match threshold
                    return matches / Math.max(tokens1.length, tokens2.length);
                  }
                }
                
                return 0;
              };
              
              // Helper function to merge tokens with overlap
              const mergeTokens = (text1, text2) => {
                const tokens1 = tokenize(text1);
                const tokens2 = tokenize(text2);
                
                if (tokens1.length === 0) return text2;
                if (tokens2.length === 0) return text1;
                
                // Find overlap
                const maxCheck = Math.min(tokens1.length, tokens2.length, 6);
                for (let i = maxCheck; i >= 2; i--) {
                  const endTokens1 = tokens1.slice(-i);
                  const startTokens2 = tokens2.slice(0, i);
                  
                  if (endTokens1.join(' ') === startTokens2.join(' ')) {
                    // Exact overlap - merge
                    const merged = [...tokens1, ...tokens2.slice(i)];
                    return merged.join(' ');
                  }
                  
                  // Fuzzy match
                  let matches = 0;
                  for (let j = 0; j < i; j++) {
                    if (endTokens1[j] === startTokens2[j] || 
                        endTokens1[j].includes(startTokens2[j]) || 
                        startTokens2[j].includes(endTokens1[j])) {
                      matches++;
                    }
                  }
                  if (matches >= i * 0.7) {
                    // Merge with overlap
                    const merged = [...tokens1, ...tokens2.slice(i)];
                    return merged.join(' ');
                  }
                }
                
                // No overlap found - concatenate
                return text1.trim() + ' ' + text2.trim();
              };
              
              // Clean up old recently finalized entries
              const cleanupRecentlyFinalized = () => {
                const now = Date.now();
                while (recentlyFinalized.length > 0) {
                  const oldest = recentlyFinalized[0];
                  if (now - oldest.timestamp > RECENTLY_FINALIZED_WINDOW) {
                    recentlyFinalized.shift();
                  } else {
                    break;
                  }
                }
                // Also limit by count
                while (recentlyFinalized.length > MAX_RECENT_FINALS) {
                  recentlyFinalized.shift();
                }
              };
              
              // Function to commit a pending final (after delay)
              const commitPendingFinal = async () => {
                if (!pendingFinal) return;
                
                let finalTextToProcess = pendingFinal.text;
                const isForcedFinal = pendingFinal.isForced;
                
                // Last chance: Check if longest partial extends the pending final
                const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                if (longestPartialText && longestPartialText.length > finalTextToProcess.length && timeSinceLongest < 2000) {
                  const longestTrimmed = longestPartialText.trim();
                  const finalTrimmed = finalTextToProcess.trim();
                  
                  if (longestTrimmed.startsWith(finalTrimmed) || longestTrimmed.includes(finalTrimmed)) {
                    console.log(`[HostMode] ⚠️ Using LONGEST partial for pending final (${finalTextToProcess.length} → ${longestPartialText.length} chars)`);
                    finalTextToProcess = longestPartialText;
                  }
                }
                
                // Update last final tracking (for continuation detection in grace period)
                lastFinalText = finalTextToProcess;
                lastFinalTime = Date.now();
                
                // Add to recently finalized window for backpatching
                const sequenceId = Date.now();
                recentlyFinalized.push({
                  text: finalTextToProcess,
                  timestamp: Date.now(),
                  sequenceId: sequenceId
                });
                cleanupRecentlyFinalized();
                
                // Reset current partial tracking (new segment starting)
                latestPartialText = '';
                longestPartialText = '';
                latestPartialTime = 0;
                longestPartialTime = 0;
                
                // Clear pending final
                const finalToProcess = finalTextToProcess;
                pendingFinal = null;
                pendingFinalTimeout = null;
                
                // Cancel any existing reset timeout
                if (partialTrackingResetTimeout) {
                  clearTimeout(partialTrackingResetTimeout);
                  partialTrackingResetTimeout = null;
                }
                
                // Schedule delayed reset of final tracking (allows grace period for continuations)
                partialTrackingResetTimeout = setTimeout(() => {
                  lastFinalText = '';
                  lastFinalTime = 0;
                  partialTrackingResetTimeout = null;
                  console.log(`[HostMode] 🧹 Reset final tracking after grace period`);
                }, PARTIAL_TRACKING_GRACE_PERIOD);
                
                // Process final using extracted function
                await processFinalTranscript(finalToProcess, isForcedFinal);
              };
              
              // Function to backpatch a recently finalized segment
              const backpatchRecentlyFinalized = async (partialText) => {
                cleanupRecentlyFinalized();
                
                const partialTokens = tokenize(partialText);
                if (partialTokens.length === 0) return false;
                
                // Check recently finalized segments (newest first)
                for (let i = recentlyFinalized.length - 1; i >= 0; i--) {
                  const recentFinal = recentlyFinalized[i];
                  const finalTokens = tokenize(recentFinal.text);
                  
                  // Calculate overlap similarity
                  const similarity = calculateTokenOverlap(finalTokens, partialTokens);
                  
                  if (similarity > 0.45) { // 45% similarity threshold
                    // This partial belongs to the recent final - merge it
                    const mergedText = mergeTokens(recentFinal.text, partialText);
                    console.log(`[HostMode] 🔙 BACKPATCHING: Merging into recent final:`);
                    console.log(`[HostMode]   Recent: "${recentFinal.text.substring(0, 60)}..."`);
                    console.log(`[HostMode]   Partial: "${partialText.substring(0, 60)}..."`);
                    console.log(`[HostMode]   Merged: "${mergedText.substring(0, 80)}..."`);
                    console.log(`[HostMode]   Similarity: ${(similarity * 100).toFixed(1)}%`);
                    
                    // Update the recent final
                    recentFinal.text = mergedText;
                    recentFinal.timestamp = Date.now(); // Update timestamp to keep it in window longer
                    
                    // Send updated final to all listeners
                    await processFinalTranscript(mergedText, false);
                    
                    return true; // Successfully backpatched
                  }
                }
                
                return false; // No backpatch match found
              };
              
              // Extract final processing into separate async function to avoid blocking
              const processFinalTranscript = async (finalText, isForcedFinal = false) => {
                console.log(`[HostMode] ✅ Processing FINAL Transcript: "${finalText.substring(0, 80)}..."`);
                
                // Send final transcript to the HOST
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({
                    type: 'translation',
                    originalText: finalText,
                    translatedText: finalText,
                    sourceLang: currentSourceLang,
                    targetLang: currentSourceLang,
                    timestamp: Date.now(),
                    sequenceId: Date.now(),
                    isPartial: false,
                    forceFinal: isForcedFinal
                  }));
                }
                
                // Get all target languages needed for listeners
                const targetLanguages = sessionStore.getSessionLanguages(sessionId);
                
                if (targetLanguages.length === 0) {
                  console.log('[HostMode] No listeners yet, skipping translation');
                  return;
                }

                try {
                  // Run grammar correction and translation in parallel for final transcript
                  // Route to appropriate worker based on tier
                  const finalWorker = usePremiumTier 
                    ? realtimeFinalTranslationWorker 
                    : finalTranslationWorker;
                  const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                  console.log(`[HostMode] 🔀 Using ${workerType} API for final translation to ${targetLanguages.length} language(s) (${finalText.length} chars)`);
                  const [grammarResult, translationResult] = await Promise.allSettled([
                    grammarWorker.correctFinal(finalText, process.env.OPENAI_API_KEY),
                    finalWorker.translateToMultipleLanguages(
                      finalText,
                      currentSourceLang,
                      targetLanguages,
                      process.env.OPENAI_API_KEY
                    )
                  ]);

                  const correctedText = grammarResult.status === 'fulfilled' 
                    ? grammarResult.value 
                    : finalText; // Fallback to original on error

                  const translations = translationResult.status === 'fulfilled'
                    ? translationResult.value
                    : {}; // Empty translations on error

                  console.log(`[HostMode] Processed final (grammar + translation to ${Object.keys(translations).length} languages)`);

                  // Broadcast to each language group
                  for (const targetLang of targetLanguages) {
                    // CRITICAL: Only use translation if it exists - never fallback to English transcriptText
                    const translatedText = translations[targetLang];
                    const hasTranslationForLang = translationResult.status === 'fulfilled' && 
                                                  translatedText && 
                                                  translatedText.trim() &&
                                                  translatedText !== finalText;
                    sessionStore.broadcastToListeners(sessionId, {
                      type: 'translation',
                      originalText: finalText,
                      correctedText: correctedText,
                      translatedText: hasTranslationForLang ? translatedText : undefined,
                      sourceLang: currentSourceLang,
                      targetLang: targetLang,
                      timestamp: Date.now(),
                      sequenceId: Date.now(),
                      isPartial: false,
                      hasTranslation: hasTranslationForLang,
                      hasCorrection: grammarResult.status === 'fulfilled',
                      forceFinal: isForcedFinal
                    }, targetLang);
                  }
                } catch (error) {
                  console.error('[HostMode] Final processing error:', error);
                }
              };
              
              // Set up result callback - handles both partials and finals
              speechStream.onResult(async (transcriptText, isPartial, meta = {}) => {
                if (isPartial) {
                  // PRIORITY 1: Check if this partial extends a PENDING final (before it's committed)
                  // This is the most important check - we can update the pending final before it's sent
                  if (pendingFinal && pendingFinal.text) {
                    const pendingTrimmed = pendingFinal.text.trim();
                    const partialTrimmed = transcriptText.trim();
                    
                    // Check if partial extends the pending final (using token-based matching)
                    const pendingTokens = tokenize(pendingFinal.text);
                    const partialTokens = tokenize(transcriptText);
                    
                    // Check if partial extends pending final (starts with it or has overlap)
                    const similarity = calculateTokenOverlap(pendingTokens, partialTokens);
                    if (similarity > 0.3 || partialTrimmed.startsWith(pendingTrimmed)) {
                      // Partial extends pending final - merge using token-based merging
                      const mergedText = mergeTokens(pendingFinal.text, transcriptText);
                      
                      if (mergedText.length > pendingFinal.text.length) {
                        console.log(`[HostMode] 🔄 Partial extends PENDING final (token merge) - updating:`);
                        console.log(`[HostMode]   Pending: "${pendingFinal.text.substring(0, 60)}..."`);
                        console.log(`[HostMode]   Partial: "${transcriptText.substring(0, 60)}..."`);
                        console.log(`[HostMode]   Merged: "${mergedText.substring(0, 80)}..."`);
                        
                        // Update pending final
                        pendingFinal.text = mergedText;
                        pendingFinal.timestamp = Date.now();
                        
                        // Also update longest partial tracking (in case there are even longer partials)
                        if (!longestPartialText || mergedText.length > longestPartialText.length) {
                          longestPartialText = mergedText;
                          longestPartialTime = Date.now();
                        }
                        
                        // Reset the commit timeout (give more time for further extensions)
                        // Use the delay appropriate for the final type
                        const delay = pendingFinal.isForced ? FINAL_COMMIT_DELAY_FORCED : FINAL_COMMIT_DELAY_NATURAL;
                        if (pendingFinalTimeout) {
                          clearTimeout(pendingFinalTimeout);
                        }
                        pendingFinalTimeout = setTimeout(() => {
                          commitPendingFinal();
                        }, delay);
                        
                        // Don't process as partial - it's extending a pending final
                        return;
                      }
                    }
                    // Check if partial contains pending final (more complete version) using token matching
                    else {
                      const similarity = calculateTokenOverlap(partialTokens, pendingTokens);
                      if (similarity > 0.3 && partialTrimmed.length > pendingTrimmed.length + 10) {
                        // Partial contains a more complete version - use token merge
                        const mergedText = mergeTokens(pendingFinal.text, transcriptText);
                        
                        if (mergedText.length > pendingFinal.text.length || transcriptText.length > pendingFinal.text.length) {
                          const bestText = transcriptText.length > mergedText.length ? transcriptText : mergedText;
                          console.log(`[HostMode] 🔄 Partial contains PENDING final (more complete) - replacing:`);
                          console.log(`[HostMode]   Pending: "${pendingFinal.text.substring(0, 60)}..."`);
                          console.log(`[HostMode]   More complete: "${bestText.substring(0, 80)}..."`);
                          console.log(`[HostMode]   Similarity: ${(similarity * 100).toFixed(1)}%`);
                          
                          // Update pending final with more complete version
                          pendingFinal.text = bestText;
                          pendingFinal.timestamp = Date.now();
                          
                          // Also update longest partial tracking
                          if (!longestPartialText || bestText.length > longestPartialText.length) {
                            longestPartialText = bestText;
                            longestPartialTime = Date.now();
                          }
                          
                          // Reset the commit timeout (use appropriate delay)
                          const delay = pendingFinal.isForced ? FINAL_COMMIT_DELAY_FORCED : FINAL_COMMIT_DELAY_NATURAL;
                          if (pendingFinalTimeout) {
                            clearTimeout(pendingFinalTimeout);
                          }
                          pendingFinalTimeout = setTimeout(() => {
                            commitPendingFinal();
                          }, delay);
                          
                          // Don't process as partial
                          return;
                        }
                      }
                    }
                  }
                  
                  // PRIORITY 2: Check if this partial should be backpatched to a recently finalized segment
                  // This catches late-arriving tokens that belong to previous lines
                  const wasBackpatched = await backpatchRecentlyFinalized(transcriptText);
                  if (wasBackpatched) {
                    // Successfully backpatched - don't process as new partial
                    return;
                  }
                  
                  // PRIORITY 3: Check if this partial extends a RECENT final (already committed, but in grace period)
                  // This allows us to send an updated final if we catch missing words
                  const timeSinceLastFinal = lastFinalTime ? (Date.now() - lastFinalTime) : Infinity;
                  if (lastFinalText && timeSinceLastFinal < PARTIAL_TRACKING_GRACE_PERIOD) {
                    // Quick string comparison - lightweight check
                    const lastFinalTrimmed = lastFinalText.trim();
                    const partialTrimmed = transcriptText.trim();
                    
                    // Case 1: Partial starts with the last final (common case - continuation at end)
                    if (partialTrimmed.startsWith(lastFinalTrimmed) && partialTrimmed.length > lastFinalTrimmed.length) {
                      // This partial extends the last final - merge and send updated final
                      const continuationText = partialTrimmed.substring(lastFinalTrimmed.length).trim();
                      if (continuationText) {
                        const mergedText = lastFinalText + ' ' + continuationText;
                        console.log(`[HostMode] 🔗 Partial extends last final (end) - merging:`);
                        console.log(`[HostMode]   Last final: "${lastFinalText.substring(0, 60)}..."`);
                        console.log(`[HostMode]   Continuation: "${continuationText}"`);
                        console.log(`[HostMode]   Merged: "${mergedText.substring(0, 80)}..."`);
                        
                        // Cancel the reset timeout since we're extending
                        if (partialTrackingResetTimeout) {
                          clearTimeout(partialTrackingResetTimeout);
                          partialTrackingResetTimeout = null;
                        }
                        
                        // Update last final
                        lastFinalText = mergedText;
                        lastFinalTime = Date.now();
                        
                        // Process as final ASYNCHRONOUSLY (non-blocking) - don't await
                        processFinalTranscript(mergedText, false).catch(error => {
                          console.error('[HostMode] Error processing continuation final:', error);
                        });
                        
                        // Reset tracking for new segment
                        latestPartialText = '';
                        longestPartialText = '';
                        latestPartialTime = 0;
                        longestPartialTime = 0;
                        
                        // Schedule new reset timeout
                        partialTrackingResetTimeout = setTimeout(() => {
                          latestPartialText = '';
                          longestPartialText = '';
                          lastFinalText = '';
                          lastFinalTime = 0;
                          partialTrackingResetTimeout = null;
                        }, PARTIAL_TRACKING_GRACE_PERIOD);
                        
                        return; // Don't process as partial - continuation handled asynchronously
                      }
                    }
                    // Case 2: Partial contains the last final (Google finalized too early, partial has more complete version)
                    else if (partialTrimmed.includes(lastFinalTrimmed) && partialTrimmed.length > lastFinalTrimmed.length) {
                      // Check if the partial is significantly longer to avoid false positives
                      // Require at least 5 chars more OR 5% longer (whichever is smaller) to catch short words like "You", "Do you"
                      const minLengthIncrease = Math.max(5, Math.floor(lastFinalTrimmed.length * 0.05));
                      if (partialTrimmed.length >= lastFinalTrimmed.length + minLengthIncrease) {
                        // Check if last final appears at the END of the partial (same sentence being extended)
                        // OR if partial starts with common sentence starters that would precede the last final
                        const lastFinalIndex = partialTrimmed.indexOf(lastFinalTrimmed);
                        const charsAfterLastFinal = partialTrimmed.length - (lastFinalIndex + lastFinalTrimmed.length);
                        const isAtEnd = charsAfterLastFinal <= 10; // Last final is at or near the end
                        
                        // Common sentence starters that might precede the last final
                        const commonStarters = ['do you', 'you', 'can you', 'will you', 'would you', 'could you', 
                                               'outside', 'week all week', 'for a', 'i love', 'centered'];
                        const partialLower = partialTrimmed.toLowerCase();
                        const startsWithCommon = commonStarters.some(starter => partialLower.startsWith(starter));
                        
                        if (isAtEnd || startsWithCommon) {
                          // This partial is a more complete version - use it as the final
                          console.log(`[HostMode] 🔗 Partial contains last final (more complete) - replacing:`);
                          console.log(`[HostMode]   Last final: "${lastFinalText.substring(0, 60)}..."`);
                          console.log(`[HostMode]   More complete: "${transcriptText.substring(0, 80)}..."`);
                          console.log(`[HostMode]   Reason: ${isAtEnd ? 'last final at end' : 'starts with common starter'}`);
                          
                          // Cancel the reset timeout since we're extending
                          if (partialTrackingResetTimeout) {
                            clearTimeout(partialTrackingResetTimeout);
                            partialTrackingResetTimeout = null;
                          }
                          
                          // Update last final with the more complete version
                          lastFinalText = transcriptText;
                          lastFinalTime = Date.now();
                          
                          // Process as final ASYNCHRONOUSLY (non-blocking) - don't await
                          processFinalTranscript(transcriptText, false).catch(error => {
                            console.error('[HostMode] Error processing continuation final:', error);
                          });
                          
                          // Reset tracking for new segment
                          latestPartialText = '';
                          longestPartialText = '';
                          latestPartialTime = 0;
                          longestPartialTime = 0;
                          
                          // Schedule new reset timeout
                          partialTrackingResetTimeout = setTimeout(() => {
                            latestPartialText = '';
                            longestPartialText = '';
                            lastFinalText = '';
                            lastFinalTime = 0;
                            partialTrackingResetTimeout = null;
                          }, PARTIAL_TRACKING_GRACE_PERIOD);
                          
                          return; // Don't process as partial - continuation handled asynchronously
                        }
                      }
                    }
                    // Case 3: Overlap check (partial might have different start but extends the end)
                    else {
                      // Quick overlap check (limited iterations for performance)
                      let overlap = 0;
                      const minLen = Math.min(lastFinalText.length, transcriptText.length);
                      for (let i = Math.min(minLen, 50); i > 15; i--) { // Reduced from 100/20 to 50/15 for speed
                        const oldSuffix = lastFinalText.slice(-i).trim();
                        if (transcriptText.trim().startsWith(oldSuffix)) {
                          overlap = i;
                          break;
                        }
                      }
                      
                      if (overlap > 0 && transcriptText.length > lastFinalText.length) {
                        // Partial extends the last final with overlap
                        const newPart = transcriptText.substring(overlap).trim();
                        if (newPart) {
                          const mergedText = lastFinalText.trim() + ' ' + newPart;
                          console.log(`[HostMode] 🔗 Partial extends last final (overlap) - merging:`);
                          console.log(`[HostMode]   Last final: "${lastFinalText.substring(0, 60)}..."`);
                          console.log(`[HostMode]   New part: "${newPart}"`);
                          console.log(`[HostMode]   Merged: "${mergedText.substring(0, 80)}..."`);
                          
                          // Cancel the reset timeout
                          if (partialTrackingResetTimeout) {
                            clearTimeout(partialTrackingResetTimeout);
                            partialTrackingResetTimeout = null;
                          }
                          
                          // Update last final
                          lastFinalText = mergedText;
                          lastFinalTime = Date.now();
                          
                          // Process as final ASYNCHRONOUSLY (non-blocking) - don't await
                          processFinalTranscript(mergedText, false).catch(error => {
                            console.error('[HostMode] Error processing continuation final:', error);
                          });
                          
                          // Reset tracking
                          latestPartialText = '';
                          longestPartialText = '';
                          latestPartialTime = 0;
                          longestPartialTime = 0;
                          
                          // Schedule new reset timeout
                          partialTrackingResetTimeout = setTimeout(() => {
                            latestPartialText = '';
                            longestPartialText = '';
                            lastFinalText = '';
                            lastFinalTime = 0;
                            partialTrackingResetTimeout = null;
                          }, PARTIAL_TRACKING_GRACE_PERIOD);
                          
                          return; // Don't process as partial - continuation handled asynchronously
                        }
                      }
                    }
                  }
                  
                  // NORMAL PARTIAL PROCESSING - continues here if not a continuation
                  
                  // Track latest partial
                  if (!latestPartialText || transcriptText.length > latestPartialText.length) {
                    latestPartialText = transcriptText;
                    latestPartialTime = Date.now();
                  }
                  
                  // Track latest partial for grammar correction relevance checks
                  latestPartialTextForCorrection = transcriptText;
                  
                  // CRITICAL FIX: Track the LONGEST partial we've seen
                  // This prevents word loss when finals come before all words are captured
                  if (!longestPartialText || transcriptText.length > longestPartialText.length) {
                    longestPartialText = transcriptText;
                    longestPartialTime = Date.now();
                    console.log(`[HostMode] 📏 New longest partial: ${longestPartialText.length} chars`);
                  }
                  
                  // Send live partial transcript to the HOST first
                  if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                      type: 'translation',
                      originalText: transcriptText,
                      translatedText: transcriptText,
                      sourceLang: currentSourceLang,
                      targetLang: currentSourceLang,
                      timestamp: Date.now(),
                      sequenceId: -1,
                      isPartial: true
                    }));
                  }
                  
                  // Also broadcast to ALL listeners so they can see the original text
                  // Frontend will filter using hasTranslation flag to avoid flipping
                  sessionStore.broadcastToListeners(sessionId, {
                    type: 'translation',
                    originalText: transcriptText,
                    translatedText: transcriptText, // Default to source (will be overridden for translated languages)
                    sourceLang: currentSourceLang,
                    targetLang: currentSourceLang,
                    timestamp: Date.now(),
                    sequenceId: -1,
                    isPartial: true,
                    hasTranslation: false // Flag to indicate this is just the original, not translated yet
                  });
                  
                  // REAL-TIME INSTANT: Start translation instantly with absolute minimum text
                  const targetLanguages = sessionStore.getSessionLanguages(sessionId);
                  if (targetLanguages.length > 0 && transcriptText.length > 1) {
                    const now = Date.now();
                    const timeSinceLastTranslation = now - lastPartialTranslationTime;
                    
                    // Separate same-language targets from translation targets
                    const sameLanguageTargets = targetLanguages.filter(lang => lang === currentSourceLang);
                    const translationTargets = targetLanguages.filter(lang => lang !== currentSourceLang);
                    
                    // OPTIMIZATION: For same-language targets, send immediately without waiting for grammar correction
                    // Grammar correction can happen asynchronously and update later
                    if (sameLanguageTargets.length > 0) {
                      // Send raw text immediately to same-language listeners (transcription mode)
                      for (const targetLang of sameLanguageTargets) {
                        sessionStore.broadcastToListeners(sessionId, {
                          type: 'translation',
                          originalText: transcriptText,
                          translatedText: transcriptText,
                          sourceLang: currentSourceLang,
                          targetLang: targetLang,
                          timestamp: Date.now(),
                          sequenceId: -1,
                          isPartial: true,
                          hasTranslation: false, // No translation needed for same language
                          hasCorrection: false // Will be updated asynchronously when grammar correction completes
                        }, targetLang);
                      }
                      
                      // Start grammar correction asynchronously (don't wait for it)
                      // Capture the text at this moment for comparison later
                      const capturedTextForCorrection = transcriptText;
                      grammarWorker.correctPartial(transcriptText, process.env.OPENAI_API_KEY)
                        .then(correctedText => {
                          // ALWAYS send grammar corrections - frontend will handle merging intelligently
                          // Update with corrected text when ready
                          for (const targetLang of sameLanguageTargets) {
                            sessionStore.broadcastToListeners(sessionId, {
                              type: 'translation',
                              originalText: capturedTextForCorrection, // Use captured text, not current transcriptText
                              correctedText: correctedText,
                              translatedText: correctedText,
                              sourceLang: currentSourceLang,
                              targetLang: targetLang,
                              timestamp: Date.now(),
                              sequenceId: -1,
                              isPartial: true,
                              hasTranslation: false,
                              hasCorrection: true
                            }, targetLang);
                          }
                        })
                        .catch(error => {
                          if (error.name !== 'AbortError') {
                            console.error('[HostMode] Grammar correction error (async):', error);
                          }
                          // Don't send error - raw text already sent
                        });
                    }
                    
                    // Process translations for different languages
                    if (translationTargets.length > 0) {
                      if (timeSinceLastTranslation >= PARTIAL_TRANSLATION_THROTTLE) {
                        lastPartialTranslationTime = now;
                        
                        // Cancel pending translation
                        if (pendingPartialTranslation) {
                          clearTimeout(pendingPartialTranslation);
                        }
                        
                        try {
                          console.log(`[HostMode] 🔄 Processing partial (grammar + translation to ${translationTargets.length} language(s))`);
                          // Run grammar correction and translation in parallel
                          // Route to appropriate worker based on tier
                          const partialWorker = usePremiumTier 
                            ? realtimePartialTranslationWorker 
                            : partialTranslationWorker;
                          const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                          console.log(`[HostMode] 🔀 Using ${workerType} API for partial translation to ${translationTargets.length} language(s) (${transcriptText.length} chars)`);
                          const [grammarResult, translationResult] = await Promise.allSettled([
                            grammarWorker.correctPartial(transcriptText, process.env.OPENAI_API_KEY),
                            partialWorker.translateToMultipleLanguages(
                              transcriptText,
                              currentSourceLang,
                              translationTargets,
                              process.env.OPENAI_API_KEY
                            )
                          ]);

                          const correctedText = grammarResult.status === 'fulfilled' 
                            ? grammarResult.value 
                            : transcriptText; // Fallback to original on error

                          const translations = translationResult.status === 'fulfilled'
                            ? translationResult.value
                            : {}; // Empty translations on error

                          // Broadcast corrected and translated partials to each language group
                          for (const targetLang of translationTargets) {
                            // CRITICAL: Only use translation if it exists - never fallback to English transcriptText
                            const translatedText = translations[targetLang];
                            const hasTranslationForLang = translationResult.status === 'fulfilled' && 
                                                          translatedText && 
                                                          translatedText.trim() &&
                                                          translatedText !== transcriptText;
                            lastPartialTranslations[targetLang] = transcriptText;
                            sessionStore.broadcastToListeners(sessionId, {
                              type: 'translation',
                              originalText: transcriptText,
                              correctedText: correctedText,
                              translatedText: hasTranslationForLang ? translatedText : undefined,
                              sourceLang: currentSourceLang,
                              targetLang: targetLang,
                              timestamp: Date.now(),
                              sequenceId: -1,
                              isPartial: true,
                              hasTranslation: hasTranslationForLang,
                              hasCorrection: grammarResult.status === 'fulfilled'
                            }, targetLang);
                          }
                        } catch (error) {
                          console.error('[HostMode] Partial processing error:', error);
                        }
                      } else {
                        // Schedule delayed translation
                        if (pendingPartialTranslation) {
                          clearTimeout(pendingPartialTranslation);
                        }
                        
                        pendingPartialTranslation = setTimeout(async () => {
                          try {
                            // Run grammar correction and translation in parallel
                            // Route to appropriate worker based on tier
                            const partialWorker = usePremiumTier 
                              ? realtimePartialTranslationWorker 
                              : partialTranslationWorker;
                            const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                            console.log(`[HostMode] 🔀 Using ${workerType} API for delayed partial translation to ${translationTargets.length} language(s) (${transcriptText.length} chars)`);
                            const [grammarResult, translationResult] = await Promise.allSettled([
                              grammarWorker.correctPartial(transcriptText, process.env.OPENAI_API_KEY),
                              partialWorker.translateToMultipleLanguages(
                                transcriptText,
                                currentSourceLang,
                                translationTargets,
                                process.env.OPENAI_API_KEY
                              )
                            ]);

                            const correctedText = grammarResult.status === 'fulfilled' 
                              ? grammarResult.value 
                              : transcriptText; // Fallback to original on error

                            const translations = translationResult.status === 'fulfilled'
                              ? translationResult.value
                              : {}; // Empty translations on error
                            
                            for (const targetLang of translationTargets) {
                              // CRITICAL: Only use translation if it exists - never fallback to English transcriptText
                              const translatedText = translations[targetLang];
                              const hasTranslationForLang = translationResult.status === 'fulfilled' && 
                                                            translatedText && 
                                                            translatedText.trim() &&
                                                            translatedText !== transcriptText;
                              lastPartialTranslations[targetLang] = transcriptText;
                              sessionStore.broadcastToListeners(sessionId, {
                                type: 'translation',
                                originalText: transcriptText,
                                correctedText: correctedText,
                                translatedText: hasTranslationForLang ? translatedText : undefined,
                                sourceLang: currentSourceLang,
                                targetLang: targetLang,
                                timestamp: Date.now(),
                                sequenceId: -1,
                                isPartial: true,
                                hasTranslation: hasTranslationForLang,
                                hasCorrection: grammarResult.status === 'fulfilled'
                              }, targetLang);
                            }
                          } catch (error) {
                            console.error('[HostMode] Delayed partial processing error:', error);
                          }
                        }, PARTIAL_TRANSLATION_THROTTLE);
                      }
                    }
                  }
                  return;
                }
                
                // Final transcript - delay processing to allow partials to extend it
                const isForcedFinal = meta?.forced === true;
                console.log(`[HostMode] 📝 FINAL signal received (${transcriptText.length} chars): "${transcriptText.substring(0, 80)}..."${isForcedFinal ? ' [FORCED]' : ''}`);
                
                // Use longest partial if it's longer (best version we have so far)
                const timeSinceLongest = longestPartialTime ? (Date.now() - longestPartialTime) : Infinity;
                let bestFinalText = transcriptText;
                
                if (longestPartialText && longestPartialText.length > transcriptText.length && timeSinceLongest < 2000) {
                  const longestTrimmed = longestPartialText.trim();
                  const finalTrimmed = transcriptText.trim();
                  
                  if (longestTrimmed.startsWith(finalTrimmed) || longestTrimmed.includes(finalTrimmed)) {
                    const missingWords = longestPartialText.substring(transcriptText.length).trim();
                    console.log(`[HostMode] ⚠️ Using LONGEST partial for final (${transcriptText.length} → ${longestPartialText.length} chars)`);
                    console.log(`[HostMode] 📊 Recovered: "${missingWords}"`);
                    bestFinalText = longestPartialText;
                  }
                }
                
                // Cancel any existing pending final timeout
                if (pendingFinalTimeout) {
                  clearTimeout(pendingFinalTimeout);
                  console.log(`[HostMode] ⏸️ Cancelled previous pending final, new final received`);
                }
                
                // Store as pending final (will be committed after delay)
                pendingFinal = {
                  text: bestFinalText,
                  timestamp: Date.now(),
                  isForced: isForcedFinal,
                  startTime: Date.now()
                };
                
                // Schedule commit after delay (allows partials to extend it)
                // Use appropriate delay: 0ms for natural (VAD pause), 750ms for forced
                const commitDelay = isForcedFinal ? FINAL_COMMIT_DELAY_FORCED : FINAL_COMMIT_DELAY_NATURAL;
                console.log(`[HostMode] ⏳ Scheduling final commit after ${commitDelay}ms delay (${isForcedFinal ? 'FORCED' : 'NATURAL'} - to catch extending partials)`);
                pendingFinalTimeout = setTimeout(() => {
                  commitPendingFinal();
                }, commitDelay);
              });
              
              console.log('[HostMode] ✅ Google Speech stream initialized and ready');
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
          // Process audio through Google Speech stream
          if (speechStream) {
            // Stream audio to Google Speech for transcription
            await speechStream.processAudio(message.audioData);
          } else {
            console.warn('[HostMode] Received audio before stream initialization');
          }
          break;
          
        case 'audio_end':
          console.log('[HostMode] Audio stream ended');
          if (speechStream) {
            await speechStream.endAudio();
          }
          break;
      }
    } catch (error) {
      console.error('[HostMode] Error processing message:', error);
    }
  });

  // Handle WebSocket errors
  clientWs.on('error', (error) => {
    console.error('[HostMode] Host WebSocket error:', error.message);
  });

  // Handle host disconnect
  clientWs.on('close', () => {
    console.log('[HostMode] Host disconnected from session');
    
    if (speechStream) {
      speechStream.destroy();
      speechStream = null;
    }
    
    sessionStore.closeSession(sessionId);
  });

  // Initialize the session as active
  sessionStore.setHost(sessionId, clientWs, null); // No direct WebSocket needed with stream
  console.log(`[HostMode] Session ${session.sessionCode} is now active with Google Speech`);
}

