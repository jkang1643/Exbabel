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
]

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
    console.log('[TranslationInterface] 📝 STATE: finalTranslations updated to', count, 'items');
    console.log('[TranslationInterface] 📝 STATE: finalTranslations value:', finalTranslations);
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
  
  // Throttle mechanism for smooth streaming
  const lastUpdateTimeRef = useRef(0)
  const pendingTextRef = useRef(null)
  const throttleTimerRef = useRef(null)
  
  // Sentence segmenter for smart text management
  const segmenterRef = useRef(null)
  const sendMessageRef = useRef(null)
  
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
              setFinalTranslations(prev => [...prev, {
                id: Date.now() + Math.random(),
                original: '',
                translated: joinedText,
                timestamp: Date.now(),
                sequenceId: -1,
                isSegmented: true  // Flag to indicate this was auto-segmented
              }])
            })
            console.log(`[TranslationInterface] ✅ Flushed to history with paint: "${joinedText.substring(0, 40)}..."`)
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
      
      if (hostname !== 'localhost' && !ipv4Pattern.test(hostname)) {
        return 'ws://localhost:3001/translate';
      }
      
      return `ws://${hostname}:3001/translate`;
    };

    const websocketUrl = import.meta.env.VITE_WS_URL || getWebSocketUrl();
    const finalUrl = websocketUrl.endsWith('/translate') ? websocketUrl : websocketUrl + '/translate';
    console.log('[TranslationInterface] 🔌 WebSocket URL:', finalUrl);
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
  
  // Helper function to commit final to history
  // CRITICAL: Use ref to store function to avoid closure issues in timeout callbacks
  const commitFinalToHistoryRef = useRef(null);
  
  // Define the commit function - recreate when component mounts/updates
  useEffect(() => {
    commitFinalToHistoryRef.current = (finalData) => {
      console.log(`[TranslationInterface] ✅ COMMIT FUNCTION CALLED - seqId=${finalData?.seqId}`, finalData)
      
      if (!finalData || !finalData.text) {
        console.warn('[TranslationInterface] ⚠️ Invalid finalData, skipping commit');
        return;
      }
      
      // Process through segmenter to flush ONLY NEW text (deduplicated)
      const { flushedSentences } = segmenterRef.current.processFinal(finalData.text)
      
      console.log(`[TranslationInterface] 📊 Segmenter returned ${flushedSentences.length} sentences:`, flushedSentences);
      
      // Add deduplicated sentences to history - use flushSync for immediate UI update
      if (flushedSentences.length > 0) {
        const joinedText = flushedSentences.join(' ').trim()
        if (joinedText) {
          flushSync(() => {
            setFinalTranslations(prev => {
              const newHistory = [...prev, {
                id: Date.now(),
                original: finalData.original || '',
                translated: joinedText,
                timestamp: finalData.timestamp || Date.now(),
                sequenceId: finalData.seqId
              }]
              console.log(`[TranslationInterface] ✅ STATE UPDATED - New history total: ${newHistory.length} items`);
              return newHistory;
            })
          })
          console.log(`[TranslationInterface] ✅ Added to history: "${joinedText.substring(0, 50)}..."`);
        }
      } else {
        // FALLBACK: If segmenter deduplicated everything, still add the final text if it's substantial
        // This ensures history appears even if deduplication is too aggressive
        const finalText = finalData.text.trim();
        if (finalText.length > 10) {
          console.log(`[TranslationInterface] ⚠️ Segmenter deduplicated all, using fallback`);
          flushSync(() => {
            setFinalTranslations(prev => {
              const newHistory = [...prev, {
                id: Date.now(),
                original: finalData.original || '',
                translated: finalText,
                timestamp: finalData.timestamp || Date.now(),
                sequenceId: finalData.seqId
              }]
              console.log(`[TranslationInterface] ✅ FALLBACK STATE UPDATED - New history total: ${newHistory.length} items`);
              return newHistory;
            })
          })
        } else {
          console.log('[TranslationInterface] ⚠️ No new sentences and text too short - NOT adding to history');
        }
      }
      
      // Clear live partial for next segment
      setLivePartial('')
      setLivePartialOriginal('')
      
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
  
  // Define message handler with useCallback to prevent re-creation
  const handleWebSocketMessage = useCallback((message) => {
    console.log('[TranslationInterface] 🔔 MESSAGE HANDLER CALLED:', message.type, message.isPartial ? '(PARTIAL)' : '(FINAL)', `seqId: ${message.seqId}`)
    
    // Drop stale messages (out of order)
    if (message.seqId !== undefined && message.seqId < latestSeqIdRef.current) {
      console.log(`[TranslationInterface] ⚠️ Dropping stale message seqId=${message.seqId} (latest=${latestSeqIdRef.current})`);
      return;
    }
    
    if (message.seqId !== undefined) {
      latestSeqIdRef.current = Math.max(latestSeqIdRef.current, message.seqId);
    }
    
    switch (message.type) {
      case 'session_ready':
        console.log('[TranslationInterface] ✅ Translation session ready')
        break
      case 'translation':
        if (message.isPartial) {
          // 🔴 LIVE PARTIAL: Run through sentence segmenter + throttle for smooth streaming
          const isTranslationMode = sourceLang !== targetLang
          const hasTranslation = message.hasTranslation
          
          // For translation mode, show both original and translated
          if (isTranslationMode) {
            // Always update original immediately (transcription is instant)
            const originalText = message.originalText || ''
            if (originalText) {
              setLivePartialOriginal(originalText)
            }
            
            // Update translation (might be delayed due to throttling)
            // Show translation when hasTranslation is true OR when translatedText exists
            const translatedText = message.translatedText
            
            if (hasTranslation && translatedText && translatedText.trim()) {
              // CRITICAL: Only show translation if it's DIFFERENT from original (prevents English glitch)
              // Check both exact match and trimmed match to catch all cases
              const isDifferent = translatedText !== originalText && 
                                  translatedText.trim() !== originalText.trim() &&
                                  translatedText.toLowerCase() !== originalText.toLowerCase();
              
              if (isDifferent) {
                const now = Date.now()
                
                pendingTextRef.current = translatedText
                const timeSinceLastUpdate = now - lastUpdateTimeRef.current
                
                // Adaptive throttle: Longer translations need more frequent updates
                // For longer text (>300 chars), reduce throttle to 30ms to keep up
                const throttleMs = translatedText.length > 300 ? 30 : 50;
                
                if (timeSinceLastUpdate >= throttleMs) {
                  lastUpdateTimeRef.current = now
                  flushSync(() => {
                    setLivePartial(translatedText)
                  })
                  console.log(`[TranslationInterface] ⚡ LIVE PARTIAL UPDATED (${translatedText.length} chars): "${translatedText.substring(0, 40)}..."`)
                } else {
                  if (throttleTimerRef.current) {
                    clearTimeout(throttleTimerRef.current)
                  }
                  
                throttleTimerRef.current = setTimeout(() => {
                  const latestText = pendingTextRef.current
                  // CRITICAL: Always update if we have text, even if it matches original briefly
                  // This ensures the last translation update always shows
                  if (latestText !== null && latestText.trim()) {
                    // Check if different from original (but don't skip if it's the last update)
                    const isDifferent = latestText !== originalText && 
                                        latestText.trim() !== originalText.trim();
                    
                    // For long text, always update even if same - might be final translation
                    const isLongText = latestText.length > 300;
                    if (isDifferent || isLongText) {
                      lastUpdateTimeRef.current = Date.now()
                      flushSync(() => {
                        setLivePartial(latestText)
                      })
                      console.log(`[TranslationInterface] ⏱️ THROTTLED LIVE PARTIAL (${latestText.length} chars): "${latestText.substring(0, 40)}..."`)
                    }
                  }
                }, throttleMs)
                }
              } else {
                console.log('[TranslationInterface] ⚠️ Translation equals original, skipping to prevent English glitch', {
                  translatedLength: translatedText.length,
                  originalLength: originalText.length,
                  areEqual: translatedText === originalText
                });
              }
            } else if (translatedText && translatedText.trim()) {
              // Fallback: Only show if it's definitely different from original
              const isDifferent = translatedText !== originalText && 
                                  translatedText.trim() !== originalText.trim() &&
                                  translatedText.toLowerCase() !== originalText.toLowerCase();
              
              if (isDifferent) {
                // Fallback: If translatedText exists and is different, show it even without hasTranslation flag
                const now = Date.now()
                pendingTextRef.current = translatedText
                const timeSinceLastUpdate = now - lastUpdateTimeRef.current
                
                if (timeSinceLastUpdate >= 50) {
                  lastUpdateTimeRef.current = now
                  flushSync(() => {
                    setLivePartial(translatedText)
                  })
                  console.log(`[TranslationInterface] ⚡ FALLBACK LIVE PARTIAL: "${translatedText.substring(0, 40)}..."`)
                } else {
                  if (throttleTimerRef.current) {
                    clearTimeout(throttleTimerRef.current)
                  }
                  throttleTimerRef.current = setTimeout(() => {
                    const latestText = pendingTextRef.current
                    // CRITICAL: Always update if we have text - ensure last translation shows
                    if (latestText !== null && latestText.trim()) {
                      const isDifferent = latestText !== originalText && 
                                          latestText.trim() !== originalText.trim();
                      const isLongText = latestText.length > 300;
                      if (isDifferent || isLongText) {
                        lastUpdateTimeRef.current = Date.now()
                        flushSync(() => {
                          setLivePartial(latestText)
                        })
                        console.log(`[TranslationInterface] ⏱️ FALLBACK THROTTLED: "${latestText.substring(0, 40)}..."`)
                      }
                    }
                  }, 50)
                }
              } else {
                console.log('[TranslationInterface] ⚠️ Fallback translation equals original, skipping');
              }
            } else {
              // No translation yet - don't update livePartial (prevents English from showing)
              // CRITICAL: Also clear livePartial if it matches original (defensive cleanup)
              if (livePartial && livePartial === livePartialOriginal) {
                console.log('[TranslationInterface] 🧹 CLEANUP: Clearing livePartial that matches original');
                setLivePartial('')
              }
              console.log('[TranslationInterface] ⏳ Waiting for translation...', { hasTranslation, hasTranslatedText: !!translatedText, originalLength: originalText.length });
            }
          } else {
            // Transcription-only mode - just show the text
            const rawText = message.originalText || message.translatedText
            const now = Date.now()
            
            // Process through segmenter (auto-flushes complete sentences to history)
            const { liveText } = segmenterRef.current.processPartial(rawText)
            
            // Store the segmented text
            pendingTextRef.current = liveText
            
            // THROTTLE: Update max 20 times per second (50ms intervals)
            const timeSinceLastUpdate = now - lastUpdateTimeRef.current
            
            if (timeSinceLastUpdate >= 50) {
              // Immediate update with forced sync render
              lastUpdateTimeRef.current = now
              flushSync(() => {
                setLivePartial(liveText)
              })
              console.log(`[TranslationInterface] ⚡ IMMEDIATE: "${liveText.substring(0, 30)}..." [${liveText.length}chars]`)
            } else {
              // Schedule delayed update
              if (throttleTimerRef.current) {
                clearTimeout(throttleTimerRef.current)
              }
              
              throttleTimerRef.current = setTimeout(() => {
                const latestText = pendingTextRef.current
                if (latestText !== null) {
                  lastUpdateTimeRef.current = Date.now()
                  flushSync(() => {
                    setLivePartial(latestText)
                  })
                  console.log(`[TranslationInterface] ⏱️ THROTTLED: "${latestText.substring(0, 30)}..." [${latestText.length}chars]`)
                }
              }, 50)
            }
          }
        } else {
          // 📝 FINAL: Commit immediately to history (restored simple approach)
          const finalText = message.translatedText
          const finalSeqId = message.seqId
          console.log(`[TranslationInterface] 📝 FINAL received seqId=${finalSeqId}: "${finalText.substring(0, 50)}..."`)
          
          // Cancel any pending final timeout (in case we had one)
          if (pendingFinalRef.current && pendingFinalRef.current.timeout) {
            clearTimeout(pendingFinalRef.current.timeout);
            pendingFinalRef.current = null;
          }
          
          // Commit immediately - process through segmenter and add to history
          const finalData = {
            text: finalText,
            original: message.originalText || '',
            timestamp: message.timestamp || Date.now(),
            serverTimestamp: message.serverTimestamp,
            seqId: finalSeqId
          };
          
          // Call commit function immediately
          if (commitFinalToHistoryRef.current) {
            commitFinalToHistoryRef.current(finalData);
          } else {
            console.error('[TranslationInterface] ❌ commitFinalToHistoryRef.current is null, using fallback');
            // FALLBACK: Direct commit if ref isn't ready
            const { flushedSentences } = segmenterRef.current.processFinal(finalText);
            if (flushedSentences.length > 0 || finalText.length > 10) {
              const textToAdd = flushedSentences.length > 0 ? flushedSentences.join(' ').trim() : finalText;
              if (textToAdd) {
                setFinalTranslations(prev => [...prev, {
                  id: Date.now(),
                  original: finalData.original,
                  translated: textToAdd,
                  timestamp: finalData.timestamp,
                  sequenceId: finalSeqId
                }]);
                console.log(`[TranslationInterface] ✅ FALLBACK: Added to history: "${textToAdd.substring(0, 50)}..."`);
              }
            }
            setLivePartial('')
            setLivePartialOriginal('')
          }
        }
        break
      case 'warning':
        console.warn('[TranslationInterface] ⚠️ Warning:', message.message)
        // Could show a toast notification here
        break
        
      case 'error':
        console.error('[TranslationInterface] ❌ Translation error:', message.message)
        // Show quota errors prominently
        if (message.code === 1011 || message.message.includes('Quota') || message.message.includes('quota')) {
          alert('⚠️ API Quota Exceeded!\n\n' + message.message + '\n\nPlease check your API limits and try again later.')
        }
        break
      default:
        console.log('[TranslationInterface] ⚠️ Unknown message type:', message.type)
    }
  }, [commitFinalToHistory]) // Include commitFinalToHistory in dependencies
  
  useEffect(() => {
    console.log('[TranslationInterface] 🚀 Initializing WebSocket connection')
    connect()
    
    // Add message handler
    const removeHandler = addMessageHandler(handleWebSocketMessage)
    
    // Handle tab visibility changes (background/foreground)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        console.log('[TranslationInterface] 📴 Tab hidden - notifying server');
        sendMessage({
          type: 'client_hidden'
        });
      } else {
        console.log('[TranslationInterface] 📴 Tab visible - notifying server');
        sendMessage({
          type: 'client_visible'
        });
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      console.log('[TranslationInterface] 🔌 Cleaning up WebSocket')
      removeHandler()
      disconnect()
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  }, [handleWebSocketMessage, sendMessage])

  useEffect(() => {
    if (connectionState === 'open') {
      setIsConnected(true)
      console.log('[TranslationInterface] 📡 WebSocket OPEN - Initializing session')
      // Initialize translation session
      sendMessage({
        type: 'init',
        sourceLang,
        targetLang
      })
    } else {
      setIsConnected(false)
      if (connectionState !== 'connecting') {
        console.log('[TranslationInterface] ⚠️ WebSocket state:', connectionState)
      }
    }
  }, [connectionState, sourceLang, targetLang]) // Remove sendMessage from deps to prevent re-render loop

  const handleStartListening = async () => {
    if (!isConnected) return
    
    try {
      // Enable streaming mode (second parameter = true)
      await startRecording((audioChunk, metadata) => {
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
    } catch (error) {
      console.error('Failed to start recording:', error)
      
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

  const handleStopListening = () => {
    stopRecording()
    setIsListening(false)
    
    // Reset segmenter deduplication memory after significant stop
    // This prevents old text from interfering with new sessions
    setTimeout(() => {
      if (segmenterRef.current) {
        console.log('[TranslationInterface] 🔄 Resetting segmenter deduplication memory')
        segmenterRef.current.reset()
      }
    }, 2000) // Wait 2 seconds after stop before resetting
  }

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
              isConnected={isConnected} 
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
            languages={LANGUAGES}
            selectedLanguage={sourceLang}
            onLanguageChange={(lang) => handleLanguageChange('source', lang)}
          />
          <LanguageSelector
            label="Target Language"
            languages={LANGUAGES}
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
                <label className={`flex items-center space-x-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                  audioSource === 'microphone' 
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
                <label className={`flex items-center space-x-2 p-2 rounded-lg border transition-colors ${
                  !systemAudioSupported
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
            className={`w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center transition-all transform hover:scale-105 ${
              isListening
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
                      className={`w-1 h-3 sm:h-4 rounded transition-all ${
                        i < (audioLevel * 5) ? 'bg-red-500' : 'bg-gray-300'
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
