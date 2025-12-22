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
import { CoreEngine } from '../core/engine/coreEngine.js';
// PHASE 8: Using CoreEngine which coordinates all extracted engines
// Host mode is a thin wrapper: host mic → coreEngine → broadcast events → listeners

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

  // Helper: Measure RTT from client timestamp
  const measureRTT = (clientTimestamp) => {
    return rttTracker.measureRTT(clientTimestamp);
  };

  // Helper: Get adaptive lookahead based on RTT
  const getAdaptiveLookahead = () => {
    return rttTracker.getAdaptiveLookahead();
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
                latestPartialText = snapshot.latestPartialText;
                longestPartialText = snapshot.longestPartialText;
                latestPartialTime = snapshot.latestPartialTime;
                longestPartialTime = snapshot.longestPartialTime;
              };
              
              // PHASE 8: Finalization state now uses CoreEngine Finalization Engine
              // Compatibility layer - pendingFinalization variable synced with engine
              // Helper to sync pendingFinalization from engine (call after engine operations)
              const syncPendingFinalization = () => {
                pendingFinalization = finalizationEngine.getPendingFinalization();
              };
              
              // PHASE 8: Forced final buffer now uses CoreEngine Forced Commit Engine
              // Compatibility layer - forcedFinalBuffer variable synced with engine
              // Helper to sync forcedFinalBuffer from engine (call after engine operations)
              const syncForcedFinalBuffer = () => {
                forcedFinalBuffer = forcedCommitEngine.getForcedFinalBuffer();
              };
              
              // Last audio timestamp for silence detection
              let lastAudioTimestamp = null;
              let silenceStartTime = null;
              let realtimeTranslationCooldownUntil = 0;
              
              // Legacy pendingFinal for backwards compatibility (will be replaced by pendingFinalization)
              let pendingFinal = null; // {text, timeout, timestamp, isForced, startTime}
              let pendingFinalTimeout = null;
              
              // PHASE 8: Removed deprecated backpatching logic (replaced by dual buffer recovery system)
              
              // Helper function to tokenize text for overlap matching
              const tokenize = (text) => {
                return text.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0);
              };
              
              // Helper function to check if two words are related (stem matching)
              const wordsAreRelated = (word1, word2) => {
                if (word1 === word2) return true;
                if (word1.includes(word2) || word2.includes(word1)) return true;
                
                // Check for common word variations (sit/sitting, go/going, etc.)
                const shorter = word1.length < word2.length ? word1 : word2;
                const longer = word1.length >= word2.length ? word1 : word2;
                
                // Check if longer word starts with shorter (stem match)
                if (longer.startsWith(shorter) && shorter.length >= 3) {
                  const remaining = longer.substring(shorter.length);
                  // Common suffixes: ing, ed, er, s, es
                  if (['ing', 'ed', 'er', 's', 'es', 'ly'].includes(remaining)) {
                    return true;
                  }
                }
                
                return false;
              };
              
              // Helper function to calculate token overlap similarity
              // Returns: {similarity: 0-1, overlapTokens: number, overlapType: 'exact'|'fuzzy'|'none'}
              const calculateTokenOverlap = (tokens1, tokens2, minOverlap = 2) => {
                if (!tokens1 || !tokens2 || tokens1.length === 0 || tokens2.length === 0) {
                  return {similarity: 0, overlapTokens: 0, overlapType: 'none'};
                }
                
                // Check if tokens2 starts with end of tokens1 (most common case)
                const maxCheck = Math.min(tokens1.length, tokens2.length, 6); // Check up to 6 tokens
                for (let i = maxCheck; i >= minOverlap; i--) {
                  const endTokens1 = tokens1.slice(-i);
                  const startTokens2 = tokens2.slice(0, i);
                  
                  // Exact match (most reliable)
                  if (endTokens1.join(' ') === startTokens2.join(' ')) {
                    const similarity = i / Math.max(tokens1.length, tokens2.length);
                    return {similarity, overlapTokens: i, overlapType: 'exact'};
                  }
                  
                  // Fuzzy match - require higher threshold for accuracy
                  let exactMatches = 0;
                  let partialMatches = 0;
                  for (let j = 0; j < i; j++) {
                    if (endTokens1[j] === startTokens2[j]) {
                      exactMatches++;
                    } else if (wordsAreRelated(endTokens1[j], startTokens2[j])) {
                      // Words are related (stem match, includes, etc.)
                      partialMatches++;
                    } else if (endTokens1[j].includes(startTokens2[j]) || startTokens2[j].includes(endTokens1[j])) {
                      // Only count as partial if words are similar length (avoid false matches)
                      const lenDiff = Math.abs(endTokens1[j].length - startTokens2[j].length);
                      if (lenDiff <= 2) { // Words must be similar length
                        partialMatches++;
                      }
                    }
                  }
                  
                  // Require at least 80% exact matches OR 90% combined (exact + partial)
                  const totalMatches = exactMatches + partialMatches;
                  if (exactMatches >= i * 0.8 || totalMatches >= i * 0.9) {
                    const similarity = totalMatches / Math.max(tokens1.length, tokens2.length);
                    return {similarity, overlapTokens: i, overlapType: 'fuzzy'};
                  }
                }
                
                return {similarity: 0, overlapTokens: 0, overlapType: 'none'};
              };
              
              // Helper function to merge tokens with overlap
              const mergeTokens = (text1, text2) => {
                const tokens1 = tokenize(text1);
                const tokens2 = tokenize(text2);
                
                if (tokens1.length === 0) return text2;
                if (tokens2.length === 0) return text1;
                
                // Use overlap calculation to find best merge point
                const overlap = calculateTokenOverlap(tokens1, tokens2);
                
                if (overlap.overlapType !== 'none' && overlap.overlapTokens >= 2) {
                  // Found overlap - merge at overlap point
                  const merged = [...tokens1, ...tokens2.slice(overlap.overlapTokens)];
                  return merged.join(' ');
                }
                
                // No overlap found - check if text2 contains text1 (more complete version)
                const text1Lower = text1.trim().toLowerCase();
                const text2Lower = text2.trim().toLowerCase();
                if (text2Lower.includes(text1Lower) && text2.length > text1.length) {
                  // text2 is a more complete version - use it
                  return text2;
                }
                
                // No overlap - concatenate (but be conservative)
                // Only concatenate if they seem related (check for common words)
                const text1Words = new Set(tokens1);
                const text2Words = new Set(tokens2);
                const commonWords = [...text1Words].filter(w => text2Words.has(w));
                if (commonWords.length >= 2) {
                  // Has common words - likely related, concatenate
                  return text1.trim() + ' ' + text2.trim();
                }
                
                // No clear relationship - return text2 if longer, else text1
                // This prevents incorrect merges
                return text2.length > text1.length ? text2 : text1;
              };
              
              // Helper function from solo mode: merge with overlap (more lenient)
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
              
              // PHASE 8: Sequence tracking now uses CoreEngine Timeline Tracker
              // Helper function to broadcast message to host and listeners (uses CoreEngine for sequencing)
              // Use currentSessionId to ensure proper closure capture
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
              const FINAL_CONTINUATION_WINDOW_MS = 3000;
              
              // Flag to prevent concurrent final processing
              let isProcessingFinal = false;
              
              // PHASE 8: Removed deprecated checkForExtendingPartialsAfterFinal and cleanupRecentlyFinalized functions
              // These were part of the old backpatching system, now replaced by dual buffer recovery
              
              // Function to commit a pending final (after delay)
              const commitPendingFinal = async () => {
                if (!pendingFinal) return;
                
                let finalTextToProcess = pendingFinal.text;
                const isForcedFinal = pendingFinal.isForced;
                
                // CRITICAL: Sync partial variables to get fresh data before checking
                syncPartialVariables();
                
                // LAST CHANCE: Aggressively check for any partials that extend the pending final
                const now = Date.now();
                const timeSinceLongest = longestPartialTime ? (now - longestPartialTime) : Infinity;
                const timeSinceLatest = latestPartialTime ? (now - latestPartialTime) : Infinity;
                
                // Check longest partial (most complete version we've seen)
                // Extended window to 6000ms to catch partials that arrive after the 4000ms delay (covers 10 words + buffer)
                if (longestPartialText && longestPartialText.length > finalTextToProcess.length && timeSinceLongest < 6000) {
                  const longestTrimmed = longestPartialText.trim().toLowerCase();
                  const finalTrimmed = finalTextToProcess.trim().toLowerCase();
                  
                  // Check if longest extends or contains the final
                  if (longestTrimmed.startsWith(finalTrimmed) || longestTrimmed.includes(finalTrimmed)) {
                    const missingWords = longestPartialText.substring(finalTextToProcess.length).trim();
                    console.log(`[HostMode] ⚠️ LAST CHANCE: Using LONGEST partial (${finalTextToProcess.length} → ${longestPartialText.length} chars)`);
                    console.log(`[HostMode] 📊 Recovered: "${missingWords}"`);
                    finalTextToProcess = longestPartialText;
                  } else {
                    // Try token-based merge
                    const overlap = calculateTokenOverlap(tokenize(finalTextToProcess), tokenize(longestPartialText));
                    if (overlap.overlapType !== 'none' && overlap.overlapTokens >= 2) {
                      const merged = mergeTokens(finalTextToProcess, longestPartialText);
                      if (merged.length > finalTextToProcess.length) {
                        console.log(`[HostMode] ⚠️ LAST CHANCE: Merged with LONGEST partial (${finalTextToProcess.length} → ${merged.length} chars)`);
                        finalTextToProcess = merged;
                      }
                    }
                  }
                }
                
                // Also check latest partial (might be even more recent)
                // Extended window to 6000ms to match longest partial window (covers 10 words + buffer)
                if (latestPartialText && timeSinceLatest < 6000) {
                  const latestTrimmed = latestPartialText.trim().toLowerCase();
                  const finalTrimmed = finalTextToProcess.trim().toLowerCase();
                  const latestTokens = tokenize(latestPartialText);
                  const continuationWords = ['and', 'then', 'so', 'but', 'or', 'nor', 'yet', 'while', 'when'];
                  const startsWithContinuation = latestTokens.length > 0 && continuationWords.includes(latestTokens[0]);
                  
                  // Check if latest extends final OR starts with continuation word
                  if (latestPartialText.length > finalTextToProcess.length) {
                    if (latestTrimmed.startsWith(finalTrimmed) || latestTrimmed.includes(finalTrimmed)) {
                      const missingWords = latestPartialText.substring(finalTextToProcess.length).trim();
                      console.log(`[HostMode] ⚠️ LAST CHANCE: Using LATEST partial (${finalTextToProcess.length} → ${latestPartialText.length} chars)`);
                      console.log(`[HostMode] 📊 Recovered: "${missingWords}"`);
                      finalTextToProcess = latestPartialText;
                    } else if (startsWithContinuation) {
                      // Latest starts with continuation word - merge it
                      const merged = mergeTokens(finalTextToProcess, latestPartialText);
                      if (merged.length > finalTextToProcess.length) {
                        console.log(`[HostMode] ⚠️ LAST CHANCE: Merging continuation word partial "${latestTokens[0]}"`);
                        console.log(`[HostMode] 📊 Recovered: "${latestPartialText}"`);
                        finalTextToProcess = merged;
                      }
                    }
                  } else if (startsWithContinuation) {
                    // Even if shorter, if it starts with continuation word, merge it
                    const merged = mergeTokens(finalTextToProcess, latestPartialText);
                    if (merged.length > finalTextToProcess.length) {
                      console.log(`[HostMode] ⚠️ LAST CHANCE: Merging continuation word partial "${latestTokens[0]}"`);
                      console.log(`[HostMode] 📊 Recovered: "${latestPartialText}"`);
                      finalTextToProcess = merged;
                    }
                  }
                }
                
                // Update last final tracking (for continuation detection in grace period)
                lastFinalText = finalTextToProcess;
                lastFinalTime = Date.now();
                
                // Add to recently finalized window for backpatching
                // CRITICAL: Store isForced flag so we can use longer window for force-committed segments
                // PHASE 8: Removed deprecated backpatching logic (recentlyFinalized tracking)
                // Dual buffer recovery system handles word recovery now
                
                // PHASE 8: Reset partial tracking using CoreEngine
                partialTracker.reset();
                syncPartialVariables(); // Sync variables after reset
                
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
              
              // PHASE 8: Removed deprecated backpatchRecentlyFinalized function
              // Dual buffer recovery system handles word recovery now
              
              // Extract final processing into separate async function (using solo mode logic, adapted for broadcasting)
              const processFinalText = (textToProcess, options = {}) => {
                (async () => {
                  try {
                    // CRITICAL: Prevent concurrent final processing
                    if (isProcessingFinal) {
                      console.log(`[HostMode] ⚠️ Final already being processed, skipping: "${textToProcess.substring(0, 60)}..."`);
                      return; // Skip if already processing a final
                    }
                    
                    // Set flag to prevent concurrent processing
                    isProcessingFinal = true;
                    
                    // CRITICAL: Duplicate prevention - skip if same text was just sent
                    const trimmedText = textToProcess.trim();
                    if (lastSentFinalText && (Date.now() - lastSentFinalTime) < FINAL_CONTINUATION_WINDOW_MS) {
                      const lastSentTrimmed = lastSentFinalText.trim();
                      // Normalize for comparison (case-insensitive, normalize whitespace)
                      const textNormalized = trimmedText.replace(/\s+/g, ' ').toLowerCase();
                      const lastSentNormalized = lastSentTrimmed.replace(/\s+/g, ' ').toLowerCase();
                      
                      // Check if text is essentially the same (exact match or very similar)
                      if (textNormalized === lastSentNormalized || 
                          (textNormalized.length > 10 && lastSentNormalized.length > 10 && 
                           (textNormalized.includes(lastSentNormalized) || lastSentNormalized.includes(textNormalized)) &&
                           Math.abs(textNormalized.length - lastSentNormalized.length) < 5)) {
                        console.log(`[HostMode] ⚠️ Duplicate final detected, skipping: "${trimmedText.substring(0, 60)}..." (last sent: "${lastSentTrimmed.substring(0, 60)}...")`);
                        isProcessingFinal = false; // Clear flag before returning
                        return; // Skip processing duplicate
                      }
                    }
                    
                    // Bible reference detection (non-blocking, runs in parallel)
                    coreEngine.detectReferences(textToProcess, {
                      sourceLang: currentSourceLang,
                      targetLang: currentSourceLang, // Host mode broadcasts to all languages
                      seqId: timelineTracker.getCurrentSeqId(),
                      openaiApiKey: process.env.OPENAI_API_KEY
                    }).then(references => {
                      if (references && references.length > 0) {
                        // Broadcast scripture detected events to all listeners
                        for (const ref of references) {
                          const message = {
                            type: 'scriptureDetected',
                            reference: {
                              book: ref.book,
                              chapter: ref.chapter,
                              verse: ref.verse
                            },
                            displayText: ref.displayText,
                            confidence: ref.confidence,
                            method: ref.method,
                            timestamp: Date.now(),
                            seqId: timelineTracker.getCurrentSeqId()
                          };
                          sessionStore.broadcastToListeners(currentSessionId, message);
                          console.log(`[HostMode] 📜 Scripture detected: ${ref.displayText} (confidence: ${ref.confidence.toFixed(2)}, method: ${ref.method})`);
                        }
                      }
                    }).catch(err => {
                      console.error('[HostMode] Bible reference detection error:', err);
                      // Fail silently - don't block transcript delivery
                    });
                    
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
                      console.log(`[HostMode] 📤 Sending FINAL (coupled for history integrity):`);
                      console.log(`[HostMode]   originalText: "${textToProcess}"`);
                      console.log(`[HostMode]   correctedText: "${correctedText}"`);
                      console.log(`[HostMode]   translations: ${Object.keys(translations).length} language(s)`);
                      console.log(`[HostMode]   hasCorrection: ${hasCorrection}`);

                      // Send to host first
                      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                        broadcastWithSequence({
                          type: 'translation',
                          originalText: textToProcess,
                          correctedText: correctedText,
                          translatedText: correctedText, // Host sees corrected source text
                          sourceLang: currentSourceLang,
                          targetLang: currentSourceLang,
                          timestamp: Date.now(),
                          hasTranslation: false,
                          hasCorrection: hasCorrection,
                          forceFinal: !!options.forceFinal
                        }, false);
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
                          originalText: textToProcess,
                          correctedText: correctedText,
                          sourceLang: currentSourceLang,
                          targetLang: targetLang,
                          timestamp: Date.now(),
                          hasTranslation: hasTranslationForLang,
                          hasCorrection: hasCorrection,
                          forceFinal: !!options.forceFinal
                        };
                        
                        // Only include translatedText if we have a valid translation
                        if (hasTranslationForLang) {
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
                      // BUT: For forced finals, clear the tracking to prevent next FINAL from merging with it
                      // Forced finals should always start a new line, not be merged with previous finals
                      const isForcedFinal = !!options.forceFinal;
                      if (isForcedFinal) {
                        // Clear tracking for forced finals - they should start a new line
                        lastSentFinalText = '';
                        lastSentFinalTime = 0;
                        console.log('[HostMode] 🧹 Cleared lastSentFinalText for forced final (should start new line)');
                      } else {
                        lastSentFinalText = correctedText !== textToProcess ? correctedText : textToProcess;
                        lastSentFinalTime = Date.now();
                      }
                      
                      // Add to recently finalized window for backpatching (Delayed Final Reconciliation System)
                      // PHASE 8: Removed deprecated backpatching logic (recentlyFinalized tracking)
                      // Dual buffer recovery system handles word recovery now
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
                      // BUT: For forced finals, clear the tracking to prevent next FINAL from merging with it
                      const isForcedFinal = !!options.forceFinal;
                      if (error.skipRequest || finalText !== `[Translation error: ${error.message}]`) {
                        if (isForcedFinal) {
                          // Clear tracking for forced finals - they should start a new line
                          lastSentFinalText = '';
                          lastSentFinalTime = 0;
                          console.log('[HostMode] 🧹 Cleared lastSentFinalText for forced final (error case, should start new line)');
                        } else {
                          lastSentFinalText = textToProcess;
                          lastSentFinalTime = Date.now();
                        }
                        
                        // PHASE 8: Removed deprecated backpatching check
                      }
                    } finally {
                      // CRITICAL: Always clear the processing flag when done
                      isProcessingFinal = false;
                    }
                  } catch (error) {
                    console.error(`[HostMode] Error processing final:`, error);
                    // CRITICAL: Clear flag on outer error too
                    isProcessingFinal = false;
                  }
                })();
              };
              
              // Alias for backwards compatibility
              const processFinalTranscript = processFinalText;
              
              // Set up result callback - handles both partials and finals (solo mode logic, adapted for broadcasting)
              speechStream.onResult(async (transcriptText, isPartial, meta = {}) => {
                if (!clientWs || clientWs.readyState !== WebSocket.OPEN) return;
                
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
                      // Partial extends the forced final - merge and commit
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
                      // New segment detected - commit forced final separately
                      console.log('[HostMode] 🔀 New segment detected - committing forced final separately');
                      forcedCommitEngine.clearForcedFinalBufferTimeout();
                      const buffer = forcedCommitEngine.getForcedFinalBuffer();
                      processFinalText(buffer.text, { forceFinal: true });
                      forcedCommitEngine.clearForcedFinalBuffer();
                      syncForcedFinalBuffer();
                      // Continue processing the new partial as a new segment
                    }
                  }
                  
                  // Track latest partial for correction race condition prevention
                  latestPartialTextForCorrection = transcriptText;
                  const translationSeedText = applyCachedCorrections(transcriptText);
                  
                  // PHASE 8: Update partial tracking using CoreEngine Partial Tracker
                  partialTracker.updatePartial(transcriptText);
                  syncPartialVariables(); // Sync variables for compatibility
                  
                  const snapshot = partialTracker.getSnapshot();
                  if (snapshot.longestPartialText.length > (longestPartialText?.length || 0)) {
                    console.log(`[HostMode] 📏 New longest partial: ${snapshot.longestPartialText.length} chars`);
                  }
                  
                  // Live partial transcript - send original immediately with sequence ID (solo mode style)
                  // Note: This is the initial send before grammar/translation, so use raw text
                  // CRITICAL: Don't set targetLang here - this message is for ALL listeners to see the original text
                  // Translations will come later with specific targetLang values
                  const isTranscriptionOnly = false; // Host mode always translates (no transcription-only mode)
                  const seqId = broadcastWithSequence({
                    type: 'translation',
                    originalText: transcriptText, // Raw STT text (shown immediately)
                    translatedText: undefined, // Will be updated when translation arrives
                    sourceLang: currentSourceLang,
                    targetLang: null, // No target language yet - this is the original text for all listeners
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
                    // If final doesn't end with complete sentence, wait longer for continuation (up to 5 seconds)
                    const mightBeContinuation = !finalEndsWithCompleteSentence && isVeryShortPartial && timeSinceFinal < 5000;
                    
                    // If partial might be a continuation, wait longer and don't treat as new segment yet
                    // Continue tracking the partial so it can grow into the complete word
                    // CRITICAL: Check max wait time - don't extend wait if we've already waited too long
                    const timeSinceMaxWait = Date.now() - pending.maxWaitTimestamp;
                    if (mightBeContinuation && !extendsFinal && timeSinceMaxWait < MAX_FINALIZATION_WAIT_MS - 1000) {
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
                        if (longestPartialText && longestPartialText.length > textToProcess.length) {
                          const longestTrimmed = longestPartialText.trim();
                          if (longestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[HostMode] ⚠️ Using CURRENT LONGEST partial (${textToProcess.length} → ${longestPartialText.length} chars)`);
                            textToProcess = longestPartialText;
                          }
                        } else if (latestPartialText && latestPartialText.length > textToProcess.length) {
                          const latestTrimmed = latestPartialText.trim();
                          if (latestTrimmed.startsWith(finalTrimmed)) {
                            console.log(`[HostMode] ⚠️ Using CURRENT LATEST partial (${textToProcess.length} → ${latestPartialText.length} chars)`);
                            textToProcess = latestPartialText;
                          }
                        }
                        
                        // PHASE 8: Reset partial tracking using tracker
                        partialTracker.reset();
                        syncPartialVariables();
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
                        const targetLanguages = sessionStore.getSessionLanguages(sessionId);
                        
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
                                
                                // Send grammar update separately
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
                              
                              // Broadcast grammar correction to all language groups
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
                          const targetLanguages = sessionStore.getSessionLanguages(sessionId);
                          
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
                            const grammarPromise = currentSourceLang === 'en' 
                              ? grammarWorker.correctPartial(latestText, process.env.OPENAI_API_KEY)
                              : Promise.resolve(latestText); // Skip grammar for non-English
                            const partialWorker = usePremiumTier 
                              ? realtimePartialTranslationWorker 
                              : partialTranslationWorker;
                            const workerType = usePremiumTier ? 'REALTIME' : 'CHAT';
                            console.log(`[HostMode] 🔀 Using ${workerType} API for delayed partial translation to ${translationTargets.length} language(s) (${latestText.length} chars)`);
                            const underRestartCooldown = usePremiumTier && Date.now() < realtimeTranslationCooldownUntil;
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
                                  
                                  // Broadcast grammar update - sequence IDs handle ordering
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
                
                if (isForcedFinal) {
                  console.warn(`[HostMode] ⚠️ Forced FINAL due to stream restart (${transcriptText.length} chars)`);
                  realtimeTranslationCooldownUntil = Date.now() + TRANSLATION_RESTART_COOLDOWN_MS;
                  
                  // PHASE 8: Use Forced Commit Engine to clear existing buffer
                  if (forcedCommitEngine.hasForcedFinalBuffer()) {
                    forcedCommitEngine.clearForcedFinalBufferTimeout();
                    forcedCommitEngine.clearForcedFinalBuffer();
                    syncForcedFinalBuffer();
                  }
                  
                  // CRITICAL: Use SNAPSHOT not live value (live value may already be from next segment!)
                  // PHASE 8: Get snapshot from tracker
                  const snapshot = partialTracker.getSnapshot();
                  const longestPartialSnapshot = snapshot.longestPartialText;
                  const longestPartialTimeSnapshot = snapshot.longestPartialTime;
                  
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
                  if (endsWithPunctuation) {
                    console.log('[HostMode] ✅ Forced final already complete - committing immediately');
                    processFinalText(transcriptText, { forceFinal: true });
                    // CRITICAL: Reset partial tracker after forced final is committed to prevent cross-segment contamination
                    partialTracker.reset();
                    syncPartialVariables();
                  } else {
                    console.log('[HostMode] ⏳ Buffering forced final until continuation arrives or timeout elapses');
                    const bufferedText = transcriptText;
                    const forcedFinalTimestamp = Date.now();
                    
                    // PHASE 8: Create forced final buffer using engine
                    forcedCommitEngine.createForcedFinalBuffer(transcriptText, forcedFinalTimestamp);
                    syncForcedFinalBuffer();
                    
                    // PHASE 8: Set timeout using engine
                    forcedCommitEngine.setForcedFinalBufferTimeout(() => {
                      syncForcedFinalBuffer();
                      if (!forcedFinalBuffer) {
                        console.warn('[HostMode] ⚠️ Forced final buffer timeout fired but buffer is null - skipping');
                        return;
                      }
                      console.warn('[HostMode] ⏰ Forced final buffer timeout - committing buffered text');
                      processFinalText(forcedFinalBuffer.text, { forceFinal: true });
                      forcedCommitEngine.clearForcedFinalBuffer();
                      syncForcedFinalBuffer();
                      // CRITICAL: Reset partial tracker after forced final is committed to prevent cross-segment contamination
                      partialTracker.reset();
                      syncPartialVariables();
                    }, FORCED_FINAL_MAX_WAIT_MS);
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
                  console.log('[HostMode] 🔁 Merging buffered forced final with new FINAL transcript');
                  forcedCommitEngine.clearForcedFinalBufferTimeout();
                  const buffer = forcedCommitEngine.getForcedFinalBuffer();
                  const merged = partialTracker.mergeWithOverlap(buffer.text, transcriptText);
                  if (merged) {
                    transcriptText = merged;
                  } else {
                    // Merge failed - use the new FINAL transcript as-is
                    console.warn('[HostMode] ⚠️ Merge failed, using new FINAL transcript');
                  }
                  forcedCommitEngine.clearForcedFinalBuffer();
                  syncForcedFinalBuffer();
                }
                
                // CRITICAL: Check if this FINAL is a continuation of the last sent FINAL
                // This prevents splitting sentences like "Where two or three" / "Are gathered together"
                // BUT: Skip this check if last sent was a forced final (forced finals should always start new lines)
                // Note: We check lastSentFinalText being empty as the signal that last final was forced
                let wasContinuationMerged = false;
                if (lastSentFinalText && lastSentFinalText.length > 0 && (Date.now() - lastSentFinalTime) < FINAL_CONTINUATION_WINDOW_MS) {
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
                
                // CRITICAL: Sentence-aware finalization - wait for complete sentences
                // If FINAL doesn't end with a complete sentence, wait significantly longer
                // This prevents cutting off mid-sentence and causing transcription errors
                const finalEndsWithCompleteSentence = endsWithCompleteSentence(transcriptText);
                if (!finalEndsWithCompleteSentence) {
                  // FINAL doesn't end with complete sentence - wait MUCH longer for continuation
                  // This allows long sentences to complete naturally before finalizing
                  const SENTENCE_WAIT_MS = Math.max(4000, Math.min(8000, transcriptText.length * 20)); // 4-8 seconds based on length (increased)
                  WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, SENTENCE_WAIT_MS);
                  console.log(`[HostMode] ⚠️ FINAL doesn't end with complete sentence - extending wait to ${WAIT_FOR_PARTIALS_MS}ms to catch sentence completion`);
                  console.log(`[HostMode] 📝 Current text: "${transcriptText.substring(Math.max(0, transcriptText.length - 60))}"`);
                } else {
                  // FINAL ends with complete sentence - still check for punctuation for backward compatibility
                  const finalEndsWithPunctuation = /[.!?…]$/.test(transcriptText.trim());
                  if (!finalEndsWithPunctuation) {
                    // Has sentence ending but not standard punctuation - still wait a bit
                    WAIT_FOR_PARTIALS_MS = Math.max(WAIT_FOR_PARTIALS_MS, 1500);
                    console.log(`[HostMode] ⚠️ FINAL doesn't end with standard punctuation - extending wait to ${WAIT_FOR_PARTIALS_MS}ms`);
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
                  console.log(`[HostMode] ⚠️ FINAL ends mid-word - waiting for complete word in partials`);
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
                    // CRITICAL FIX: Process the old pending final BEFORE clearing it
                    // This prevents dropping finals when a new final arrives during high partial activity
                    const oldPending = finalizationEngine.getPendingFinalization();
                    if (oldPending) {
                      console.log(`[HostMode] 🔀 New final arrived - processing old pending final before clearing: "${oldPending.text.substring(0, 80)}..."`);
                      // Process the old final immediately with its current text
                      // Use the longest partial if it extends the old final
                      let oldFinalText = oldPending.text;
                      const oldFinalTrimmed = oldPending.text.trim();
                      
                      // Check if longest partial extends the old final
                      if (longestPartialText && longestPartialText.length > oldPending.text.length) {
                        const longestTrimmed = longestPartialText.trim();
                        const oldFinalNormalized = oldFinalTrimmed.replace(/\s+/g, ' ').toLowerCase();
                        const longestNormalized = longestTrimmed.replace(/\s+/g, ' ').toLowerCase();
                        if (longestNormalized.startsWith(oldFinalNormalized) || 
                            (oldFinalTrimmed.length > 5 && longestNormalized.substring(0, oldFinalNormalized.length) === oldFinalNormalized)) {
                          oldFinalText = longestPartialText;
                          console.log(`[HostMode] 📊 Using longest partial for old final (${oldPending.text.length} → ${longestPartialText.length} chars)`);
                        }
                      }
                      
                      // Clear timeout and pending finalization
                      finalizationEngine.clearPendingFinalizationTimeout();
                      finalizationEngine.clearPendingFinalization();
                      syncPendingFinalization();
                      
                      // Process the old final immediately
                      processFinalText(oldFinalText);
                    } else {
                      // No old pending - just clear
                      finalizationEngine.clearPendingFinalizationTimeout();
                      finalizationEngine.clearPendingFinalization();
                      syncPendingFinalization();
                    }
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
    
    // PHASE 8: Reset core engine state
    coreEngine.reset();
    
    sessionStore.closeSession(currentSessionId);
  });

  // Initialize the session as active
  sessionStore.setHost(currentSessionId, clientWs, null); // No direct WebSocket needed with stream
  console.log(`[HostMode] Session ${session.sessionCode} is now active with Google Speech`);
}

