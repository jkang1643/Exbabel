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
  const MAX_FINALIZATION_WAIT_MS = 12000; // Maximum 12 seconds - safety net for long sentences (increased to prevent mid-sentence cutoffs)
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
              
              // CRITICAL: Track last sent FINAL to merge consecutive continuations
              let lastSentFinalText = ''; // Last FINAL text that was sent to client
              let lastSentFinalTime = 0; // Timestamp when last FINAL was sent
              const FINAL_CONTINUATION_WINDOW_MS = 3000; // 3 seconds - if new FINAL arrives within this window and continues last, merge them
              
              // RECENTLY FINALIZED WINDOW: Keep previous lines editable for backpatching (Delayed Final Reconciliation System)
              const recentlyFinalized = []; // Array of {text, timestamp, sequenceId, isForced}
              const RECENTLY_FINALIZED_WINDOW = 2500; // 2.5 seconds
              const RECENTLY_FINALIZED_WINDOW_FORCED = 5000; // 5 seconds for force-committed segments
              const MAX_RECENT_FINALS = 4; // Keep last 4 finalized segments
              
              // Helper function to cleanup old entries from recentlyFinalized
              const cleanupRecentlyFinalized = () => {
                const now = Date.now();
                recentlyFinalized.forEach((entry, index) => {
                  const window = entry.isForced ? RECENTLY_FINALIZED_WINDOW_FORCED : RECENTLY_FINALIZED_WINDOW;
                  if (now - entry.timestamp > window) {
                    recentlyFinalized.splice(index, 1);
                  }
                });
                // Also limit by count
                if (recentlyFinalized.length > MAX_RECENT_FINALS) {
                  recentlyFinalized.shift(); // Remove oldest
                }
              };
              
              // Helper function to tokenize text for overlap matching
              const tokenize = (text) => {
                return text.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0);
              };
              
              // Helper function to calculate token overlap
              const calculateTokenOverlap = (tokens1, tokens2) => {
                if (tokens1.length === 0 || tokens2.length === 0) {
                  return { overlapType: 'none', overlapTokens: 0, similarity: 0 };
                }
                const maxCheck = 6;
                let bestOverlap = 0;
                let bestType = 'none';
                
                // Check if tokens2 starts with end of tokens1
                for (let i = 1; i <= Math.min(tokens1.length, maxCheck); i++) {
                  const suffix = tokens1.slice(-i);
                  if (tokens2.slice(0, i).join(' ') === suffix.join(' ')) {
                    if (i > bestOverlap) {
                      bestOverlap = i;
                      bestType = 'suffix-prefix';
                    }
                  }
                }
                
                // Check if tokens2 contains tokens1
                const tokens1Str = tokens1.join(' ');
                const tokens2Str = tokens2.join(' ');
                if (tokens2Str.includes(tokens1Str)) {
                  const overlapTokens = tokens1.length;
                  if (overlapTokens > bestOverlap) {
                    bestOverlap = overlapTokens;
                    bestType = 'contains';
                  }
                }
                
                const similarity = bestOverlap > 0 ? bestOverlap / Math.max(tokens1.length, tokens2.length) : 0;
                return { overlapType: bestType, overlapTokens: bestOverlap, similarity };
              };
              
              // Helper function to merge tokens
              const mergeTokens = (text1, text2) => {
                const tokens1 = tokenize(text1);
                const tokens2 = tokenize(text2);
                const overlap = calculateTokenOverlap(tokens1, tokens2);
                
                if (overlap.overlapType === 'suffix-prefix') {
                  const newTokens = tokens2.slice(overlap.overlapTokens);
                  return text1 + ' ' + newTokens.join(' ');
                } else if (overlap.overlapType === 'contains') {
                  return text2; // text2 contains text1, use text2
                } else {
                  return text1 + ' ' + text2;
                }
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
          
          const mergeWithOverlap = (previousText = '', currentText = '') => {
            const prev = (previousText || '').trim();
            const curr = (currentText || '').trim();
            if (!prev) return curr;
            if (!curr) return prev;
            if (curr.startsWith(prev)) {
              return curr;
            }
            // CRITICAL: More lenient matching - check if current text starts with previous (case-insensitive, ignoring extra spaces)
            const prevNormalized = prev.replace(/\s+/g, ' ').toLowerCase();
            const currNormalized = curr.replace(/\s+/g, ' ').toLowerCase();
            if (currNormalized.startsWith(prevNormalized)) {
              // Current extends previous (with normalization) - use current
              return curr;
            }
            // CRITICAL: Prevent cross-segment merging
            // If current text is significantly longer and doesn't start with previous, it's likely a different segment
            // Only merge if there's a clear overlap AND the texts are similar in structure
            if (curr.length > prev.length * 1.5) {
              // Current is much longer - check if it contains the previous text in a way that suggests same segment
              const prevWords = prev.split(/\s+/).filter(w => w.length > 2); // Words longer than 2 chars (more lenient)
              const currWords = curr.split(/\s+/).filter(w => w.length > 2);
              // If current doesn't share significant words with previous, don't merge
              const sharedWords = prevWords.filter(w => currWords.includes(w));
              if (sharedWords.length < Math.min(2, prevWords.length * 0.3)) {
                // Not enough shared words - likely different segment
                return null; // Don't merge
              }
            }
            const maxOverlap = Math.min(prev.length, curr.length, 200);
            // More lenient: Require overlap (at least 3 chars) to catch more cases, including short words
            // Also try case-insensitive matching
            for (let overlap = maxOverlap; overlap >= 3; overlap--) {
              const prevSuffix = prev.slice(-overlap).toLowerCase();
              const currPrefix = curr.slice(0, overlap).toLowerCase();
              // Try exact match first
              if (prev.slice(-overlap) === curr.slice(0, overlap)) {
                return (prev + curr.slice(overlap)).trim();
              }
              // Try case-insensitive match
              if (prevSuffix === currPrefix) {
                // Case-insensitive match - use original case from current text
                return (prev + curr.slice(overlap)).trim();
              }
              // Try normalized (ignore extra spaces)
              const prevSuffixNorm = prev.slice(-overlap).replace(/\s+/g, ' ').toLowerCase();
              const currPrefixNorm = curr.slice(0, overlap).replace(/\s+/g, ' ').toLowerCase();
              if (prevSuffixNorm === currPrefixNorm && overlap >= 5) {
                // Normalized match - merge them
                return (prev + curr.slice(overlap)).trim();
              }
            }
            // No significant overlap found - don't merge (return null to indicate failure)
            return null;
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
          
          // Helper: Check if text ends with a complete sentence
          // A complete sentence ends with sentence-ending punctuation (. ! ?) followed by optional quotes/closing punctuation
          const endsWithCompleteSentence = (text) => {
            if (!text || text.length === 0) return false;
            const trimmed = text.trim();
            // Ends with sentence-ending punctuation (period, exclamation, question mark, ellipsis)
            // May be followed by closing quotes, parentheses, or other closing punctuation
            if (/[.!?…]["')]*\s*$/.test(trimmed)) return true;
            // Also check for common sentence-ending patterns
            if (/[.!?…]\s*$/.test(trimmed)) return true;
            return false;
          };
              
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
                        
                        // Add to recently finalized window for backpatching (Delayed Final Reconciliation System)
                        const isForcedFinal = !!options.forceFinal;
                        const sequenceId = Date.now();
                        const segmentToAdd = {
                          text: textToProcess,
                          timestamp: Date.now(),
                          sequenceId: sequenceId,
                          isForced: isForcedFinal
                        };
                        recentlyFinalized.push(segmentToAdd);
                        console.log(`[SoloMode] 📦 Added to recentlyFinalized: "${textToProcess.substring(0, 60)}..." (isForced: ${isForcedFinal})`);
                        cleanupRecentlyFinalized();
                        console.log(`[SoloMode] 📦 After cleanup: ${recentlyFinalized.length} segments in window`);
                        
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
                
                // DEBUG: Log every result to verify callback is being called
                console.log(`[SoloMode] 📥 RESULT RECEIVED: ${isPartial ? 'PARTIAL' : 'FINAL'} "${transcriptText.substring(0, 60)}..." (meta: ${JSON.stringify(meta)})`);
                
                if (isPartial) {
                  // PRIORITY 0: ALWAYS check if this partial should backpatch to a force-committed segment
                  // This catches partials that arrive in the gap between force commits (MOST IMPORTANT CASE)
                  cleanupRecentlyFinalized();
                  
                  console.log(`[SoloMode] 🔍 PRIORITY 0 CHECK: Partial "${transcriptText.substring(0, 60)}..." - checking ${recentlyFinalized.length} recently finalized segments`);
                  
                  // Check if any recently finalized segment was force-committed
                  let foundForceCommitted = false;
                  for (let i = recentlyFinalized.length - 1; i >= 0; i--) {
                    const recentFinal = recentlyFinalized[i];
                    const isForced = recentFinal.isForced || false;
                    const age = Date.now() - recentFinal.timestamp;
                    console.log(`[SoloMode]   Checking segment ${i}: "${recentFinal.text.substring(0, 60)}..." (isForced: ${isForced}, age: ${age}ms)`);
                    
                    if (isForced) {
                      foundForceCommitted = true;
                      console.log(`[SoloMode]   ✅ Found FORCE-COMMITTED segment - evaluating merge...`);
                      const recentTokens = tokenize(recentFinal.text);
                      const partialTokens = tokenize(transcriptText);
                      const recentTrimmed = recentFinal.text.trim().toLowerCase();
                      const partialTrimmed = transcriptText.trim().toLowerCase();
                      
                      // Check for continuation words
                      const continuationWords = ['and', 'then', 'so', 'but', 'or', 'nor', 'yet', 'while', 'when', 
                                                'where', 'as', 'if', 'because', 'since', 'although', 'though',
                                                'after', 'before', 'during', 'until', 'unplug', 'engage', 'rather'];
                      const startsWithContinuation = partialTokens.length > 0 && continuationWords.includes(partialTokens[0].toLowerCase());
                      
                      // Check if partial extends the force-committed segment
                      const overlap = calculateTokenOverlap(recentTokens, partialTokens);
                      const hasOverlap = overlap.overlapType !== 'none' && overlap.overlapTokens >= 1;
                      const partialContainsRecent = partialTrimmed.includes(recentTrimmed) && partialTrimmed.length > recentTrimmed.length;
                      const partialStartsWithRecent = partialTrimmed.startsWith(recentTrimmed) && partialTrimmed.length > recentTrimmed.length;
                      const recentEndsWithPeriod = recentFinal.text.trim().endsWith('.');
                      
                      // Very aggressive: merge if:
                      // 1. Partial starts with continuation word OR
                      // 2. Has ANY overlap OR
                      // 3. Partial contains/starts with recent OR
                      // 4. Recent doesn't end with period (incomplete sentence)
                      console.log(`[SoloMode]   Evaluation: startsWithContinuation=${startsWithContinuation}, hasOverlap=${hasOverlap} (overlapTokens=${overlap.overlapTokens}), partialContainsRecent=${partialContainsRecent}, partialStartsWithRecent=${partialStartsWithRecent}, recentEndsWithPeriod=${recentEndsWithPeriod}`);
                      
                      if (startsWithContinuation || hasOverlap || partialContainsRecent || partialStartsWithRecent || !recentEndsWithPeriod) {
                        console.log(`[SoloMode]   ✅ Merge condition met! Attempting merge...`);
                        let mergedText;
                        
                        // If partial starts with recent, just append the continuation
                        if (partialStartsWithRecent) {
                          const continuationText = transcriptText.substring(recentFinal.text.length).trim();
                          mergedText = recentFinal.text + ' ' + continuationText;
                        } else {
                          // Use token-based merge
                          mergedText = mergeTokens(recentFinal.text, transcriptText);
                        }
                        
                        if (mergedText.length > recentFinal.text.length) {
                          console.log(`[SoloMode] 🔙 SEAMLESS BACKPATCH: Partial extends FORCE-COMMITTED segment (gap between commits):`);
                          console.log(`[SoloMode]   Force-committed: "${recentFinal.text.substring(0, 60)}..."`);
                          console.log(`[SoloMode]   Partial: "${transcriptText.substring(0, 60)}..."`);
                          console.log(`[SoloMode]   Merged: "${mergedText.substring(0, 80)}..."`);
                          console.log(`[SoloMode]   Reason: ${startsWithContinuation ? 'continuation word' : hasOverlap ? 'overlap' : partialContainsRecent ? 'contains' : 'no period'}`);
                          
                          // CRITICAL: Check if we just sent a final for this segment recently
                          // Only send backpatch update if:
                          // 1. Enough time has passed (2+ seconds) OR
                          // 2. Significant new content added (10+ words or 50+ chars)
                          const timeSinceLastSent = lastSentFinalTime ? (Date.now() - lastSentFinalTime) : Infinity;
                          const newContent = mergedText.substring(recentFinal.text.length).trim();
                          const newWordCount = newContent.split(/\s+/).filter(w => w.length > 0).length;
                          const significantExtension = newWordCount >= 5 || newContent.length >= 30;
                          const enoughTimePassed = timeSinceLastSent >= 2000;
                          
                          // Update the force-committed segment in memory
                          recentFinal.text = mergedText;
                          recentFinal.timestamp = Date.now();
                          
                          if (!enoughTimePassed && !significantExtension) {
                            // Too recent and not significant - don't send new final to avoid duplicate history entries
                            // The extended text will be included in the next natural final
                            console.log(`[SoloMode]   ⏭️ Skipping backpatch send - too recent (${timeSinceLastSent}ms ago, +${newWordCount} words), will be included in next final`);
                            // Update lastSentFinalText to reflect the extension (in memory only)
                            lastSentFinalText = mergedText;
                            lastSentFinalTime = Date.now();
                          } else {
                            // Send updated final - significant extension or enough time has passed
                            console.log(`[SoloMode]   ✅ Sending backpatch update (${timeSinceLastSent}ms since last send, +${newWordCount} words, ${significantExtension ? 'significant' : 'time passed'})`);
                            await processFinalText(mergedText, { forceFinal: false });
                          }
                          
                          // Don't process as new partial - it's been backpatched
                          return;
                        } else {
                          console.log(`[SoloMode]   ⚠️ Merge resulted in same or shorter length (${recentFinal.text.length} → ${mergedText.length} chars) - skipping`);
                        }
                      } else {
                        console.log(`[SoloMode]   ❌ Merge conditions not met - skipping`);
                      }
                    }
                  }
                  
                  if (!foundForceCommitted) {
                    console.log(`[SoloMode]   ⚠️ No force-committed segments found in ${recentlyFinalized.length} recent segments`);
                  }
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
                    
                    // CRITICAL: Sentence-aware continuation detection
                    // If FINAL doesn't end with complete sentence, partials are likely continuations
                    const finalEndsWithCompleteSentence = endsWithCompleteSentence(finalText);
                    const finalEndsWithPunctuationOrSpace = /[.!?…\s]$/.test(finalText);
                    const isVeryShortPartial = partialText.length < 20; // Very short partials (< 20 chars) are likely continuations
                    // If final doesn't end with complete sentence, wait longer for continuation (up to 5 seconds)
                    const mightBeContinuation = !finalEndsWithCompleteSentence && isVeryShortPartial && timeSinceFinal < 5000;
                    
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
                            if (merged && merged.length > finalTrimmed.length + 5 && merged.length > longestTrimmed.length * 0.7) {
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
                            if (merged && merged.length > finalTrimmed.length + 5 && merged.length > latestTrimmed.length * 0.7) {
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
                      clearTimeout(pendingFinalization.timeout);
                      // If extended text ends with complete sentence, use shorter wait; otherwise wait longer
                      const extendedEndsWithCompleteSentence = endsWithCompleteSentence(textToUpdate);
                      const baseWait = extendedEndsWithCompleteSentence ? 1000 : 2000; // Shorter wait if sentence is complete
                      const remainingWait = Math.max(800, baseWait - timeSinceFinal);
                      console.log(`[SoloMode] ⏱️ Extending finalization wait by ${remainingWait}ms (partial still growing: ${textToUpdate.length} chars, sentence complete: ${extendedEndsWithCompleteSentence})`);
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
                      // New segment detected - but check if final ends with complete sentence first
                      // If final doesn't end with complete sentence, wait longer before committing
                      const finalEndsWithCompleteSentence = endsWithCompleteSentence(pendingFinalization.text);
                      if (!finalEndsWithCompleteSentence && timeSinceFinal < 3000) {
                        // Final doesn't end with complete sentence and not enough time has passed - wait more
                        console.log(`[SoloMode] ⏳ New segment detected but final incomplete - waiting longer (${timeSinceFinal}ms < 3000ms)`);
                        // Continue tracking - don't commit yet
                      } else {
                        // Commit FINAL immediately using longest partial that extends it
                        // CRITICAL: Only use partials that DIRECTLY extend the final (start with it) to prevent mixing segments
                        console.log(`[SoloMode] 🔀 New segment detected during finalization (${timeSinceFinal}ms since final) - committing FINAL`);
                        console.log(`[SoloMode] 📊 Pending final: "${pendingFinalization.text.substring(0, 100)}..."`);
                        console.log(`[SoloMode] 📊 Longest partial: "${longestPartialText?.substring(0, 100) || 'none'}..."`);
                        
                        clearTimeout(pendingFinalization.timeout);
                        
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
                        
                        // Reset and commit immediately
                        latestPartialText = '';
                        longestPartialText = '';
                        latestPartialTime = 0;
                        longestPartialTime = 0;
                        pendingFinalization = null;
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
                  // If FINAL doesn't end with a complete sentence, wait significantly longer
                  // This prevents cutting off mid-sentence and causing transcription errors
                  const finalEndsWithCompleteSentence = endsWithCompleteSentence(transcriptText);
                  if (!finalEndsWithCompleteSentence) {
                    // FINAL doesn't end with complete sentence - wait MUCH longer for continuation
                    // This allows long sentences to complete naturally before finalizing
                    const SENTENCE_WAIT_MS = Math.max(4000, Math.min(8000, transcriptText.length * 20)); // 4-8 seconds based on length (increased)
                    WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, SENTENCE_WAIT_MS);
                    console.log(`[SoloMode] ⚠️ FINAL doesn't end with complete sentence - extending wait to ${WAIT_FOR_PARTIALS_MS}ms to catch sentence completion`);
                    console.log(`[SoloMode] 📝 Current text: "${transcriptText.substring(Math.max(0, transcriptText.length - 60))}"`);
                  } else {
                    // FINAL ends with complete sentence - still check for punctuation for backward compatibility
                    const finalEndsWithPunctuation = /[.!?…]$/.test(transcriptText.trim());
                    if (!finalEndsWithPunctuation) {
                      // Has sentence ending but not standard punctuation - still wait a bit
                      WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 1500);
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
                    // Increase wait time to catch complete word
                    WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 1200); // At least 1200ms for mid-word finals
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
                    // CRITICAL: Don't reset partials here - they're needed during timeout check
                    // Both BASIC and PREMIUM tiers need partials available during the wait period
                    // Partials will be reset AFTER final processing completes (see timeout callback)
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
                      
                      if (!finalEndsWithCompleteSentence && timeSinceMaxWait < MAX_FINALIZATION_WAIT_MS) {
                        // Sentence is incomplete but we haven't hit max wait yet - wait a bit more
                        // CRITICAL: Update pendingFinalization.text with the latest finalTextToUse (may include partials)
                        pendingFinalization.text = finalTextToUse;
                        // More aggressive wait: up to 4 seconds per reschedule, but don't exceed max wait
                        const remainingWait = Math.min(4000, MAX_FINALIZATION_WAIT_MS - timeSinceMaxWait);
                        console.log(`[SoloMode] ⏳ Sentence incomplete - waiting ${remainingWait}ms more (${timeSinceMaxWait}ms / ${MAX_FINALIZATION_WAIT_MS}ms)`);
                        // Reschedule the timeout to check again after remaining wait
                        pendingFinalization.timeout = setTimeout(() => {
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
                          latestPartialText = '';
                          longestPartialText = '';
                          latestPartialTime = 0;
                          longestPartialTime = 0;
                          pendingFinalization = null;
                          console.log(`[SoloMode] ✅ FINAL Transcript (after ${waitTime}ms wait): "${textToProcess.substring(0, 80)}..."`);
                          processFinalText(textToProcess);
                        }, remainingWait);
                        return; // Don't commit yet
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

