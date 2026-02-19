import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Settings, Mic, Volume2, VolumeX, RefreshCw } from 'lucide-react';
import { useSoloSession, SessionState, SoloMode } from '../../hooks/useSoloSession';
import { useTtsQueue } from '../../hooks/useTtsQueue';
import { useTtsStreaming } from '../../hooks/useTtsStreaming';
import { useAudioCapture } from '../../hooks/useAudioCapture';
import { useQuotaWarning } from '../../hooks/useQuotaWarning';
import { useAuth } from '@/contexts/AuthContext';
import ModeSelector from './ModeSelector';
import LanguageSelector from './LanguageSelector';
import StatusIndicator from './StatusIndicator';
import TurnIndicator from './TurnIndicator';
import TranscriptPanel from './TranscriptPanel';
import PlaybackQueueBadge from './PlaybackQueueBadge';
import TtsStreamingControl from '../tts/TtsStreamingControl';
import TtsRoutingOverlay from '../tts/TtsRoutingOverlay';
import AdvancedSettingsDrawer from './AdvancedSettingsDrawer';
import { UsageLimitModal, QuotaWarningToast } from '../ui/UsageLimitModal';
import { normalizeLanguageCode } from '../../config/ttsVoices';
import { useSessionTimer } from '../../hooks/useSessionTimer';
import '../../components/home/AdminAnalytics.css';

/**
 * SoloPage - Main Solo Mode Experience
 * 
 * A hands-free translation experience with auto-listening.
 * No push-to-talk, no holding buttons.
 */
export function SoloPage({ onBackToHome }) {
    // Auth context for token
    const { getAccessToken } = useAuth();

    // Stable session ID (created once, never changes)
    const sessionIdRef = useRef(`solo_${Date.now()}`);

    // Connection state
    const [ws, setWs] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    const [isServerReady, setIsServerReady] = useState(false);

    // Language state
    const [sourceLang, setSourceLang] = useState('en');
    const [targetLang, setTargetLang] = useState('es');

    // Settings
    const [showSettings, setShowSettings] = useState(false);
    const [silenceThreshold, setSilenceThreshold] = useState(800);
    const [speakerPriority, setSpeakerPriority] = useState(false);
    const [streamingTts, setStreamingTts] = useState(false); // new speech cancels TTS
    const [profanityFilter, setProfanityFilter] = useState(true); // Default: enabled

    // Voice selection
    const [selectedVoice, setSelectedVoice] = useState(null);
    const [availableVoices, setAvailableVoices] = useState([]);
    const [allowedTiers, setAllowedTiers] = useState([]);
    const [planCode, setPlanCode] = useState('starter');

    // Refs
    const wsRef = useRef(null);
    const targetLangRef = useRef(targetLang); // For closure-safe access
    const streamingTtsRef = useRef(streamingTts); // Sync with state

    // Routing Overlay State
    const [activeRouting, setActiveRouting] = useState(null);
    const routingTimeoutRef = useRef(null);

    // Deduplication Ref
    const lastQueuedTtsRef = useRef(null);

    // Keep refs in sync
    useEffect(() => {
        targetLangRef.current = targetLang;
    }, [targetLang]);

    useEffect(() => {
        streamingTtsRef.current = streamingTts;
    }, [streamingTts]);

    // Session state machine
    const session = useSoloSession({
        ws,
        sourceLang,
        targetLang,
        onPartial: (text) => {
            console.log('[SoloPage] Partial:', text.substring(0, 50));
        },
        onFinal: (text) => {
            console.log('[SoloPage] Final:', text.substring(0, 50));
        },
        onTranslation: (text, translatedText, isUpdate) => {
            console.log('[SoloPage] Translation:', { text, translatedText, isUpdate });

            // If streaming is enabled, the backend handles TTS via Orchestrator
            // We ONLY enqueue for Unary if streaming is DISABLED
            if (streamingTtsRef.current) {
                console.log('[SoloPage] Streaming enabled - skipping Unary TTS enqueue');
                return;
            }

            // Auto-enqueue for TTS if not text-only mode
            // Use ref for closure-safe access to current targetLang
            if (session.mode !== SoloMode.TEXT_ONLY) {
                // SKIP TTS FOR UPDATES/CORRECTIONS
                // If this is just an update to an existing segment (e.g. grammar correction),
                // we've likely already spoken the original version.
                // Re-speaking it causes "stuttering" or overlapping audio.
                if (isUpdate) {
                    console.log('[SoloPage] Skipping TTS - update/correction only');
                    return;
                }

                // BUG FIX: If translating (source != target), DO NOT use original text as fallback.
                // If translation is undefined/empty, we should simply NOT speak yet.
                // Using 'text' (source) as fallback causes English to be spoken in Chinese mode.
                const isTranslationRequired = sourceLang !== targetLangRef.current;

                if (isTranslationRequired) {
                    if (!translatedText) {
                        console.log('[SoloPage] Skipping TTS - translation not ready yet (undefined/null)');
                        return;
                    }
                    // ALSO check if translatedText is just the original text (which sometimes happens if backend falls back)
                    // We don't want to speak English in a Spanish mode
                    if (translatedText === text && text.trim().length > 0) {
                        console.log('[SoloPage] Skipping TTS - translation equals original (fallback detected)');
                        return;
                    }
                }

                const textToSpeak = translatedText || text;

                if (textToSpeak && textToSpeak.trim().length > 0) {

                    // DEDUPLICATION: Prevent speaking the exact same text twice in a row
                    // (Backend sometimes sends duplicate "Final" correction events)
                    const last = lastQueuedTtsRef.current;
                    const now = Date.now();
                    const isDuplicate = last &&
                        last.text === textToSpeak &&
                        (now - last.timestamp < 3000); // 3 second duplicate window

                    if (isDuplicate) {
                        console.log('[SoloPage] Skipping duplicate TTS:', textToSpeak);
                        return;
                    }

                    // Update dedupe tracker
                    lastQueuedTtsRef.current = {
                        text: textToSpeak,
                        timestamp: now
                    };

                    ttsQueue.enqueue({
                        text: text, // Original
                        translatedText: textToSpeak, // Text to speak
                        languageCode: normalizeLanguageCode(targetLangRef.current), // Use ref instead of stale closure
                        voiceId: selectedVoice?.voiceId // Pass selected voice explicitely
                    });
                } else {
                    console.warn('[SoloPage] Skipping TTS enqueue - empty text');
                }
            }
        },
        onStateChange: (state) => {
            console.log('[SoloPage] State:', state);
        }
    });

    // Determine playback rate based on tier
    // Determine playback rate based on tier
    const getPlaybackRate = useCallback(() => {
        return 1.0;
    }, []);

    const playbackRate = getPlaybackRate();

    // TTS queue
    const ttsQueue = useTtsQueue({
        ws,
        languageCode: normalizeLanguageCode(targetLang),
        tier: 'gemini',
        playbackRate,
        onPlayStart: () => {
            console.log('[SoloPage] TTS playing');
        },
        onPlayEnd: () => {
            console.log('[SoloPage] TTS done');
            session.onSpeakComplete();
        },
        onError: (error) => {
            console.error('[SoloPage] TTS error:', error);
        }
    });

    // TTS streaming (real-time) - uses same session ID as main WebSocket
    const ttsStreaming = useTtsStreaming({
        sessionId: sessionIdRef.current,
        enabled: streamingTts && session.mode !== SoloMode.TEXT_ONLY,
        playbackRate,
        onBufferUpdate: (ms) => {
            console.log('[SoloPage] Buffer:', ms, 'ms');
        },
        onUnderrun: (count) => {
            console.warn('[SoloPage] Audio underrun:', count);
        },
        onError: (err) => {
            console.error('[SoloPage] Streaming error:', err);
        }
    });

    // Audio capture
    const audioCapture = useAudioCapture();

    // Quota warning/exceeded handling
    const quotaWarning = useQuotaWarning();

    // Live session timer
    const sessionTimer = useSessionTimer();

    // Pre-connect quota check: blocks Start button if quota already exceeded
    useEffect(() => {
        quotaWarning.checkQuotaOnMount('solo');
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // WebSocket URL
    const getWebSocketUrl = () => {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = import.meta.env.VITE_WS_URL || `${wsProtocol}//${window.location.hostname}:3001`;
        const baseUrl = `${host}/translate`;

        // Add auth token if available
        const token = getAccessToken();
        return token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
    };

    // Connect to WebSocket
    const connect = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            return;
        }

        const wsUrl = getWebSocketUrl();
        console.log('[SoloPage] Connecting to:', wsUrl);

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
            console.log('[SoloPage] Connected');
            setIsConnected(true);
            setWs(socket);
            // NOTE: Don't send init here - wait for 'info' from backend
            // This ensures the backend message handler is fully set up
        };

        socket.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                handleMessage(message, socket);
            } catch (e) {
                console.error('[SoloPage] Parse error:', e);
            }
        };

        socket.onclose = () => {
            console.log('[SoloPage] Disconnected');
            setIsConnected(false);
            setWs(null);
        };

        socket.onerror = (error) => {
            console.error('[SoloPage] WS error:', error);
        };
    }, [sourceLang, targetLang]);

    // Handle incoming messages
    const handleMessage = useCallback((message, socket) => {
        // TTS messages
        if (message.type?.startsWith('tts/')) {
            // Handle voice list response
            if (message.type === 'tts/voices') {
                console.log('[SoloPage] Received voices:', message.voices?.length, 'allowedTiers:', message.allowedTiers, 'plan:', message.planCode);
                setAvailableVoices(message.voices || []);
                setAllowedTiers(message.allowedTiers || []);
                setPlanCode(message.planCode || 'starter');
                // Auto-select plan-appropriate default voice based on tier priority
                // Always select the default voice based on plan, don't persist previous selections
                if (message.voices?.length > 0) {
                    // Define tier priorities based on plan (matches backend voiceCatalog logic)
                    let tierPriority;
                    const allowedTiers = message.allowedTiers || [];

                    if (allowedTiers.includes('elevenlabs_flash') || allowedTiers.includes('elevenlabs')) {
                        // Unlimited tier
                        tierPriority = ['elevenlabs_flash', 'elevenlabs_turbo', 'elevenlabs_v3', 'elevenlabs', 'gemini', 'chirp3_hd', 'neural2', 'standard'];
                    } else if (allowedTiers.includes('gemini')) {
                        // Pro tier
                        tierPriority = ['gemini', 'chirp3_hd', 'neural2', 'studio', 'standard'];
                    } else {
                        // Starter tier
                        tierPriority = ['standard', 'neural2', 'studio'];
                    }

                    // Find first voice matching tier priority
                    let voiceToSelect = null;
                    for (const tier of tierPriority) {
                        if (!allowedTiers.includes(tier)) continue;

                        const voice = message.voices.find(v => v.tier === tier && v.isAllowed);
                        if (voice) {
                            voiceToSelect = voice;
                            break;
                        }
                    }

                    // Fallback to first allowed voice if no match found
                    if (!voiceToSelect) {
                        voiceToSelect = message.voices.find(v => v.isAllowed) || message.voices[0];
                    }

                    console.log(`[SoloPage] 🔄 Auto-selecting plan-appropriate voice: ${voiceToSelect?.voiceName} (tier: ${voiceToSelect?.tier})`);
                    setSelectedVoice(voiceToSelect);
                }
                return;
            }
        }
        ttsQueue.handleTtsMessage(message);

        // Handle routing info (broadcasted by backend)
        if (message.type === 'tts/routing') {
            console.log('[SoloPage] 🧭 Received routing info:', message);
            setActiveRouting({
                voiceName: message.voiceName,
                provider: message.provider,
                tier: message.tier,
                latencyMs: message.latencyMs
            });

            // Auto-hide after 5 seconds of inactivity
            if (routingTimeoutRef.current) clearTimeout(routingTimeoutRef.current);
            routingTimeoutRef.current = setTimeout(() => {
                setActiveRouting(null);
            }, 5000);
            return;
        }

        // Translation messages
        if (message.type === 'translation') {
            console.log('[SoloPage] Translation msg:', {
                isPartial: message.isPartial,
                originalText: message.originalText?.substring(0, 30),
                translatedText: message.translatedText?.substring(0, 30),
                seqId: message.seqId
            });

            if (message.isPartial) {
                session.handlePartial(message.originalText || message.transcript);
            } else {
                session.handleFinal(
                    message.originalText || message.transcript,
                    message.translatedText || message.translation,
                    message.seqId // Pass seqId for deduplication
                );
            }
            return;
        }

        // Other messages
        switch (message.type) {
            case 'info':
                console.log('[SoloPage] Info:', message.message);
                // The first info message confirms the backend handler is attached and ready
                // NOW we can safely send init
                if (!isServerReady && socket && socket.readyState === WebSocket.OPEN) {
                    // Send init message now that backend handler is ready
                    const initMessage = {
                        type: 'init',
                        sourceLang,
                        targetLang,
                        tier: 'basic',
                        sessionId: sessionIdRef.current,
                        voiceId: selectedVoice?.voiceId || null,
                        ttsMode: streamingTts ? 'streaming' : 'unary', // Tell backend which TTS mode to use
                        profanityFilter: profanityFilter
                    };
                    console.log('[SoloPage] 📤 SENDING INIT (after info):', initMessage);
                    socket.send(JSON.stringify(initMessage));

                    setIsServerReady(true);
                    console.log('[SoloPage] Server ready');
                }
                break;
            case 'warning':
                console.warn('[SoloPage] Warning:', message.message);
                break;
            case 'error':
                console.error('[SoloPage] Error:', message.message);
                break;
            default:
                console.log('[SoloPage] Message:', message.type);
        }

        // Handle quota events (warning/exceeded)
        quotaWarning.handleMessage(message);
    }, [session, ttsQueue, sourceLang, targetLang, selectedVoice, isServerReady, quotaWarning]);

    // Start auto-listening
    const handleStart = useCallback(async () => {
        if (!isConnected) {
            connect();
            return;
        }

        // Start TTS session
        ttsQueue.startTts();

        // Start audio capture
        try {
            await audioCapture.startRecording(
                (audioData, metadata) => {
                    if (wsRef.current?.readyState === WebSocket.OPEN) {
                        wsRef.current.send(JSON.stringify({
                            type: 'audio',
                            audioData,
                            chunkIndex: metadata?.chunkIndex,
                            startMs: metadata?.startMs,
                            endMs: metadata?.endMs
                        }));
                    }
                },
                true // Enable streaming mode for real-time transcription
            );

            // Start session state machine
            session.start();
            sessionTimer.start();

            console.log('[SoloPage] Started listening');
        } catch (error) {
            console.error('[SoloPage] Mic error:', error);
        }
    }, [isConnected, connect, session, ttsQueue, audioCapture]);

    // Stop everything
    const handleStop = useCallback(() => {
        audioCapture.stopRecording();
        ttsQueue.stopTts();
        session.stop();
        sessionTimer.stop();

        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'audio_end' }));
        }

        console.log('[SoloPage] Stopped');
    }, [audioCapture, ttsQueue, session, sessionTimer]);

    // Handle language change
    const handleLanguageChange = useCallback((type, lang) => {
        const newSourceLang = type === 'source' ? lang : sourceLang;
        const newTargetLang = type === 'target' ? lang : targetLang;

        console.log('[SoloPage] 🔄 Language change requested:', {
            type,
            newLang: lang,
            oldSourceLang: sourceLang,
            oldTargetLang: targetLang,
            newSourceLang,
            newTargetLang
        });

        if (type === 'source') {
            setSourceLang(lang);
        } else {
            setTargetLang(lang);
        }

        // Reinitialize backend if connected
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            const initMessage = {
                type: 'init',
                sourceLang: newSourceLang,
                targetLang: newTargetLang,
                tier: 'basic',
                sessionId: sessionIdRef.current,
                voiceId: selectedVoice?.voiceId || null, // Include current voice
                ttsMode: streamingTts ? 'streaming' : 'unary', // Tell backend which TTS mode to use
                profanityFilter: profanityFilter
            };

            console.log('[SoloPage] 📤 Sending init message:', initMessage);
            wsRef.current.send(JSON.stringify(initMessage));
            console.log('[SoloPage] ✅ Backend reinitialized for:', newSourceLang, '→', newTargetLang);
        } else {
            console.warn('[SoloPage] ⚠️ Cannot reinitialize - WebSocket not connected');
        }

        console.log('[SoloPage] Languages changed:', newSourceLang, '→', newTargetLang);
    }, [sourceLang, targetLang, selectedVoice]);

    // Handle voice change
    const handleVoiceChange = useCallback((voice) => {
        console.log('[SoloPage] 🎙️ Voice changed to:', voice.voiceName);
        setSelectedVoice(voice);

        // Reinitialize backend with new voice
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            const initMessage = {
                type: 'init',
                sourceLang: sourceLang,
                targetLang: targetLang,
                tier: 'basic',
                sessionId: sessionIdRef.current,
                voiceId: voice.voiceId,
                ttsMode: streamingTts ? 'streaming' : 'unary', // Tell backend which TTS mode to use
                profanityFilter: profanityFilter
            };

            console.log('[SoloPage] 📤 Sending init message (voice update):', initMessage);
            wsRef.current.send(JSON.stringify(initMessage));
        }
    }, [sourceLang, targetLang]);




    // Handle mode change
    const handleModeChange = useCallback((newMode) => {
        session.setMode(newMode);

        // If switching to text-only, stop TTS
        if (newMode === SoloMode.TEXT_ONLY) {
            ttsQueue.stopTts();
        }
    }, [session, ttsQueue]);

    // Connect on mount
    useEffect(() => {
        connect();

        return () => {
            audioCapture.stopRecording();
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
    }, []);

    // Re-fetch voices when target language changes AND server is ready
    useEffect(() => {
        if (isConnected && isServerReady && wsRef.current?.readyState === WebSocket.OPEN) {
            const normalizedLang = normalizeLanguageCode(targetLang);
            console.log('[SoloPage] Fetching voices for:', targetLang, `(normalized: ${normalizedLang})`);
            wsRef.current.send(JSON.stringify({
                type: 'tts/list_voices',
                languageCode: normalizedLang
            }));
        }
    }, [targetLang, isConnected, isServerReady]);

    // Send updated init when streamingTts changes (so backend knows the TTS mode)
    useEffect(() => {
        if (isConnected && isServerReady && wsRef.current?.readyState === WebSocket.OPEN) {
            const initMessage = {
                type: 'init',
                sourceLang,
                targetLang,
                tier: 'basic',
                sessionId: sessionIdRef.current,
                voiceId: selectedVoice?.voiceId || null,
                ttsMode: streamingTts ? 'streaming' : 'unary',
                profanityFilter: profanityFilter
            };
            console.log('[SoloPage] 📤 Sending init (streamingTts changed):', initMessage);
            wsRef.current.send(JSON.stringify(initMessage));
        }
    }, [streamingTts, isConnected, isServerReady, sourceLang, targetLang, selectedVoice]);

    // Get display state
    const getDisplayState = () => {
        if (!isConnected) return 'Connecting...';
        if (session.state === SessionState.IDLE) return 'Ready';
        if (session.state === SessionState.LISTENING) return 'Listening...';
        if (session.state === SessionState.FINALIZING) return 'Processing...';
        if (session.state === SessionState.SPEAKING) return 'Speaking...';
        return 'Ready';
    };

    return (
        <div className="solo-page">
            {/* Header */}
            <header className="solo-header">
                <button
                    className="back-button"
                    onClick={onBackToHome}
                    aria-label="Back to home"
                >
                    <ArrowLeft size={24} />
                </button>

                <h1 className="solo-title">Solo Mode</h1>

                <button
                    className="settings-button"
                    onClick={() => setShowSettings(true)}
                    aria-label="Settings"
                >
                    <Settings size={24} />
                </button>
            </header>

            {/* Mode Selector */}
            <ModeSelector
                mode={session.mode}
                onChange={handleModeChange}
            />

            {/* Language Selector */}
            <LanguageSelector
                sourceLang={sourceLang}
                targetLang={targetLang}
                onSourceChange={(lang) => handleLanguageChange('source', lang)}
                onTargetChange={(lang) => handleLanguageChange('target', lang)}
            />

            {/* Main Status Area */}
            <div className="solo-main">
                {/* Status Indicator */}
                <StatusIndicator
                    state={session.state}
                    isConnected={isConnected}
                />

                {/* Turn Indicator (bi-directional auto-detect status) */}
                {session.mode === SoloMode.CONVERSATION && (
                    <TurnIndicator
                        sourceLang={sourceLang}
                        targetLang={targetLang}
                    />
                )}

                {/* RTS Routing Overlay (Debug only) */}
                {import.meta.env.VITE_ENABLE_DEBUG_ROUTING === 'true' && (
                    <TtsRoutingOverlay
                        isActive={!!activeRouting}
                        {...activeRouting}
                    />
                )}

                {/* Queue Badge */}
                {ttsQueue.queueLength > 0 && (
                    <PlaybackQueueBadge count={ttsQueue.queueLength} />
                )}

                {/* Streaming Status */}
                <TtsStreamingControl
                    isEnabled={streamingTts}
                    isConnected={ttsStreaming.isConnected}
                    isPlaying={ttsStreaming.isPlaying}
                    bufferedMs={ttsStreaming.bufferedMs}
                    stats={ttsStreaming.stats}
                />
            </div>

            {/* Transcript Panel */}
            <TranscriptPanel
                partialText={session.partialText}
                segments={session.finalizedSegments}
                showTranslation={session.mode !== SoloMode.TEXT_ONLY || sourceLang !== targetLang}
                onPlay={useCallback((segment) => {
                    const textToSpeak = segment.translatedText || segment.originalText;
                    if (!textToSpeak) return;

                    console.log('[SoloPage] Replaying segment:', segment.id);
                    ttsQueue.enqueue({
                        text: segment.originalText,
                        translatedText: textToSpeak,
                        languageCode: normalizeLanguageCode(targetLangRef.current),
                        voiceId: selectedVoice?.voiceId
                    });
                    // If queue was empty, we need to make sure audio context is resumed and TTS is started?
                    // ttsQueue.startTts() handles context resume, but manual enqueue might work if already started.
                    // Assuming 'Started Listening' state means TTS is started. 
                }, [ttsQueue, selectedVoice])}
            />

            {/* Control Button */}
            <div className="solo-controls">
                {/* Session Timer Bar */}
                {sessionTimer.isRunning && (
                    <div className="session-timer-bar">
                        <span className="timer-icon">⏱️</span>
                        <span className="timer-elapsed">{sessionTimer.formattedTime}</span>
                        <span className="timer-separator">|</span>
                        <span className="timer-remaining">Solo Session Active</span>
                    </div>
                )}
                {session.state === SessionState.IDLE ? (
                    <button
                        className="control-button start"
                        onClick={handleStart}
                        disabled={!isConnected || quotaWarning.isRecordingBlocked}
                    >
                        <Mic size={32} />
                        <span>{quotaWarning.isRecordingBlocked ? 'Quota Exceeded' : 'Start Listening'}</span>
                    </button>
                ) : (
                    <button
                        className="control-button stop"
                        onClick={handleStop}
                    >
                        <VolumeX size={32} />
                        <span>Stop</span>
                    </button>
                )}
            </div>

            {/* Settings Drawer */}
            {showSettings && (
                <AdvancedSettingsDrawer
                    isOpen={showSettings}
                    onClose={() => setShowSettings(false)}
                    silenceThreshold={silenceThreshold}
                    onSilenceThresholdChange={setSilenceThreshold}
                    speakerPriority={speakerPriority}
                    onSpeakerPriorityChange={setSpeakerPriority}
                    streamingTts={streamingTts}
                    onStreamingTtsChange={setStreamingTts}
                    profanityFilter={profanityFilter}
                    onProfanityFilterChange={setProfanityFilter}
                    availableVoices={availableVoices}
                    selectedVoice={selectedVoice}
                    onVoiceChange={handleVoiceChange}
                    planCode={planCode}
                />
            )}

            {/* Quota Warning Toast */}
            {quotaWarning.showToast && (
                <QuotaWarningToast
                    quotaEvent={quotaWarning.quotaEvent}
                    onDismiss={quotaWarning.dismiss}
                    onShowModal={quotaWarning.openModal}
                />
            )}

            {/* Quota Limit Modal */}
            {quotaWarning.showModal && (
                <UsageLimitModal
                    quotaEvent={quotaWarning.quotaEvent}
                    onDismiss={quotaWarning.dismiss}
                    onAction={quotaWarning.handleAction}
                />
            )}

            {/* Styles */}
            <style>{`
        .solo-page {
          display: flex;
          flex-direction: column;
          min-height: 100vh;
          background: linear-gradient(135deg, #f8fafc 0%, #ffffff 50%, #f1f5f9 100%);
          color: #1f2937;
          font-family: 'Inter', -apple-system, sans-serif;
        }
        
        .solo-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 1rem 1.5rem;
          background: rgba(255, 255, 255, 0.8);
          backdrop-filter: blur(10px);
          border-bottom: 1px solid rgba(59, 91, 255, 0.1);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
        }
        
        .back-button,
        .settings-button {
          background: rgba(59, 91, 255, 0.05);
          border: 1px solid rgba(59, 91, 255, 0.1);
          border-radius: 12px;
          padding: 0.75rem;
          color: #3B5BFF;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .back-button:hover,
        .settings-button:hover {
          background: rgba(59, 91, 255, 0.1);
          transform: scale(1.05);
        }
        
        .solo-title {
          font-size: 1.25rem;
          font-weight: 600;
          margin: 0;
          background: linear-gradient(135deg, #3B5BFF, #2563eb);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        
        .solo-main {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 2rem;
          gap: 1.5rem;
        }
        
        .solo-controls {
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: rgba(255, 255, 255, 0.7);
          border-top: 1px solid rgba(59, 91, 255, 0.1);
        }
        
        .control-button {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 1rem 2rem;
          border: none;
          border-radius: 50px;
          font-size: 1.1rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s;
        }
        
        .control-button.start {
          background: linear-gradient(135deg, #3B5BFF, #2563eb);
          color: #fff;
          box-shadow: 0 4px 20px rgba(59, 91, 255, 0.3);
        }
        
        .control-button.start:hover:not(:disabled) {
          transform: scale(1.05);
          box-shadow: 0 6px 30px rgba(59, 91, 255, 0.4);
        }
        
        .control-button.start:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .control-button.stop {
          background: linear-gradient(135deg, #ef4444, #dc2626);
          color: #fff;
          box-shadow: 0 4px 20px rgba(239, 68, 68, 0.4);
        }
        
        .control-button.stop:hover {
          transform: scale(1.05);
          box-shadow: 0 6px 30px rgba(239, 68, 68, 0.6);
        }
        
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
        </div>
    );
}

export default SoloPage;
// Force rebuild Fri Feb  6 16:24:13 CST 2026
