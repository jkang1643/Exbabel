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

export function HostPage({ onBackToHome }) {
  const [sessionCode, setSessionCode] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [sourceLang, setSourceLang] = useState('en');
  const [usePremiumTier, setUsePremiumTier] = useState(false); // Tier selection: false = basic, true = premium
  const [showSettings, setShowSettings] = useState(false);
  const [connectionState, setConnectionState] = useState('disconnected');
  const [transcript, setTranscript] = useState([]);
  const [currentTranscript, setCurrentTranscript] = useState(''); // Live partial transcription
  const [isStreaming, setIsStreaming] = useState(false);
  const [listenerCount, setListenerCount] = useState(0);
  const [languageStats, setLanguageStats] = useState({});
  const [error, setError] = useState('');

  const wsRef = useRef(null);
  
  // Track corrected text for merging (similar to TranslationInterface.jsx)
  const longestCorrectedTextRef = useRef('');
  const longestCorrectedOriginalRef = useRef('');
  
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
  const segmenterRef = useRef(null);
  if (!segmenterRef.current) {
    segmenterRef.current = new SentenceSegmenter({
      maxSentences: 10,     // Increased to allow more sentences in live view
      maxChars: 2000,       // Increased to handle longer text (prevents premature flushing)
      maxTimeMs: 15000,
      onFlush: (flushedSentences) => {
        const joinedText = flushedSentences.join(' ').trim();
        if (joinedText) {
          setTranscript(prev => [...prev, {
            text: joinedText,
            timestamp: Date.now()
          }].slice(-10));
        }
      }
    });
  }

  // Create session on mount
  useEffect(() => {
    createSession();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const createSession = async () => {
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
        
        // Connect WebSocket
        connectWebSocket(data.sessionId);
      } else {
        setError('Failed to create session');
      }
    } catch (err) {
      console.error('Failed to create session:', err);
      setError('Failed to create session. Please check your connection.');
    }
  };

  const connectWebSocket = (sessionId) => {
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
    };
    
    ws.onerror = (error) => {
      console.error('[Host] WebSocket error:', error);
      setConnectionState('error');
    };
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
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

              // REAL-TIME STREAMING FIX: Update immediately on every delta for true real-time streaming
              // No throttling - let React batch updates naturally for optimal performance
              flushSync(() => {
                setCurrentTranscript(liveText);
              });
            } else {
              // Final transcript - process through segmenter (deduplicated)
              // CRITICAL: Use correctedText if available (grammar corrections), otherwise fall back to originalText or translatedText
              // This ensures grammar corrections and recovered text are applied to finals
              const finalText = message.correctedText || message.translatedText || message.originalText;
              
              // Reset correction tracking for next segment
              longestCorrectedTextRef.current = '';
              longestCorrectedOriginalRef.current = '';
              
              const { flushedSentences } = segmenterRef.current.processFinal(finalText, { isForced: message.forceFinal === true });
              
              // Add deduplicated sentences to history
              if (flushedSentences.length > 0) {
                const joinedText = flushedSentences.join(' ').trim();
                setTranscript(prev => [...prev, {
                  text: joinedText,
                  timestamp: message.timestamp || Date.now()
                }].slice(-10));
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

