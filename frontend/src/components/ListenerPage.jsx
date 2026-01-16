/**
 * Listener Page - For audience members to receive live translations
 */

import { useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useImperativePainter } from '../hooks/useImperativePainter';
import { Header } from './Header';
import { ConnectionStatus } from './ConnectionStatus';
import { LanguageSelector } from './LanguageSelector';

import { TtsPlayerController } from '../tts/TtsPlayerController.js';
import { SentenceSegmenter } from '../utils/sentenceSegmenter';
import { TRANSLATION_LANGUAGES } from '../config/languages.js';
import { Play, Square, Settings } from 'lucide-react';
import { TtsSettingsModal } from './TtsSettingsModal';
import { getVoicesForLanguage, normalizeLanguageCode } from '../config/ttsVoices.js';
import { TtsMode, TtsPlayerState } from '../tts/types.js';
import { getDeliveryStyle, voiceSupportsSSML } from '../config/ssmlConfig.js';

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
  const [showOriginal, setShowOriginal] = useState(false); // Toggle for showing original text

  const wsRef = useRef(null);
  const translationsEndRef = useRef(null);

  // DOM refs for imperative partial painting (flicker-free)
  const currentTranslationElRef = useRef(null);
  const currentOriginalElRef = useRef(null);

  // Imperative painters for live partial text (avoids React state churn)
  const { updateText: updateTranslationText, clearText: clearTranslationText } = useImperativePainter(currentTranslationElRef, { shrinkDelayMs: 200 });
  const { updateText: updateOriginalText, clearText: clearOriginalText } = useImperativePainter(currentOriginalElRef, { shrinkDelayMs: 0 }); // No delay for transcription - show last word immediately

  const ttsControllerRef = useRef(null); // TTS controller for audio playback

  // TTS UI State (Lifted from TtsPanel)
  const [ttsState, setTtsState] = useState(TtsPlayerState.STOPPED);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('Kore');
  // Default settings for hidden controls (Kore is Chirp3, so default to 1.1x)
  const [ttsSettings, setTtsSettings] = useState({
    speakingRate: 1.1,
    deliveryStyle: 'standard_preaching',
    ssmlEnabled: true,
    promptPresetId: 'preacher_warm_build',
    intensity: 3,
    pitch: '0st',
    volume: '0dB'
  });

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

  // Auto-scroll to latest translation (bottom of list)
  useEffect(() => {
    translationsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
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

    // Attach listeners to update local state
    if (ttsControllerRef.current) {
      ttsControllerRef.current.onStateChange = (newState) => {
        setTtsState(newState);
      };
      ttsControllerRef.current.onError = (err) => {
        console.error('[ListenerPage] TTS Error:', err);
      };
    }

    return () => {
      if (ttsControllerRef.current) {
        console.log('[ListenerPage] Disposing stable TTS controller on cleanup');
        ttsControllerRef.current.dispose();
        ttsControllerRef.current = null;
      }
    };
  }, []);

  // Sync Voice/Lang Selection with Controller
  useEffect(() => {
    if (!ttsControllerRef.current) return;

    // Update language
    if (targetLang) {
      ttsControllerRef.current.currentLanguageCode = normalizeLanguageCode(targetLang);
    }

    // Update voice
    if (selectedVoice) {
      ttsControllerRef.current.currentVoiceName = selectedVoice;
    }

    // Update settings (SSML/Prompts) - Syncing minimal defaults
    const isGemini = ['Kore', 'Charon', 'Leda', 'Puck', 'Aoede', 'Fenrir', 'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam'].includes(selectedVoice);

    // Sync SSML options
    ttsControllerRef.current.ssmlOptions = {
      enabled: ttsSettings.ssmlEnabled,
      deliveryStyle: ttsSettings.deliveryStyle,
      rate: ttsSettings.speakingRate,
      pitch: '+1st',
      pauseIntensity: getDeliveryStyle(ttsSettings.deliveryStyle).pauseIntensity,
      emphasizePowerWords: true,
      emphasisLevel: 'moderate',
      supportsPhraseProsody: true // Simplified assumption for internal logic preservation
    };

    // Sync Prompt options
    ttsControllerRef.current.promptPresetId = ttsSettings.promptPresetId;
    ttsControllerRef.current.intensity = ttsSettings.intensity;

  }, [targetLang, selectedVoice, ttsSettings]);

  // Ensure selected voice is valid for current language
  useEffect(() => {
    const voices = getVoicesForLanguage(targetLang);
    if (voices.length > 0 && !voices.some(v => v.value === selectedVoice)) {
      setSelectedVoice(voices[0].value);
    }
  }, [targetLang]);

  // Track previous tier to detect tier changes and reset speed accordingly
  const prevTierRef = useRef(null);

  // Reset speed to tier-specific default when tier changes
  useEffect(() => {
    if (!selectedVoice) return;
    const voices = getVoicesForLanguage(targetLang);
    const voiceOption = voices.find(v => v.value === selectedVoice);
    if (voiceOption) {
      const tier = voiceOption.tier || 'standard';

      // Detect tier change
      const tierChanged = prevTierRef.current !== null && prevTierRef.current !== tier;

      // Update previous tier ref
      const isFirstLoad = prevTierRef.current === null;
      prevTierRef.current = tier;

      // Determine tier-specific default speed
      let defaultSpeed = 1.0;
      if (tier === 'gemini') {
        defaultSpeed = 1.45;
      } else if (tier === 'chirp3_hd') {
        defaultSpeed = 1.1;
      } else if (tier === 'neural2' || tier === 'standard') {
        defaultSpeed = 1.0;
      }

      // Reset to tier-specific default when tier changes OR on first load if at 1.0
      if (tierChanged) {
        console.log(`[ListenerPage] Tier changed to ${tier}, resetting speed to ${defaultSpeed}x`);
        setTtsSettings(prev => ({ ...prev, speakingRate: defaultSpeed }));
      } else if (isFirstLoad && ttsSettings.speakingRate === 1.0 && defaultSpeed !== 1.0) {
        console.log(`[ListenerPage] First load with ${tier} tier, setting speed to ${defaultSpeed}x`);
        setTtsSettings(prev => ({ ...prev, speakingRate: defaultSpeed }));
      }
    }
  }, [selectedVoice, targetLang]);

  const handleTtsPlay = () => {
    if (!ttsControllerRef.current) return;
    if (connectionState !== 'open') {
      alert('Not connected to session');
      return;
    }

    const voices = getVoicesForLanguage(targetLang);
    const voiceOption = voices.find(v => v.value === selectedVoice);
    const tier = voiceOption?.tier || 'neural2';
    // Strictly rely on tier - 'Gemini' voices are explicitly marked as tier: 'gemini'
    // Chirp 3 HD voices with the same name (e.g. Kore) will have tier: 'chirp3_hd'
    const isGemini = tier === 'gemini';

    const requestData = {
      languageCode: targetLang,
      voiceName: selectedVoice,
      tier: tier,
      mode: TtsMode.UNARY, // Forced UNARY as requested ("only working mode")
      startFromSegmentId: Date.now(),
      ssmlOptions: {
        enabled: ttsSettings.ssmlEnabled,
        deliveryStyle: ttsSettings.deliveryStyle,
        rate: ttsSettings.speakingRate,
        pitch: ttsSettings.pitch || '0st',
        volume: ttsSettings.volume || '0dB',
        pauseIntensity: getDeliveryStyle(ttsSettings.deliveryStyle).pauseIntensity,
        emphasizePowerWords: true,
        emphasisLevel: 'moderate',
        supportsPhraseProsody: voiceSupportsSSML(selectedVoice, tier)
      }
    };

    // Always include prompt settings - backend/controller will ignore if not applicable
    requestData.promptPresetId = ttsSettings.promptPresetId;
    requestData.intensity = ttsSettings.intensity;

    console.log('[ListenerPage] Starting TTS (Radio UI)', requestData);
    ttsControllerRef.current.start(requestData);
  };

  const handleTtsStop = () => {
    ttsControllerRef.current?.stop();
  };

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

    ws.onclose = () => {
      console.log('[Listener] WebSocket disconnected');
      setConnectionState('closed');

      // Stop TTS playback to clear queue on disconnect
      if (ttsControllerRef.current && ttsControllerRef.current.getState().state === 'PLAYING') {
        console.log('[Listener] Stopping TTS due to WebSocket disconnect');
        ttsControllerRef.current.stop();
      }
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
                // Use imperative painter for flicker-free updates
                updateOriginalText(textToDisplay);
                setCurrentOriginal(textToDisplay); // Keep state for UI conditionals
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

                  // TRANSLATION LANGUAGE GUARD: Skip if translatedText is suspiciously similar to originalText (API misfire)
                  const isSuspiciousEnglish = !isTranscriptionMode && originalText && translatedText &&
                    translatedText.toLowerCase().trim() === originalText.toLowerCase().trim();

                  // REFUSAL FILTER: Skip AI refusal messages (sorry, I can't help, etc.)
                  const lowerText = (translatedText || liveText || '').toLowerCase();
                  const isAIRefusal =
                    lowerText.includes('sorry') ||
                    lowerText.includes('lo siento') ||  // Spanish
                    lowerText.includes('désolé') ||     // French
                    lowerText.includes('desculpe') ||   // Portuguese
                    lowerText.includes("i can't") ||
                    lowerText.includes("i cannot") ||
                    lowerText.includes("no puedo") ||   // Spanish
                    lowerText.includes("je ne peux") || // French
                    lowerText.includes('unfortunately') ||
                    lowerText.includes('lamentablemente');

                  if (isSuspiciousEnglish && targetLangRef.current !== 'en') {
                    console.log('[SKIP_ENGLISH_TRANSLATION]', { translatedText: translatedText?.slice(0, 50) });
                    // Don't update translation display - keep previous content
                  } else if (isAIRefusal) {
                    console.log('[SKIP_AI_REFUSAL]', { text: lowerText.slice(0, 60) });
                    // Don't update translation display - AI is refusing to translate
                  } else {
                    // Use imperative painter for flicker-free updates (replaces flushSync)
                    console.log('[LISTENER_UI_UPDATE]', { liveText: liveText.substring(0, 30) });
                    updateTranslationText(liveText);
                    setCurrentTranslation(liveText); // Keep state for UI conditionals
                  }
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
                      id: (message.sourceSeqId ?? message.seqId ?? `seg_${Date.now()}`).toString(),
                      text: textToDisplay,
                      timestamp: message.timestamp || Date.now()
                    });
                  }
                } catch (ttsErr) {
                  console.error('[ListenerPage] Failed to enqueue TTS segment:', ttsErr);
                  // Swallow error to protect history update flow
                }

                // Clear live displays immediately after adding to history
                clearTranslationText(); // Clear imperative painter
                clearOriginalText();     // Clear imperative painter
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

      <div className="container mx-auto px-2 sm:px-4 py-4 sm:py-8">
        {/* Unified Session Info Bar */}
        <div className="bg-white rounded-lg shadow-lg p-3 sm:p-4 mb-4 sm:mb-6">
          <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3 lg:gap-4">

            {/* Session Code */}
            <div className="flex-shrink-0">
              <p className="text-xs text-gray-600">Session Code:</p>
              <p className="text-lg sm:text-xl font-bold text-emerald-600">{sessionInfo?.sessionCode}</p>
            </div>

            {/* Voice Model */}
            {TTS_UI_ENABLED && (
              <div className="flex-1 lg:max-w-xs">
                <label className="block text-xs text-gray-600 mb-1">Voice Model</label>
                <select
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
                >
                  {Object.entries(
                    getVoicesForLanguage(targetLang).reduce((acc, voice) => {
                      const tier = voice.tier || 'standard';
                      let group = 'Standard';
                      if (tier === 'gemini') group = 'Gemini & Studio';
                      else if (tier === 'chirp3_hd') group = 'Chirp 3 HD';
                      else if (tier === 'neural2') group = 'Neural2';
                      if (!acc[group]) acc[group] = [];
                      acc[group].push(voice);
                      return acc;
                    }, {})
                  ).map(([group, voices]) => (
                    <optgroup key={group} label={group}>
                      {voices.map(v => (
                        <option key={v.value} value={v.value}>{v.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            )}

            {/* Language Selector */}
            <div className="flex-1 lg:max-w-xs">
              <LanguageSelector
                label="Your Language"
                languages={LANGUAGES}
                selectedLanguage={targetLang}
                onLanguageChange={handleChangeLanguage}
              />
            </div>

            {/* Controls: Settings, Play, Connection, Leave */}
            <div className="flex items-center gap-2 lg:ml-auto">
              {/* Settings */}
              {TTS_UI_ENABLED && (
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="p-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-all"
                  title="Settings"
                >
                  <Settings className="w-4 h-4" />
                </button>
              )}

              {/* Play/Stop */}
              {TTS_UI_ENABLED && (
                ttsState === 'PLAYING' ? (
                  <button
                    onClick={handleTtsStop}
                    className="p-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-all"
                    title="Stop"
                  >
                    <Square className="w-4 h-4 fill-current" />
                  </button>
                ) : (
                  <button
                    onClick={handleTtsPlay}
                    disabled={connectionState !== 'open'}
                    className="px-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-all disabled:bg-gray-300 text-sm font-medium"
                    title="Play"
                  >
                    <Play className="w-4 h-4 fill-current inline mr-1" />
                    <span className="hidden sm:inline">Play</span>
                  </button>
                )
              )}

              {/* Connection Status */}
              <ConnectionStatus state={connectionState} />

              {/* Leave Button */}
              <button
                onClick={handleLeaveSession}
                className="px-3 py-2 bg-red-500 hover:bg-red-600 text-white font-semibold rounded-lg transition-all text-sm"
              >
                Leave
              </button>
            </div>

          </div>
        </div>

        {/* Settings Modal */}
        <TtsSettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={ttsSettings}
          onSettingsChange={setTtsSettings}
          selectedVoice={selectedVoice}
          targetLang={targetLang}
        />



        {error && (
          <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
            {error}
          </div>
        )
        }

        {/* Translation History */}
        <div className="bg-gray-50 rounded-lg sm:rounded-xl p-3 sm:p-5 border-2 border-gray-200 -mx-2 sm:mx-0 mb-4 sm:mb-6">
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
                <div
                  key={index}
                  onClick={() => {
                    const updatedTranslations = [...translations];
                    updatedTranslations[index] = { ...item, showOriginal: !item.showOriginal };
                    setTranslations(updatedTranslations);
                  }}
                  className="bg-white rounded-lg p-4 sm:p-5 shadow-sm hover:shadow-md transition-all border border-gray-200 cursor-pointer"
                >
                  {/* Show translation by default, tap to reveal original */}
                  {item.showOriginal && item.original ? (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-blue-600 uppercase">Original (Tap to hide)</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(item.original);
                          }}
                          className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          title="Copy"
                        >
                          📋
                        </button>
                      </div>
                      <p className="text-gray-900 text-lg sm:text-xl md:text-2xl leading-relaxed font-medium">{item.original}</p>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-green-600 uppercase">Translation (Tap to see original)</span>
                        <div className="flex items-center space-x-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(item.translated);
                            }}
                            className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                            title="Copy"
                          >
                            📋
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const utterance = new SpeechSynthesisUtterance(item.translated);
                              speechSynthesis.speak(utterance);
                            }}
                            className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                            title="Listen"
                          >
                            🔊
                          </button>
                        </div>
                      </div>
                      <p className="text-gray-900 text-lg sm:text-xl md:text-2xl leading-relaxed font-medium">{item.translated}</p>
                    </div>
                  )}

                  <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-400 flex items-center justify-between">
                    <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                    <span className="text-gray-300">#{translations.length - index}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div ref={translationsEndRef} />
        </div>

        {/* LIVE TRANSLATION BOX - Shows both original and translation */}
        <div className="bg-gradient-to-br from-green-500 via-emerald-500 to-teal-600 rounded-lg sm:rounded-2xl p-4 sm:p-6 shadow-2xl -mx-2 sm:mx-0">
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <div className="flex items-center space-x-2 sm:space-x-3">
              {connectionState === 'open' && (
                <div className="flex space-x-1">
                  <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce"></div>
                  <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '0.15s' }}></div>
                  <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '0.3s' }}></div>
                </div>
              )}
              <span className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider">
                {connectionState === 'open' ? 'LIVE TRANSLATION' : 'CONNECTING...'}
              </span>
            </div>
          </div>

          {/* Show both original and translation */}
          <div className="space-y-2 sm:space-y-3">
            {/* Original Text from Host */}
            {!showOriginal && (
              <div className="bg-white/10 backdrop-blur-sm rounded-lg sm:rounded-xl p-3 sm:p-4">
                <div className="text-xs font-semibold text-white/70 uppercase tracking-wide mb-2">
                  Original (Host)
                </div>
                {currentOriginal ? (
                  <p ref={currentOriginalElRef} className="text-white text-xl sm:text-2xl md:text-3xl font-medium leading-relaxed live-partial-container" />
                ) : (
                  <p className="text-white/40 text-sm italic">Listening for host...</p>
                )}
              </div>
            )}

            {/* Translated Text */}
            <div className="bg-white/15 backdrop-blur-sm rounded-lg sm:rounded-xl p-3 sm:p-4 border-2 border-white/20">
              <div className="text-xs font-semibold text-white/70 uppercase tracking-wide mb-2 flex items-center gap-2">
                <span>Translation ({targetLang.toUpperCase()})</span>
                {currentTranslation && currentTranslation !== currentOriginal && (
                  <span className="inline-flex items-center gap-1 text-emerald-300">
                    <span className="inline-block w-1 h-1 sm:w-1.5 sm:h-1.5 bg-emerald-300 rounded-full animate-pulse"></span>
                    <span className="text-xs">Live</span>
                  </span>
                )}
              </div>
              {currentTranslation ? (
                <p ref={currentTranslationElRef} className="text-white text-xl sm:text-2xl md:text-3xl font-medium leading-relaxed live-partial-container" />
              ) : isTranslationStalled && currentOriginal ? (
                <div className="space-y-2">
                  <p className="text-white/70 text-base italic">{currentOriginal}</p>
                  <p className="text-white/50 text-sm italic animate-pulse">⏳ Translating...</p>
                </div>
              ) : currentOriginal ? (
                <p className="text-white/50 text-sm italic animate-pulse">Translating...</p>
              ) : (
                <p className="text-white/40 text-sm italic">Waiting for host...</p>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
