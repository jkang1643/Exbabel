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
  
  // Lag detection and catch-up mode
  const messageTimestampsRef = useRef([]) // Track message arrival times
  const catchUpModeRef = useRef(false) // Flag for catch-up mode
  const lastTextLengthRef = useRef(0) // Track text length to detect rapid growth
  
  // Track longest grammar-corrected text to merge with new raw partials
  const longestCorrectedTextRef = useRef('')
  const longestCorrectedOriginalRef = useRef('')
  
  // Sentence segmenter for smart text management
  const segmenterRef = useRef(null)
  const sendMessageRef = useRef(null)
  const handleStopListeningRef = useRef(null)
  
  // Function to detect lag and activate catch-up mode
  const detectLag = useCallback((currentTextLength) => {
    const now = Date.now()
    messageTimestampsRef.current.push(now)
    
    // Keep only last 10 timestamps (last ~1-2 seconds)
    if (messageTimestampsRef.current.length > 10) {
      messageTimestampsRef.current.shift()
    }
    
    // Detect rapid text growth (indicates backlog)
    const textGrowth = currentTextLength - lastTextLengthRef.current
    lastTextLengthRef.current = currentTextLength
    
    // Check if messages are arriving faster than we can process
    if (messageTimestampsRef.current.length >= 5) {
      const timeSpan = messageTimestampsRef.current[messageTimestampsRef.current.length - 1] - messageTimestampsRef.current[0]
      const messagesPerSecond = (messageTimestampsRef.current.length / timeSpan) * 1000
      
      // If receiving > 5 messages/second OR text growing > 100 chars per update, we're lagging
      const isLagging = messagesPerSecond > 5 || textGrowth > 100 || currentTextLength > 1500
      
      if (isLagging && !catchUpModeRef.current) {
        console.log('[TranslationInterface] 🚀 CATCH-UP MODE ACTIVATED (lag detected)')
        catchUpModeRef.current = true
        
        // Temporarily reduce segmenter thresholds for faster flushing
        if (segmenterRef.current) {
          segmenterRef.current.maxSentences = 3 // Reduced from 10
          segmenterRef.current.maxChars = 800   // Reduced from 2000
          segmenterRef.current.maxTimeMs = 3000 // Reduced from 15000
        }
      } else if (!isLagging && catchUpModeRef.current && currentTextLength < 500) {
        // Deactivate catch-up mode when caught up
        console.log('[TranslationInterface] ✅ CATCH-UP MODE DEACTIVATED (caught up)')
        catchUpModeRef.current = false
        
        // Restore normal thresholds
        if (segmenterRef.current) {
          segmenterRef.current.maxSentences = 10
          segmenterRef.current.maxChars = 2000
          segmenterRef.current.maxTimeMs = 15000
        }
      }
    }
    
    return catchUpModeRef.current
  }, [])
  
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
                
                return newHistory;
              })
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
              
              console.log(`[TranslationInterface] ✅ STATE UPDATED - New history total: ${newHistory.length} items (sorted by seqId/timestamp)`);
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
              
              console.log(`[TranslationInterface] ✅ FALLBACK STATE UPDATED - New history total: ${newHistory.length} items (sorted by seqId/timestamp)`);
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
  
  // Define message handler with useCallback to prevent re-creation
  // CRITICAL: Don't include isListening in dependencies - use ref instead to prevent WebSocket reconnection
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
          // CRITICAL: Check message flag first, then fall back to language comparison
          const isTranscriptionMode = message.isTranscriptionOnly === true || (sourceLang === targetLang && !message.hasTranslation)
          const isTranslationMode = !isTranscriptionMode
          const hasTranslation = message.hasTranslation
          
          // DEBUG: Log mode detection
          console.log(`[TranslationInterface] 🔍 Mode detection: isTranscriptionOnly=${message.isTranscriptionOnly}, sourceLang=${sourceLang}, targetLang=${targetLang}, hasTranslation=${hasTranslation}, isTranscriptionMode=${isTranscriptionMode}, isTranslationMode=${isTranslationMode}`)
          
          // For translation mode, show both original and translated
          if (isTranslationMode) {
            // Always update original immediately (transcription is instant)
            // Use correctedText if available, otherwise use originalText (raw STT)
            // This allows live updates: show raw text first, then update with corrected text
            const correctedText = message.correctedText
            const originalText = message.originalText || ''
            
            // If this is a grammar correction, update our tracking
            if (message.hasCorrection && correctedText && correctedText.trim()) {
              longestCorrectedTextRef.current = correctedText;
              longestCorrectedOriginalRef.current = originalText;
            }
            
            // Determine what to display - merge corrected text with new raw partials
            let textToDisplay = '';
            
            if (correctedText && correctedText.trim()) {
              // Grammar correction available - use it and update tracking
              textToDisplay = correctedText;
              longestCorrectedTextRef.current = correctedText;
              longestCorrectedOriginalRef.current = originalText;
            } else if (originalText && originalText.trim()) {
              // Raw partial - merge with existing corrected text if available
              const existingCorrected = longestCorrectedTextRef.current;
              const existingOriginal = longestCorrectedOriginalRef.current;
              
              if (existingCorrected && existingOriginal) {
                // Check if new raw extends beyond what we have corrected
                if (originalText.startsWith(existingOriginal)) {
                  // New raw extends corrected text - merge: corrected + new raw extension
                  const extension = originalText.substring(existingOriginal.length);
                  textToDisplay = existingCorrected + extension;
                } else if (originalText.length > existingOriginal.length * 1.5) {
                  // New text is much longer - likely a reset or new segment, use raw
                  textToDisplay = originalText;
                  // Clear corrected tracking since we're using raw
                  longestCorrectedTextRef.current = '';
                  longestCorrectedOriginalRef.current = '';
                } else {
                  // Text diverged but not much longer - keep corrected if it's still a prefix
                  if (originalText.startsWith(existingOriginal.substring(0, Math.min(existingOriginal.length, originalText.length)))) {
                    // Still related - merge what we can
                    const extension = originalText.substring(existingOriginal.length);
                    textToDisplay = existingCorrected + extension;
                  } else {
                    // Completely diverged - use raw
                    textToDisplay = originalText;
                    longestCorrectedTextRef.current = '';
                    longestCorrectedOriginalRef.current = '';
                  }
                }
              } else {
                // No existing correction - use raw
                textToDisplay = originalText;
              }
            }
            
            if (textToDisplay) {
              console.log(`[TranslationInterface] 📝 Updating original: hasCorrection=${!!correctedText}, displayLen=${textToDisplay.length}`)
              console.log(`[TranslationInterface]   Raw: "${originalText.substring(0, 60)}${originalText.length > 60 ? '...' : ''}"`)
              if (correctedText) {
                console.log(`[TranslationInterface]   Corrected: "${correctedText.substring(0, 60)}${correctedText.length > 60 ? '...' : ''}"`)
              }
              if (longestCorrectedTextRef.current && textToDisplay !== longestCorrectedTextRef.current) {
                console.log(`[TranslationInterface]   Merged: "${textToDisplay.substring(0, 60)}${textToDisplay.length > 60 ? '...' : ''}"`)
              }
              setLivePartialOriginal(textToDisplay)
            }
            
            // Update translation (might be delayed due to throttling or streaming)
            // Show translation when hasTranslation is true OR when translatedText exists
            const translatedText = message.translatedText
            const isIncremental = message.isIncremental || false // Streaming incremental update flag
            
            if (hasTranslation && translatedText && translatedText.trim()) {
              // CRITICAL: Only show translation if it's DIFFERENT from original (prevents English glitch)
              // Check both exact match and trimmed match to catch all cases
              const isDifferent = translatedText !== originalText && 
                                  translatedText.trim() !== originalText.trim() &&
                                  translatedText.toLowerCase() !== originalText.toLowerCase();
              
              if (isDifferent) {
                const now = Date.now()
                
                // For incremental streaming updates, use even more aggressive throttling
                // Streaming tokens arrive rapidly, so we can update more frequently
                pendingTextRef.current = translatedText
                const timeSinceLastUpdate = now - lastUpdateTimeRef.current
                
                // Adaptive throttle: Streaming updates need very frequent updates for smooth feel
                // For longer text (>300 chars), reduce throttle to 20ms for streaming
                // In catch-up mode, reduce throttling significantly
                const isCatchingUp = detectLag(translatedText.length)
                const baseThrottleMs = isIncremental 
                  ? (translatedText.length > 300 ? 20 : 30) // Streaming: faster updates
                  : (translatedText.length > 300 ? 30 : 50); // Non-streaming: normal updates
                const throttleMs = isCatchingUp ? Math.max(5, baseThrottleMs / 3) : baseThrottleMs // Much faster in catch-up mode
                
                if (timeSinceLastUpdate >= throttleMs) {
                  lastUpdateTimeRef.current = now
                  flushSync(() => {
                    setLivePartial(translatedText)
                  })
                  console.log(`[TranslationInterface] ⚡ ${isIncremental ? 'STREAMING' : 'LIVE'} PARTIAL UPDATED (${translatedText.length} chars): "${translatedText.substring(0, 40)}..."`)
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
                      console.log(`[TranslationInterface] ⏱️ THROTTLED ${isIncremental ? 'STREAMING' : 'LIVE'} PARTIAL (${latestText.length} chars): "${latestText.substring(0, 40)}..."`)
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
                
                // Detect lag for fallback updates too
                const isCatchingUp = detectLag(translatedText.length)
                const fallbackThrottleMs = isCatchingUp ? 10 : 50 // Faster in catch-up mode
                
                if (timeSinceLastUpdate >= fallbackThrottleMs) {
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
                  }, fallbackThrottleMs)
                }
              } else {
                console.log('[TranslationInterface] ⚠️ Fallback translation equals original, skipping');
              }
            } else {
              // No translation yet - keep the last partial translation (don't clear it)
              // Only clear if it matches original (defensive cleanup for English glitch)
              if (livePartial && livePartial === livePartialOriginal) {
                console.log('[TranslationInterface] 🧹 CLEANUP: Clearing livePartial that matches original');
                setLivePartial('')
              } else {
                // Keep the last partial translation - don't clear it
                console.log('[TranslationInterface] ⏳ Waiting for translation, keeping last partial...', { 
                  hasTranslation, 
                  hasTranslatedText: !!translatedText, 
                  originalLength: originalText.length,
                  lastPartialLength: livePartial.length 
                });
              }
            }
          } else {
            // Transcription-only mode - just show the text IMMEDIATELY (no throttling)
            // OPTIMIZATION: For same-language, use correctedText if available, otherwise originalText or translatedText
            // This allows immediate display of raw text, then update with corrections
            const correctedText = message.correctedText
            const originalText = message.originalText || ''
            const translatedText = message.translatedText || ''
            
            // If this is a grammar correction, update our tracking
            if (message.hasCorrection && correctedText && correctedText.trim()) {
              longestCorrectedTextRef.current = correctedText;
              longestCorrectedOriginalRef.current = originalText;
            }
            
            // Determine what to display - merge corrected text with new raw partials
            let rawText = '';
            
            if (correctedText && correctedText.trim()) {
              // Grammar correction available - use it and update tracking
              rawText = correctedText;
              longestCorrectedTextRef.current = correctedText;
              longestCorrectedOriginalRef.current = originalText;
            } else if (originalText && originalText.trim()) {
              // Raw partial - merge with existing corrected text if available
              const existingCorrected = longestCorrectedTextRef.current;
              const existingOriginal = longestCorrectedOriginalRef.current;
              
              if (existingCorrected && existingOriginal) {
                // Check if new raw extends beyond what we have corrected
                if (originalText.startsWith(existingOriginal)) {
                  // New raw extends corrected text - merge: corrected + new raw extension
                  const extension = originalText.substring(existingOriginal.length);
                  rawText = existingCorrected + extension;
                } else if (originalText.length > existingOriginal.length * 1.5) {
                  // New text is much longer - likely a reset or new segment, use raw
                  rawText = originalText;
                  // Clear corrected tracking since we're using raw
                  longestCorrectedTextRef.current = '';
                  longestCorrectedOriginalRef.current = '';
                } else {
                  // Text diverged but not much longer - keep corrected if it's still a prefix
                  if (originalText.startsWith(existingOriginal.substring(0, Math.min(existingOriginal.length, originalText.length)))) {
                    // Still related - merge what we can
                    const extension = originalText.substring(existingOriginal.length);
                    rawText = existingCorrected + extension;
                  } else {
                    // Completely diverged - use raw
                    rawText = originalText;
                    longestCorrectedTextRef.current = '';
                    longestCorrectedOriginalRef.current = '';
                  }
                }
              } else {
                // No existing correction - use raw or translatedText
                rawText = originalText || translatedText;
              }
            } else if (translatedText && translatedText.trim()) {
              // Fallback to translatedText
              rawText = translatedText;
            }
            
            if (!rawText || !rawText.trim()) {
              console.log('[TranslationInterface] ⚠️ Transcription mode: No text to display');
              return;
            }
            
            // Detect lag for transcription mode too
            detectLag(rawText.length)
            
            // Process through segmenter (auto-flushes complete sentences to history)
            const { liveText } = segmenterRef.current.processPartial(rawText)
            
            // CRITICAL: Update immediately without any throttling for transcription mode
            // This matches the instant display behavior of translation mode's original text
            flushSync(() => {
              setLivePartial(liveText)
            })
            console.log(`[TranslationInterface] ⚡ INSTANT TRANSCRIPTION (no throttle): "${liveText.substring(0, 30)}..." [${liveText.length}chars]`)
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
          
          // CRITICAL: Check if this is transcription-only mode (same language)
          // Use message flag first, then fall back to language comparison
          const isTranscriptionMode = message.isTranscriptionOnly === true || (sourceLang === targetLang && !message.hasTranslation);
          
          // Only include original text if it's translation mode (not transcription mode)
          // Use correctedText if available (grammar-fixed), otherwise fall back to originalText (raw STT)
          const originalTextForHistory = isTranscriptionMode ? '' : (message.correctedText || message.originalText || '');
          console.log(`[TranslationInterface] 📝 FINAL history text: isTranscriptionMode=${isTranscriptionMode}, hasCorrection=${!!message.correctedText}, length=${originalTextForHistory.length}`);
          if (message.correctedText && message.correctedText !== message.originalText) {
            console.log(`[TranslationInterface] 📝 FINAL used corrected text: "${message.originalText}" → "${message.correctedText}"`);
          }
          
          // Commit immediately - process through segmenter and add to history
          const finalData = {
            text: finalText,
            original: originalTextForHistory,  // Only set if translation mode, empty string for transcription mode
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
                console.log(`[TranslationInterface] ✅ FALLBACK: Added to history: "${textToAdd.substring(0, 50)}..."`);
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
          console.log('[TranslationInterface] 🔄 Auto-stopping listening due to service restart/timeout')
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
          console.log('[TranslationInterface] 🔄 Auto-stopping listening due to error')
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
        console.log('[TranslationInterface] ⚠️ Unknown message type:', message.type)
    }
  }, [commitFinalToHistory, sourceLang, targetLang]) // Removed isListening - use ref instead to prevent WebSocket reconnection
  
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
    console.log('[TranslationInterface] 🚀 Initializing WebSocket connection')
    connectRef.current()
    
    // Add message handler using ref to avoid dependency issues
    // This wrapper function will always call the latest handleWebSocketMessage via ref
    const removeHandler = addMessageHandlerRef.current((message) => {
      handleWebSocketMessageRef.current(message)
    })
    
    // Handle tab visibility changes (background/foreground)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        console.log('[TranslationInterface] 📴 Tab hidden - notifying server');
        sendMessageRef.current({
          type: 'client_hidden'
        });
      } else {
        console.log('[TranslationInterface] 📴 Tab visible - notifying server');
        sendMessageRef.current({
          type: 'client_visible'
        });
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      console.log('[TranslationInterface] 🔌 Cleaning up WebSocket')
      removeHandler()
      disconnectRef.current()
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
    // CRITICAL: Empty dependency array - only run on mount/unmount
    // All functions are accessed via refs to ensure we always use the latest versions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only run once on mount

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
    if (!isConnected) {
      console.warn('[TranslationInterface] ⚠️ Cannot start listening - WebSocket not connected')
      return
    }
    
    // If already listening, stop first to reset state
    if (isListening) {
      console.log('[TranslationInterface] 🔄 Already listening, stopping first to reset...')
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
      console.log('[TranslationInterface] 🔄 Reinitializing session before starting...')
      sendMessage({
        type: 'init',
        sourceLang,
        targetLang
      })
      
      // Small delay to ensure backend is ready
      await new Promise(resolve => setTimeout(resolve, 200))
      
      // Enable streaming mode (second parameter = true)
      await startRecording((audioChunk, metadata) => {
        // CRITICAL: Only send if WebSocket is connected
        // This prevents errors when audio chunks arrive after stopping
        if (!isConnected) {
          console.warn('[TranslationInterface] ⚠️ Skipping audio chunk - WebSocket not connected')
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
      console.log('[TranslationInterface] ✅ Started listening successfully')
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
    console.log('[TranslationInterface] 🛑 Stopping listening...')
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
        console.log('[TranslationInterface] 🔄 Resetting segmenter deduplication memory')
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
