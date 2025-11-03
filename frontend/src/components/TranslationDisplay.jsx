import React, { useEffect, useRef } from 'react'
import { Volume2, Copy, Download } from 'lucide-react'

function TranslationDisplay({ 
  finalTranslations = [],  // Default to empty array to prevent undefined errors
  livePartial, 
  livePartialOriginal,
  audioEnabled, 
  isListening, 
  sourceLang, 
  targetLang
}) {
  // CRITICAL: Ensure finalTranslations is always an array
  const safeFinalTranslations = Array.isArray(finalTranslations) ? finalTranslations : [];
  
  const isTranscriptionMode = sourceLang === targetLang
  const isTranslationMode = !isTranscriptionMode
  const transcriptBoxRef = useRef(null)
  const translationBoxRef = useRef(null)
  
  // DEBUG: Log when component receives live partial
  useEffect(() => {
    if (livePartial) {
      console.log('[TranslationDisplay] 🔴 LIVE PARTIAL RENDER:', livePartial.substring(0, 50))
    }
  }, [livePartial])
  
  // DEBUG: Log when finalTranslations changes
  useEffect(() => {
    const count = safeFinalTranslations.length;
    console.log('[TranslationDisplay] 📝 FINAL TRANSLATIONS CHANGED:', count, 'items');
    console.log('[TranslationDisplay] 📝 Safe final translations:', safeFinalTranslations);
    console.log('[TranslationDisplay] 📝 Raw prop - isArray:', Array.isArray(finalTranslations), 'isDefined:', finalTranslations !== undefined, 'isNull:', finalTranslations === null, 'value:', finalTranslations);
  }, [finalTranslations, safeFinalTranslations])
  
  // Auto-scroll to bottom when live partial updates
  useEffect(() => {
    if (transcriptBoxRef.current && livePartial) {
      transcriptBoxRef.current.scrollTop = transcriptBoxRef.current.scrollHeight
    }
  }, [livePartial])

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
  }

  const downloadTranscript = () => {
    const content = safeFinalTranslations.map(t => 
      `${isTranscriptionMode ? 'Transcription' : 'Original'}: ${t.original || t.translated}\n${isTranscriptionMode ? '' : `Translated: ${t.translated}\n`}---`
    ).join('\n')
    
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${isTranscriptionMode ? 'transcription' : 'translation'}-${new Date().toISOString().split('T')[0]}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-base sm:text-lg font-semibold text-gray-900">
          {isTranscriptionMode ? 'Live Transcription' : 'Live Translation'}
        </h3>
        <button
          onClick={downloadTranscript}
          disabled={safeFinalTranslations.length === 0}
          className="flex items-center space-x-1 px-2 sm:px-3 py-1 text-xs sm:text-sm text-gray-600 hover:text-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Download className="w-3 h-3 sm:w-4 sm:h-4" />
          <span className="hidden sm:inline">Download</span>
          <span className="sm:hidden">Save</span>
        </button>
      </div>

      {/* LIVE TRANSCRIPTION AREA - FIXED POSITION, INLINE UPDATES */}
      <div className="bg-gradient-to-br from-blue-500 via-purple-500 to-indigo-600 rounded-lg sm:rounded-2xl p-3 sm:p-6 shadow-2xl -mx-3 sm:mx-0">
        <div className="flex items-center justify-between mb-3 sm:mb-4">
          <div className="flex items-center space-x-2 sm:space-x-3">
            {isListening && (
              <div className="flex space-x-1">
                <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce"></div>
                <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{animationDelay: '0.15s'}}></div>
                <div className="w-1.5 h-1.5 sm:w-2.5 sm:h-2.5 bg-white rounded-full animate-bounce" style={{animationDelay: '0.3s'}}></div>
              </div>
            )}
            <span className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider flex items-center gap-1 sm:gap-2">
              {isListening ? (
                <>
                  <span className="relative flex h-2 w-2 sm:h-2.5 sm:w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 sm:h-2.5 sm:w-2.5 bg-white"></span>
                  </span>
                  LIVE
                </>
              ) : (
                'READY'
              )}
            </span>
          </div>
          {livePartial && (
            <button
              onClick={() => copyToClipboard(livePartial)}
              className="p-1 sm:p-1.5 text-white/80 hover:text-white transition-colors"
              title="Copy live text"
            >
              <Copy className="w-3 h-3 sm:w-4 sm:h-4" />
            </button>
          )}
        </div>
        
        {/* TRANSLATION MODE: Show both original and translation */}
        {isTranslationMode ? (
          <div className="space-y-2 sm:space-y-3">
            {/* Original Text */}
            <div className="bg-white/10 backdrop-blur-sm rounded-lg sm:rounded-xl p-2 sm:p-3">
              <div className="text-xs font-semibold text-white/70 uppercase tracking-wide mb-1 sm:mb-2">
                Original ({sourceLang.toUpperCase()})
              </div>
              {livePartialOriginal ? (
                <p className="text-white text-sm sm:text-base leading-relaxed whitespace-pre-wrap">
                  {livePartialOriginal}
                  {isListening && (
                    <span className="inline-block w-0.5 h-4 sm:h-5 ml-1 bg-white animate-pulse"></span>
                  )}
                </p>
              ) : (
                <p className="text-white/40 text-xs sm:text-sm italic">Listening...</p>
              )}
            </div>
            
            {/* Translated Text */}
            <div className="bg-white/15 backdrop-blur-sm rounded-lg sm:rounded-xl p-2 sm:p-3 border-2 border-white/20">
              <div className="text-xs font-semibold text-white/70 uppercase tracking-wide mb-1 sm:mb-2 flex items-center gap-2">
                <span>Translation ({targetLang.toUpperCase()})</span>
                {livePartial && livePartial !== livePartialOriginal && (
                  <span className="inline-flex items-center gap-1 text-emerald-300">
                    <span className="inline-block w-1 h-1 sm:w-1.5 sm:h-1.5 bg-emerald-300 rounded-full animate-pulse"></span>
                    <span className="text-xs">Live</span>
                  </span>
                )}
              </div>
              {/* CRITICAL: Only show livePartial if it's different from original (prevents English glitch) */}
              {/* Check multiple ways to ensure we never show English in translation box */}
              {livePartial && 
               livePartial.trim() && 
               livePartial !== livePartialOriginal && 
               livePartial.trim() !== livePartialOriginal.trim() &&
               livePartial.toLowerCase() !== livePartialOriginal.toLowerCase() ? (
                <p className="text-white text-base sm:text-lg font-medium leading-relaxed whitespace-pre-wrap">
                  {livePartial}
                  {isListening && (
                    <span className="inline-block w-0.5 h-5 sm:h-6 ml-1 bg-emerald-300 animate-pulse"></span>
                  )}
                </p>
              ) : livePartialOriginal ? (
                // Show "Translating..." when we have original but no translation yet
                <p className="text-white/50 text-xs sm:text-sm italic animate-pulse">Translating...</p>
              ) : (
                <p className="text-white/40 text-xs sm:text-sm italic">Waiting for speech...</p>
              )}
            </div>
            
            <div className="mt-2 text-xs text-white/70 font-medium">
              {livePartialOriginal && livePartial && livePartial !== livePartialOriginal ? (
                <>✨ Live translation updating...</>
              ) : livePartialOriginal ? (
                <>⏳ Translation in progress...</>
              ) : isListening ? (
                <>🎤 Ready • Start speaking...</>
              ) : (
                <>Click "Start" to begin</>
              )}
            </div>
          </div>
        ) : (
          /* TRANSCRIPTION MODE: Single text display */
          <>
            <div 
              ref={transcriptBoxRef}
              className="bg-white/95 backdrop-blur rounded-lg sm:rounded-xl p-3 sm:p-6 min-h-[100px] sm:min-h-[140px] max-h-[300px] sm:max-h-[400px] overflow-y-auto transition-none scroll-smooth"
            >
              {livePartial ? (
                <p className="text-gray-900 font-semibold text-xl sm:text-2xl md:text-3xl leading-relaxed tracking-wide break-words">
                  {livePartial}
                  {isListening && (
                    <span className="inline-block w-0.5 sm:w-1 h-6 sm:h-8 ml-1 sm:ml-2 bg-blue-600 animate-pulse"></span>
                  )}
                </p>
              ) : (
                <div className="flex items-center justify-center h-full min-h-[100px] sm:min-h-[140px]">
                  <p className="text-gray-400 text-base sm:text-lg md:text-xl text-center px-2">
                    {isListening ? 'Ready • Start speaking...' : 'Click "Listen" to start'}
                  </p>
                </div>
              )}
            </div>
            
            <div className="mt-2 sm:mt-3 text-xs text-white/80 font-medium">
              {livePartial ? (
                <>🔴 LIVE • Words streaming in real-time</>
              ) : isListening ? (
                <>Ready • Start speaking to see text appear</>
              ) : (
                <>Start listening to see live transcription</>
              )}
            </div>
          </>
        )}
      </div>

      {/* HISTORY - Completed paragraphs scroll below */}
      {/* CRITICAL: Always render history if there are items - use safeFinalTranslations to ensure it's always an array */}
      {safeFinalTranslations.length > 0 && (
        <div className="bg-gray-50 rounded-lg sm:rounded-xl p-3 sm:p-5 border-2 border-gray-200 -mx-3 sm:mx-0">
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <h4 className="text-xs sm:text-sm font-semibold text-gray-700 flex items-center gap-1 sm:gap-2">
              <span className="text-blue-600">📝</span>
              History
              <span className="text-xs text-gray-500 font-normal">
                ({safeFinalTranslations.length})
              </span>
            </h4>
          </div>
          
          <div className="space-y-2 sm:space-y-3 max-h-80 sm:max-h-96 overflow-y-auto pr-1 sm:pr-2">
            {safeFinalTranslations.slice().reverse().map((translation, index) => (
              <div 
                key={translation.id} 
                className="bg-white rounded-lg p-3 sm:p-4 shadow-sm hover:shadow-md transition-all border border-gray-200 animate-fadeIn"
              >
                {!isTranscriptionMode && translation.original && (
                  <div className="mb-2 sm:mb-3 pb-2 sm:pb-3 border-b border-gray-100">
                    <div className="flex items-center justify-between mb-1 sm:mb-1.5">
                      <span className="text-xs font-semibold text-blue-600 uppercase">Original</span>
                      <button
                        onClick={() => copyToClipboard(translation.original)}
                        className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </div>
                    <p className="text-gray-700 text-sm sm:text-base leading-relaxed">{translation.original}</p>
                  </div>
                )}
                
                <div>
                  <div className="flex items-center justify-between mb-1 sm:mb-1.5">
                    <span className={`text-xs font-semibold uppercase ${isTranscriptionMode ? 'text-blue-600' : 'text-green-600'}`}>
                      {isTranscriptionMode ? 'Transcription' : 'Translation'}
                    </span>
                    <div className="flex items-center space-x-1">
                      <button
                        onClick={() => copyToClipboard(translation.translated)}
                        className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                      {audioEnabled && (
                        <button
                          onClick={() => {
                            const utterance = new SpeechSynthesisUtterance(translation.translated)
                            speechSynthesis.speak(utterance)
                          }}
                          className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                        >
                          <Volume2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-gray-900 text-sm sm:text-base font-medium leading-relaxed">{translation.translated}</p>
                </div>
                
                <div className="mt-2 sm:mt-3 pt-2 sm:pt-3 border-t border-gray-100 text-xs text-gray-400 flex items-center justify-between">
                  <span>{new Date(translation.timestamp).toLocaleTimeString()}</span>
                  <span className="text-gray-300">#{safeFinalTranslations.length - index}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {safeFinalTranslations.length === 0 && !livePartial && !isListening && (
        <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg sm:rounded-xl p-6 sm:p-12 text-center border-2 border-dashed border-blue-300 -mx-3 sm:mx-0">
          <div className="space-y-2 sm:space-y-3">
            <div className="text-4xl sm:text-5xl">🎤</div>
            <p className="text-gray-600 text-base sm:text-lg font-medium">Ready to Start</p>
            <p className="text-gray-500 text-xs sm:text-sm">
              Click "Listen" and start speaking to see live {isTranscriptionMode ? 'transcription' : 'translation'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export default TranslationDisplay
