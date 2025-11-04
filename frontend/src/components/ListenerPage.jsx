/**
 * Listener Page - For audience members to receive live translations
 */

import { useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { Header } from './Header';
import { ConnectionStatus } from './ConnectionStatus';
import { LanguageSelector } from './LanguageSelector';
import { SentenceSegmenter } from '../utils/sentenceSegmenter';

// Dynamically determine backend URL based on frontend URL
// If accessing via network IP, use the same IP for backend
const getBackendUrl = () => {
  const hostname = window.location.hostname;
  console.log('[ListenerPage] Detected hostname:', hostname);
  
  // Validate IP address format
  const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  
  if (hostname !== 'localhost' && !ipv4Pattern.test(hostname)) {
    console.error('[ListenerPage] Invalid hostname format, using localhost');
    return 'http://localhost:3001';
  }
  
  return `http://${hostname}:3001`;
};

const getWebSocketUrl = () => {
  const hostname = window.location.hostname;
  
  // Validate IP address format
  const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  
  if (hostname !== 'localhost' && !ipv4Pattern.test(hostname)) {
    console.error('[ListenerPage] Invalid hostname format, using localhost');
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

export function ListenerPage({ sessionCodeProp, onBackToHome }) {
  const [sessionCode, setSessionCode] = useState(sessionCodeProp || '');
  const [isJoined, setIsJoined] = useState(false);
  const [userName, setUserName] = useState('');
  const [targetLang, setTargetLang] = useState('es');
  const [connectionState, setConnectionState] = useState('disconnected');
  const [translations, setTranslations] = useState([]);
  const [currentTranslation, setCurrentTranslation] = useState(''); // Live partial translation
  const [currentOriginal, setCurrentOriginal] = useState(''); // Live partial original text
  const [sessionInfo, setSessionInfo] = useState(null);
  const [error, setError] = useState('');
  const [isJoining, setIsJoining] = useState(false);

  const wsRef = useRef(null);
  const translationsEndRef = useRef(null);
  
  // Throttling refs for smooth partial updates (20fps max)
  const lastUpdateTimeRef = useRef(0);
  const pendingTextRef = useRef(null);
  const throttleTimerRef = useRef(null);
  
  // Sentence segmenter for smart text management
  // Note: For listener mode, we disable auto-flush to history since backend sends finals
  const segmenterRef = useRef(null);
  if (!segmenterRef.current) {
    segmenterRef.current = new SentenceSegmenter({
      maxSentences: 10,     // Increased to allow more sentences in live view
      maxChars: 2000,       // Increased to handle longer text (prevents premature flushing)
      maxTimeMs: 15000,
      onFlush: (flushedSentences) => {
        // DO NOT add to history in listener mode - finals come from backend
        // Just log for debugging
        console.log('[ListenerPage] Segmenter auto-flushed (ignored):', flushedSentences.join(' ').substring(0, 50));
      }
    });
  }

  // Auto-scroll to latest translation
  useEffect(() => {
    translationsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [translations]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
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
    const ws = new WebSocket(
      `${WS_URL}/translate?role=listener&sessionId=${sessionId}&targetLang=${lang}&userName=${encodeURIComponent(name)}`
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
        
        switch (message.type) {
          case 'session_joined':
            console.log('[Listener] Joined session:', message.sessionCode);
            break;
          
          case 'translation':
            // ✨ REAL-TIME STREAMING: Sentence segmented + throttled display
            if (message.isPartial) {
              const originalText = message.originalText || '';
              const translatedText = message.translatedText || message.originalText;
              const now = Date.now();
              
              // Always update original text immediately (transcription)
              if (originalText) {
                setCurrentOriginal(originalText);
              }
              
              // Only update translation if this message is actually intended for this listener's language
              // Check if: 1) It has a real translation (hasTranslation: true), AND
              //           2) The message target language matches the listener's target language
              const isForMyLanguage = message.hasTranslation && message.targetLang === targetLang;
              
              // Special case: If listener wants same language as source (transcription only)
              const isTranscriptionMode = targetLang === message.sourceLang;
              
              const shouldUpdateTranslation = isForMyLanguage || isTranscriptionMode;
              
              console.log(`[ListenerPage] 🔍 Partial: hasTranslation=${message.hasTranslation}, msgTarget=${message.targetLang}, myTarget=${targetLang}, shouldUpdate=${shouldUpdateTranslation}`);
              
              if (shouldUpdateTranslation) {
                // Process translated text through segmenter (auto-flushes complete sentences)
                const { liveText } = segmenterRef.current.processPartial(translatedText);
                
                // Store the segmented text
                pendingTextRef.current = liveText;
                
                // Handle streaming incremental updates with faster throttling
                const isIncremental = message.isIncremental || false;
                
                // THROTTLE: Streaming updates get faster throttling (20-30ms) vs normal (50ms)
                const throttleMs = isIncremental 
                  ? (translatedText.length > 300 ? 20 : 30) // Streaming: faster updates
                  : 50; // Non-streaming: normal updates
                
                const timeSinceLastUpdate = now - lastUpdateTimeRef.current;
                
                if (timeSinceLastUpdate >= throttleMs) {
                  // Immediate update with forced sync render
                  lastUpdateTimeRef.current = now;
                  flushSync(() => {
                    setCurrentTranslation(liveText);
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
                        setCurrentTranslation(latestText);
                      });
                    }
                  }, throttleMs);
                }
              }
            } else {
              // Final translation - add to history directly (no segmenter needed for finals)
              const finalText = message.translatedText;
              const originalText = message.originalText || '';
              
              console.log('[ListenerPage] 📝 Final received:', finalText.substring(0, 50));
              
              // Deduplicate: Check if this exact text was already added recently
              setTranslations(prev => {
                // Check last 3 entries for duplicates
                const recentEntries = prev.slice(-3);
                const isDuplicate = recentEntries.some(entry => 
                  entry.translated === finalText || 
                  (entry.original === originalText && originalText.length > 0)
                );
                
                if (isDuplicate) {
                  console.log('[ListenerPage] ⚠️ Duplicate final detected, skipping');
                  return prev;
                }
                
                return [...prev, {
                  original: originalText,
                  translated: finalText,
                  timestamp: message.timestamp || Date.now()
                }].slice(-50);
              });
              
              // Clear live displays
              setCurrentTranslation('');
              setCurrentOriginal('');
              
              // Reset segmenter to clear any buffered partial text
              if (segmenterRef.current) {
                segmenterRef.current.reset();
              }
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
        }
      } catch (err) {
        console.error('[Listener] Failed to parse message:', err);
      }
    };
    
    wsRef.current = ws;
  };

  const handleChangeLanguage = (newLang) => {
    setTargetLang(newLang);
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'change_language',
        targetLang: newLang
      }));
      
      // Clear old translations and current text when changing language
      setTranslations([]);
      setCurrentTranslation('');
      setCurrentOriginal('');
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
                  <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{animationDelay: '0.15s'}}></div>
                  <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{animationDelay: '0.3s'}}></div>
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

