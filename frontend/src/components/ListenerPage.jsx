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

import { TRANSLATION_LANGUAGES } from '../config/languages.js';

import { Play, Square, Settings, Volume2 } from 'lucide-react';
import { TtsSettingsModal } from './TtsSettingsModal';
import { TtsMode, TtsPlayerState } from '../tts/types.js';
import { getDeliveryStyle, voiceSupportsSSML } from '../config/ssmlConfig.js';
import { CaptionClientEngine, SentenceSegmenter } from '@jkang1643/caption-engine';
import { useTtsStreaming } from '../hooks/useTtsStreaming';
import TtsStreamingControl from './tts/TtsStreamingControl';

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

// DEBUG: Gate high-frequency logging to prevent event loop blocking
// Set VITE_DEBUG_LISTENER=1 to enable verbose logging for debugging
const DEBUG = import.meta.env.VITE_DEBUG_LISTENER === '1';

// TTS UI feature flag
const TTS_UI_ENABLED = import.meta.env.VITE_TTS_UI_ENABLED === 'true';
if (DEBUG) console.log('[ListenerPage] TTS_UI_ENABLED:', TTS_UI_ENABLED, 'raw env:', import.meta.env.VITE_TTS_UI_ENABLED);

const USE_SHARED_ENGINE = import.meta.env.VITE_USE_SHARED_ENGINE === 'true';
if (DEBUG) console.log('[ListenerPage] USE_SHARED_ENGINE:', USE_SHARED_ENGINE);

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

  // Track which committed lines have been sent to TTS (prevents duplicates)
  const sentToTtsRef = useRef(new Set());

  const [sessionCode, setSessionCode] = useState(sessionCodeProp || '');
  const [isJoined, setIsJoined] = useState(false);
  const [showLiveOriginal, setShowLiveOriginal] = useState(false);
  const [userName, setUserName] = useState('');
  const [targetLang, setTargetLang] = useState('es');
  const targetLangRef = useRef('es'); // Ref to avoid closure issues in WebSocket handler
  const [userPlan, setUserPlan] = useState(null); // Track user plan for voice defaults

  // Sync sessionCodeProp with sessionCode state (for URL parameters)
  useEffect(() => {
    if (sessionCodeProp && sessionCodeProp !== sessionCode) {
      setSessionCode(sessionCodeProp);
    }
  }, [sessionCodeProp]);

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
  const [routingDebug, setRoutingDebug] = useState(null);
  const [isJoining, setIsJoining] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false); // Toggle for showing original text
  // Stable map: item identity key -> boolean, survives setTranslations() replacements
  const showOriginalMapRef = useRef(new Map());
  // Dummy state to force re-render when the map changes
  const [showOriginalVersion, setShowOriginalVersion] = useState(0);

  const wsRef = useRef(null);
  const engineRef = useRef(null); // Shared engine ref

  // DOM refs for imperative partial painting (flicker-free)
  const currentTranslationElRef = useRef(null);
  const currentOriginalElRef = useRef(null);

  // Imperative painters for live partial text (avoids React state churn)
  const { updateText: updateTranslationText, clearText: clearTranslationText } = useImperativePainter(currentTranslationElRef, { shrinkDelayMs: 200 });
  const { updateText: updateOriginalText, clearText: clearOriginalText } = useImperativePainter(currentOriginalElRef, { shrinkDelayMs: 0 }); // No delay for transcription - show last word immediately

  const ttsControllerRef = useRef(null); // TTS controller for audio playback

  // SHARED ENGINE INTEGRATION
  useEffect(() => {
    if (!USE_SHARED_ENGINE) return;

    // Create independent segmenter for the engine to avoid conflict with legacy path
    const engineSegmenter = new SentenceSegmenter({
      maxSentences: 10,
      maxChars: 2000,
      maxTimeMs: 15000
    });

    // Track processed history to avoid re-announcing
    let lastCommittedLength = 0;

    console.log('[ListenerPage] Initializing Shared Engine');
    engineRef.current = new CaptionClientEngine({
      segmenter: engineSegmenter,
      lang: targetLangRef.current, // Use ref for initial value
      debug: true
    });

    // Subscribe to state updates
    const handleState = (state) => {
      // 1. Update Live Partial Text immediately via imperative painters
      if (state.liveLine) {
        updateTranslationText(state.liveLine);
        setCurrentTranslation(state.liveLine);
      } else {
        // Only clear if explicitly empty string (meaning reset or new sentence started)
        // Check if we need to clear? The engine state.liveLine should be the truth.
        clearTranslationText();
        setCurrentTranslation('');
      }

      if (state.liveOriginal) {
        updateOriginalText(state.liveOriginal);
        setCurrentOriginal(state.liveOriginal);
      } else {
        clearOriginalText();
        setCurrentOriginal('');
      }

      // 2. Update History (Committed Lines)
      if (state.committedLines) {
        // Map engine model to UI model
        setTranslations(state.committedLines.map(line => ({
          original: line.original || '',
          translated: line.text,
          timestamp: line.timestamp,
          seqId: line.seqId || -1,
          isSegmented: true
        })));

        // Detect new lines for TTS triggering
        if (state.committedLines.length > lastCommittedLength) {
          const newLines = state.committedLines.slice(lastCommittedLength);
          lastCommittedLength = state.committedLines.length;

          // Enqueue new lines for TTS (Unary mode only - streaming mode uses backend orchestrator)
          if (!streamingTtsRef.current && ttsControllerRef.current && ttsControllerRef.current.getState().state === 'PLAYING') {
            newLines.forEach(line => {
              if (!line.text) return;

              // Create content hash to prevent duplicate TTS requests
              // 1. Primary Check: seqId (most stable)
              // 2. Secondary Check: text (fallback) - unstable timestamps are ignored
              const seqIdHash = line.seqId ? `seq_${line.seqId}` : null;
              const textHash = `txt_${line.text.trim().toLowerCase()}`;

              const isDuplicate = (seqIdHash && sentToTtsRef.current.has(seqIdHash)) ||
                sentToTtsRef.current.has(textHash);

              // Skip if already sent to TTS
              if (isDuplicate) {
                console.log('[ListenerPage] Skipping duplicate TTS request (dedupe):', {
                  seqId: line.seqId,
                  text: line.text.substring(0, 50)
                });
                return;
              }

              // Mark as sent
              if (seqIdHash) sentToTtsRef.current.add(seqIdHash);
              sentToTtsRef.current.add(textHash);

              // Use stable seqId from engine if available, otherwise generate one
              const segmentId = line.seqId
                ? line.seqId.toString()
                : `seg_${line.timestamp || Date.now()}`;

              ttsControllerRef.current.onFinalSegment({
                id: segmentId,
                text: line.text,
                timestamp: line.timestamp
              });
            });
          }
        }
      }
    };

    // Pass-through TTS events from engine to controller
    const handleTts = (event) => {
      if (ttsControllerRef.current) {
        ttsControllerRef.current.onWsMessage(event);
      }
    };

    engineRef.current.on('state', handleState);
    engineRef.current.on('tts', handleTts);

    return () => {
      if (engineRef.current) {
        console.log('[ListenerPage] Cleaning up Shared Engine listeners');
        engineRef.current.off('state', handleState);
        engineRef.current.off('tts', handleTts);
        engineRef.current = null;
      }
    };
  }, []); // Run once on mount

  // Sync Language with Engine
  useEffect(() => {
    if (USE_SHARED_ENGINE && engineRef.current) {
      engineRef.current.setLang(targetLang);
    }
  }, [targetLang]);


  // TTS UI State (Lifted from TtsPanel)
  const [ttsState, setTtsState] = useState(TtsPlayerState.STOPPED);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('');
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
  const [availableVoices, setAvailableVoices] = useState([]);
  const [ttsDefaults, setTtsDefaults] = useState({});
  const [streamingTts, setStreamingTts] = useState(false);
  const streamingTtsRef = useRef(streamingTts);

  // Sync ref with state to prevent stale closures in event handlers
  useEffect(() => {
    streamingTtsRef.current = streamingTts;
  }, [streamingTts]);

  // Stable session ID for streaming (must not change on re-render)
  const streamingSessionIdRef = useRef(`listener_${Date.now()}`);

  // Determine effective playback rate
  const getEffectivePlaybackRate = () => {
    return ttsSettings.speakingRate || 1.0;
  };

  // TTS streaming (real-time) - uses session ID from join if available
  const ttsStreaming = useTtsStreaming({
    sessionId: sessionInfo?.sessionId || streamingSessionIdRef.current,
    enabled: streamingTts && isJoined && connectionState === 'open',
    targetLang: targetLang,  // Filter server-side audio delivery to this language only
    playbackRate: getEffectivePlaybackRate(),
    onBufferUpdate: (ms) => {
      console.log('[ListenerPage] Buffer:', ms, 'ms');
    },
    onUnderrun: (count) => {
      console.warn('[ListenerPage] Audio underrun:', count);
    },
    onError: (err) => {
      console.error('[ListenerPage] Streaming error:', err);
    }
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
                if (DEBUG && added > 0) {
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
                } else if (DEBUG) {
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
                if (DEBUG) {
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
      ttsControllerRef.current.onRouteResolved = (route) => {
        console.log('[ListenerPage] TTS Route resolved:', route);
        setRoutingDebug(route);
      };
      ttsControllerRef.current.onVoicesUpdate = (voices) => {
        console.log('[ListenerPage] Received dynamic voices update:', voices.length);
        setAvailableVoices(voices);
      };
      ttsControllerRef.current.onDefaultsUpdate = (defaults) => {
        console.log('[ListenerPage] Received dynamic defaults update:', Object.keys(defaults).length);
        setTtsDefaults(defaults);
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
    let lang = targetLang;
    if (targetLang) {
      ttsControllerRef.current.currentLanguageCode = targetLang;
    }

    // Update voice AND tier
    let voiceId = selectedVoice;
    let voiceName = null;
    let tier = 'neural2'; // Default

    if (selectedVoice) {
      ttsControllerRef.current.currentVoiceId = selectedVoice;

      // Update tier based on selected voice
      const voiceOption = availableVoices.find(v => v.voiceId === selectedVoice);
      if (voiceOption) {
        voiceName = voiceOption.voiceName;
        tier = voiceOption.tier || 'neural2';
        ttsControllerRef.current.currentVoiceName = voiceName;
        ttsControllerRef.current.tier = tier;
        console.log(`[ListenerPage] Updated voice and tier: ${selectedVoice} (${tier})`);
      }
    }

    // Sync SSML options
    const ssmlOptions = {
      enabled: ttsSettings.ssmlEnabled,
      deliveryStyle: ttsSettings.deliveryStyle,
      rate: ttsSettings.speakingRate,
      pitch: '+1st',
      pauseIntensity: getDeliveryStyle(ttsSettings.deliveryStyle).pauseIntensity,
      emphasizePowerWords: true, // internal logic assumption
      emphasisLevel: 'moderate',
      supportsPhraseProsody: true
    };
    ttsControllerRef.current.ssmlOptions = ssmlOptions;

    // Sync Prompt options
    ttsControllerRef.current.promptPresetId = ttsSettings.promptPresetId;
    ttsControllerRef.current.intensity = ttsSettings.intensity;
    // Also sync to instance properties
    ttsControllerRef.current.ttsPrompt = null; // simplified

    // CRITICAL FIX: Send 'tts/start' to backend to update session preferred voice
    // Only if we have a valid voice selected
    if (voiceId && connectionState === 'open') {
      ttsControllerRef.current.start({
        languageCode: lang,
        voiceName,
        voiceId,
        tier,
        mode: TtsMode.UNARY, // Host listener uses Unary requests for fallback/config? Or just config.
        ssmlOptions,
        promptPresetId: ttsSettings.promptPresetId,
        intensity: ttsSettings.intensity
      });
    }

    // CRITICAL FIX: Only fetch voices if WebSocket is connected
    // Without this check, fetchVoices silently fails when called before connection
    if (connectionState === 'open') {
      console.log('[ListenerPage] Fetching voices for:', targetLang);
      ttsControllerRef.current.fetchVoices(targetLang);
    } else {
      console.warn('[ListenerPage] Skipping fetchVoices - WebSocket not ready:', connectionState);
    }

  }, [targetLang, selectedVoice, ttsSettings, connectionState]);

  // Ensure selected voice is valid for current language AND allowed by PLAN
  useEffect(() => {
    if (availableVoices.length === 0) return;

    // CRITICAL: Wait for userPlan to be set before making default decisions
    // This prevents premature defaults when session_joined hasn't arrived yet
    // However, add a timeout to prevent indefinite waiting
    if (userPlan === null) {
      console.log('[ListenerPage] ⏳ Waiting for userPlan before selecting voice default...');

      // Timeout fallback: If plan doesn't load within 2 seconds, default to 'starter'
      const timeoutId = setTimeout(() => {
        if (userPlan === null) {
          console.warn('[ListenerPage] ⚠️ userPlan timeout - defaulting to starter plan');
          setUserPlan('starter');
        }
      }, 2000);

      return () => clearTimeout(timeoutId);
    }

    // Helper to check if voice is allowed - uses server-sent isAllowed flag
    const isVoiceAllowed = (voice) => voice.isAllowed !== undefined ? voice.isAllowed : true;

    // 1. Check if voice exists strictly in list
    const voiceExists = availableVoices.some(v => v.voiceId === selectedVoice);

    // 2. Check if voice is ALLOWED by plan (using server's isAllowed flag)
    const currentVoiceObj = availableVoices.find(v => v.voiceId === selectedVoice);
    const isAllowed = currentVoiceObj ? isVoiceAllowed(currentVoiceObj) : false;

    // If invalid or disallowed, we must pick a new default
    if (!voiceExists || !isAllowed) {
      console.log(`[ListenerPage] Selecting default voice (Plan: ${userPlan || 'unknown'}, Current: ${selectedVoice}, isAllowed: ${isAllowed})`);

      let defaultVoiceId = null;

      // Use the first allowed voice from the server-provided list
      // The server already sorts voices by tier priority in getDefaultVoice()
      const firstAllowed = availableVoices.find(v => isVoiceAllowed(v));
      if (firstAllowed) {
        defaultVoiceId = firstAllowed.voiceId;
      } else {
        // Last resort: Just pick the first one (even if technically disallowed, better than crash)
        defaultVoiceId = availableVoices[0]?.voiceId;
      }

      if (defaultVoiceId) {
        console.log(`[ListenerPage] Setting default voice to: ${defaultVoiceId}`);
        setSelectedVoice(defaultVoiceId);
        return;
      }

      // Safe Fallback if list is empty but we need a value to prevent backend crashing
      const safeDefault = `google-${targetLang}-Standard-A`;
      console.log(`[ListenerPage] ⚠️ No available voices found, forcing safe default: ${safeDefault}`);
      setSelectedVoice(safeDefault);
    }
  }, [availableVoices, selectedVoice, targetLang, userPlan]);

  // Track previous tier to detect tier changes and reset speed accordingly
  const prevTierRef = useRef(null);

  // Reset speed to tier-specific default when tier changes
  useEffect(() => {
    if (!selectedVoice || availableVoices.length === 0) return;
    const voiceOption = availableVoices.find(v => v.voiceId === selectedVoice);
    if (voiceOption) {
      const tier = voiceOption.tier || 'standard';

      // Detect tier change
      const tierChanged = prevTierRef.current !== null && prevTierRef.current !== tier;

      // Update previous tier ref
      const isFirstLoad = prevTierRef.current === null;
      prevTierRef.current = tier;

      // Determine tier-specific default speed
      let defaultSpeed = 1.1; // Baseline is 1.1x for Standard, Neural2, Chirp3

      // Check if this is any ElevenLabs tier (Explicitly check to avoid fallthrough)
      const isElevenLabs = tier === 'elevenlabs_flash' || tier === 'elevenlabs_turbo' ||
        tier === 'elevenlabs_v3' || tier === 'elevenlabs' || (tier && tier.startsWith('elevenlabs'));

      // Robust Gemini detection (Ensure we don't accidentally catch ElevenLabs)
      const isGemini = !isElevenLabs && (tier === 'gemini' || (selectedVoice && selectedVoice.startsWith('gemini-')));

      if (isGemini) {
        defaultSpeed = 1.45;
      } else if (isElevenLabs) {
        defaultSpeed = 1.0; // All ElevenLabs voices default to 1.0x (normal speed)
      } else if (tier === 'chirp3_hd') {
        defaultSpeed = 1.1;
      } else if (tier === 'neural2' || tier === 'standard') {
        defaultSpeed = 1.1;
      }

      // Reset to tier-specific default when tier changes OR on first load if at 1.0
      if (tierChanged) {
        console.log(`[ListenerPage] Tier changed to ${tier}, resetting speed to ${defaultSpeed}x`);
        setTtsSettings(prev => ({ ...prev, speakingRate: defaultSpeed }));
      } else if (isFirstLoad && defaultSpeed !== ttsSettings.speakingRate) {
        // Fix: Don't restrict to only if currently 1.0/1.1 - just enforce default on first load for consistency
        console.log(`[ListenerPage] First load with ${tier} tier, forcing default speed to ${defaultSpeed}x`);
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

    const voiceOption = availableVoices.find(v => v.voiceId === selectedVoice);
    const tier = voiceOption?.tier || 'neural2';
    // Strictly rely on tier - 'Gemini' voices are explicitly marked as tier: 'gemini'
    // Chirp 3 HD voices with the same name (e.g. Kore) will have tier: 'chirp3_hd'
    const isGemini = tier === 'gemini';

    const requestData = {
      languageCode: targetLang,
      voiceName: voiceOption?.voiceName || selectedVoice,
      voiceId: selectedVoice,
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

    // CRITICAL: Unlock AudioContext HERE — we are inside a direct user gesture (the Join button click).
    // This must happen synchronously before any await, while the browser still considers
    // this a trusted user interaction. Without this, AudioContext stays 'suspended' and
    // auto-play silently fails on iOS/Chrome ~15% of the time.
    if (ttsControllerRef.current) {
      ttsControllerRef.current.unlockFromUserGesture();
      console.log('[ListenerPage] 🔓 AudioContext unlocked from Join gesture');
    }

    if (ttsStreaming && ttsStreaming.unlockAudio) {
      ttsStreaming.unlockAudio();
      console.log('[ListenerPage] 🔓 Streaming Audio Player unlocked from Join gesture');
    }

    // CRITICAL: iOS needs SpeechSynthesis to be touched at least once during a user gesture
    // Otherwise it fails to initialize the subsystem, even if we are using Web Audio API / MediaSource.
    try {
      const utterance = new SpeechSynthesisUtterance('');
      utterance.volume = 0;
      speechSynthesis.speak(utterance);
      console.log('[ListenerPage] 🔓 SpeechSynthesis primed from Join gesture');
    } catch (e) {
      console.warn('[ListenerPage] Failed to prime SpeechSynthesis', e);
    }

    setIsJoining(true);
    setError('');

    try {
      // Get auth token if available (for auto-linking)
      let headers = { 'Content-Type': 'application/json' };
      try {
        const { supabase } = await import('@/lib/supabase');
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          headers['Authorization'] = `Bearer ${session.access_token}`;
        }
      } catch (authErr) {
        // No auth available - continue as anonymous
        console.log('[ListenerPage] No auth token available (anonymous join)');
      }

      const response = await fetch(`${API_URL}/session/join`, {
        method: 'POST',
        headers,
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

        // Show auto-link toast if user was just linked to a church
        if (data.autoLinked && data.churchName) {
          console.log(`[ListenerPage] ✅ Auto-linked to church: ${data.churchName}`);
          // Simple alert for now - can be replaced with toast library later
          setTimeout(() => {
            alert(`Welcome! You've joined ${data.churchName}. You now have full member access.`);
          }, 500);
        }

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

    // CRITICAL: Use persistent listener ID to track unique users across sessions
    let listenerId = localStorage.getItem('exbabel_listener_id');
    if (!listenerId) {
      listenerId = crypto.randomUUID();
      localStorage.setItem('exbabel_listener_id', listenerId);
    }

    const ws = new WebSocket(
      `${finalWsUrl}?role=listener&sessionId=${sessionId}&targetLang=${lang}&userName=${encodeURIComponent(name)}&listenerId=${listenerId}`
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

        // Forward TTS-related control messages to the controller
        // (voices, defaults, audio, etc.) regardless of engine mode
        if (message.type && message.type.startsWith('tts/')) {
          if (ttsControllerRef.current) {
            ttsControllerRef.current.onWsMessage(message);
          }
          // Some TTS messages are pure control/data (voices, defaults) 
          // while others are audio chunks that the engine might also care about.
          // For voices/defaults/errors, we can consume them here.
          if (['tts/voices', 'tts/defaults', 'tts/error'].includes(message.type)) {
            return;
          }
        }

        // FEATURE FLAG: Shared Engine Integration
        if (USE_SHARED_ENGINE && engineRef.current) {
          engineRef.current.ingest(message);
          return;
        }

        // Track last stable key for onFlush correlation
        lastStableKeyRef.current = (message.sourceSeqId ?? message.seqId ?? null);

        // Track if last message was partial for flush guard
        lastWasPartialRef.current = !!message.isPartial;

        // TRACE: Log WebSocket message received
        traceUI('WS_IN', message);

        // LATENCY MEASUREMENT: Always log if message seems delayed
        const msgTimestamp = message.timestamp;
        if (msgTimestamp && message.type === 'translation') {
          const latencyMs = Date.now() - msgTimestamp;
          if (latencyMs > 100) {
            console.log(`[LISTENER_LATENCY] seqId=${message.seqId} latency=${latencyMs}ms isPartial=${message.isPartial}`);
          }
        }

        // RAW_IN logging: canonical ingestion truth for ghost bug debugging
        if (DEBUG) console.log('[RAW_IN]', {
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
        if (DEBUG) {
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
        }

        // Track seen fingerprints for invariant checking
        if (message.translatedText) {
          seenRawInFpsRef.current.add(fp(message.translatedText));
        }
        if (message.originalText) {
          seenRawInFpsRef.current.add(fp(message.originalText));
        }

        // A) LISTENER_IN logging: how listener receives messages
        if (DEBUG) console.log('[LISTENER_IN]', {
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
            if (DEBUG) console.log('[DROP_OOO_PARTIAL]', {
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
            // Extract plan from session_joined message (backend now includes it)
            const receivedPlan = message.plan || 'starter';
            console.log('[Listener] User Plan:', receivedPlan);
            setUserPlan(receivedPlan);
            break;

          case 'plan_updated':
            // Handle plan updates (sent by backend if entitlements load late)
            console.log('[Listener] Plan updated:', message.plan);
            setUserPlan(message.plan);
            break;

          case 'translation':
            // UNCONDITIONAL DEBUG: Count all messages received
            console.log(`[MSG_${message.isPartial ? 'PARTIAL' : 'FINAL'}] seqId=${message.seqId} hasTranslation=${message.hasTranslation} targetLang=${message.targetLang}`);
            if (DEBUG) console.log('[LISTENER_CASE_TRANSLATION]', { type: message.type, isPartial: message.isPartial });
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
              if (DEBUG) console.log('[LISTENER_DECISION]', {
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
                if (DEBUG) console.log('[LISTENER_TRANSLATION_PROCESSING]', {
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
                  if (DEBUG) console.log('[LISTENER_RENDER_TRIGGER]', {
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
                    if (DEBUG) console.log('[SKIP_ENGLISH_TRANSLATION]', { translatedText: translatedText?.slice(0, 50) });
                    // Don't update translation display - keep previous content
                  } else if (isAIRefusal) {
                    if (DEBUG) console.log('[SKIP_AI_REFUSAL]', { text: lowerText.slice(0, 60) });
                    // Don't update translation display - AI is refusing to translate
                  } else {
                    // Use imperative painter for flicker-free updates (replaces flushSync)
                    if (DEBUG) console.log('[LISTENER_UI_UPDATE]', { liveText: liveText.substring(0, 30) });
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

              // ⚡ FORCED FINAL UPDATE GATE: Async grammar/translation refinements carry isUpdate:true.
              // They refine an already-committed row — do NOT add another history entry.
              if (message.isUpdate === true) {
                const refinedText = message.translatedText || message.correctedText || '';
                if (refinedText.trim()) {
                  updateTranslationText(refinedText);
                  setCurrentTranslation(refinedText);
                }
                break;
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
              if (DEBUG) console.log('[LISTENER_FINAL_DECISION]', {
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
                if (DEBUG) console.log('[LISTENER_FINAL_SKIP]', {
                  reason: 'not for this language',
                  listenerLang: targetLangRef.current,
                  messageLang: message.targetLang
                });
                return;
              }

              // Skip if no translation and not transcription mode
              if (!finalText && !isTranscriptionMode) {
                if (DEBUG) console.warn('[ListenerPage] ⚠️ Final received without translation, skipping (not transcription mode)');
                return;
              }

              // Use translatedText if available, otherwise use correctedText/originalText for transcription mode
              const textToDisplay = finalText || (isTranscriptionMode ? correctedOriginalText : undefined);

              if (!textToDisplay) {
                if (DEBUG) console.warn('[ListenerPage] ⚠️ Final received with no displayable text, skipping');
                return;
              }

              // Removed final logging - reduces console noise

              // CRITICAL: Use flushSync for final updates to ensure immediate UI feedback
              // This prevents flicker when clearing currentTranslation right after adding to history
              flushSync(() => {
                if (DEBUG) console.log('[LISTENER_FINAL_ADD_TO_HISTORY]', {
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
                  if (DEBUG && (!correctedOriginalText || !correctedOriginalText.trim())) {
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
                  if (DEBUG) console.log('[LISTENER_ROW_KEY]', { rowKey, seqId: message.seqId, sourceSeqId: message.sourceSeqId });

                  const next = [...prev, newEntry].slice(-50);

                  // LOG ONLY THE NEW/CHANGED ROW(S)
                  const added = next.length - prev.length;
                  if (DEBUG && added > 0) {
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
                  if (DEBUG) {
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
                  }

                  return next;
                });

                // Radio Mode: Auto-enqueue finalized segment for TTS
                // GATED: Only run this legacy path if NOT using the shared engine (which handles its own TTS triggers)
                // ALSO GATED: Skip if streaming mode is enabled (backend orchestrator handles it)
                try {
                  // TRANSLATION LANGUAGE GUARD: Skip if translatedText is suspiciously similar to originalText (API misfire)
                  // Use robust detection (not just !==)
                  const isSuspiciousEnglish = !isTranscriptionMode &&
                    textToDisplay &&
                    originalText &&
                    textToDisplay.toLowerCase().trim() === originalText.toLowerCase().trim();

                  if (isSuspiciousEnglish && targetLangRef.current !== 'en') {
                    console.log('[ListenerPage] 🚫 Skipping TTS: English text detected in non-English channel', { text: textToDisplay });
                  } else if (!USE_SHARED_ENGINE &&
                    !streamingTtsRef.current &&
                    ttsControllerRef.current &&
                    ttsControllerRef.current.getState().state === 'PLAYING' &&
                    (isForMyLanguage || isTranscriptionMode) &&
                    textToDisplay) {

                    console.log('[ListenerPage] 🗣️ Queuing TTS segment:', { id: message.seqId, text: textToDisplay });
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
          case 'tts/voices':
          case 'tts/defaults':
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
    <div className="h-screen flex flex-col bg-gradient-to-br from-green-50 to-emerald-100 overflow-hidden">


      {/* NEW: Full-page scrollable area with bottom anchoring */}
      <div className="flex-1 overflow-y-auto flex flex-col-reverse px-2 sm:px-4">
        <div className="container mx-auto w-full flex flex-col-reverse relative">

          {/* LIVE TRANSLATION BOX - Sticky at the start of the reversed container (visual bottom) */}
          <div className="sticky bottom-0 z-10 pt-4">
            <div
              onClick={() => setShowLiveOriginal(!showLiveOriginal)}
              className="bg-gradient-to-br from-green-500 via-emerald-500 to-teal-600 rounded-lg sm:rounded-2xl p-4 sm:p-6 shadow-2xl border-4 border-white/20 ring-1 ring-black/5 cursor-pointer hover:ring-white/20 transition-all active:scale-[0.99]"
            >
              <div className="flex items-center justify-between mb-3 sm:mb-4">
                <div className="flex items-center space-x-2 sm:space-x-3">
                  {connectionState === 'open' && (
                    <div className="flex space-x-1">
                      <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce"></div>
                      <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '0.15s' }}></div>
                      <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{ animationDelay: '0.3s' }}></div>
                    </div>
                  )}
                  <span className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    {connectionState === 'open' ? 'LIVE TRANSLATION' : 'CONNECTING...'}
                    {connectionState === 'open' && !showLiveOriginal && (
                      <span className="normal-case opacity-70 font-normal text-[10px] sm:text-xs tracking-normal">
                        (Tap to expand)
                      </span>
                    )}
                  </span>
                </div>
              </div>

              {/* Show both original and translation */}
              <div className="space-y-2 sm:space-y-3">
                {/* Original Text from Host */}
                {showLiveOriginal && (
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

          {/* Translation History - Part of the same reversed flow */}
          <div className="bg-gray-50/50 backdrop-blur-sm rounded-lg sm:rounded-xl p-3 sm:p-5 border-2 border-gray-200 mb-2">
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
              <div className="space-y-2 sm:space-y-3 flex flex-col-reverse">
                {[...translations].reverse().map((item, index) => {
                  const actualIndex = translations.length - 1 - index;
                  return (
                    <div
                      key={index}
                      onClick={() => {
                        const itemKey = item.seqId !== -1 && item.seqId != null ? `seq_${item.seqId}` : `ts_${item.timestamp}`;
                        const current = showOriginalMapRef.current.get(itemKey) || false;
                        showOriginalMapRef.current.set(itemKey, !current);
                        setShowOriginalVersion(v => v + 1); // force re-render
                      }}
                      className="bg-white rounded-lg p-4 sm:p-5 shadow-sm hover:shadow-md transition-all border border-gray-200 cursor-pointer"
                    >
                      {(() => { const itemKey = item.seqId !== -1 && item.seqId != null ? `seq_${item.seqId}` : `ts_${item.timestamp}`; return showOriginalMapRef.current.get(itemKey); })() && item.original ? (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold text-blue-600 uppercase">Original (Tap to hide)</span>
                            <div className="flex items-center space-x-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if ('speechSynthesis' in window) {
                                    window.speechSynthesis.cancel();
                                    const utterance = new SpeechSynthesisUtterance(item.original);
                                    utterance.lang = sessionInfo?.sourceLang || 'en';
                                    window.speechSynthesis.speak(utterance);
                                  }
                                }}
                                className="p-1 text-gray-400 hover:text-blue-600 transition-colors"
                                title="Play Original"
                              >
                                <Volume2 className="w-4 h-4" />
                              </button>
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
                                  if ('speechSynthesis' in window) {
                                    window.speechSynthesis.cancel();
                                    const utterance = new SpeechSynthesisUtterance(item.translated);
                                    utterance.lang = targetLang;
                                    window.speechSynthesis.speak(utterance);
                                  }
                                }}
                                className="p-1 text-gray-400 hover:text-green-600 transition-colors"
                                title="Play Translation"
                              >
                                <Volume2 className="w-4 h-4" />
                              </button>
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
                            </div>
                          </div>
                          <p className="text-gray-900 text-lg sm:text-xl md:text-2xl leading-relaxed font-medium">{item.translated}</p>
                        </div>
                      )}

                      <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-400 flex items-center justify-between">
                        <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                        <span className="text-gray-300">#{index + 1}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-none container mx-auto px-2 sm:px-4 py-2 sm:py-4 sticky bottom-0 z-50 bg-white/80 backdrop-blur-md border-t border-gray-200 shadow-lg">
        {/* Unified Session Info Bar */}
        <div className="bg-white rounded-lg shadow-sm p-1.5 sm:p-3">
          <div className="flex flex-row items-center gap-2 sm:gap-4 overflow-x-auto sm:overflow-visible no-scrollbar">

            {/* Session Code */}
            <div className="flex-shrink-0 flex items-center gap-1">
              <span className="text-[10px] uppercase font-bold text-gray-400 sm:text-gray-600 sm:font-normal sm:capitalize sm:block hidden">Code:</span>
              <p className="text-sm sm:text-xl font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100">{sessionCode || sessionInfo?.sessionCode}</p>
            </div>

            {/* Voice Model */}
            {TTS_UI_ENABLED && (
              <div className="flex-shrink-0 w-24 sm:flex-1 sm:max-w-xs">
                <select
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  className="w-full px-1 py-1 border border-gray-200 rounded text-[10px] sm:text-sm focus:ring-2 focus:ring-emerald-500 outline-none truncate"
                >
                  {Object.entries(
                    availableVoices.reduce((acc, voice) => {
                      const tier = voice.tier || 'standard';
                      let group = 'Standard';
                      if (tier === 'gemini') group = 'Gemini & Studio';
                      else if (tier === 'elevenlabs_v3') group = 'Eleven v3 alpha';
                      else if (tier === 'elevenlabs_turbo') group = 'Eleven Turbo v2.5';
                      else if (tier === 'elevenlabs_flash') group = 'Eleven Flash 2.5';
                      else if (tier === 'elevenlabs') group = 'Eleven Multilingual';
                      else if (tier === 'chirp3_hd') group = 'Chirp 3 HD';
                      else if (tier === 'neural2') group = 'Neural2';

                      if (!acc[group]) acc[group] = [];
                      acc[group].push(voice);
                      return acc;
                    }, {})
                  ).map(([group, voices]) => (
                    <optgroup key={group} label={group}>
                      {voices.map(v => {
                        // Use isAllowed from server (set based on user's plan entitlements)
                        const isAllowed = v.isAllowed !== undefined ? v.isAllowed : true;

                        return (
                          <option
                            key={v.value}
                            value={v.value}
                            disabled={!isAllowed}
                            style={!isAllowed ? { color: '#9ca3af', opacity: 0.6 } : {}}
                          >
                            {v.label.replace('Premium, ', '').replace('Female', 'F').replace('Male', 'M')}
                            {!isAllowed ? ' 🔒 (Upgrade)' : ''}
                          </option>
                        );
                      })}
                    </optgroup>
                  ))}
                </select>
              </div>
            )}

            {/* Language Selector */}
            <div className="flex-shrink-0 w-24 sm:flex-1 sm:max-w-xs">
              <LanguageSelector
                label=""
                languages={LANGUAGES}
                selectedLanguage={targetLang}
                onLanguageChange={handleChangeLanguage}
                compact={true}
              />
            </div>

            {/* Controls: Settings, Play, Connection, Leave */}
            <div className="flex items-center gap-1.5 sm:gap-2 ml-auto">
              {/* Settings */}
              {TTS_UI_ENABLED && (
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="p-1.5 sm:p-2 bg-gray-50 text-gray-500 rounded border border-gray-200 hover:bg-gray-100 transition-all"
                  title="Settings"
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>
              )}

              {/* Play/Stop */}
              {TTS_UI_ENABLED && (
                ttsState === 'PLAYING' ? (
                  <button
                    onClick={handleTtsStop}
                    className="p-1.5 sm:p-2 bg-red-500 text-white rounded hover:bg-red-600 transition-all shadow-sm"
                    title="Stop"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    onClick={handleTtsPlay}
                    disabled={connectionState !== 'open'}
                    className="p-1.5 sm:px-3 sm:py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 transition-all disabled:bg-gray-200 shadow-sm"
                    title="Play"
                  >
                    <Play className="w-3.5 h-3.5 fill-current inline sm:mr-1" />
                    <span className="hidden sm:inline text-sm font-medium">Play</span>
                  </button>
                )
              )}

              {/* Connection Status */}
              <div className="scale-75 sm:scale-100 origin-right">
                <ConnectionStatus state={connectionState} />
              </div>

              {/* Leave Button */}
              <button
                onClick={handleLeaveSession}
                className="px-2 py-1 sm:px-3 sm:py-2 bg-gray-100 hover:bg-red-50 hover:text-red-600 text-gray-600 font-bold rounded border border-gray-200 transition-all text-[10px] sm:text-xs uppercase tracking-tight"
              >
                Leave
              </button>
            </div>

          </div>
        </div>


      </div>

      {/* Settings Modal - Outside sticky container for correct stacking context */}
      <TtsSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={ttsSettings}
        onSettingsChange={setTtsSettings}
        selectedVoice={selectedVoice}
        targetLang={targetLang}
        voices={availableVoices}
        streamingTts={streamingTts}
        onStreamingTtsChange={setStreamingTts}
      />

      {/* Streaming Status (when enabled) */}
      {streamingTts && isJoined && (
        <div className="fixed bottom-32 right-4 z-50">
          <TtsStreamingControl
            isEnabled={streamingTts}
            isConnected={ttsStreaming.isConnected}
            isPlaying={ttsStreaming.isPlaying}
            bufferedMs={ttsStreaming.bufferedMs}
            stats={ttsStreaming.stats}
          />
        </div>
      )}

      {error && (
        <div className="fixed bottom-20 left-4 right-4 z-[60] p-4 bg-red-100 border border-red-400 text-red-700 rounded shadow-lg animate-in slide-in-from-bottom duration-300">
          {error}
        </div>
      )}
      {/* TTS Routing Debug Overlay */}
      {import.meta.env.VITE_ENABLE_DEBUG_ROUTING === 'true' && routingDebug && (
        <div className="fixed bottom-20 left-4 z-50 bg-black/80 text-white text-[10px] p-2 rounded-md border border-gray-600 font-mono pointer-events-none max-w-xs shadow-xl backdrop-blur-sm">
          <div className="flex justify-between items-center mb-1 pb-1 border-b border-gray-700">
            <span className="font-bold text-blue-400">TTS ROUTING DEBUG</span>
            <span className="opacity-50">{new Date().toLocaleTimeString()}</span>
          </div>
          <div className="space-y-0.5">
            <div className="flex justify-between gap-4"><span className="text-gray-400">Tier:</span> <span className="font-bold text-yellow-400">{routingDebug.tier}</span></div>
            <div className="flex justify-between gap-4"><span className="text-gray-400">Model:</span> <span>{routingDebug.model || 'N/A'}</span></div>
            <div className="flex justify-between gap-4"><span className="text-gray-400">Voice:</span> <span className="text-green-400 truncate max-w-[120px]" title={routingDebug.voiceName}>{routingDebug.voiceName}</span></div>
            <div className="flex justify-between gap-4"><span className="text-gray-400">Lang:</span> <span>{routingDebug.languageCode}</span></div>
            <div className="mt-1 pt-1 border-t border-gray-700 text-blue-300 italic">
              {routingDebug.reason}
            </div>
            {routingDebug.fallbackFrom && (
              <div className="mt-1 text-orange-400 text-[9px] border-t border-gray-700 pt-1">
                FALLBACK FROM: {routingDebug.fallbackFrom.tier}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
