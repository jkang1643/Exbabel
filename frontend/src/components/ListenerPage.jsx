/**
 * Listener Page - For audience members to receive live translations
 */

import { useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { Header } from './Header';
import { ConnectionStatus } from './ConnectionStatus';
import { LanguageSelector } from './LanguageSelector';
import { TtsPanel } from './TtsPanel';
import { TtsPlayerController } from '../tts/TtsPlayerController.js';
import { SentenceSegmenter } from '../utils/sentenceSegmenter';
import { TRANSLATION_LANGUAGES } from '../config/languages.js';

// Dynamically determine backend URL based on frontend URL
// If accessing via network IP, use the same IP for backend
const getBackendUrl = () => {
  const hostname = window.location.hostname;
  console.log('[ListenerPage] Detected hostname:', hostname);

  // Validate IP address format
  const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  if (hostname !== '127.0.0.1' && !ipv4Pattern.test(hostname)) {
    console.error('[ListenerPage] Invalid hostname format, using 127.0.0.1');
    return 'http://127.0.0.1:3001';
  }

  return `http://${hostname}:3001`;
};

const getWebSocketUrl = () => {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Use current host which includes port (e.g. localhost:3000)
  // This ensures we go through the Vite proxy
  return `${wsProtocol}//${window.location.host}/translate`;
};

const API_URL = import.meta.env.VITE_API_URL || getBackendUrl();
const WS_URL = import.meta.env.VITE_WS_URL || getWebSocketUrl();

const LANGUAGES = TRANSLATION_LANGUAGES; // Listeners choose their language - can use all translation languages

// TRACE: Frontend tracing helper
const TRACE = import.meta.env.VITE_TRACE_REALTIME === '1';

// TTS UI feature flag
const TTS_UI_ENABLED = import.meta.env.VITE_TTS_UI_ENABLED === 'true';
console.log('[ListenerPage] TTS_UI_ENABLED:', TTS_UI_ENABLED, 'raw env:', import.meta.env.VITE_TTS_UI_ENABLED);

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

function traceUI(stage, msg, extra = {}) {
  if (!TRACE) return;
  const now = Date.now();
  console.log(`[UI_TRACE] ${stage}`, {
    stage,
    traceId: msg.traceId,
    sessionId: msg.sessionId,
    seqId: msg.seqId || msg.seq,
    kind: msg.kind || (msg.isPartial ? (msg.hasTranslation ? 'translation_partial' : 'transcript_partial') : (msg.hasTranslation ? 'translation_final' : 'transcript_final')),
    targetLang: msg.targetLang,
    hasTranslation: msg.hasTranslation,
    textLen: msg.text?.length || msg.originalText?.length || msg.translatedText?.length,
    wsDelay: msg.t_pub ? (now - msg.t_pub) : undefined,
    ...extra
  });
  // CRITICAL: Log full raw message JSON for WS_IN to help debug correlation issues
  if (stage === 'WS_IN') {
    console.log(`[UI_TRACE] WS_IN RAW JSON:`, JSON.stringify(msg, null, 2));
  }
}

export function ListenerPage({ sessionCodeProp, onBackToHome }) {
  // Track seen raw messages for invariant checking
  const seenRawInFpsRef = useRef(new Set());

  // Out-of-order partial prevention: track last seqId per sourceSeqId
  const lastPartialSeqBySourceRef = useRef(new Map());

  const [sessionCode, setSessionCode] = useState(sessionCodeProp || '');
  const [isJoined, setIsJoined] = useState(false);
  const [userName, setUserName] = useState('');
  const [targetLang, setTargetLang] = useState('es');
  const targetLangRef = useRef('es'); // Ref to avoid closure issues in WebSocket handler

  // Keep ref in sync with state
  useEffect(() => {
    targetLangRef.current = targetLang;
  }, [targetLang]);
  const [connectionState, setConnectionState] = useState('disconnected');
  const [translations, setTranslations] = useState([]);
  const [currentTranslation, setCurrentTranslation] = useState(''); // Live partial translation
  const [currentOriginal, setCurrentOriginal] = useState(''); // Live partial original text
  const [isTranslationStalled, setIsTranslationStalled] = useState(false); // Track if translation is stalled
  const [sessionInfo, setSessionInfo] = useState(null);
  const [error, setError] = useState('');
  const [isJoining, setIsJoining] = useState(false);

  const wsRef = useRef(null);
  const translationsEndRef = useRef(null);
  const ttsControllerRef = useRef(null); // TTS controller for audio playback

  // Commit counter for tracing leaked rows
  const commitCounterRef = useRef(0);
  const nextCommitId = () => ++commitCounterRef.current;

  // Throttling refs for partial rendering (10-15 fps)
  const lastRenderTimeRef = useRef(0);
  const lastTextLengthRef = useRef(0);

  // TRANSLATION STALL DETECTION: Track when source partials arrive vs when translations arrive
  const lastSourcePartialTimeRef = useRef(null);
  const lastTranslationTimeRef = useRef(null);
  const translationStallCheckIntervalRef = useRef(null);

  // Cache for original text correlation
  const lastNonEmptyOriginalRef = useRef('');
  const originalBySeqIdRef = useRef(new Map());
  const lastStableKeyRef = useRef(null); // last seen (sourceSeqId ?? seqId)
  const lastWasPartialRef = useRef(false);

  // Helper to cache original text with seqId correlation
  const cacheOriginal = (text, seqId) => {
    const t = (text || '').trim();
    if (!t) return;
    lastNonEmptyOriginalRef.current = t;
    if (seqId !== undefined && seqId !== null && seqId !== -1) {
      originalBySeqIdRef.current.set(seqId, t);
      // Avoid unbounded growth - keep last 200 entries
      if (originalBySeqIdRef.current.size > 200) {
        const firstKey = originalBySeqIdRef.current.keys().next().value;
        originalBySeqIdRef.current.delete(firstKey);
      }
    }
  };

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
        const joinedText = flushedSentences.join(' ').trim();
        if (lastWasPartialRef?.current) return; // 🚫 don't TIME-FLUSH into history while stream is partial
        if (joinedText) {
          // Schedule flush for next tick to allow browser paint between flushes
          setTimeout(() => {
            flushSync(() => {
              setTranslations(prev => {
                // ✅ Fill original for auto-segmented rows using stable correlation key
                const key = lastStableKeyRef.current;
                const cachedOriginal =
                  (key !== null && key !== undefined)
                    ? originalBySeqIdRef.current.get(key)
                    : undefined;

                const safeOriginal = (cachedOriginal || lastNonEmptyOriginalRef.current || '').trim();

                const newItem = {
                  original: safeOriginal,   // ✅ was '' (this caused Spanish-only rows)
                  translated: joinedText,
                  timestamp: Date.now(),
                  seqId: -1,
                  isSegmented: true,
                  isPartial: lastWasPartialRef.current
                };

                // CRITICAL: Insert in correct position based on timestamp (sequenceId is -1 for auto-segmented)
                const newHistory = [...prev, newItem].sort((a, b) => {
                  if (a.seqId !== undefined && b.seqId !== undefined && a.seqId !== -1 && b.seqId !== -1) {
                    return a.seqId - b.seqId;
                  }
                  return (a.timestamp || 0) - (b.timestamp || 0);
                });

                // LOG ONLY THE NEW/CHANGED ROW(S)
                const added = newHistory.length - prev.length;
                if (added > 0) {
                  const last = newHistory[newHistory.length - 1];
                  console.log('[COMMIT]', {
                    page: 'LISTENER',
                    path: 'SEGMENTER_ONFLUSH',
                    added,
                    last: {
                      seqId: last.seqId,
                      sourceSeqId: last.sourceSeqId,
                      isSegmented: last.isSegmented,
                      isPartial: last.isPartial,
                      o: (last.original || '').slice(0, 140),
                      t: (last.translated || '').slice(0, 140),
                    }
                  });
                } else {
                  // also log replaces where length unchanged but last row text changed
                  const pLast = prev[prev.length - 1];
                  const nLast = newHistory[newHistory.length - 1];
                  if (pLast && nLast && (pLast.original !== nLast.original || pLast.translated !== nLast.translated)) {
                    console.log('[COMMIT]', {
                      page: 'LISTENER',
                      path: 'REPLACE',
                      prevLast: { seqId: pLast.seqId, o: (pLast.original || '').slice(0, 120), t: (pLast.translated || '').slice(0, 120) },
                      nextLast: { seqId: nLast.seqId, o: (nLast.original || '').slice(0, 120), t: (nLast.translated || '').slice(0, 120) },
                    });
                  }
                }

                // COMMIT filter print for history commits only
                const last = newHistory[newHistory.length - 1];
                const blob = `${last?.original || ''} ${last?.translated || ''}`;
                if (blob.includes('Own self-centered desires cordoned') || blob.includes('Centered desires cordoned')) {
                  console.log('[LISTENER_COMMIT_MATCH]', {
                    path: 'SEGMENTER_ONFLUSH',
                    last: {
                      seqId: last.seqId,
                      sourceSeqId: last.sourceSeqId,
                      isPartial: last.isPartial,
                      isSegmented: last.isSegmented,
                      original: (last.original || '').slice(0, 220),
                      translated: (last.translated || '').slice(0, 220),
                    }
                  });
                }

                return newHistory;
              });
            });


            // Removed flush logging - reduces console noise
          }, 0);
        }
      }
    });
  }

  // Auto-scroll to latest translation
  useEffect(() => {
    translationsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [translations]);

  // TRANSLATION STALL DETECTION: Check periodically if source partials arrive but translations don't
  useEffect(() => {
    if (!isJoined || connectionState !== 'open') {
      return;
    }

    const checkStall = () => {
      const now = Date.now();
      const timeSinceLastSourcePartial = lastSourcePartialTimeRef.current ? (now - lastSourcePartialTimeRef.current) : Infinity;
      const timeSinceLastTranslation = lastTranslationTimeRef.current ? (now - lastTranslationTimeRef.current) : Infinity;

      // Check if source partials are flowing but translations stopped for >1s
      const sourcePartialsFlowing = timeSinceLastSourcePartial < 2000; // Source partials within last 2 seconds
      const translationsStopped = timeSinceLastTranslation > 1000; // No translations for >1s

      // Only show stall if we've received at least one translation before (to avoid false positives on startup)
      const hasReceivedTranslationBefore = lastTranslationTimeRef.current !== null;

      if (sourcePartialsFlowing && translationsStopped && hasReceivedTranslationBefore && currentOriginal) {
        setIsTranslationStalled(true);
      } else {
        setIsTranslationStalled(false);
      }
    };

    // Check every 500ms
    translationStallCheckIntervalRef.current = setInterval(checkStall, 500);

    return () => {
      if (translationStallCheckIntervalRef.current) {
        clearInterval(translationStallCheckIntervalRef.current);
        translationStallCheckIntervalRef.current = null;
      }
    };
  }, [isJoined, connectionState, currentOriginal]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (translationStallCheckIntervalRef.current) {
        clearInterval(translationStallCheckIntervalRef.current);
      }
    };
  }, []);

  // Initialize TTS Controller once
  useEffect(() => {
    if (TTS_UI_ENABLED && !ttsControllerRef.current) {
      console.log('[ListenerPage] Initializing stable TTS controller');
      ttsControllerRef.current = new TtsPlayerController((msg) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify(msg));
        }
      });
    }

    return () => {
      if (ttsControllerRef.current) {
        console.log('[ListenerPage] Disposing stable TTS controller on cleanup');
        ttsControllerRef.current.dispose();
        ttsControllerRef.current = null;
      }
    };
  }, []);

  const handleJoinSession = async () => {
    if (!sessionCode.trim()) {
      setError('Please enter a session code');
      return;
    }

    setIsJoining(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/session/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionCode: sessionCode.toUpperCase(),
          targetLang: targetLang,
          userName: userName || 'Anonymous'
        })
      });

      const data = await response.json();

      if (data.success) {
        setSessionInfo(data);
        setIsJoined(true);

        // Connect WebSocket
        connectWebSocket(data.sessionId, targetLang, userName || 'Anonymous');
      } else {
        setError(data.error || 'Failed to join session');
      }
    } catch (err) {
      console.error('Failed to join session:', err);
      setError('Failed to join session. Please check your connection.');
    } finally {
      setIsJoining(false);
    }
  };

  const connectWebSocket = (sessionId, lang, name) => {
    const websocketUrl = WS_URL;
    const finalWsUrl = (websocketUrl.endsWith('/translate') || websocketUrl.endsWith('/translate/'))
      ? websocketUrl
      : (websocketUrl.endsWith('/') ? `${websocketUrl}translate` : `${websocketUrl}/translate`);

    const ws = new WebSocket(
      `${finalWsUrl}?role=listener&sessionId=${sessionId}&targetLang=${lang}&userName=${encodeURIComponent(name)}`
    );

    ws.onopen = () => {
      console.log('[Listener] WebSocket connected');
      setConnectionState('open');
    };

    ws.onclose = () => {
      console.log('[Listener] WebSocket disconnected');
      setConnectionState('closed');
      setError('Disconnected from session');
    };

    ws.onerror = (error) => {
      console.error('[Listener] WebSocket error:', error);
      setConnectionState('error');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        // Track last stable key for onFlush correlation
        lastStableKeyRef.current = (message.sourceSeqId ?? message.seqId ?? null);

        // Track if last message was partial for flush guard
        lastWasPartialRef.current = !!message.isPartial;

        // TRACE: Log WebSocket message received
        traceUI('WS_IN', message);

        // RAW_IN logging: canonical ingestion truth for ghost bug debugging
        console.log('[RAW_IN]', {
          page: 'LISTENER',
          type: message.type,
          updateType: message.updateType,
          seqId: message.seqId,
          sourceSeqId: message.sourceSeqId,
          isPartial: message.isPartial,
          forceFinal: message.forceFinal,
          hasTranslation: message.hasTranslation,
          hasCorrection: message.hasCorrection,
          o: (message.originalText || '').slice(0, 120),
          c: (message.correctedText || '').slice(0, 120),
          t: (message.translatedText || '').slice(0, 120),
          correctedText: message.correctedText,
          translatedText: message.translatedText,
        });

        // RAW_IN filter print for the exact escaped phrase
        const s = `${message?.originalText || ''} ${message?.translatedText || ''} ${message?.correctedText || ''}`;
        if (s.includes('Own self-centered desires cordoned') || s.includes('Centered desires cordoned')) {
          console.log('[LISTENER_RAW_IN_MATCH]', {
            seqId: message.seqId,
            sourceSeqId: message.sourceSeqId,
            isPartial: message.isPartial,
            forceFinal: message.forceFinal,
            targetLang: message.targetLang,
            o: (message.originalText || '').slice(0, 180),
            t: (message.translatedText || '').slice(0, 180),
          });
        }

        // Track seen fingerprints for invariant checking
        if (message.translatedText) {
          seenRawInFpsRef.current.add(fp(message.translatedText));
        }
        if (message.originalText) {
          seenRawInFpsRef.current.add(fp(message.originalText));
        }

        // A) LISTENER_IN logging: how listener receives messages
        console.log('[LISTENER_IN]', {
          seqId: message.seqId,
          sourceSeqId: message.sourceSeqId,
          hasTranslation: message.hasTranslation,
          isPartial: message.isPartial,
          originalPreview: (message.originalText || '').slice(0, 50),
          translatedPreview: (message.translatedText || '').slice(0, 50),
        });

        // BUG DETECTION: Check for translation messages missing originalText
        if (
          message?.type === 'translation' &&
          message?.hasTranslation === true &&
          (!message.originalText || message.originalText.trim() === '') &&
          (message.translatedText && message.translatedText.trim().length > 0)
        ) {
          console.warn('[BUG] Translation message missing originalText', {
            seqId: message.seqId,
            targetLang: message.targetLang,
            sourceLang: message.sourceLang,
            pipeline: message.pipeline,
            recoveryEpoch: message.recoveryEpoch,
            translatedPreview: message.translatedText.slice(0, 50)
          });
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
          case 'session_joined':
            console.log('[Listener] Joined session:', message.sessionCode);
            break;

          case 'TRANSCRIPT_PARTIAL':
            // English source transcript partial - update original text for ALL listeners
            if (message.isPartial) {
              const correctedText = message.correctedText;
              const originalText = message.originalText || '';
              const textToDisplay = correctedText && correctedText.trim() ? correctedText : originalText;

              if (textToDisplay) {
                // TRANSLATION STALL DETECTION: Track when source partials arrive
                lastSourcePartialTimeRef.current = Date.now();

                // Removed partial logging - was causing event loop lag
                setCurrentOriginal(textToDisplay);
                cacheOriginal(textToDisplay, message.sourceSeqId ?? message.seqId);
              }
            }
            break;

          case 'TRANSLATION_PARTIAL':
            // Translation partial - update translation text only if targetLang matches
            if (message.isPartial) {
              // Cache original text if present in message
              const originalText = message.originalText || '';
              const correctedText = message.correctedText;
              const originalToCache = correctedText && correctedText.trim() ? correctedText : originalText;
              if (originalToCache && originalToCache.trim()) {
                cacheOriginal(originalToCache, message.sourceSeqId ?? message.seqId);
              }

              const translatedText = message.translatedText || '';
              const isForMyLanguage = message.targetLang === targetLangRef.current;

              // TRANSLATION STALL DETECTION: Track when translations arrive for my language
              if (isForMyLanguage) {
                lastTranslationTimeRef.current = Date.now();
              }

              if (isForMyLanguage && translatedText.trim()) {
                // Process translated text through segmenter (auto-flushes complete sentences)
                const { liveText } = segmenterRef.current.processPartial(translatedText);

                // THROTTLING: Limit render frequency to ~10-15 fps (66-100ms) to prevent UI freezes
                const THROTTLE_MS = 66; // ~15 fps
                const MIN_CHAR_DELTA = 3; // Minimum character growth to trigger render
                const now = Date.now();
                const timeSinceLastRender = now - lastRenderTimeRef.current;
                const charDelta = liveText.length - lastTextLengthRef.current;

                // CRITICAL: Always render first partial after reset (when lastRenderTimeRef is 0)
                // This ensures immediate display when new segment starts
                const isFirstPartialAfterReset = lastRenderTimeRef.current === 0;

                // Always render if significant text growth or enough time passed
                const shouldRender =
                  isFirstPartialAfterReset || // Always render first partial after reset
                  charDelta >= MIN_CHAR_DELTA || // Significant text growth
                  timeSinceLastRender >= THROTTLE_MS; // Enough time passed

                if (shouldRender) {
                  lastRenderTimeRef.current = now;
                  lastTextLengthRef.current = liveText.length;
                  // CRITICAL: Use flushSync for partial updates to ensure immediate responsiveness
                  // Throttling limits frequency, but when we DO update, make it immediate
                  flushSync(() => {
                    setCurrentTranslation(liveText);
                  });
                }
              }
            }
            break;

          case 'TRANSCRIPT_FINAL': {
            // English source transcript final - update original text history
            const originalText = message.originalText || '';
            const correctedOriginalText = message.correctedText || originalText;

            if (correctedOriginalText) {
              // Removed final transcript logging - reduces console noise

              // Update current original to show the final
              setCurrentOriginal(correctedOriginalText);
              cacheOriginal(correctedOriginalText, message.sourceSeqId ?? message.seqId);

              // Add to translations history (as original text entry)
              setTranslations(prev => {
                const recentEntries = prev.slice(-3);
                const isDuplicate = recentEntries.some(entry =>
                  entry.text === correctedOriginalText ||
                  entry.originalText === correctedOriginalText
                );
                if (isDuplicate) {
                  // Removed duplicate logging - reduces console noise
                  return prev;
                }
                // B) LISTENER_ROW_KEY logging: how rows are keyed
                const rowKey = message.sourceSeqId ?? message.seqId ?? 'none';
                console.log('[LISTENER_ROW_KEY]', { rowKey, seqId: message.seqId, sourceSeqId: message.sourceSeqId });

                const next = [...prev, {
                  text: correctedOriginalText,
                  originalText: correctedOriginalText,
                  timestamp: message.timestamp || Date.now(),
                  isTranscription: true
                }];

                // LOG ONLY THE NEW/CHANGED ROW(S)
                const added = next.length - prev.length;
                if (added > 0) {
                  const last = next[next.length - 1];
                  console.log('[COMMIT]', {
                    page: 'LISTENER',
                    path: 'TRANSCRIPT_FINAL',
                    added,
                    last: {
                      seqId: last.seqId,
                      sourceSeqId: last.sourceSeqId,
                      isSegmented: last.isSegmented,
                      isPartial: last.isPartial,
                      o: (last.original || last.originalText || '').slice(0, 140),
                      t: (last.translated || last.text || '').slice(0, 140),
                    }
                  });
                }

                return next;
              });
            }
            break;
          }

          case 'TRANSLATION_FINAL': {
            // Translation final - add to history only if targetLang matches
            const finalText = message.translatedText || undefined;
            const finalOriginalText = message.originalText || '';
            const finalCorrectedOriginalText = message.correctedText || finalOriginalText;
            const isForMyLanguageFinal = message.targetLang === targetLangRef.current;

            // Cache original text if available
            cacheOriginal(finalCorrectedOriginalText, message.sourceSeqId ?? message.seqId);

            if (isForMyLanguageFinal && finalText) {
              // Removed final translation logging - reduces console noise

              // CRITICAL: Use flushSync for final updates to ensure immediate UI feedback
              flushSync(() => {
                // Update current translation to show the final
                setCurrentTranslation(finalText);

                // Add to translations history
                setTranslations(prev => {
                  const recentEntries = prev.slice(-3);
                  const isDuplicate = recentEntries.some(entry =>
                    entry.text === finalText ||
                    entry.translatedText === finalText
                  );
                  if (isDuplicate) {
                    console.log('[ListenerPage] ⏭️ Skipping duplicate final translation');
                    return prev;
                  }

                  // Use fallback if original text is missing
                  const cachedFromSeqId = message.seqId !== undefined ? originalBySeqIdRef.current.get(message.seqId) : undefined;
                  const fallbackOriginal = cachedFromSeqId || lastNonEmptyOriginalRef.current || '';

                  const safeOriginal = finalCorrectedOriginalText && finalCorrectedOriginalText.trim()
                    ? finalCorrectedOriginalText.trim()
                    : fallbackOriginal;

                  // Diagnostic logging: log correlation info if original was missing
                  if (!finalCorrectedOriginalText || !finalCorrectedOriginalText.trim()) {
                    console.log(`[ListenerPage] 🔗 Filled missing original: seqId=${message.seqId}, cachedFromSeqId=${!!cachedFromSeqId}, fallbackLen=${fallbackOriginal.length}, safeOriginalLen=${safeOriginal.length}`);
                  }

                  const newEntry = {
                    text: finalText,
                    originalText: safeOriginal,
                    translatedText: finalText,
                    timestamp: message.timestamp || Date.now(),
                    hasTranslation: true
                  };

                  // B) LISTENER_ROW_KEY logging: how rows are keyed
                  const rowKey = message.sourceSeqId ?? message.seqId ?? 'none';
                  console.log('[LISTENER_ROW_KEY]', { rowKey, seqId: message.seqId, sourceSeqId: message.sourceSeqId });

                  const next = [...prev, newEntry];

                  // LOG ONLY THE NEW/CHANGED ROW(S)
                  const added = next.length - prev.length;
                  if (added > 0) {
                    const last = next[next.length - 1];
                    console.log('[COMMIT]', {
                      page: 'LISTENER',
                      path: 'FINAL_HANDLER',
                      added,
                      last: {
                        seqId: last.seqId,
                        sourceSeqId: last.sourceSeqId,
                        isSegmented: last.isSegmented,
                        isPartial: last.isPartial,
                        o: (last.original || last.originalText || '').slice(0, 140),
                        t: (last.translated || last.translatedText || last.text || '').slice(0, 140),
                      }
                    });
                  }

                  // COMMIT filter print for history commits only
                  const last = next[next.length - 1];
                  const blob = `${last?.original || last?.originalText || ''} ${last?.translated || last?.translatedText || last?.text || ''}`;
                  if (blob.includes('Own self-centered desires cordoned') || blob.includes('Centered desires cordoned')) {
                    console.log('[LISTENER_COMMIT_MATCH]', {
                      path: 'FINAL_HANDLER',
                      last: {
                        seqId: last.seqId,
                        sourceSeqId: last.sourceSeqId,
                        isPartial: last.isPartial,
                        isSegmented: last.isSegmented,
                        original: (last.original || last.originalText || '').slice(0, 220),
                        translated: (last.translated || last.translatedText || last.text || '').slice(0, 220),
                      }
                    });
                  }

                  // Post-commit invariant checker: detect suspicious rows that appeared without RAW_IN
                  const suspicious = newEntry.translated ? [newEntry].filter(it => it?.translated && !seenRawInFpsRef.current.has(fp(it.translated))) : [];
                  if (suspicious.length) {
                    console.log('[SUSPICIOUS_COMMIT_ROWS]', {
                      path: 'FINAL_HANDLER',
                      suspicious: suspicious.map(it => ({
                        translated: it.translated,
                        fp: fp(it.translated),
                        seqId: it.seqId,
                        sourceSeqId: it.sourceSeqId,
                        isSegmented: it.isSegmented
                      }))
                    });
                  }

                  return next;
                });
              });

              // Radio Mode: Auto-enqueue finalized segment for TTS
              if (ttsControllerRef.current &&
                ttsControllerRef.current.getState().state === 'PLAYING' &&
                isForMyLanguageFinal &&
                finalText) {
                ttsControllerRef.current.onFinalSegment({
                  id: message.seqId || `seg_${Date.now()}`,
                  text: finalText,
                  timestamp: message.timestamp || Date.now()
                });
              }

              // CRITICAL: Reset throttling refs so new partials can immediately update after final
              // Without this, throttling might skip the first partials of the new segment
              lastRenderTimeRef.current = 0;
              lastTextLengthRef.current = 0;

              // Reset segmenter to clear any buffered partial text for new segment
              if (segmenterRef.current) {
                segmenterRef.current.reset();
              }
            }
            break;
          }

          case 'translation':
            console.log('[LISTENER_CASE_TRANSLATION]', { type: message.type, isPartial: message.isPartial });
            // ✨ REAL-TIME STREAMING: Sentence segmented, immediate display
            if (message.isPartial) {
              // Use correctedText if available, otherwise use originalText (raw STT)
              const correctedText = message.correctedText;
              const originalText = message.originalText || '';
              const textToDisplay = correctedText && correctedText.trim() ? correctedText : originalText;

              // ROBUST: Treat translatedText presence as valid translation signal even if hasTranslation flag is missing
              const hasTranslatedText = typeof message.translatedText === 'string' && message.translatedText.trim().length > 0;
              const hasTranslationFlag = message.hasTranslation === true || hasTranslatedText;
              const translatedText = hasTranslationFlag ? (message.translatedText || undefined) : undefined;

              // Always update original text immediately (transcription, then corrected when available)
              if (textToDisplay) {
                // Removed partial logging - was causing event loop lag
                setCurrentOriginal(textToDisplay);
                cacheOriginal(textToDisplay, message.sourceSeqId ?? message.seqId);
              }

              // Only update translation if this message is actually intended for this listener's language
              // Check if: 1) It has a real translation (hasTranslation flag or translatedText exists), AND
              //           2) The message target language matches the listener's target language
              const isForMyLanguage = hasTranslationFlag && message.targetLang === targetLangRef.current;

              // TRANSLATION STALL DETECTION: Track when source partials arrive (msgTarget=en)
              if (message.targetLang && message.targetLang !== targetLangRef.current && message.originalText) {
                lastSourcePartialTimeRef.current = Date.now();
              }

              // TRANSLATION STALL DETECTION: Track when translations arrive for my language
              if (isForMyLanguage) {
                lastTranslationTimeRef.current = Date.now();
              }

              // Special case: If listener wants same language as source (transcription only)
              const isTranscriptionMode = targetLangRef.current === message.sourceLang;

              const shouldUpdateTranslation = isForMyLanguage || isTranscriptionMode;

              // DEBUG: Log decision logic
              console.log('[LISTENER_DECISION]', {
                listenerTargetLang: targetLangRef.current,
                messageTargetLang: message.targetLang,
                messageSourceLang: message.sourceLang,
                hasTranslationFlag,
                hasTranslatedText,
                isForMyLanguage,
                isTranscriptionMode,
                shouldUpdateTranslation,
                messageType: message.type,
                isPartial: message.isPartial
              });

              // TRACE: Log decision logic
              const isXlatePartial = message.type === 'PARTIAL' && message.isPartial && hasTranslationFlag;
              traceUI('DECIDE', message, {
                myTarget: targetLangRef.current,
                msgTarget: message.targetLang,
                isXlatePartial,
                shouldApply: shouldUpdateTranslation && isXlatePartial
              });

              // Removed partial logging - was causing event loop lag with high-frequency partials

              if (shouldUpdateTranslation) {
                // TRACE: Log apply
                traceUI('APPLY', message);

                // DEBUG: Log translation processing
                console.log('[LISTENER_TRANSLATION_PROCESSING]', {
                  targetLang: targetLang,
                  messageTargetLang: message.targetLang,
                  isForMyLanguage,
                  isTranscriptionMode,
                  shouldUpdateTranslation,
                  hasTranslatedText: !!translatedText,
                  translatedText: translatedText?.substring(0, 50)
                });

                // OPTIMIZATION: For transcription mode (same language), use correctedText if available
                // For translation mode, use translatedText; for transcription mode, use correctedText or originalText
                let textToDisplay = isTranscriptionMode
                  ? (correctedText && correctedText.trim() ? correctedText : originalText)
                  : translatedText;

                // Process translated text through segmenter (auto-flushes complete sentences)
                const { liveText } = segmenterRef.current.processPartial(textToDisplay);

                // THROTTLING: Limit render frequency to ~10-15 fps (66-100ms) to prevent UI freezes
                // Coalesce updates: only re-render if significant change or enough time passed
                const THROTTLE_MS = 66; // ~15 fps
                const MIN_CHAR_DELTA = 3; // Minimum character growth to trigger render
                const now = Date.now();
                const timeSinceLastRender = now - lastRenderTimeRef.current;
                const charDelta = liveText.length - lastTextLengthRef.current;

                // CRITICAL: Always render first partial after reset (when lastRenderTimeRef is 0)
                // This ensures immediate display when new segment starts
                const isFirstPartialAfterReset = lastRenderTimeRef.current === 0;

                // Always render finals, or if significant text growth, or if enough time passed
                const shouldRender =
                  message.isPartial === false || // Always render finals
                  isFirstPartialAfterReset || // Always render first partial after reset
                  charDelta >= MIN_CHAR_DELTA || // Significant text growth
                  timeSinceLastRender >= THROTTLE_MS; // Enough time passed

                if (shouldRender) {
                  console.log('[LISTENER_RENDER_TRIGGER]', {
                    liveText: liveText.substring(0, 50),
                    shouldRender,
                    charDelta,
                    timeSinceLastRender,
                    isFirstPartialAfterReset
                  });
                  lastRenderTimeRef.current = now;
                  lastTextLengthRef.current = liveText.length;
                  // CRITICAL: Use flushSync for partial updates to ensure immediate responsiveness
                  // Throttling limits frequency, but when we DO update, make it immediate
                  flushSync(() => {
                    console.log('[LISTENER_UI_UPDATE]', { liveText: liveText.substring(0, 30) });
                    setCurrentTranslation(liveText);
                  });
                }
              }
            } else {
              // Lock finals to prevent partial overwrites
              if (!message?.isPartial && message?.sourceSeqId != null && message?.seqId != null) {
                lastPartialSeqBySourceRef.current.set(message.sourceSeqId, Number.MAX_SAFE_INTEGER);
              }

              // Final translation - add to history directly (no segmenter needed for finals)
              // CRITICAL: Only use translatedText if hasTranslation is true - never fallback to English
              const finalText = message.hasTranslation ? (message.translatedText || undefined) : undefined;
              const originalText = message.originalText || '';
              // CRITICAL: Use correctedText for original display (grammar corrections)
              const correctedOriginalText = message.correctedText || originalText;

              // ✅ Use stable correlation key for caching (sourceSeqId for translations)
              const stableKey = (message.sourceSeqId ?? message.seqId);

              // Cache original text if available (keyed by stableKey)
              cacheOriginal(correctedOriginalText, stableKey);

              // CRITICAL: Check if this final is for this listener's target language
              const isForMyLanguage = message.hasTranslation && message.targetLang === targetLangRef.current;
              const isTranscriptionMode = targetLangRef.current === message.sourceLang;

              // DEBUG: Log final translation decision
              console.log('[LISTENER_FINAL_DECISION]', {
                listenerTargetLang: targetLangRef.current,
                messageTargetLang: message.targetLang,
                messageSourceLang: message.sourceLang,
                isForMyLanguage,
                isTranscriptionMode,
                hasTranslation: message.hasTranslation,
                finalText: message.translatedText?.substring(0, 30),
                isPartial: message.isPartial
              });

              // Skip if not for this listener's language and not transcription mode
              if (!isForMyLanguage && !isTranscriptionMode) {
                console.log('[LISTENER_FINAL_SKIP]', {
                  reason: 'not for this language',
                  listenerLang: targetLangRef.current,
                  messageLang: message.targetLang
                });
                return;
              }

              // Skip if no translation and not transcription mode
              if (!finalText && !isTranscriptionMode) {
                console.warn('[ListenerPage] ⚠️ Final received without translation, skipping (not transcription mode)');
                return;
              }

              // Use translatedText if available, otherwise use correctedText/originalText for transcription mode
              const textToDisplay = finalText || (isTranscriptionMode ? correctedOriginalText : undefined);

              if (!textToDisplay) {
                console.warn('[ListenerPage] ⚠️ Final received with no displayable text, skipping');
                return;
              }

              // Removed final logging - reduces console noise

              // CRITICAL: Use flushSync for final updates to ensure immediate UI feedback
              // This prevents flicker when clearing currentTranslation right after adding to history
              flushSync(() => {
                console.log('[LISTENER_FINAL_ADD_TO_HISTORY]', {
                  text: textToDisplay?.substring(0, 50),
                  targetLang: message.targetLang,
                  isTranscriptionMode
                });
                // Deduplicate: Check if this exact text was already added recently
                setTranslations(prev => {
                  // Check last 3 entries for duplicates
                  const recentEntries = prev.slice(-3);
                  const isDuplicate = recentEntries.some(entry =>
                    entry.translated === textToDisplay ||
                    (entry.original === correctedOriginalText && correctedOriginalText.length > 0)
                  );

                  if (isDuplicate) {
                    // Removed duplicate logging - reduces console noise
                    return prev;
                  }

                  const stableKey = (message.sourceSeqId ?? message.seqId);
                  const cachedFromKey = (stableKey !== undefined && stableKey !== null)
                    ? originalBySeqIdRef.current.get(stableKey)
                    : undefined;

                  const fallbackOriginal = cachedFromKey || lastNonEmptyOriginalRef.current || '';

                  const safeOriginal = correctedOriginalText && correctedOriginalText.trim()
                    ? correctedOriginalText.trim()
                    : fallbackOriginal;

                  // CRITICAL INVARIANT: Never render blank "Original:" if backend sent originalText
                  const msgOriginal = (message.originalText || '').trim();
                  const safeOriginalFinal = msgOriginal || safeOriginal;

                  // Diagnostic logging: log correlation info if original was missing
                  if (!correctedOriginalText || !correctedOriginalText.trim()) {
                    console.log(`[ListenerPage] 🔗 Filled missing original: seqId=${message.seqId}, cachedFromSeqId=${!!cachedFromKey}, fallbackLen=${fallbackOriginal.length}, safeOriginalLen=${safeOriginalFinal.length}`);
                  }

                  const newEntry = {
                    original: safeOriginalFinal, // Use safeOriginalFinal to guarantee non-blank originals
                    translated: textToDisplay,
                    timestamp: message.timestamp || Date.now(),
                    // ✅ critical: give the UI a stable ordering key
                    seqId: (message.sourceSeqId ?? message.seqId),
                    sourceSeqId: message.sourceSeqId
                  };

                  // B) LISTENER_ROW_KEY logging: how rows are keyed
                  const rowKey = message.sourceSeqId ?? message.seqId ?? 'none';
                  console.log('[LISTENER_ROW_KEY]', { rowKey, seqId: message.seqId, sourceSeqId: message.sourceSeqId });

                  const next = [...prev, newEntry].slice(-50);

                  // LOG ONLY THE NEW/CHANGED ROW(S)
                  const added = next.length - prev.length;
                  if (added > 0) {
                    const last = next[next.length - 1];
                    console.log('[COMMIT]', {
                      page: 'LISTENER',
                      path: 'PARTIAL_FINAL',
                      added,
                      last: {
                        seqId: last.seqId,
                        sourceSeqId: last.sourceSeqId,
                        isSegmented: last.isSegmented,
                        isPartial: last.isPartial,
                        o: (last.original || '').slice(0, 140),
                        t: (last.translated || '').slice(0, 140),
                      }
                    });
                  }

                  // COMMIT filter print for history commits only
                  const last = next[next.length - 1];
                  const blob = `${last?.original || ''} ${last?.translated || ''}`;
                  if (blob.includes('Own self-centered desires cordoned') || blob.includes('Centered desires cordoned')) {
                    console.log('[LISTENER_COMMIT_MATCH]', {
                      path: 'PARTIAL_FINAL',
                      last: {
                        seqId: last.seqId,
                        sourceSeqId: last.sourceSeqId,
                        isPartial: last.isPartial,
                        isSegmented: last.isSegmented,
                        original: (last.original || '').slice(0, 220),
                        translated: (last.translated || '').slice(0, 220),
                      }
                    });
                  }

                  return next;
                });

                // Radio Mode: Auto-enqueue finalized segment for TTS
                try {
                  if (ttsControllerRef.current &&
                    ttsControllerRef.current.getState().state === 'PLAYING' &&
                    (isForMyLanguage || isTranscriptionMode) &&
                    textToDisplay) {
                    ttsControllerRef.current.onFinalSegment({
                      id: message.seqId || `seg_${Date.now()}`,
                      text: textToDisplay,
                      timestamp: message.timestamp || Date.now()
                    });
                  }
                } catch (ttsErr) {
                  console.error('[ListenerPage] Failed to enqueue TTS segment:', ttsErr);
                  // Swallow error to protect history update flow
                }

                // Clear live displays immediately after adding to history
                setCurrentTranslation('');
                setCurrentOriginal('');
              });

              // Reset segmenter to clear any buffered partial text
              if (segmenterRef.current) {
                segmenterRef.current.reset();
              }

              // CRITICAL: Reset throttling refs so new partials can immediately update after final
              // Without this, throttling might skip the first partials of the new segment
              lastRenderTimeRef.current = 0;
              lastTextLengthRef.current = 0;
            }
            break;

          case 'session_ended':
            setError('The host has ended the session');
            setConnectionState('closed');
            break;

          case 'error':
            console.error('[Listener] Error:', message.message);
            setError(message.message);
            break;

          // TTS messages - route to TTS controller
          case 'tts/audio':
          case 'tts/audio_chunk':
          case 'tts/error':
          case 'tts/ack':
            if (ttsControllerRef.current) {
              ttsControllerRef.current.onWsMessage(message);
            }
            break;

          // Session stats - silence to prevent undefined log noise
          case 'session_stats':
            // Harmless stats message, ignore
            break;

          default:
            console.log('[LISTENER_UNKNOWN_TYPE]', {
              type: message.type,
              isPartial: message.isPartial,
              hasTranslation: message.hasTranslation,
              targetLang: message.targetLang
            });
            break;
        }
      } catch (err) {
        console.error('[Listener] Failed to parse message:', err);
      }
    };

    wsRef.current = ws;
  };

  const handleChangeLanguage = (newLang) => {
    console.log('[LISTENER_LANGUAGE_CHANGE]', { from: targetLangRef.current, to: newLang });
    setTargetLang(newLang);
    targetLangRef.current = newLang; // Update ref immediately for WebSocket handler

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('[LISTENER_SENDING_CHANGE]', { type: 'change_language', targetLang: newLang });
      wsRef.current.send(JSON.stringify({
        type: 'change_language',
        targetLang: newLang
      }));

      // Clear old translations and current text when changing language
      setTranslations([]);
      setCurrentTranslation('');
      setCurrentOriginal('');
    } else {
      console.warn('[LISTENER_WS_NOT_OPEN]', { readyState: wsRef.current?.readyState });
    }
  };

  const handleLeaveSession = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    setIsJoined(false);
    setSessionCode('');
    setTranslations([]);
    setCurrentTranslation('');
    setCurrentOriginal('');
    setConnectionState('disconnected');
  };

  // Join form
  if (!isJoined) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100">
        <Header />

        <div className="container mx-auto px-2 sm:px-4 py-4 sm:py-8">
          <button
            onClick={onBackToHome}
            className="mb-4 px-3 py-2 text-sm sm:text-base text-gray-600 hover:text-gray-800 flex items-center gap-2"
          >
            ← Back to Home
          </button>

          <div className="max-w-md mx-auto bg-white rounded-lg shadow-lg p-4 sm:p-8">
            <h2 className="text-2xl sm:text-3xl font-bold mb-4 sm:mb-6 text-gray-800 text-center">
              Join Translation Session
            </h2>

            {error && (
              <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
                {error}
              </div>
            )}

            <div className="space-y-3 sm:space-y-4">
              {/* Session Code Input */}
              <div>
                <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                  Session Code
                </label>
                <input
                  type="text"
                  value={sessionCode}
                  onChange={(e) => setSessionCode(e.target.value.toUpperCase())}
                  placeholder="Enter 6-digit code"
                  maxLength={6}
                  className="w-full px-3 sm:px-4 py-2 sm:py-3 text-xl sm:text-2xl font-bold text-center tracking-wider border-2 border-gray-300 rounded-lg focus:border-emerald-500 focus:outline-none uppercase"
                />
              </div>

              {/* User Name Input */}
              <div>
                <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                  Your Name (Optional)
                </label>
                <input
                  type="text"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="Anonymous"
                  className="w-full px-3 sm:px-4 py-2 border-2 border-gray-300 rounded-lg focus:border-emerald-500 focus:outline-none text-sm sm:text-base"
                />
              </div>

              {/* Language Selection */}
              <div>
                <LanguageSelector
                  label="Translation Language"
                  languages={LANGUAGES}
                  selectedLanguage={targetLang}
                  onLanguageChange={setTargetLang}
                />
              </div>

              {/* Join Button */}
              <button
                onClick={handleJoinSession}
                disabled={isJoining || !sessionCode.trim()}
                className="w-full px-4 sm:px-6 py-2 sm:py-3 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-300 text-white text-sm sm:text-base font-semibold rounded-lg shadow-lg transition-all transform hover:scale-105 disabled:scale-100"
              >
                {isJoining ? 'Joining...' : 'Join Session'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Listener view (after joining)
  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100">
      <Header />

      <div className="container mx-auto px-2 sm:px-4 py-4 sm:py-8">
        {/* Session Info Bar */}
        <div className="bg-white rounded-lg shadow-lg p-3 sm:p-4 mb-4 sm:mb-6">
          <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3 sm:gap-4">
            <div className="text-center sm:text-left">
              <p className="text-xs sm:text-sm text-gray-600">Session Code:</p>
              <p className="text-xl sm:text-2xl font-bold text-emerald-600">{sessionInfo?.sessionCode}</p>
            </div>

            <div className="flex-1 sm:max-w-xs">
              <LanguageSelector
                label="Your Language"
                languages={LANGUAGES}
                selectedLanguage={targetLang}
                onLanguageChange={handleChangeLanguage}
              />
            </div>

            <div className="flex items-center justify-between sm:flex-col sm:items-end gap-3">
              <ConnectionStatus state={connectionState} />

              <button
                onClick={handleLeaveSession}
                className="px-3 sm:px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm sm:text-base font-semibold rounded-lg transition-all"
              >
                Leave
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
            {error}
          </div>
        )}

        {/* LIVE STREAMING TRANSLATION BOX - Shows both original and translation */}
        <div className="bg-gradient-to-br from-green-500 via-emerald-500 to-teal-600 rounded-lg sm:rounded-2xl p-3 sm:p-6 shadow-2xl mb-4 sm:mb-6 -mx-2 sm:mx-0">
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <div className="flex items-center space-x-2 sm:space-x-3">
              {connectionState === 'open' && (
                <div className="flex space-x-1">
                  <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce"></div>
                  <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '0.15s' }}></div>
                  <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '0.3s' }}></div>
                </div>
              )}
              <span className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider flex items-center gap-1 sm:gap-2">
                {connectionState === 'open' ? (
                  <>
                    <span className="relative flex h-2 w-2 sm:h-2.5 sm:w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 sm:h-2.5 sm:w-2.5 bg-white"></span>
                    </span>
                    <span className="hidden sm:inline">LIVE TRANSLATION</span>
                    <span className="sm:hidden">LIVE</span>
                  </>
                ) : (
                  'CONNECTING...'
                )}
              </span>
            </div>
            {currentTranslation && (
              <button
                onClick={() => navigator.clipboard.writeText(currentTranslation)}
                className="p-1 sm:p-1.5 text-white/80 hover:text-white transition-colors"
                title="Copy live translation"
              >
                📋
              </button>
            )}
          </div>

          {/* Show both original and translation */}
          <div className="space-y-2 sm:space-y-3">
            {/* Original Text from Host */}
            <div className="bg-white/10 backdrop-blur-sm rounded-lg sm:rounded-xl p-2 sm:p-3">
              <div className="text-xs font-semibold text-white/70 uppercase tracking-wide mb-1 sm:mb-2">
                Original (Host)
              </div>
              {currentOriginal ? (
                <p className="text-white text-sm sm:text-base leading-relaxed whitespace-pre-wrap">
                  {currentOriginal}
                  {connectionState === 'open' && (
                    <span className="inline-block w-0.5 h-4 sm:h-5 ml-1 bg-white animate-pulse"></span>
                  )}
                </p>
              ) : (
                <p className="text-white/40 text-xs sm:text-sm italic">Listening for host...</p>
              )}
            </div>

            {/* Translated Text */}
            <div className="bg-white/15 backdrop-blur-sm rounded-lg sm:rounded-xl p-2 sm:p-3 border-2 border-white/20">
              <div className="text-xs font-semibold text-white/70 uppercase tracking-wide mb-1 sm:mb-2 flex items-center gap-2">
                <span>Translation ({targetLang.toUpperCase()})</span>
                {currentTranslation && currentTranslation !== currentOriginal && (
                  <span className="inline-flex items-center gap-1 text-emerald-300">
                    <span className="inline-block w-1 h-1 sm:w-1.5 sm:h-1.5 bg-emerald-300 rounded-full animate-pulse"></span>
                    <span className="text-xs">Live</span>
                  </span>
                )}
              </div>
              {currentTranslation ? (
                <p className="text-white text-base sm:text-lg font-medium leading-relaxed whitespace-pre-wrap">
                  {currentTranslation}
                  {connectionState === 'open' && (
                    <span className="inline-block w-0.5 h-5 sm:h-6 ml-1 bg-emerald-300 animate-pulse"></span>
                  )}
                </p>
              ) : isTranslationStalled && currentOriginal ? (
                <div className="space-y-2">
                  <p className="text-white/70 text-sm sm:text-base leading-relaxed whitespace-pre-wrap italic">
                    {currentOriginal}
                  </p>
                  <p className="text-white/50 text-xs sm:text-sm italic animate-pulse">
                    ⏳ Waiting for translation...
                  </p>
                </div>
              ) : currentOriginal ? (
                <p className="text-white/50 text-xs sm:text-sm italic animate-pulse">Translating...</p>
              ) : (
                <p className="text-white/40 text-xs sm:text-sm italic">Waiting for host to speak...</p>
              )}
            </div>

            <div className="mt-2 text-xs text-white/70 font-medium">
              {currentOriginal && currentTranslation && currentTranslation !== currentOriginal ? (
                <>✨ Live translation updating...</>
              ) : currentOriginal ? (
                <>⏳ Translation in progress...</>
              ) : connectionState === 'open' ? (
                <>🎤 Connected • Waiting for host to speak...</>
              ) : (
                <>Connecting to session...</>
              )}
            </div>
          </div>
        </div>

        {/* TTS Panel - Only shown when feature flag enabled */}
        {TTS_UI_ENABLED && (
          <TtsPanel
            controller={ttsControllerRef.current}
            targetLang={targetLang}
            isConnected={connectionState === 'open'}
            translations={translations}
          />
        )}

        {/* Translation History */}
        <div className="bg-gray-50 rounded-lg sm:rounded-xl p-3 sm:p-5 border-2 border-gray-200 -mx-2 sm:mx-0">
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <h3 className="text-xs sm:text-sm font-semibold text-gray-700 flex items-center gap-1 sm:gap-2">
              <span className="text-green-600">📝</span>
              History
              {translations.length > 0 && (
                <span className="text-xs text-gray-500 font-normal">
                  ({translations.length})
                </span>
              )}
            </h3>
            {translations.length > 0 && (
              <button
                onClick={() => {
                  const content = translations.map(t =>
                    `Original: ${t.original}\nTranslation: ${t.translated}\n---`
                  ).join('\n')
                  const blob = new Blob([content], { type: 'text/plain' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `translation-${new Date().toISOString().split('T')[0]}.txt`
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
            )}
          </div>

          {translations.length === 0 ? (
            <div className="text-center py-8 sm:py-12 text-gray-500">
              <p className="text-base sm:text-lg">No translations yet</p>
              <p className="text-xs sm:text-sm mt-2">Translations will appear here after each phrase</p>
            </div>
          ) : (
            <div className="space-y-2 sm:space-y-3 max-h-80 sm:max-h-96 overflow-y-auto pr-1 sm:pr-2">
              {translations.map((item, index) => (
                <div key={index} className="bg-white rounded-lg p-3 sm:p-4 shadow-sm hover:shadow-md transition-all border border-gray-200">
                  {item.original && (
                    <div className="mb-2 sm:mb-3 pb-2 sm:pb-3 border-b border-gray-100">
                      <div className="flex items-center justify-between mb-1 sm:mb-1.5">
                        <span className="text-xs font-semibold text-blue-600 uppercase">Original</span>
                        <button
                          onClick={() => navigator.clipboard.writeText(item.original)}
                          className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          title="Copy"
                        >
                          📋
                        </button>
                      </div>
                      <p className="text-gray-700 text-sm sm:text-base leading-relaxed">{item.original}</p>
                    </div>
                  )}

                  <div>
                    <div className="flex items-center justify-between mb-1 sm:mb-1.5">
                      <span className="text-xs font-semibold text-green-600 uppercase">Translation</span>
                      <div className="flex items-center space-x-1">
                        <button
                          onClick={() => navigator.clipboard.writeText(item.translated)}
                          className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          title="Copy"
                        >
                          📋
                        </button>
                        <button
                          onClick={() => {
                            const utterance = new SpeechSynthesisUtterance(item.translated)
                            speechSynthesis.speak(utterance)
                          }}
                          className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          title="Speak"
                        >
                          🔊
                        </button>
                      </div>
                    </div>
                    <p className="text-gray-900 text-sm sm:text-base font-medium leading-relaxed">{item.translated}</p>
                  </div>

                  <div className="mt-2 sm:mt-3 pt-2 sm:pt-3 border-t border-gray-100 text-xs text-gray-400 flex items-center justify-between">
                    <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                    <span className="text-gray-300">#{translations.length - index}</span>
                  </div>
                </div>
              ))}
              <div ref={translationsEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

