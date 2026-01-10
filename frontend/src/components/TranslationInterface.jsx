import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { Mic, MicOff, Volume2, VolumeX, Globe, Settings, ArrowLeft } from 'lucide-react'
import { LanguageSelector } from './LanguageSelector'
import TranslationDisplay from './TranslationDisplay'
import { ConnectionStatus } from './ConnectionStatus'
import { Header } from './Header'
import { useWebSocket } from '../hooks/useWebSocket'
import { useAudioCapture } from '../hooks/useAudioCapture'
import { SentenceSegmenter } from '../utils/sentenceSegmenter'
import { isMobileDevice, isSystemAudioSupported } from '../utils/deviceDetection'
import { TRANSCRIPTION_LANGUAGES, TRANSLATION_LANGUAGES } from '../config/languages.js'

const DEBUG = false; // flip to true only when needed

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

function TranslationInterface({ onBackToHome }) {
  const [isListening, setIsListening] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [sourceLang, setSourceLang] = useState('en')
  const [targetLang, setTargetLang] = useState('es')

  // CRITICAL: Separate states for live streaming vs history
  const [livePartial, setLivePartial] = useState('') // 🔴 LIVE text appearing word-by-word
  const [livePartialOriginal, setLivePartialOriginal] = useState('') // 🔴 LIVE original (for translation mode)
  const [finalTranslations, setFinalTranslations] = useState([]) // 📝 Completed translations

  // DEBUG: Log when finalTranslations state changes and detect if it's being cleared
  useEffect(() => {
    const count = Array.isArray(finalTranslations) ? finalTranslations.length : 0;
    if (DEBUG) {
      console.log('[TranslationInterface] 📝 STATE: finalTranslations updated to', count, 'items');
      console.log('[TranslationInterface] 📝 STATE: finalTranslations value:', finalTranslations);
    }
    if (count === 0 && finalTranslations !== undefined && !Array.isArray(finalTranslations)) {
      console.error('[TranslationInterface] ❌ CRITICAL: finalTranslations is not an array!', typeof finalTranslations, finalTranslations);
    }
  }, [finalTranslations])

  // CRITICAL: Ensure finalTranslations is always an array (never null/undefined)
  // This prevents the history box from disappearing due to type issues
  const safeFinalTranslations = Array.isArray(finalTranslations) ? finalTranslations : [];

  const [showSettings, setShowSettings] = useState(false)
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [latency, setLatency] = useState(0)
  const [usePremiumTier, setUsePremiumTier] = useState(false) // Tier selection: false = basic, true = premium

  // Track seen raw messages for invariant checking
  const seenRawInFpsRef = useRef(new Set());

  // Track longest grammar-corrected text to merge with new raw partials
  const longestCorrectedTextRef = useRef('')
  const longestCorrectedOriginalRef = useRef('')

  // Sentence segmenter for smart text management
  const segmenterRef = useRef(null)
  const sendMessageRef = useRef(null)
  const handleStopListeningRef = useRef(null)

  if (!segmenterRef.current) {
    segmenterRef.current = new SentenceSegmenter({
      maxSentences: 10,     // Increased to allow more sentences in live view (prevents premature flushing)
      maxChars: 2000,       // Increased to handle longer text (prevents premature flushing after 4 lines)
      maxTimeMs: 15000,     // Force flush after 15 seconds
      onFlush: (flushedSentences) => {
        // Move flushed sentences to history with forced paint
        const joinedText = flushedSentences.join(' ').trim()
        if (joinedText) {
          // Schedule flush for next tick to allow browser paint between flushes
          // This prevents browser from batching all visual updates until VAD pause
          setTimeout(() => {
            flushSync(() => {
              setFinalTranslations(prev => {
                const newItem = {
                  id: Date.now() + Math.random(),
                  original: '',
                  translated: joinedText,
                  timestamp: Date.now(),
                  sequenceId: -1,
                  isSegmented: true  // Flag to indicate this was auto-segmented
                };

                // CRITICAL: Insert in correct position based on timestamp (sequenceId is -1 for auto-segmented)
                const newHistory = [...prev, newItem].sort((a, b) => {
                  if (a.sequenceId !== undefined && b.sequenceId !== undefined && a.sequenceId !== -1 && b.sequenceId !== -1) {
                    return a.sequenceId - b.sequenceId;
                  }
                  return (a.timestamp || 0) - (b.timestamp || 0);
                });

                // Post-commit invariant checker: detect suspicious rows that appeared without RAW_IN
                const suspicious = newHistory.slice(-5).filter(it => it?.translated && !seenRawInFpsRef.current.has(fp(it.translated)));
                if (suspicious.length) {
                  console.log('[SUSPICIOUS_COMMIT_ROWS]', {
                    path: 'SEGMENTER_ONFLUSH',
                    suspicious: suspicious.map(it => ({
                      translated: it.translated,
                      fp: fp(it.translated),
                      seqId: it.sequenceId,
                      sourceSeqId: it.sourceSeqId,
                      isSegmented: it.isSegmented
                    }))
                  });
                }

                return newHistory;
              })
            })

            // COMMIT LOGGING: Log exact final text being committed by segmenter onFlush
            console.log('[SOLO_COMMIT]', {
              commitId: Date.now(),
              path: 'SEGMENTER_ONFLUSH',
              side: 'SOLO',
              commitOriginal: '',
              commitTranslated: joinedText,
              originalFp: null,
              translatedFp: fp(joinedText),
              seqId: -1,
              sourceSeqId: -1,
              isPartial: false,
              ts: Date.now()
            });
            if (DEBUG) console.log(`[TranslationInterface] ✅ Flushed to history with paint: "${joinedText.substring(0, 40)}..."`)
          }, 0)

          // Note: No backend force-commit needed
          // OpenAI partials are cumulative per turn - we can't control mid-turn breaks
          // The stripping logic above handles display by hiding already-shown content
        }
      }
    })
  }

  // Memoize WebSocket URL calculation to prevent re-computation on every render
  const finalWebSocketUrl = useMemo(() => {
    const getWebSocketUrl = () => {
      const hostname = window.location.hostname;

      // Validate IP address format
      const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

      if (hostname !== '127.0.0.1' && !ipv4Pattern.test(hostname)) {
        return 'ws://127.0.0.1:3001/translate';
      }

      return `ws://${hostname === '127.0.0.1' ? '127.0.0.1' : hostname}:3001/translate`;
    };

    const websocketUrl = import.meta.env.VITE_WS_URL || getWebSocketUrl();
    const finalUrl = websocketUrl.endsWith('/translate') ? websocketUrl : websocketUrl + '/translate';
    if (DEBUG) console.log('[TranslationInterface] 🔌 WebSocket URL:', finalUrl);
    return finalUrl;
  }, []); // Empty deps - only calculate once

  const {
    connect,
    disconnect,
    sendMessage,
    connectionState,
    addMessageHandler
  } = useWebSocket(finalWebSocketUrl)

  // Update sendMessage ref for segmenter callback
  sendMessageRef.current = sendMessage

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
  } = useAudioCapture()

  // Check device capabilities
  const isMobile = isMobileDevice()
  const systemAudioSupported = isSystemAudioSupported()

  // Sequence tracking to prevent stale partials
  const latestSeqIdRef = useRef(-1);

  // Pending final tracking for confirmation window
  const pendingFinalRef = useRef(null);

  // Track last partial text to detect if final extends it
  const lastPartialTextRef = useRef('');
  const lastPartialTimeRef = useRef(0);

  // Helper function to commit final to history
  // CRITICAL: Use ref to store function to avoid closure issues in timeout callbacks
  const commitFinalToHistoryRef = useRef(null);

  // Define the commit function - recreate when component mounts/updates
  useEffect(() => {
    commitFinalToHistoryRef.current = (finalData) => {
      if (DEBUG) console.log(`[TranslationInterface] ✅ COMMIT FUNCTION CALLED - seqId=${finalData?.seqId}`, finalData)

      if (!finalData || !finalData.text) {
        console.warn('[TranslationInterface] ⚠️ Invalid finalData, skipping commit');
        return;
      }

      // Process through segmenter to flush ONLY NEW text (deduplicated)
      const { flushedSentences } = segmenterRef.current.processFinal(finalData.text, { isForced: finalData.forceFinal })

      if (DEBUG) console.log(`[TranslationInterface] 📊 Segmenter returned ${flushedSentences.length} sentences:`, flushedSentences);

      // Add deduplicated sentences to history - use flushSync for immediate UI update
      if (flushedSentences.length > 0) {
        const joinedText = flushedSentences.join(' ').trim()
        if (joinedText) {
          flushSync(() => {
            setFinalTranslations(prev => {
              const newItem = {
                id: Date.now(),
                original: finalData.original || '',
                translated: joinedText,
                timestamp: finalData.timestamp || Date.now(),
                sequenceId: finalData.seqId
              };

              // CRITICAL: Insert in correct position based on sequenceId to maintain chronological order
              // This prevents race conditions where longer translations complete after shorter ones
              const newHistory = [...prev, newItem].sort((a, b) => {
                // Sort by sequenceId first (most reliable), then by timestamp
                if (a.sequenceId !== undefined && b.sequenceId !== undefined && a.sequenceId !== -1 && b.sequenceId !== -1) {
                  return a.sequenceId - b.sequenceId;
                }
                // Fallback to timestamp if sequenceId not available
                return (a.timestamp || 0) - (b.timestamp || 0);
              });

              if (DEBUG) console.log(`[TranslationInterface] ✅ STATE UPDATED - New history total: ${newHistory.length} items (sorted by seqId/timestamp)`);
              return newHistory;
            })
          })

          // Post-commit invariant checker: detect suspicious rows that appeared without RAW_IN
          const suspicious = newHistory.slice(-5).filter(it => it?.translated && !seenRawInFpsRef.current.has(fp(it.translated)));
          if (suspicious.length) {
            console.log('[SUSPICIOUS_COMMIT_ROWS]', {
              path: 'FINAL_HANDLER',
              suspicious: suspicious.map(it => ({
                translated: it.translated,
                fp: fp(it.translated),
                seqId: it.sequenceId,
                sourceSeqId: it.sourceSeqId,
                isSegmented: it.isSegmented
              }))
            });
          }

          // COMMIT LOGGING: Log exact final text being committed to history
          console.log('[SOLO_COMMIT]', {
            commitId: Date.now(),
            path: 'FINAL_HANDLER',
            side: 'SOLO',
            commitOriginal: newItem.original,
            commitTranslated: newItem.translated,
            originalFp: fp(newItem.original),
            translatedFp: fp(newItem.translated),
            seqId: finalSeqId,
            sourceSeqId: message?.sourceSeqId,
            isPartial: false,
            ts: Date.now()
          });

          if (DEBUG) console.log(`[TranslationInterface] ✅ Added to history: "${joinedText.substring(0, 50)}..."`);
        }
      } else {
        // FALLBACK: If segmenter deduplicated everything, still add the final text if it's substantial
        // This ensures history appears even if deduplication is too aggressive
        const finalText = finalData.text.trim();
        if (finalText.length > 10) {
          if (DEBUG) console.log(`[TranslationInterface] ⚠️ Segmenter deduplicated all, using fallback`);
          flushSync(() => {
            setFinalTranslations(prev => {
              const newItem = {
                id: Date.now(),
                original: finalData.original || '',
                translated: finalText,
                timestamp: finalData.timestamp || Date.now(),
                sequenceId: finalData.seqId
              };

              // CRITICAL: Insert in correct position based on sequenceId to maintain chronological order
              const newHistory = [...prev, newItem].sort((a, b) => {
                if (a.sequenceId !== undefined && b.sequenceId !== undefined && a.sequenceId !== -1 && b.sequenceId !== -1) {
                  return a.sequenceId - b.sequenceId;
                }
                return (a.timestamp || 0) - (b.timestamp || 0);
              });

              if (DEBUG) console.log(`[TranslationInterface] ✅ FALLBACK STATE UPDATED - New history total: ${newHistory.length} items (sorted by seqId/timestamp)`);
              return newHistory;
            })
          })
        } else {
          if (DEBUG) console.log('[TranslationInterface] ⚠️ No new sentences and text too short - NOT adding to history');
        }
      }

      // Clear live partial for next segment
      setLivePartial('')
      setLivePartialOriginal('')
      // Clear corrected text tracking for new segment
      longestCorrectedTextRef.current = ''
      longestCorrectedOriginalRef.current = ''

      // Calculate latency from server timestamp if available
      if (finalData.serverTimestamp) {
        setLatency(Date.now() - finalData.serverTimestamp);
      } else {
        setLatency(Date.now() - (finalData.timestamp || Date.now()));
      }
    };
  }, []); // Only set once on mount

  // Also create a stable reference function for use in callbacks
  const commitFinalToHistory = useCallback((finalData) => {
    if (commitFinalToHistoryRef.current) {
      commitFinalToHistoryRef.current(finalData);
    } else {
      console.error('[TranslationInterface] ❌ commitFinalToHistoryRef.current is null!');
    }
  }, []);

  // Use ref to track isListening to avoid recreating handleWebSocketMessage
  const isListeningRef = useRef(false)

  // Update ref when isListening changes
  useEffect(() => {
    isListeningRef.current = isListening
  }, [isListening])

  // OPTIMIZATION: Utility function to check if translation differs from original
  // Memoize this to avoid repeated string operations on every delta
  const isTranslationDifferent = useCallback((translated, original) => {
    if (!translated || !original) return true;
    const t = translated.trim();
    const o = original.trim();
    return t !== o && t !== o.toLowerCase() && t.toLowerCase() !== o.toLowerCase();
  }, []);

  // OPTIMIZATION: Utility function to merge corrected text with raw partials
  // Extract to avoid code duplication between translation and transcription modes
  const mergeTextWithCorrection = useCallback((newRawText, correctedOverride = null) => {
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
  }, []);

  // Define message handler with useCallback to prevent re-creation
  // CRITICAL: Don't include isListening in dependencies - use ref instead to prevent WebSocket reconnection
  const handleWebSocketMessage = useCallback((message) => {
    // Drop stale messages (out of order) - minimal logging
    if (message.seqId !== undefined && message.seqId < latestSeqIdRef.current) {
      return; // Silent drop for stale messages
    }

    // RAW_IN logging: canonical ingestion truth for ghost bug debugging
    console.log('[SOLO_RAW_IN]', {
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

    if (message.seqId !== undefined) {
      latestSeqIdRef.current = Math.max(latestSeqIdRef.current, message.seqId);
    }

    switch (message.type) {
      case 'info':
        // Info messages from backend (e.g. connection status)
        if (DEBUG) console.log('[TranslationInterface] ℹ️ Info:', message.message);
        break;
      case 'session_ready':
        if (DEBUG) console.log('[TranslationInterface] ✅ Translation session ready')
        break
      case 'TRANSCRIPT_PARTIAL':
        // English source transcript partial - update original text
        if (message.isPartial) {
          const originalText = message.originalText || '';
          const correctedText = message.correctedText;
          const textToDisplay = mergeTextWithCorrection(originalText, correctedText);

          if (textToDisplay) {
            // Use flushSync for consistent real-time updates
            flushSync(() => {
              setLivePartialOriginal(textToDisplay);
            });
          }
        }
        break

      case 'TRANSLATION_PARTIAL':
        // Translation partial - update translation text only if targetLang matches
        if (message.isPartial) {
          const translatedText = message.translatedText || '';
          const isForMyLanguage = message.targetLang === targetLang;

          if (isForMyLanguage && translatedText.trim() && isTranslationDifferent(translatedText, livePartialOriginal)) {
            flushSync(() => {
              setLivePartial(translatedText);
            });
          } else if (!translatedText || !translatedText.trim()) {
            // No translation - keep last partial but clear if it matches original
            if (livePartial && livePartial === livePartialOriginal) {
              setLivePartial('');
            }
          }
        }
        break

      case 'TRANSCRIPT_FINAL':
        // English source transcript final - commit to history
        if (message.isPartial === true) {
          console.warn(`[TranslationInterface] ⚠️ SAFEGUARD: Received TRANSCRIPT_FINAL marked as partial - ignoring`);
          return;
        }

        const transcriptFinalText = message.correctedText || message.originalText || '';
        const transcriptSeqId = message.seqId;
        const isForcedTranscriptFinal = message.forceFinal === true;

        if (DEBUG) console.log(`[TranslationInterface] 📝 TRANSCRIPT_FINAL received seqId=${transcriptSeqId}: "${transcriptFinalText.substring(0, 50)}..."`);

        if (transcriptFinalText) {
          // Update live partial original to show the final
          flushSync(() => {
            setLivePartialOriginal(transcriptFinalText);
          });

          // Commit to history (similar to translation final logic)
          if (pendingFinalRef.current && pendingFinalRef.current.timeout) {
            clearTimeout(pendingFinalRef.current.timeout);
            pendingFinalRef.current = null;
          }

          // Add to history
          setTranslationHistory(prev => {
            const recentEntries = prev.slice(-3);
            const isDuplicate = recentEntries.some(entry => entry.text === transcriptFinalText);
            if (isDuplicate) {
              console.log('[TranslationInterface] ⏭️ Skipping duplicate transcript final');
              return prev;
            }
            return [...prev, {
              text: transcriptFinalText,
              originalText: transcriptFinalText,
              timestamp: message.timestamp || Date.now(),
              seqId: transcriptSeqId,
              isTranscription: true,
              isForcedFinal: isForcedTranscriptFinal
            }];
          });
        }
        break

      case 'TRANSLATION_FINAL':
        // Translation final - commit to history only if targetLang matches
        if (message.isPartial === true) {
          console.warn(`[TranslationInterface] ⚠️ SAFEGUARD: Received TRANSLATION_FINAL marked as partial - ignoring`);
          return;
        }

        const translationFinalText = message.translatedText || '';
        const translationSeqId = message.seqId;
        const isForcedTranslationFinal = message.forceFinal === true;
        const isForMyLanguageFinal = message.targetLang === targetLang;

        if (!isForMyLanguageFinal) {
          return; // Not for this listener's language
        }

        if (DEBUG) console.log(`[TranslationInterface] 📝 TRANSLATION_FINAL received seqId=${translationSeqId}: "${translationFinalText.substring(0, 50)}..."`);

        if (isForcedTranslationFinal) {
          console.warn('[TranslationInterface] ⚠️ Forced TRANSLATION_FINAL received from backend (may be incomplete)');
        }

        if (translationFinalText) {
          // Cancel any pending final timeout
          if (pendingFinalRef.current && pendingFinalRef.current.timeout) {
            clearTimeout(pendingFinalRef.current.timeout);
            pendingFinalRef.current = null;
          }

          // Update live partial to show the final
          flushSync(() => {
            setLivePartial(translationFinalText);
          });

          // Commit to history (use existing final handling logic)
          const finalOriginalText = message.correctedText || message.originalText || '';

          setTranslationHistory(prev => {
            const recentEntries = prev.slice(-3);
            const isDuplicate = recentEntries.some(entry => entry.text === translationFinalText);
            if (isDuplicate) {
              console.log('[TranslationInterface] ⏭️ Skipping duplicate translation final');
              return prev;
            }
            return [...prev, {
              text: translationFinalText,
              originalText: finalOriginalText,
              translatedText: translationFinalText,
              timestamp: message.timestamp || Date.now(),
              seqId: translationSeqId,
              hasTranslation: true,
              isForcedFinal: isForcedTranslationFinal
            }];
          });
        }
        break

      case 'translation':
        if (message.isPartial) {
          // 🔴 LIVE PARTIAL: Optimized handler with utility functions
          const isTranscriptionMode = message.isTranscriptionOnly === true || (sourceLang === targetLang && !message.hasTranslation);
          const originalText = message.originalText || '';
          const translatedText = message.translatedText || '';
          const correctedText = message.correctedText;

          if (!isTranscriptionMode) {
            // TRANSLATION MODE: Show both original and translation
            // Update original text using utility function
            const textToDisplay = mergeTextWithCorrection(originalText, correctedText);
            if (textToDisplay) {
              // Use flushSync for consistent real-time updates (especially important now that grammar corrections reach all listeners)
              flushSync(() => {
                setLivePartialOriginal(textToDisplay);
              });
            }

            // Update translation text - only if different from original
            if (translatedText && translatedText.trim() && isTranslationDifferent(translatedText, originalText)) {
              flushSync(() => {
                setLivePartial(translatedText);
              });
            } else if (!translatedText || !translatedText.trim()) {
              // No translation - keep last partial but clear if it matches original
              if (livePartial && livePartial === livePartialOriginal) {
                setLivePartial('');
              }
            }
          } else {
            // TRANSCRIPTION MODE: Just show the text immediately
            const rawText = mergeTextWithCorrection(originalText, correctedText) || translatedText;

            if (!rawText || !rawText.trim()) {
              return; // No text to display
            }

            // Process through segmenter
            const { liveText } = segmenterRef.current.processPartial(rawText);

            // Track last partial text and time for final extension detection
            lastPartialTextRef.current = rawText;
            lastPartialTimeRef.current = Date.now();

            // Update immediately with flushSync
            flushSync(() => {
              setLivePartial(liveText);
            });
          }
        } else {
          // 📝 FINAL: Commit immediately to history (restored simple approach)
          // CRITICAL SAFEGUARD: Double-check that this is NOT a partial (defensive programming)
          if (message.isPartial === true) {
            console.warn(`[TranslationInterface] ⚠️ SAFEGUARD: Received message marked as partial in FINAL handler - ignoring to prevent mid-sentence commits. Text: "${(message.translatedText || message.correctedText || message.originalText || '').substring(0, 50)}..."`);
            return; // Skip committing partials - they should only update live text
          }

          const finalText = message.translatedText || message.correctedText || message.originalText || ''
          const finalSeqId = message.seqId
          const isForcedFinal = message.forceFinal === true
          if (DEBUG) console.log(`[TranslationInterface] 📝 FINAL received seqId=${finalSeqId}: "${finalText.substring(0, 50)}..."`)
          if (isForcedFinal) {
            console.warn('[TranslationInterface] ⚠️ Forced FINAL received from backend (may be incomplete)')
          }

          // Cancel any pending final timeout (in case we had one)
          if (pendingFinalRef.current && pendingFinalRef.current.timeout) {
            clearTimeout(pendingFinalRef.current.timeout);
            pendingFinalRef.current = null;
          }

          // CRITICAL: Check if this final extends the last partial text
          // If it does, we need to prevent duplication by marking the partial as already flushed
          const lastPartialText = lastPartialTextRef.current.trim();
          const finalTextTrimmed = finalText.trim();
          const timeSinceLastPartial = Date.now() - lastPartialTimeRef.current;
          const FINAL_EXTENSION_WINDOW_MS = 5000; // 5 seconds - finals typically arrive within this window

          if (lastPartialText &&
            timeSinceLastPartial < FINAL_EXTENSION_WINDOW_MS &&
            finalTextTrimmed.length > lastPartialText.length &&
            (finalTextTrimmed.startsWith(lastPartialText) ||
              (lastPartialText.length > 10 && finalTextTrimmed.substring(0, lastPartialText.length) === lastPartialText))) {
            if (DEBUG) {
              console.log(`[TranslationInterface] 🔁 Final extends last partial - preventing duplication`);
              console.log(`[TranslationInterface] 📝 Last partial: "${lastPartialText.substring(0, 50)}..." → Final: "${finalTextTrimmed.substring(0, 50)}..."`);
            }

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
                  if (DEBUG) console.log(`[TranslationInterface] ✅ Marked partial as flushed: "${partialTextToFlush.substring(0, 50)}..."`);
                }
              }
            }
          }

          // CRITICAL: Check if this is transcription-only mode (same language)
          // Use message flag first, then fall back to language comparison
          const isTranscriptionMode = message.isTranscriptionOnly === true || (sourceLang === targetLang && !message.hasTranslation);

          // Only include original text if it's translation mode (not transcription mode)
          // Use correctedText if available (grammar-fixed), otherwise fall back to originalText (raw STT)
          const originalTextForHistory = isTranscriptionMode ? '' : (message.correctedText || message.originalText || '');
          if (DEBUG) {
            console.log(`[TranslationInterface] 📝 FINAL history text: isTranscriptionMode=${isTranscriptionMode}, hasCorrection=${!!message.correctedText}, length=${originalTextForHistory.length}`);
            if (message.correctedText && message.correctedText !== message.originalText) {
              console.log(`[TranslationInterface] 📝 FINAL used corrected text: "${message.originalText}" → "${message.correctedText}"`);
            }
          }

          // Commit immediately - process through segmenter and add to history
          const finalData = {
            text: finalText,
            original: originalTextForHistory,  // Only set if translation mode, empty string for transcription mode
            timestamp: message.timestamp || Date.now(),
            serverTimestamp: message.serverTimestamp,
            seqId: finalSeqId,
            forceFinal: isForcedFinal
          };

          // Call commit function immediately
          if (commitFinalToHistoryRef.current) {
            commitFinalToHistoryRef.current(finalData);
          } else {
            console.error('[TranslationInterface] ❌ commitFinalToHistoryRef.current is null, using fallback');
            // FALLBACK: Direct commit if ref isn't ready
            const { flushedSentences } = segmenterRef.current.processFinal(finalText, { isForced: finalData.forceFinal });
            if (flushedSentences.length > 0 || finalText.length > 10) {
              const textToAdd = flushedSentences.length > 0 ? flushedSentences.join(' ').trim() : finalText;
              if (textToAdd) {
                setFinalTranslations(prev => {
                  const newItem = {
                    id: Date.now(),
                    original: finalData.original,
                    translated: textToAdd,
                    timestamp: finalData.timestamp,
                    sequenceId: finalSeqId
                  };

                  // CRITICAL: Insert in correct position based on sequenceId to maintain chronological order
                  const newHistory = [...prev, newItem].sort((a, b) => {
                    if (a.sequenceId !== undefined && b.sequenceId !== undefined && a.sequenceId !== -1 && b.sequenceId !== -1) {
                      return a.sequenceId - b.sequenceId;
                    }
                    return (a.timestamp || 0) - (b.timestamp || 0);
                  });

                  return newHistory;
                });

                // Post-commit invariant checker: detect suspicious rows that appeared without RAW_IN
                const suspicious = newHistory.slice(-5).filter(it => it?.translated && !seenRawInFpsRef.current.has(fp(it.translated)));
                if (suspicious.length) {
                  console.log('[SUSPICIOUS_COMMIT_ROWS]', {
                    path: 'FINAL_HANDLER_FALLBACK',
                    suspicious: suspicious.map(it => ({
                      translated: it.translated,
                      fp: fp(it.translated),
                      seqId: it.sequenceId,
                      sourceSeqId: it.sourceSeqId,
                      isSegmented: it.isSegmented
                    }))
                  });
                }

                if (DEBUG) console.log(`[TranslationInterface] ✅ FALLBACK: Added to history: "${textToAdd.substring(0, 50)}..."`);
              }
            }
            setLivePartial('')
            setLivePartialOriginal('')
            // Clear corrected text tracking for new segment
            longestCorrectedTextRef.current = ''
            longestCorrectedOriginalRef.current = ''
          }
        }
        break
      case 'warning':
        console.warn('[TranslationInterface] ⚠️ Warning:', message.message)
        // If we're listening and get a warning about service restarting/timeout, stop listening
        // This allows the user to restart by clicking the button again
        // Use ref instead of isListening to avoid dependency issues
        if (isListeningRef.current && (message.message.includes('restarting') || message.message.includes('timeout') || message.code === 11)) {
          if (DEBUG) console.log('[TranslationInterface] 🔄 Auto-stopping listening due to service restart/timeout')
          if (handleStopListeningRef.current) {
            handleStopListeningRef.current()
          }
        }
        break

      case 'error':
        console.error('[TranslationInterface] ❌ Translation error:', message.message)
        // Auto-stop listening on errors to allow restart
        // Use ref instead of isListening to avoid dependency issues
        if (isListeningRef.current) {
          if (DEBUG) console.log('[TranslationInterface] 🔄 Auto-stopping listening due to error')
          if (handleStopListeningRef.current) {
            handleStopListeningRef.current()
          }
        }
        // Show quota errors prominently
        if (message.code === 1011 || message.message.includes('Quota') || message.message.includes('quota')) {
          alert('⚠️ API Quota Exceeded!\n\n' + message.message + '\n\nPlease check your API limits and try again later.')
        } else if (message.message.includes('timeout') || message.message.includes('Timeout')) {
          // Show timeout error to user
          console.warn('[TranslationInterface] ⚠️ Service timeout - you can restart by clicking the listening button again')
        }
        break
      default:
        if (DEBUG) console.log('[TranslationInterface] ⚠️ Unknown message type:', message.type)
    }
  }, [commitFinalToHistory, sourceLang, targetLang, isTranslationDifferent, mergeTextWithCorrection, livePartial, livePartialOriginal]) // Include utility functions and live state for comparison

  // CRITICAL: Use refs for functions to prevent WebSocket reconnection on every render
  // Note: sendMessageRef already declared above (line 59), so we reuse it
  const handleWebSocketMessageRef = useRef(handleWebSocketMessage)
  const connectRef = useRef(connect)
  const addMessageHandlerRef = useRef(addMessageHandler)
  const disconnectRef = useRef(disconnect)

  // Update refs when functions change (these are stable from useWebSocket, but update refs anyway)
  useEffect(() => {
    handleWebSocketMessageRef.current = handleWebSocketMessage
  }, [handleWebSocketMessage])

  // sendMessageRef is already updated at line 186, no need to update again here

  useEffect(() => {
    connectRef.current = connect
    addMessageHandlerRef.current = addMessageHandler
    disconnectRef.current = disconnect
  }, [connect, addMessageHandler, disconnect])

  useEffect(() => {
    if (DEBUG) console.log('[TranslationInterface] 🚀 Initializing WebSocket connection')
    connectRef.current()

    // Add message handler using ref to avoid dependency issues
    // This wrapper function will always call the latest handleWebSocketMessage via ref
    const removeHandler = addMessageHandlerRef.current((message) => {
      handleWebSocketMessageRef.current(message)
    })

    // Handle tab visibility changes (background/foreground)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (DEBUG) console.log('[TranslationInterface] 📴 Tab hidden - notifying server');
        sendMessageRef.current({
          type: 'client_hidden'
        });
      } else {
        if (DEBUG) console.log('[TranslationInterface] 📴 Tab visible - notifying server');
        sendMessageRef.current({
          type: 'client_visible'
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (DEBUG) console.log('[TranslationInterface] 🔌 Cleaning up WebSocket')
      removeHandler()
      disconnectRef.current()
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    // CRITICAL: Empty dependency array - only run on mount/unmount
    // All functions are accessed via refs to ensure we always use the latest versions
  }, []) // Only run once on mount

  useEffect(() => {
    if (connectionState === 'open') {
      setIsConnected(true)
      if (DEBUG) console.log('[TranslationInterface] 📡 WebSocket OPEN - Initializing session')
      // Initialize translation session
      sendMessage({
        type: 'init',
        sourceLang,
        targetLang,
        tier: usePremiumTier ? 'premium' : 'basic'
      })
    } else {
      setIsConnected(false)
      if (DEBUG && connectionState !== 'connecting') {
        console.log('[TranslationInterface] ⚠️ WebSocket state:', connectionState)
      }
    }
  }, [connectionState, sourceLang, targetLang, usePremiumTier]) // Remove sendMessage from deps to prevent re-render loop

  const handleStartListening = async () => {
    if (!isConnected) {
      console.warn('[TranslationInterface] ⚠️ Cannot start listening - WebSocket not connected')
      return
    }

    // If already listening, stop first to reset state
    if (isListening) {
      if (DEBUG) console.log('[TranslationInterface] 🔄 Already listening, stopping first to reset...')
      handleStopListening()
      // Wait longer for cleanup and WebSocket to stabilize
      await new Promise(resolve => setTimeout(resolve, 800))
    }

    // CRITICAL: Ensure WebSocket is connected before proceeding
    // Check connectionState directly as it's more reliable than isConnected state
    if (connectionState !== 'open') {
      console.warn('[TranslationInterface] ⚠️ WebSocket not connected, waiting for connection...')
      // Wait up to 5 seconds for connection
      let waitCount = 0
      while (connectionState !== 'open' && waitCount < 50) {
        await new Promise(resolve => setTimeout(resolve, 100))
        waitCount++
      }

      if (connectionState !== 'open') {
        console.error('[TranslationInterface] ❌ WebSocket connection timeout')
        alert('⚠️ Unable to connect to server. Please refresh the page.')
        return
      }
    }

    try {
      // Reinitialize session when starting to ensure clean state
      if (DEBUG) console.log('[TranslationInterface] 🔄 Reinitializing session before starting...')
      sendMessage({
        type: 'init',
        sourceLang,
        targetLang,
        tier: usePremiumTier ? 'premium' : 'basic'
      })

      // Small delay to ensure backend is ready
      await new Promise(resolve => setTimeout(resolve, 200))

      // Enable streaming mode (second parameter = true)
      await startRecording((audioChunk, metadata) => {
        // CRITICAL: Only send if WebSocket is connected
        // This prevents errors when audio chunks arrive after stopping
        if (!isConnected) {
          if (DEBUG) console.warn('[TranslationInterface] ⚠️ Skipping audio chunk - WebSocket not connected')
          return
        }

        // Send audio chunk to backend in real-time with language information and metadata
        const message = {
          type: 'audio',
          audioData: audioChunk,
          sourceLang: sourceLang,
          targetLang: targetLang,
          streaming: true
        }

        // Add chunk metadata if available (from optimized AudioWorklet)
        if (metadata) {
          message.chunkIndex = metadata.chunkIndex
          message.startMs = metadata.startMs
          message.endMs = metadata.endMs
          message.clientTimestamp = Date.now()
        }

        sendMessage(message)
      }, true) // true = streaming mode
      setIsListening(true)
      if (DEBUG) console.log('[TranslationInterface] ✅ Started listening successfully')
    } catch (error) {
      console.error('Failed to start recording:', error)
      setIsListening(false)

      // Show user-friendly error message
      let errorMessage = 'Failed to start audio capture.'
      if (error.message) {
        if (error.message.includes('Share audio')) {
          errorMessage = '⚠️ No audio captured. Please make sure to check "Share audio" in the browser prompt when sharing your screen.'
        } else if (error.message.includes('not supported')) {
          errorMessage = '⚠️ System audio capture is not supported on this device or browser.'
        } else {
          errorMessage = `⚠️ ${error.message}`
        }
      }

      alert(errorMessage)
    }
  }

  const handleStopListening = useCallback(() => {
    if (DEBUG) console.log('[TranslationInterface] 🛑 Stopping listening...')
    stopRecording()
    setIsListening(false)

    // Clear live partials when stopping
    setLivePartial('')
    setLivePartialOriginal('')

    // Reset catch-up mode and lag detection
    catchUpModeRef.current = false
    messageTimestampsRef.current = []
    lastTextLengthRef.current = 0

    // Reset segmenter deduplication memory after significant stop
    // This prevents old text from interfering with new sessions
    setTimeout(() => {
      if (segmenterRef.current) {
        if (DEBUG) console.log('[TranslationInterface] 🔄 Resetting segmenter deduplication memory')
        segmenterRef.current.reset()
        // Restore normal thresholds
        segmenterRef.current.maxSentences = 10
        segmenterRef.current.maxChars = 2000
        segmenterRef.current.maxTimeMs = 15000
      }
    }, 2000) // Wait 2 seconds after stop before resetting

    // Send audio_end message to backend to signal end of audio stream
    if (isConnected) {
      sendMessage({
        type: 'audio_end'
      })
    }
  }, [stopRecording, isConnected, sendMessage])

  // Store handleStopListening in ref for use in message handler
  handleStopListeningRef.current = handleStopListening

  const handleLanguageChange = (type, language) => {
    if (type === 'source') {
      setSourceLang(language)
    } else {
      setTargetLang(language)
    }

    // Reinitialize session with new languages
    if (isConnected) {
      sendMessage({
        type: 'init',
        sourceLang: type === 'source' ? language : sourceLang,
        targetLang: type === 'target' ? language : targetLang
      })
    }
  }

  // handleWebSocketMessage is now defined above with useCallback

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <Header />
      <div className="container mx-auto px-2 sm:px-4 py-4 sm:py-8">
        {onBackToHome && (
          <button
            onClick={onBackToHome}
            className="mb-4 px-3 py-2 text-sm sm:text-base text-gray-600 hover:text-gray-800 flex items-center gap-2 transition-colors"
          >
            <ArrowLeft className="w-3 h-3 sm:w-4 sm:h-4" />
            <span>Back to Home</span>
          </button>
        )}

        <div className="max-w-6xl mx-auto">
          <div className="bg-white rounded-lg sm:rounded-xl shadow-lg p-3 sm:p-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 sm:mb-6 gap-3">
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4">
                <h2 className="text-lg sm:text-xl md:text-2xl font-bold text-gray-900">
                  {sourceLang === targetLang ? 'Voice Transcription' : 'Voice Translation'} - Solo Mode
                </h2>
                <ConnectionStatus
                  state={connectionState}
                  latency={latency}
                />
              </div>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Settings className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            </div>

            {/* Language Selection */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 mb-4 sm:mb-6">
              <LanguageSelector
                label="Source Language"
                languages={TRANSCRIPTION_LANGUAGES}
                selectedLanguage={sourceLang}
                onLanguageChange={(lang) => handleLanguageChange('source', lang)}
              />
              <LanguageSelector
                label="Target Language"
                languages={TRANSLATION_LANGUAGES}
                selectedLanguage={targetLang}
                onLanguageChange={(lang) => handleLanguageChange('target', lang)}
              />
            </div>

            {/* Settings Panel */}
            {showSettings && (
              <div className="bg-gray-50 rounded-lg p-3 sm:p-4 mb-4 sm:mb-6">
                <h3 className="text-sm sm:text-base font-semibold text-gray-900 mb-3">Settings</h3>

                {/* Audio Source Selector */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Audio Source
                  </label>
                  <div className="space-y-2">
                    <label className={`flex items-center space-x-2 p-2 rounded-lg border cursor-pointer transition-colors ${audioSource === 'microphone'
                      ? 'bg-blue-50 border-blue-300'
                      : 'bg-white border-gray-300 hover:bg-gray-50'
                      } ${isListening ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      <input
                        type="radio"
                        name="audioSource"
                        value="microphone"
                        checked={audioSource === 'microphone'}
                        onChange={(e) => setAudioSource(e.target.value)}
                        disabled={isListening}
                        className="text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">🎤 Microphone</span>
                    </label>
                    <label className={`flex items-center space-x-2 p-2 rounded-lg border transition-colors ${!systemAudioSupported
                      ? 'bg-gray-100 border-gray-200 cursor-not-allowed opacity-60'
                      : audioSource === 'system'
                        ? 'bg-blue-50 border-blue-300 cursor-pointer'
                        : 'bg-white border-gray-300 hover:bg-gray-50 cursor-pointer'
                      } ${isListening ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      <input
                        type="radio"
                        name="audioSource"
                        value="system"
                        checked={audioSource === 'system'}
                        onChange={(e) => setAudioSource(e.target.value)}
                        disabled={!systemAudioSupported || isListening}
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
                  {isListening && (
                    <p className="text-xs text-amber-600 mt-1">
                      Stop listening to change audio source
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
                      disabled={isListening}
                    >
                      <option value="">Auto-select (Recommended)</option>
                      {availableDevices.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || `Microphone ${device.deviceId.substring(0, 8)}`}
                        </option>
                      ))}
                    </select>
                    {isListening && (
                      <p className="text-xs text-amber-600 mt-1">
                        Stop listening to change microphone
                      </p>
                    )}
                  </div>
                )}

                {audioSource === 'system' && (
                  <div className="mb-4 p-2 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-xs text-blue-800">
                      💡 <strong>Important:</strong> When you start listening, your browser will show a screen sharing dialog.
                      You can select any window or screen - we only need the audio. <strong>Make sure to check "Share audio" or enable audio sharing</strong>
                      in the browser prompt, otherwise no audio will be captured.
                    </p>
                  </div>
                )}

                {/* Tier Selection */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Translation Tier
                  </label>
                  <div className="space-y-2">
                    <label className={`flex items-center space-x-2 p-2 rounded-lg border cursor-pointer transition-colors ${!usePremiumTier
                      ? 'bg-blue-50 border-blue-300'
                      : 'bg-white border-gray-300 hover:bg-gray-50'
                      } ${isListening ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      <input
                        type="radio"
                        name="tier"
                        value="basic"
                        checked={!usePremiumTier}
                        onChange={(e) => setUsePremiumTier(false)}
                        disabled={isListening}
                        className="text-blue-600 focus:ring-blue-500"
                      />
                      <div className="flex-1">
                        <span className="text-sm font-medium text-gray-700">Basic (Chat API)</span>
                        <p className="text-xs text-gray-500">Standard latency (400-1500ms), lower cost</p>
                      </div>
                    </label>
                    <label className={`flex items-center space-x-2 p-2 rounded-lg border cursor-pointer transition-colors ${usePremiumTier
                      ? 'bg-blue-50 border-blue-300'
                      : 'bg-white border-gray-300 hover:bg-gray-50'
                      } ${isListening ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      <input
                        type="radio"
                        name="tier"
                        value="premium"
                        checked={usePremiumTier}
                        onChange={(e) => setUsePremiumTier(true)}
                        disabled={isListening}
                        className="text-blue-600 focus:ring-blue-500"
                      />
                      <div className="flex-1">
                        <span className="text-sm font-medium text-gray-700">Premium (Realtime API)</span>
                        <p className="text-xs text-gray-500">Ultra-low latency (150-300ms), 3-4x cost</p>
                      </div>
                    </label>
                  </div>
                  {isListening && (
                    <p className="text-xs text-amber-600 mt-1">
                      Stop listening to change tier
                    </p>
                  )}
                </div>

                <div className="flex items-center space-x-4">
                  <label className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={audioEnabled}
                      onChange={(e) => setAudioEnabled(e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-sm text-gray-700">Enable audio output</span>
                  </label>
                </div>
              </div>
            )}

            {/* Microphone Controls */}
            <div className="flex flex-col items-center justify-center mb-4 sm:mb-8 gap-3">
              <button
                onClick={isListening ? handleStopListening : handleStartListening}
                disabled={!isConnected}
                className={`w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center transition-all transform hover:scale-105 ${isListening
                  ? 'bg-red-500 hover:bg-red-600 text-white animate-pulse'
                  : isConnected
                    ? 'bg-blue-500 hover:bg-blue-600 text-white'
                    : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  }`}
              >
                {isListening ? (
                  <MicOff className="w-6 h-6 sm:w-8 sm:h-8" />
                ) : (
                  <Mic className="w-6 h-6 sm:w-8 sm:h-8" />
                )}
              </button>

              {isListening && (
                <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-3">
                  {/* LIVE Badge */}
                  <div className="flex items-center space-x-1 bg-red-500 text-white px-2 py-1 rounded font-bold text-xs">
                    <div className="w-2 h-2 bg-white rounded-full animate-pulse"></div>
                    <span>LIVE</span>
                  </div>
                  <span className="text-xs sm:text-sm text-gray-600">Streaming translation...</span>
                  {audioLevel > 0 && (
                    <div className="flex space-x-1">
                      {[...Array(5)].map((_, i) => (
                        <div
                          key={i}
                          className={`w-1 h-3 sm:h-4 rounded transition-all ${i < (audioLevel * 5) ? 'bg-red-500' : 'bg-gray-300'
                            }`}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Translation Display */}
            <TranslationDisplay
              finalTranslations={safeFinalTranslations}
              livePartial={livePartial}
              livePartialOriginal={livePartialOriginal}
              audioEnabled={audioEnabled}
              isListening={isListening}
              sourceLang={sourceLang}
              targetLang={targetLang}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export default TranslationInterface
