/**
 * Host Page - For the speaker/preacher to broadcast live translations
 */

import { useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import QRCode from 'qrcode';
import { Settings } from 'lucide-react';
import { useAudioCapture } from '../hooks/useAudioCapture';
import { Header } from './Header';
import { ConnectionStatus } from './ConnectionStatus';
import { LanguageSelector } from './LanguageSelector';
import { SentenceSegmenter } from '../utils/sentenceSegmenter';
import { TRANSCRIPTION_LANGUAGES } from '../config/languages.js';
import { isMobileDevice, isSystemAudioSupported } from '../utils/deviceDetection';

// Dynamically determine backend URL based on frontend URL
// If accessing via network IP, use the same IP for backend
const getBackendUrl = () => {
  const hostname = window.location.hostname;
  console.log('[HostPage] Detected hostname:', hostname);
  
  // Validate IP address format
  const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  
  if (hostname !== 'localhost' && !ipv4Pattern.test(hostname)) {
    console.error('[HostPage] Invalid hostname format, using localhost');
    return 'http://localhost:3001';
  }
  
  return `http://${hostname}:3001`;
};

const getWebSocketUrl = () => {
  const hostname = window.location.hostname;
  
  // Validate IP address format
  const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  
  if (hostname !== 'localhost' && !ipv4Pattern.test(hostname)) {
    console.error('[HostPage] Invalid hostname format, using localhost');
    return 'ws://localhost:3001';
  }
  
  return `ws://${hostname}:3001`;
};

// Get the frontend app URL for QR code generation
// Uses VITE_APP_URL if set (for production), otherwise falls back to window.location.origin
const getAppUrl = () => {
  return import.meta.env.VITE_APP_URL || window.location.origin;
};

const API_URL = import.meta.env.VITE_API_URL || getBackendUrl();
const WS_URL = import.meta.env.VITE_WS_URL || getWebSocketUrl();
const APP_URL = getAppUrl();

const LANGUAGES = TRANSCRIPTION_LANGUAGES; // Host speaks - needs transcription support

// Fingerprint helper for debugging ghost sentences
const fp = (s) => {
  if (!s) return null;
  // stable-ish fingerprint for searching
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
};

export function HostPage({ onBackToHome }) {
  // Track seen raw messages for invariant checking
  const seenRawInFpsRef = useRef(new Set());

  // Out-of-order partial prevention: track last seqId per sourceSeqId
  const lastPartialSeqBySourceRef = useRef(new Map());

  const [sessionCode, setSessionCode] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [sourceLang, setSourceLang] = useState('en');
  const [usePremiumTier, setUsePremiumTier] = useState(false); // Tier selection: false = basic, true = premium
  const [showSettings, setShowSettings] = useState(false);
  const [connectionState, setConnectionState] = useState('disconnected');
  const [transcript, setTranscript] = useState([]);
  const transcriptRef = useRef([]); // Ref to access transcript synchronously
  const [currentTranscript, setCurrentTranscript] = useState(''); // Live partial transcription
  const [isStreaming, setIsStreaming] = useState(false);
  const [listenerCount, setListenerCount] = useState(0);
  const [languageStats, setLanguageStats] = useState({});
  const [error, setError] = useState('');

  const wsRef = useRef(null);
  const isInitializedRef = useRef(false); // Prevent duplicate initialization in Strict Mode
  const sessionCreatedRef = useRef(false); // Prevent duplicate session creation
  const processedSeqIdsRef = useRef(new Set()); // Track processed seqIds to prevent duplicate processing

  // Commit counter for tracing leaked rows
  const commitCounterRef = useRef(0);
  const nextCommitId = () => ++commitCounterRef.current;
  
  // Keep ref in sync with state
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
  
  // Track corrected text for merging (similar to TranslationInterface.jsx)
  const longestCorrectedTextRef = useRef('');
  const longestCorrectedOriginalRef = useRef('');
  
  // Track last partial text to detect if final extends it
  const lastPartialTextRef = useRef('');
  const lastPartialTimeRef = useRef(0);
  
  // Merge text with grammar corrections (similar to TranslationInterface.jsx)
  const mergeTextWithCorrection = (newRawText, correctedOverride = null) => {
    const trimmedRaw = (newRawText || '').trim();
    if (!trimmedRaw) {
      return '';
    }

    // If we have a corrected override, prefer it and update refs to keep alignment
    if (correctedOverride && correctedOverride.trim()) {
      longestCorrectedTextRef.current = correctedOverride;
      longestCorrectedOriginalRef.current = trimmedRaw;
      return correctedOverride;
    }

    const existingCorrected = longestCorrectedTextRef.current;
    const existingOriginal = longestCorrectedOriginalRef.current;

    if (existingCorrected && existingOriginal) {
      if (trimmedRaw.startsWith(existingOriginal)) {
        const extension = trimmedRaw.substring(existingOriginal.length);
        const merged = existingCorrected + extension;
        longestCorrectedTextRef.current = merged;
        longestCorrectedOriginalRef.current = trimmedRaw;
        return merged;
      } else if (trimmedRaw.startsWith(existingOriginal.substring(0, Math.min(existingOriginal.length, trimmedRaw.length)))) {
        const extension = trimmedRaw.substring(existingOriginal.length);
        const merged = existingCorrected + extension;
        longestCorrectedTextRef.current = merged;
        longestCorrectedOriginalRef.current = trimmedRaw;
        return merged;
      }
    }

    // No existing correction or unable to merge - treat as fresh text
    longestCorrectedTextRef.current = trimmedRaw;
    longestCorrectedOriginalRef.current = trimmedRaw;
    return trimmedRaw;
  };
  const { 
    startRecording, 
    stopRecording, 
    isRecording, 
    audioLevel,
    availableDevices,
    selectedDeviceId,
    setSelectedDeviceId,
    audioSource,
    setAudioSource
  } = useAudioCapture();
  
  // Check device capabilities
  const isMobile = isMobileDevice();
  const systemAudioSupported = isSystemAudioSupported();

  // Sentence segmenter for smart text management
  // Enable auto-flush to history (same as solo mode) - partials that accumulate into complete sentences are committed
  const segmenterRef = useRef(null);
  if (!segmenterRef.current) {
    segmenterRef.current = new SentenceSegmenter({
      maxSentences: 10,     // Increased to allow more sentences in live view
      maxChars: 2000,       // Increased to handle longer text (prevents premature flushing)
      maxTimeMs: 15000,
      onFlush: (flushedSentences) => {
        // Move flushed sentences to history with forced paint (same as solo mode)
        // NOTE: Grammar corrections will be applied when finals arrive from backend
        // The deduplication logic will replace auto-segmented items with grammar-corrected finals
        const joinedText = flushedSentences.join(' ').trim();
        if (joinedText) {
          // Schedule flush for next tick to allow browser paint between flushes
          setTimeout(() => {
            flushSync(() => {
              setTranscript(prev => {
                const newItem = {
                  text: joinedText,
                  timestamp: Date.now(),
                  seqId: -1, // Auto-segmented partials don't have seqId
                  isSegmented: true  // Flag to indicate this was auto-segmented (will be replaced by final if similar)
                };
                
                // CRITICAL: Insert in correct position based on timestamp (sequenceId is -1 for auto-segmented)
                const newHistory = [...prev, newItem].sort((a, b) => {
                  if (a.seqId !== undefined && b.seqId !== undefined && a.seqId !== -1 && b.seqId !== -1) {
                    return a.seqId - b.seqId;
                  }
                  return (a.timestamp || 0) - (b.timestamp || 0);
                });
                
                // Update ref immediately to keep it in sync
                transcriptRef.current = newHistory;

                // COMMIT LOGGING: Log exact final text being committed by segmenter onFlush
                console.log('[HOST_COMMIT]', {
                  commitId: nextCommitId(),
                  path: 'SEGMENTER_ONFLUSH',
                  side: 'HOST',
                  commitOriginal: joinedText,
                  commitTranslated: joinedText,
                  originalFp: fp(joinedText),
                  translatedFp: fp(joinedText),
                  seqId: -1,
                  sourceSeqId: -1,
                  isPartial: false,
                  ts: Date.now(),
                  prevTail: prev.slice(-2),
                  newItem: newItem
                });

                return newHistory;
              });
            });

            // Post-commit invariant checker: detect suspicious rows that appeared without RAW_IN
            const suspicious = newHistory.slice(-5).filter(it => it?.text && !seenRawInFpsRef.current.has(fp(it.text)));
            if (suspicious.length) {
              console.log('[SUSPICIOUS_COMMIT_ROWS]', {
                path: 'SEGMENTER_ONFLUSH',
                suspicious: suspicious.map(it => ({
                  text: it.text,
                  fp: fp(it.text),
                  seqId: it.seqId,
                  sourceSeqId: it.sourceSeqId,
                  isSegmented: it.isSegmented
                }))
              });
            }

            console.log(`[HostPage] ✅ Flushed to history with paint: "${joinedText.substring(0, 40)}..."`);
          }, 0);
        }
      }
    });
  }

  // Create session on mount (only once, even in Strict Mode)
  useEffect(() => {
    // Guard against duplicate initialization in React Strict Mode
    if (isInitializedRef.current || sessionCreatedRef.current) {
      return;
    }
    
    isInitializedRef.current = true;
    createSession();
    
    return () => {
      // Cleanup: close WebSocket and reset flags
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch (e) {
          // Ignore errors during cleanup
        }
        wsRef.current = null;
      }
      // Don't reset isInitializedRef here - we want to prevent re-initialization
      // Only reset sessionCreatedRef if we're actually unmounting (not just Strict Mode remount)
    };
  }, []);

  const createSession = async () => {
    // Guard against duplicate session creation
    if (sessionCreatedRef.current) {
      console.log('[HostPage] ⚠️ Session creation already in progress, skipping duplicate call');
      return;
    }
    
    sessionCreatedRef.current = true;
    
    try {
      const response = await fetch(`${API_URL}/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      const data = await response.json();
      
      if (data.success) {
        setSessionId(data.sessionId);
        setSessionCode(data.sessionCode);
        
        // Generate QR code with join URL using configured app URL
        // This ensures QR codes work on mobile devices by using the production domain
        const joinUrl = `${APP_URL}?join=${data.sessionCode}`;
        console.log('[HostPage] Generated QR code URL:', joinUrl);
        const qrUrl = await QRCode.toDataURL(joinUrl, {
          width: 300,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#ffffff'
          }
        });
        setQrDataUrl(qrUrl);
        
        // Connect WebSocket (only if not already connected)
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED || wsRef.current.readyState === WebSocket.CLOSING) {
          connectWebSocket(data.sessionId);
        } else {
          console.log('[HostPage] ⚠️ WebSocket already connected, skipping duplicate connection');
        }
      } else {
        setError('Failed to create session');
        sessionCreatedRef.current = false; // Allow retry on failure
      }
    } catch (err) {
      console.error('Failed to create session:', err);
      setError('Failed to create session. Please check your connection.');
      sessionCreatedRef.current = false; // Allow retry on failure
    }
  };

  const connectWebSocket = (sessionId) => {
    // Close existing WebSocket connection if any
    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
          console.log('[HostPage] ⚠️ Closing existing WebSocket connection before creating new one');
          wsRef.current.close();
        }
      } catch (e) {
        // Ignore errors when closing
      }
      wsRef.current = null;
    }
    
    const ws = new WebSocket(`${WS_URL}/translate?role=host&sessionId=${sessionId}`);
    
    ws.onopen = () => {
      console.log('[Host] WebSocket connected');
      setConnectionState('open');
      
      // Send initialization
      ws.send(JSON.stringify({
        type: 'init',
        sourceLang: sourceLang,
        tier: usePremiumTier ? 'premium' : 'basic'
      }));
    };
    
    ws.onclose = () => {
      console.log('[Host] WebSocket disconnected');
      setConnectionState('closed');
      // Clear ref when closed
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
    
    ws.onerror = (error) => {
      console.error('[Host] WebSocket error:', error);
      setConnectionState('error');
    };
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        // RAW_IN logging: canonical ingestion truth for ghost bug debugging
        console.log('[HOST_RAW_IN]', {
          type: message.type,
          seqId: message.seqId,
          sourceSeqId: message.sourceSeqId,
          targetLang: message.targetLang,
          originalFp: fp(message.originalText),
          correctedFp: fp(message.correctedText),
          translatedFp: fp(message.translatedText),
          originalText: message.originalText,
          correctedText: message.correctedText,
          translatedText: message.translatedText,
        });

        // Track seen fingerprints for invariant checking
        if (message.translatedText) {
          seenRawInFpsRef.current.add(fp(message.translatedText));
        }
        if (message.originalText) {
          seenRawInFpsRef.current.add(fp(message.originalText));
        }

        // Drop out-of-order PARTIAL translations (prevents delayed partial overwrites)
        if (message?.isPartial && message?.sourceSeqId != null && message?.seqId != null) {
          const last = lastPartialSeqBySourceRef.current.get(message.sourceSeqId) || 0;
          if (message.seqId <= last) {
            console.log('[DROP_OOO_PARTIAL]', {
              sourceSeqId: message.sourceSeqId,
              seqId: message.seqId,
              last,
              t: (message.translatedText || '').slice(0, 80)
            });
            return;
          }
          lastPartialSeqBySourceRef.current.set(message.sourceSeqId, message.seqId);
        }

        switch (message.type) {
          case 'session_ready':
            console.log('[Host] Session ready:', message.sessionCode);
            break;
          
          case 'gemini_ready':
            console.log('[Host] Gemini ready for audio');
            break;
          
          case 'transcript':
            // Add transcript to display
            setTranscript(prev => [...prev, {
              text: message.text,
              timestamp: message.timestamp
            }].slice(-10)); // Keep last 10 transcripts
            break;
          
          case 'translation':
            // ✨ REAL-TIME STREAMING: Sentence segmented, immediate display
            if (message.isPartial) {
              // CRITICAL: Merge grammar corrections with existing partial text
              // This ensures grammar corrections are applied live to the transcription
              const originalText = message.originalText || '';
              const correctedText = message.correctedText;
              const translatedText = message.translatedText || '';
              
              // Use merge function to intelligently combine original and corrected text
              const rawText = mergeTextWithCorrection(originalText, correctedText) || translatedText;

              if (!rawText || !rawText.trim()) {
                return; // No text to display
              }

              // Process through segmenter (auto-flushes complete sentences)
              const { liveText } = segmenterRef.current.processPartial(rawText);

              // Track last partial text and time for final extension detection
              lastPartialTextRef.current = rawText;
              lastPartialTimeRef.current = Date.now();

              // REAL-TIME STREAMING FIX: Update immediately on every delta for true real-time streaming
              // No throttling - let React batch updates naturally for optimal performance
              flushSync(() => {
                setCurrentTranscript(liveText);
              });
            } else {
              // Lock finals to prevent partial overwrites
              if (!message?.isPartial && message?.sourceSeqId != null && message?.seqId != null) {
                lastPartialSeqBySourceRef.current.set(message.sourceSeqId, Number.MAX_SAFE_INTEGER);
              }

              // Final transcript - use processFinal like solo mode (handles deduplication automatically)
              // CRITICAL: Use correctedText if available (grammar corrections), otherwise fall back to originalText or translatedText
              // This ensures grammar corrections and recovered text are applied to finals
              const finalText = message.correctedText || message.translatedText || message.originalText;
              const finalSeqId = message.seqId;
              const isForcedFinal = message.forceFinal === true;
              
              // CRITICAL: Prevent duplicate processing of the same seqId
              // This can happen if multiple WebSocket connections exist or messages are duplicated
              if (finalSeqId !== undefined && finalSeqId !== null) {
                if (processedSeqIdsRef.current.has(finalSeqId)) {
                  console.log(`[HostPage] ⚠️ SKIP DUPLICATE FINAL seqId=${finalSeqId}: "${finalText.substring(0, 50)}..." (already processed)`);
                  return; // Skip duplicate processing
                }
                processedSeqIdsRef.current.add(finalSeqId);
                
                // Clean up old seqIds to prevent memory leak (keep last 100)
                if (processedSeqIdsRef.current.size > 100) {
                  const seqIdsArray = Array.from(processedSeqIdsRef.current).sort((a, b) => a - b);
                  const toRemove = seqIdsArray.slice(0, seqIdsArray.length - 100);
                  toRemove.forEach(id => processedSeqIdsRef.current.delete(id));
                }
              }
              
              console.log(`[HostPage] 📝 FINAL received seqId=${finalSeqId}: "${finalText.substring(0, 50)}..."`);
              if (isForcedFinal) {
                console.warn('[HostPage] ⚠️ Forced FINAL received from backend (may be incomplete)');
              }
              
              // Reset correction tracking for next segment
              longestCorrectedTextRef.current = '';
              longestCorrectedOriginalRef.current = '';
              
              const fullFinalText = finalText.trim();
              
              if (!fullFinalText || fullFinalText.length === 0) {
                console.warn('[HostPage] ⚠️ Final received with no text, skipping');
                return;
              }
              
              // CRITICAL: Check if this final extends the last partial text (same as solo mode)
              // If it does, we need to prevent duplication by marking the partial as already flushed
              const lastPartialText = lastPartialTextRef.current.trim();
              const finalTextTrimmed = fullFinalText.trim();
              const timeSinceLastPartial = Date.now() - lastPartialTimeRef.current;
              const FINAL_EXTENSION_WINDOW_MS = 5000; // 5 seconds - finals typically arrive within this window
              
              if (lastPartialText && 
                  timeSinceLastPartial < FINAL_EXTENSION_WINDOW_MS &&
                  finalTextTrimmed.length > lastPartialText.length &&
                  (finalTextTrimmed.startsWith(lastPartialText) || 
                   (lastPartialText.length > 10 && finalTextTrimmed.substring(0, lastPartialText.length) === lastPartialText))) {
                console.log(`[HostPage] 🔁 Final extends last partial - preventing duplication`);
                console.log(`[HostPage] 📝 Last partial: "${lastPartialText.substring(0, 50)}..." → Final: "${finalTextTrimmed.substring(0, 50)}..."`);
                
                // Mark the partial text as already flushed in the segmenter to prevent duplication
                // This ensures processFinal will deduplicate correctly
                if (segmenterRef.current) {
                  // Add the partial text to flushedText so it won't be committed again
                  const partialSentences = segmenterRef.current.detectSentences(lastPartialText);
                  const completePartialSentences = partialSentences.filter(s => segmenterRef.current.isComplete(s));
                  if (completePartialSentences.length > 0) {
                    const partialTextToFlush = completePartialSentences.join(' ').trim();
                    if (partialTextToFlush && !segmenterRef.current.flushedText.includes(partialTextToFlush)) {
                      segmenterRef.current.flushedText += ' ' + partialTextToFlush;
                      segmenterRef.current.flushedText = segmenterRef.current.flushedText.trim();
                      console.log(`[HostPage] ✅ Marked partial as flushed: "${partialTextToFlush.substring(0, 50)}..."`);
                    }
                  }
                }
              }
              
              // CRITICAL: Before calling processFinal, sync segmenter's flushedText with auto-segmented items in transcript
              // This ensures processFinal knows about auto-flushed partials and can deduplicate correctly
              // Use ref to access transcript synchronously (React state updates are async)
              const currentTranscript = transcriptRef.current;
              const autoSegmentedItemsToSync = currentTranscript.filter(entry => entry.isSegmented === true);
              
              if (autoSegmentedItemsToSync.length > 0) {
                console.log(`[HostPage] 🔍 Found ${autoSegmentedItemsToSync.length} auto-segmented items in transcript`);
                console.log(`[HostPage] 🔍 Auto-segmented items:`, autoSegmentedItemsToSync.map(e => `"${e.text.substring(0, 40)}..."`));
                
                // Check if any auto-segmented items are contained in the final
                const finalNormalized = fullFinalText.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
                
                for (const item of autoSegmentedItemsToSync) {
                  const itemNormalized = item.text.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
                  
                  // If final contains the auto-segmented text, add it to segmenter's flushedText
                  if (finalNormalized.includes(itemNormalized) && itemNormalized.length > 10) {
                    const segmenterFlushedText = segmenterRef.current.flushedText || '';
                    if (!segmenterFlushedText.includes(item.text)) {
                      console.log(`[HostPage] 🔄 Syncing auto-segmented item to segmenter flushedText: "${item.text.substring(0, 50)}..."`);
                      segmenterRef.current.flushedText = (segmenterFlushedText + ' ' + item.text).trim();
                    } else {
                      console.log(`[HostPage] ⏭️ Auto-segmented item already in segmenter flushedText: "${item.text.substring(0, 50)}..."`);
                    }
                  } else {
                    console.log(`[HostPage] ⏭️ Auto-segmented item not contained in final (or too short): "${item.text.substring(0, 50)}..." (final: "${fullFinalText.substring(0, 50)}...")`);
                  }
                }
              } else {
                console.log(`[HostPage] 🔍 No auto-segmented items found in transcript (total items: ${currentTranscript.length})`);
              }
              
              // CRITICAL: Use processFinal like solo mode - this handles deduplication automatically
              // processFinal checks if final contains already-flushed text and only returns NEW sentences
              console.log(`[HostPage] 🔍 Calling processFinal with text: "${fullFinalText.substring(0, 60)}..."`);
              console.log(`[HostPage] 🔍 Segmenter flushedText length: ${segmenterRef.current.flushedText?.length || 0}`);
              const { flushedSentences } = segmenterRef.current.processFinal(fullFinalText, { isForced: isForcedFinal });
              
              console.log(`[HostPage] 📊 Segmenter returned ${flushedSentences.length} sentences:`, flushedSentences);
              if (flushedSentences.length > 0) {
                console.log(`[HostPage] 📊 Flushed sentences: "${flushedSentences.join(' | ').substring(0, 100)}..."`);
              } else {
                console.log(`[HostPage] ⚠️ Segmenter returned 0 sentences - all text was deduplicated`);
              }
              
              // Add deduplicated sentences to history - use flushSync for immediate UI update (same as solo mode)
              if (flushedSentences.length > 0) {
                const joinedText = flushedSentences.join(' ').trim();
                if (joinedText) {
                  flushSync(() => {
                    setTranscript(prev => {
                      // CRITICAL: Remove auto-segmented items that are contained in this final
                      // This prevents duplicates when the final extends an auto-segmented partial
                      const finalNormalized = fullFinalText.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
                      const filteredPrev = prev.filter(entry => {
                        if (entry.isSegmented) {
                          const entryNormalized = entry.text.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
                          // If final contains this auto-segmented entry, remove it
                          if (finalNormalized.includes(entryNormalized) && entryNormalized.length > 10) {
                            console.log(`[HostPage] 🗑️ Removing auto-segmented item contained in final: "${entry.text.substring(0, 50)}..."`);
                            return false; // Remove this entry
                          }
                        }
                        return true; // Keep this entry
                      });
                      
                      // CRITICAL: Check if this exact text already exists in history (prevent duplicates)
                      // Also check if this is a newer version of an existing entry (replace older with newer)
                      // This catches cases where forced finals with different seqIds have similar text
                      // Use more comprehensive normalization including quotes and apostrophes for forced finals
                      const joinedNormalized = joinedText.toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim();
                      
                      // First pass: Find and remove older versions of similar text
                      let updatedPrev = filteredPrev.filter(entry => {
                        if (entry.seqId === finalSeqId) {
                          console.log(`[HostPage] 🗑️ Removing duplicate entry with same seqId: ${finalSeqId}`);
                          return false; // Remove exact duplicate
                        }
                        
                        const entryNormalized = entry.text.toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim();
                        
                        // For forced finals, use more lenient matching since they may have punctuation variations
                        if (isForcedFinal) {
                          // Check if texts are the same (normalized)
                          if (entryNormalized === joinedNormalized) {
                            // Same text - keep newer one (higher seqId or later timestamp)
                            if (finalSeqId !== undefined && entry.seqId !== undefined && finalSeqId > entry.seqId) {
                              console.log(`[HostPage] 🔄 Replacing older duplicate (seqId ${entry.seqId} → ${finalSeqId}): "${entry.text.substring(0, 50)}..."`);
                              return false; // Remove older version
                            }
                            return true; // Keep existing if it's newer
                          }
                          
                          // Check if one contains the other (for partial matches)
                          if (entryNormalized.length > 15 && joinedNormalized.length > 15) {
                            const entryContainsNew = entryNormalized.includes(joinedNormalized);
                            const newContainsEntry = joinedNormalized.includes(entryNormalized);
                            
                            if (entryContainsNew || newContainsEntry) {
                              // One contains the other - keep the longer/newer one
                              if (finalSeqId !== undefined && entry.seqId !== undefined && finalSeqId > entry.seqId) {
                                console.log(`[HostPage] 🔄 Replacing older similar entry (seqId ${entry.seqId} → ${finalSeqId}): "${entry.text.substring(0, 50)}..."`);
                                return false; // Remove older version
                              }
                              if (joinedNormalized.length > entryNormalized.length) {
                                console.log(`[HostPage] 🔄 Replacing shorter entry with longer version (seqId ${entry.seqId} → ${finalSeqId}): "${entry.text.substring(0, 50)}..."`);
                                return false; // Remove shorter version
                              }
                            }
                            
                            // Check if significant prefixes match (first 80 chars) - catches minor variations
                            const prefixLen = Math.min(80, Math.min(entryNormalized.length, joinedNormalized.length));
                            if (prefixLen > 30 && entryNormalized.substring(0, prefixLen) === joinedNormalized.substring(0, prefixLen)) {
                              // Similar prefixes - keep newer/longer one
                              if (finalSeqId !== undefined && entry.seqId !== undefined && finalSeqId > entry.seqId) {
                                console.log(`[HostPage] 🔄 Replacing older entry with similar prefix (seqId ${entry.seqId} → ${finalSeqId}): "${entry.text.substring(0, 50)}..."`);
                                return false; // Remove older version
                              }
                              if (joinedNormalized.length > entryNormalized.length) {
                                console.log(`[HostPage] 🔄 Replacing shorter entry with longer similar prefix (seqId ${entry.seqId} → ${finalSeqId}): "${entry.text.substring(0, 50)}..."`);
                                return false; // Remove shorter version
                              }
                            }
                          }
                        } else {
                          // For regular finals, use stricter matching
                          if (entryNormalized === joinedNormalized) {
                            // Exact match - keep newer one
                            if (finalSeqId !== undefined && entry.seqId !== undefined && finalSeqId > entry.seqId) {
                              console.log(`[HostPage] 🔄 Replacing older exact duplicate (seqId ${entry.seqId} → ${finalSeqId})`);
                              return false; // Remove older version
                            }
                            return true; // Keep existing if it's newer
                          }
                          if (entryNormalized.length > 20 && joinedNormalized.includes(entryNormalized)) {
                            // New text contains old - replace old with new
                            if (finalSeqId !== undefined && entry.seqId !== undefined && finalSeqId > entry.seqId) {
                              console.log(`[HostPage] 🔄 Replacing older contained entry (seqId ${entry.seqId} → ${finalSeqId})`);
                              return false;
                            }
                          }
                          if (joinedNormalized.length > 20 && entryNormalized.includes(joinedNormalized)) {
                            // Old text contains new - keep old (it's more complete)
                            return true;
                          }
                        }
                        return true; // Keep this entry
                      });
                      
                      // Second pass: Check if this exact text still exists after filtering
                      const stillDuplicate = updatedPrev.some(entry => {
                        if (entry.seqId === finalSeqId) {
                          return true; // Same seqId = definitely duplicate
                        }
                        const entryNormalized = entry.text.toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim();
                        return entryNormalized === joinedNormalized;
                      });
                      
                      if (stillDuplicate) {
                        console.log(`[HostPage] ⏭️ SKIP DUPLICATE TEXT in history: "${joinedText.substring(0, 50)}..." (seqId: ${finalSeqId})`);
                        return updatedPrev.slice(-50); // Return filtered list
                      }
                      
                      const newItem = {
                        text: joinedText,
                        timestamp: message.timestamp || Date.now(),
                        seqId: finalSeqId
                      };
                      
                      // CRITICAL: Insert in correct position based on sequenceId to maintain chronological order
                      // This prevents race conditions where longer translations complete after shorter ones
                      const newHistory = [...updatedPrev, newItem].sort((a, b) => {
                        // Sort by sequenceId first (most reliable), then by timestamp
                        if (a.seqId !== undefined && b.seqId !== undefined && a.seqId !== -1 && b.seqId !== -1) {
                          return a.seqId - b.seqId;
                        }
                        // Fallback to timestamp if sequenceId not available
                        return (a.timestamp || 0) - (b.timestamp || 0);
                      });
                      
                      // Update ref immediately to keep it in sync
                      transcriptRef.current = newHistory.slice(-50);

                      // COMMIT LOGGING: Log exact final text being committed to history
                      console.log('[HOST_COMMIT]', {
                        commitId: nextCommitId(),
                        path: 'FINAL_HANDLER',
                        side: 'HOST',
                        commitOriginal: newItem.text,
                        commitTranslated: newItem.text,
                        originalFp: fp(newItem.text),
                        translatedFp: fp(newItem.text),
                        seqId: finalSeqId,
                        sourceSeqId: message.sourceSeqId,
                        isPartial: false,
                        ts: Date.now(),
                        prevTail: updatedPrev.slice(-2),
                        newItem: newItem
                      });

                      console.log(`[HostPage] ✅ STATE UPDATED - New history total: ${newHistory.length} items (sorted by seqId/timestamp)`);
                      return newHistory.slice(-50); // Keep last 50 entries
                    });
                  });

                  // Post-commit invariant checker: detect suspicious rows that appeared without RAW_IN
                  const suspicious = newHistory.slice(-5).filter(it => it?.text && !seenRawInFpsRef.current.has(fp(it.text)));
                  if (suspicious.length) {
                    console.log('[SUSPICIOUS_COMMIT_ROWS]', {
                      path: 'FINAL_HANDLER',
                      suspicious: suspicious.map(it => ({
                        text: it.text,
                        fp: fp(it.text),
                        seqId: it.seqId,
                        sourceSeqId: it.sourceSeqId,
                        isSegmented: it.isSegmented
                      }))
                    });
                  }

                  console.log(`[HostPage] ✅ Added to history: "${joinedText.substring(0, 50)}..."`);
                }
              } else {
                // FALLBACK: If segmenter deduplicated everything, still add the final text if it's substantial
                // This ensures history appears even if deduplication is too aggressive
                // CRITICAL: Match solo mode's behavior - simple length check (segmenter already handles short complete sentences)
                const finalTextTrimmed = fullFinalText.trim();
                
                // Check if this text is already in history (prevent duplicates)
                const currentTranscript = transcriptRef.current;
                // Use more comprehensive normalization including quotes for forced finals
                const normalizeForComparison = (text) => text.toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim();
                const finalNormalized = normalizeForComparison(finalTextTrimmed);
                const alreadyInHistory = currentTranscript.some(entry => {
                  const entryNormalized = normalizeForComparison(entry.text);
                  if (entryNormalized === finalNormalized) {
                    return true;
                  }
                  // For forced finals, use more lenient matching
                  if (isForcedFinal && entryNormalized.length > 15 && finalNormalized.length > 15) {
                    return entryNormalized.includes(finalNormalized) || 
                           finalNormalized.includes(entryNormalized) ||
                           (entryNormalized.substring(0, Math.min(80, entryNormalized.length)) === 
                            finalNormalized.substring(0, Math.min(80, finalNormalized.length)));
                  }
                  // For regular finals, use standard matching
                  return entryNormalized.length > 5 && finalNormalized.length > 5 && 
                         (entryNormalized.includes(finalNormalized) || finalNormalized.includes(entryNormalized));
                });
                
                // Match solo mode: simple length check (segmenter already handles short complete sentences internally)
                if (finalTextTrimmed.length > 10 && !alreadyInHistory) {
                  console.log(`[HostPage] ⚠️ Segmenter deduplicated all, using fallback`);
                  flushSync(() => {
                    setTranscript(prev => {
                      // CRITICAL: Remove auto-segmented items that are contained in this final
                      // Use more comprehensive normalization including quotes for forced finals
                      const normalizeForFallback = (text) => text.toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim();
                      const finalNormalized = normalizeForFallback(fullFinalText);
                      const filteredPrev = prev.filter(entry => {
                        if (entry.isSegmented) {
                          const entryNormalized = normalizeForFallback(entry.text);
                          // If final contains this auto-segmented entry, remove it
                          if (finalNormalized.includes(entryNormalized) && entryNormalized.length > 10) {
                            console.log(`[HostPage] 🗑️ Removing auto-segmented item contained in final (fallback): "${entry.text.substring(0, 50)}..."`);
                            return false; // Remove this entry
                          }
                        }
                        return true; // Keep this entry
                      });
                      
                      // CRITICAL: Check if this exact text already exists in history (prevent duplicates)
                      const fullFinalNormalized = normalizeForFallback(fullFinalText);
                      const isDuplicate = filteredPrev.some(entry => {
                        if (entry.seqId === finalSeqId) {
                          return true; // Same seqId = definitely duplicate
                        }
                        const entryNormalized = normalizeForFallback(entry.text);
                        
                        // For forced finals, use more lenient matching since they may have punctuation variations
                        if (isForcedFinal) {
                          // Check if texts are the same (normalized)
                          if (entryNormalized === fullFinalNormalized) {
                            return true;
                          }
                          // Check if one contains the other (for partial matches)
                          if (entryNormalized.length > 15 && fullFinalNormalized.length > 15) {
                            if (entryNormalized.includes(fullFinalNormalized) || fullFinalNormalized.includes(entryNormalized)) {
                              return true;
                            }
                            // Check if significant prefixes match (first 80 chars) - catches minor variations
                            const prefixLen = Math.min(80, Math.min(entryNormalized.length, fullFinalNormalized.length));
                            if (prefixLen > 30 && entryNormalized.substring(0, prefixLen) === fullFinalNormalized.substring(0, prefixLen)) {
                              return true;
                            }
                          }
                        } else {
                          // For regular finals, use stricter matching
                          return entryNormalized === fullFinalNormalized || 
                                 (entryNormalized.length > 20 && fullFinalNormalized.includes(entryNormalized)) ||
                                 (fullFinalNormalized.length > 20 && entryNormalized.includes(fullFinalNormalized));
                        }
                        return false;
                      });
                      
                      if (isDuplicate) {
                        console.log(`[HostPage] ⏭️ SKIP DUPLICATE TEXT in history (fallback): "${fullFinalText.substring(0, 50)}..." (seqId: ${finalSeqId})`);
                        return filteredPrev.slice(-50); // Return unchanged
                      }
                      
                      const newItem = {
                        text: fullFinalText,
                        timestamp: message.timestamp || Date.now(),
                        seqId: finalSeqId
                      };
                      
                      // CRITICAL: Insert in correct position based on sequenceId to maintain chronological order
                      const newHistory = [...filteredPrev, newItem].sort((a, b) => {
                        if (a.seqId !== undefined && b.seqId !== undefined && a.seqId !== -1 && b.seqId !== -1) {
                          return a.seqId - b.seqId;
                        }
                        return (a.timestamp || 0) - (b.timestamp || 0);
                      });
                      
                      // Update ref immediately to keep it in sync
                      transcriptRef.current = newHistory.slice(-50);
                      
                      return newHistory.slice(-50);
                    });
                  });

                  // Post-commit invariant checker: detect suspicious rows that appeared without RAW_IN
                  const suspicious = newHistory.slice(-5).filter(it => it?.text && !seenRawInFpsRef.current.has(fp(it.text)));
                  if (suspicious.length) {
                    console.log('[SUSPICIOUS_COMMIT_ROWS]', {
                      path: 'FINAL_HANDLER_FALLBACK',
                      suspicious: suspicious.map(it => ({
                        text: it.text,
                        fp: fp(it.text),
                        seqId: it.seqId,
                        sourceSeqId: it.sourceSeqId,
                        isSegmented: it.isSegmented
                      }))
                    });
                  }

                  // Log after state update completes
                  const finalHistory = transcriptRef.current;
                  console.log(`[HostPage] ✅ FALLBACK STATE UPDATED - New history total: ${finalHistory.length} items (sorted by seqId/timestamp)`);
                } else {
                  console.log('[HostPage] ⚠️ No new sentences and text too short - NOT adding to history');
                }
              }
              
              setCurrentTranscript('');
            }
            break;
          
          case 'session_stats':
            if (message.stats) {
              setListenerCount(message.stats.listenerCount || 0);
              setLanguageStats(message.stats.languageCounts || {});
            }
            break;
          
          case 'error':
            console.error('[Host] Error:', message.message);
            setError(message.message);
            break;
        }
      } catch (err) {
        console.error('[Host] Failed to parse message:', err);
      }
    };
    
    wsRef.current = ws;
  };

  const handleStartBroadcast = async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('WebSocket not connected');
      return;
    }

    try {
      await startRecording((audioData) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'audio',
            audioData: audioData,
            streaming: true
          }));
        }
      }, true); // streaming mode
      
      setIsStreaming(true);
      setError('');
    } catch (err) {
      console.error('Failed to start recording:', err);
      setError('Failed to access microphone. Please check permissions.');
    }
  };

  const handleStopBroadcast = () => {
    stopRecording();
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'audio_end'
      }));
    }
    
    setIsStreaming(false);
  };

  const handleSourceLangChange = (lang) => {
    setSourceLang(lang);
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'init',
        sourceLang: lang,
        tier: usePremiumTier ? 'premium' : 'basic'
      }));
    }
  };
  
  const handleTierChange = (tier) => {
    if (isStreaming) {
      return; // Don't allow tier change while streaming
    }
    setUsePremiumTier(tier === 'premium');
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'init',
        sourceLang: sourceLang,
        tier: tier
      }));
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <Header />
      
      <div className="container mx-auto px-2 sm:px-4 py-4 sm:py-8">
        {/* Back button */}
        <button
          onClick={onBackToHome}
          className="mb-4 px-3 py-2 text-sm sm:text-base text-gray-600 hover:text-gray-800 flex items-center gap-2"
        >
          ← Back to Home
        </button>

        {/* Session Info Card */}
        <div className="bg-white rounded-lg shadow-lg p-3 sm:p-6 mb-4 sm:mb-6">
          <h2 className="text-lg sm:text-xl md:text-2xl font-bold mb-3 sm:mb-4 text-gray-800">Live Translation - Host</h2>
          
          {error && (
            <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
              {error}
            </div>
          )}

          {/* Session Code Display */}
          {sessionCode && (
            <div className="mb-4 sm:mb-6 text-center">
              <p className="text-sm sm:text-base text-gray-600 mb-2">Session Code:</p>
              <div className="text-3xl sm:text-4xl md:text-5xl font-bold text-indigo-600 tracking-wider mb-3 sm:mb-4">
                {sessionCode}
              </div>
              
              {/* QR Code */}
              {qrDataUrl && (
                <div className="flex flex-col items-center gap-2">
                  <img src={qrDataUrl} alt="QR Code" className="border-2 sm:border-4 border-gray-200 rounded-lg w-48 h-48 sm:w-auto sm:h-auto" />
                  <p className="text-xs sm:text-sm text-gray-500">Listeners can scan this code to join</p>
                </div>
              )}
            </div>
          )}

          {/* Connection Status */}
          <ConnectionStatus state={connectionState} />

          {/* Language Selection and Settings */}
          <div className="mb-4 sm:mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm sm:text-base font-semibold text-gray-700">Configuration</h3>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Settings className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            </div>
            
            <LanguageSelector
              label="Speaking Language"
              languages={LANGUAGES}
              selectedLanguage={sourceLang}
              onLanguageChange={handleSourceLangChange}
            />
            
            {/* Settings Panel */}
            {showSettings && (
              <div className="bg-gray-50 rounded-lg p-3 sm:p-4 mt-4">
                <h3 className="text-sm sm:text-base font-semibold text-gray-900 mb-3">Settings</h3>
                
                {/* Audio Source Selector */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Audio Source
                  </label>
                  <div className="space-y-2">
                    <label className={`flex items-center space-x-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                      audioSource === 'microphone' 
                        ? 'bg-blue-50 border-blue-300' 
                        : 'bg-white border-gray-300 hover:bg-gray-50'
                    } ${isStreaming ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      <input
                        type="radio"
                        name="audioSource"
                        value="microphone"
                        checked={audioSource === 'microphone'}
                        onChange={(e) => setAudioSource(e.target.value)}
                        disabled={isStreaming}
                        className="text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">🎤 Microphone</span>
                    </label>
                    <label className={`flex items-center space-x-2 p-2 rounded-lg border transition-colors ${
                      !systemAudioSupported
                        ? 'bg-gray-100 border-gray-200 cursor-not-allowed opacity-60'
                        : audioSource === 'system'
                        ? 'bg-blue-50 border-blue-300 cursor-pointer'
                        : 'bg-white border-gray-300 hover:bg-gray-50 cursor-pointer'
                    } ${isStreaming ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      <input
                        type="radio"
                        name="audioSource"
                        value="system"
                        checked={audioSource === 'system'}
                        onChange={(e) => setAudioSource(e.target.value)}
                        disabled={!systemAudioSupported || isStreaming}
                        className="text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                      />
                      <span className="text-sm text-gray-700">🔊 System Audio</span>
                      {!systemAudioSupported && (
                        <span className="text-xs text-gray-500 ml-auto">
                          {isMobile ? '(Not available on mobile)' : '(Not supported)'}
                        </span>
                      )}
                    </label>
                  </div>
                  {isStreaming && (
                    <p className="text-xs text-amber-600 mt-1">
                      Stop broadcasting to change audio source
                    </p>
                  )}
                </div>
                
                {/* Microphone Selector - only show when microphone is selected */}
                {audioSource === 'microphone' && availableDevices.length > 0 && (
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      🎤 Microphone Device
                    </label>
                    <select
                      value={selectedDeviceId || ''}
                      onChange={(e) => setSelectedDeviceId(e.target.value || null)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      disabled={isStreaming}
                    >
                      <option value="">Auto-select (Recommended)</option>
                      {availableDevices.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || `Microphone ${device.deviceId.substring(0, 8)}`}
                        </option>
                      ))}
                    </select>
                    {isStreaming && (
                      <p className="text-xs text-amber-600 mt-1">
                        Stop broadcasting to change microphone
                      </p>
                    )}
                  </div>
                )}
                
                {audioSource === 'system' && (
                  <div className="mb-4 p-2 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-xs text-blue-800">
                      💡 <strong>Important:</strong> When you start broadcasting, your browser will show a screen sharing dialog. 
                      You can select any window or screen - we only need the audio. <strong>Make sure to check "Share audio" or enable audio sharing</strong> 
                      in the browser prompt, otherwise no audio will be captured.
                    </p>
                  </div>
                )}
                
                <h3 className="text-sm sm:text-base font-semibold text-gray-900 mb-3 mt-4">Translation Tier</h3>
                <div className="space-y-2">
                  <label className={`flex items-center space-x-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                    !usePremiumTier 
                      ? 'bg-blue-50 border-blue-300' 
                      : 'bg-white border-gray-300 hover:bg-gray-50'
                  } ${isStreaming ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    <input
                      type="radio"
                      name="tier"
                      value="basic"
                      checked={!usePremiumTier}
                      onChange={(e) => handleTierChange('basic')}
                      disabled={isStreaming}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium text-gray-700">Basic (Chat API)</span>
                      <p className="text-xs text-gray-500">Standard latency (400-1500ms), lower cost</p>
                    </div>
                  </label>
                  <label className={`flex items-center space-x-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                    usePremiumTier 
                      ? 'bg-blue-50 border-blue-300' 
                      : 'bg-white border-gray-300 hover:bg-gray-50'
                  } ${isStreaming ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    <input
                      type="radio"
                      name="tier"
                      value="premium"
                      checked={usePremiumTier}
                      onChange={(e) => handleTierChange('premium')}
                      disabled={isStreaming}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium text-gray-700">Premium (Realtime API)</span>
                      <p className="text-xs text-gray-500">Ultra-low latency (150-300ms), 3-4x cost</p>
                    </div>
                  </label>
                </div>
                {isStreaming && (
                  <p className="text-xs text-amber-600 mt-2">
                    Stop broadcasting to change tier
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Broadcast Controls */}
          <div className="flex justify-center gap-3 sm:gap-4 mb-4 sm:mb-6">
            {!isStreaming ? (
              <button
                onClick={handleStartBroadcast}
                disabled={connectionState !== 'open'}
                className="px-6 py-3 sm:px-8 sm:py-4 bg-red-500 hover:bg-red-600 disabled:bg-gray-300 text-white text-sm sm:text-base font-semibold rounded-lg shadow-lg transition-all transform hover:scale-105 disabled:scale-100"
              >
                🎙️ Start Broadcasting
              </button>
            ) : (
              <button
                onClick={handleStopBroadcast}
                className="px-6 py-3 sm:px-8 sm:py-4 bg-gray-500 hover:bg-gray-600 text-white text-sm sm:text-base font-semibold rounded-lg shadow-lg transition-all transform hover:scale-105"
              >
                ⏹️ Stop Broadcasting
              </button>
            )}
          </div>

          {/* Audio Level Indicator */}
          {isStreaming && (
            <div className="mb-4 sm:mb-6">
              <p className="text-xs sm:text-sm text-gray-600 mb-2">Audio Level:</p>
              <div className="w-full bg-gray-200 rounded-full h-3 sm:h-4 overflow-hidden">
                <div
                  className="bg-green-500 h-full transition-all duration-100"
                  style={{ width: `${audioLevel * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Listener Stats */}
          <div className="mb-4 sm:mb-6 p-3 sm:p-4 bg-indigo-50 rounded-lg">
            <h3 className="text-sm sm:text-base font-semibold text-gray-800 mb-2">📊 Listener Statistics</h3>
            <p className="text-xl sm:text-2xl font-bold text-indigo-600">{listenerCount} Listeners</p>
            
            {Object.keys(languageStats).length > 0 && (
              <div className="mt-3">
                <p className="text-xs sm:text-sm text-gray-600 mb-1">By Language:</p>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(languageStats).map(([lang, count]) => (
                    <div key={lang} className="flex justify-between text-xs sm:text-sm">
                      <span className="text-gray-700">{lang}:</span>
                      <span className="font-semibold">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* LIVE TRANSCRIPTION AREA - FIXED POSITION, INLINE UPDATES */}
        <div className="bg-gradient-to-br from-blue-500 via-purple-500 to-indigo-600 rounded-lg sm:rounded-2xl p-3 sm:p-6 shadow-2xl mb-4 sm:mb-6 -mx-2 sm:mx-0">
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <div className="flex items-center space-x-2 sm:space-x-3">
              {isStreaming && (
                <div className="flex space-x-1">
                  <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce"></div>
                  <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{animationDelay: '0.15s'}}></div>
                  <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{animationDelay: '0.3s'}}></div>
                </div>
              )}
              <span className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider flex items-center gap-1 sm:gap-2">
                {isStreaming ? (
                  <>
                    <span className="relative flex h-2 w-2 sm:h-2.5 sm:w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 sm:h-2.5 sm:w-2.5 bg-white"></span>
                    </span>
                    <span className="hidden sm:inline">LIVE TRANSCRIPTION</span>
                    <span className="sm:hidden">LIVE</span>
                  </>
                ) : (
                  'READY'
                )}
              </span>
            </div>
            {currentTranscript && (
              <button
                onClick={() => navigator.clipboard.writeText(currentTranscript)}
                className="p-1 sm:p-1.5 text-white/80 hover:text-white transition-colors"
                title="Copy live text"
              >
                📋
              </button>
            )}
          </div>
          
          <div className="bg-white/95 backdrop-blur rounded-lg sm:rounded-xl p-3 sm:p-6 min-h-[100px] sm:min-h-[140px] max-h-[300px] sm:max-h-[400px] overflow-y-auto transition-none scroll-smooth">
            {currentTranscript ? (
              <p className="text-gray-900 font-semibold text-xl sm:text-2xl md:text-3xl leading-relaxed tracking-wide break-words">
                {currentTranscript}
                {isStreaming && (
                  <span className="inline-block w-0.5 sm:w-1 h-6 sm:h-8 ml-1 sm:ml-2 bg-blue-600 animate-pulse"></span>
                )}
              </p>
            ) : (
              <div className="flex items-center justify-center h-full min-h-[100px] sm:min-h-[140px]">
                <p className="text-gray-400 text-base sm:text-lg md:text-xl text-center px-2">
                  {isStreaming ? 'Ready • Start speaking...' : 'Click "Start Broadcasting"'}
                </p>
              </div>
            )}
          </div>
          
          <div className="mt-2 sm:mt-3 text-xs text-white/80 font-medium">
            {currentTranscript ? (
              <>🔴 LIVE • Broadcasting to {listenerCount} {listenerCount === 1 ? 'listener' : 'listeners'}</>
            ) : isStreaming ? (
              <>Ready • Start speaking to broadcast</>
            ) : (
              <>Click "Start Broadcasting" to begin</>
            )}
          </div>
        </div>

        {/* History - Completed transcripts */}
        {transcript.length > 0 && (
          <div className="bg-gray-50 rounded-lg sm:rounded-xl p-3 sm:p-5 border-2 border-gray-200 -mx-2 sm:mx-0">
            <div className="flex items-center justify-between mb-3 sm:mb-4">
              <h3 className="text-xs sm:text-sm font-semibold text-gray-700 flex items-center gap-1 sm:gap-2">
                <span className="text-blue-600">📝</span>
                History
                <span className="text-xs text-gray-500 font-normal">
                  ({transcript.length})
                </span>
              </h3>
              <button
                onClick={() => {
                  const content = transcript.map(t => `${t.text}\n---`).join('\n')
                  const blob = new Blob([content], { type: 'text/plain' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `transcription-${new Date().toISOString().split('T')[0]}.txt`
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                  URL.revokeObjectURL(url)
                }}
                className="flex items-center space-x-1 px-2 sm:px-3 py-1 text-xs sm:text-sm text-gray-600 hover:text-gray-800 transition-colors"
              >
                <span>📥</span>
                <span className="hidden sm:inline">Download</span>
              </button>
            </div>
            <div className="space-y-2 sm:space-y-3 max-h-80 sm:max-h-96 overflow-y-auto pr-1 sm:pr-2">
              {transcript.slice().reverse().map((item, index) => (
                <div key={index} className="p-3 sm:p-4 bg-white rounded-lg border border-gray-200 shadow-sm hover:shadow-md transition-all">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-blue-600 uppercase">Transcription</span>
                    <button
                      onClick={() => navigator.clipboard.writeText(item.text)}
                      className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                      title="Copy"
                    >
                      📋
                    </button>
                  </div>
                  <p className="text-gray-900 text-sm sm:text-base font-medium leading-relaxed">{item.text}</p>
                  <div className="mt-2 sm:mt-3 pt-2 sm:pt-3 border-t border-gray-100 text-xs text-gray-400 flex items-center justify-between">
                    <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                    <span className="text-gray-300">#{transcript.length - index}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

