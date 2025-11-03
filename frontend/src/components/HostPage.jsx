/**
 * Host Page - For the speaker/preacher to broadcast live translations
 */

import { useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import QRCode from 'qrcode';
import { useAudioCapture } from '../hooks/useAudioCapture';
import { Header } from './Header';
import { ConnectionStatus } from './ConnectionStatus';
import { LanguageSelector } from './LanguageSelector';
import { SentenceSegmenter } from '../utils/sentenceSegmenter';

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

const API_URL = import.meta.env.VITE_API_URL || getBackendUrl();
const WS_URL = import.meta.env.VITE_WS_URL || getWebSocketUrl();

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)' },
  { code: 'ru', name: 'Russian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'bn', name: 'Bengali' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'id', name: 'Indonesian' },
  { code: 'sv', name: 'Swedish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'da', name: 'Danish' },
  { code: 'fi', name: 'Finnish' },
  { code: 'el', name: 'Greek' },
  { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'he', name: 'Hebrew' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'fa', name: 'Persian' },
  { code: 'ur', name: 'Urdu' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'mr', name: 'Marathi' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'kn', name: 'Kannada' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'sw', name: 'Swahili' },
  { code: 'fil', name: 'Filipino' },
  { code: 'ms', name: 'Malay' },
  { code: 'ca', name: 'Catalan' },
  { code: 'sk', name: 'Slovak' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'hr', name: 'Croatian' },
  { code: 'sr', name: 'Serbian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'lv', name: 'Latvian' },
  { code: 'et', name: 'Estonian' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'af', name: 'Afrikaans' }
];

export function HostPage({ onBackToHome }) {
  const [sessionCode, setSessionCode] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [sourceLang, setSourceLang] = useState('en');
  const [connectionState, setConnectionState] = useState('disconnected');
  const [transcript, setTranscript] = useState([]);
  const [currentTranscript, setCurrentTranscript] = useState(''); // Live partial transcription
  const [isStreaming, setIsStreaming] = useState(false);
  const [listenerCount, setListenerCount] = useState(0);
  const [languageStats, setLanguageStats] = useState({});
  const [error, setError] = useState('');

  const wsRef = useRef(null);
  const { startRecording, stopRecording, isRecording, audioLevel } = useAudioCapture();
  
  // Throttling refs for smooth partial updates (20fps max)
  const lastUpdateTimeRef = useRef(0);
  const pendingTextRef = useRef(null);
  const throttleTimerRef = useRef(null);
  
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
        
        // Generate QR code with join URL
        const joinUrl = `${window.location.origin}?join=${data.sessionCode}`;
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
        sourceLang: sourceLang
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
            // ✨ REAL-TIME STREAMING: Sentence segmented + throttled display
            if (message.isPartial) {
              const rawText = message.originalText || message.translatedText;
              const now = Date.now();
              
              // Process through segmenter (auto-flushes complete sentences)
              const { liveText } = segmenterRef.current.processPartial(rawText);
              
              // Store the segmented text
              pendingTextRef.current = liveText;
              
              // THROTTLE: Update max 20 times per second (50ms intervals)
              const timeSinceLastUpdate = now - lastUpdateTimeRef.current;
              
              if (timeSinceLastUpdate >= 50) {
                // Immediate update with forced sync render
                lastUpdateTimeRef.current = now;
                flushSync(() => {
                  setCurrentTranscript(liveText);
                });
              } else {
                // Schedule delayed update
                if (throttleTimerRef.current) {
                  clearTimeout(throttleTimerRef.current);
                }
                
                throttleTimerRef.current = setTimeout(() => {
                  const latestText = pendingTextRef.current;
                  if (latestText !== null) {
                    lastUpdateTimeRef.current = Date.now();
                    flushSync(() => {
                      setCurrentTranscript(latestText);
                    });
                  }
                }, 50);
              }
            } else {
              // Final transcript - process through segmenter (deduplicated)
              const finalText = message.originalText || message.translatedText;
              const { flushedSentences } = segmenterRef.current.processFinal(finalText);
              
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
        sourceLang: lang
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

          {/* Language Selection */}
          <div className="mb-4 sm:mb-6">
            <LanguageSelector
              label="Speaking Language"
              languages={LANGUAGES}
              selectedLanguage={sourceLang}
              onLanguageChange={handleSourceLangChange}
            />
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

