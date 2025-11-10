import React, { useState } from 'react'
import { Send, Volume2, Copy, ArrowLeft } from 'lucide-react'
import { LanguageSelector } from './LanguageSelector'
import { Header } from './Header'
import { useWebSocket } from '../hooks/useWebSocket'
import { TRANSLATION_LANGUAGES } from '../config/languages.js'

const LANGUAGES = TRANSLATION_LANGUAGES; // Text translation can use all languages

function DemoPage({ onBackToHome }) {
  const [inputText, setInputText] = useState('')
  const [sourceLang, setSourceLang] = useState('en')
  const [targetLang, setTargetLang] = useState('es')
  const [translations, setTranslations] = useState([])
  const [isLoading, setIsLoading] = useState(false)

  // Dynamically determine WebSocket URL based on frontend URL
  const getWebSocketUrl = () => {
    const hostname = window.location.hostname;
    console.log('[DemoPage] Detected hostname:', hostname);
    
    // Validate IP address format
    const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    
    if (hostname !== 'localhost' && !ipv4Pattern.test(hostname)) {
      console.error('[DemoPage] Invalid hostname format, using localhost');
      return 'ws://localhost:3001/translate';
    }
    
    return `ws://${hostname}:3001/translate`;
  };

  // Get the WebSocket URL - ensure it has /translate path
  const websocketUrl = import.meta.env.VITE_WS_URL || getWebSocketUrl();
  // Force /translate path if not present
  const finalWebSocketUrl = websocketUrl.endsWith('/translate') ? websocketUrl : websocketUrl + '/translate';
  console.log('[DemoPage] Final WebSocket URL being used:', finalWebSocketUrl);

  const { connect, disconnect, sendMessage, connectionState, addMessageHandler } = useWebSocket(finalWebSocketUrl)

  React.useEffect(() => {
    connect()
    
    // Add message handler
    const removeHandler = addMessageHandler(handleWebSocketMessage)
    
    return () => {
      removeHandler()
      disconnect()
    }
  }, [])

  React.useEffect(() => {
    if (connectionState === 'open') {
      sendMessage({
        type: 'init',
        sourceLang,
        targetLang
      })
    }
  }, [connectionState, sourceLang, targetLang])

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!inputText.trim() || isLoading) return

    setIsLoading(true)
    sendMessage({
      type: 'text',
      text: inputText,
      sourceLang: sourceLang,
      targetLang: targetLang
    })
    setInputText('')
  }

  const handleWebSocketMessage = (message) => {
    switch (message.type) {
      case 'translation':
        setTranslations(prev => [...prev, {
          id: Date.now(),
          original: message.originalText,
          translated: message.translatedText,
          timestamp: message.timestamp
        }])
        setIsLoading(false)
        break
      case 'error':
        console.error('Translation error:', message.message)
        setIsLoading(false)
        break
    }
  }

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
  }

  const speakText = (text) => {
    const utterance = new SpeechSynthesisUtterance(text)
    speechSynthesis.speak(utterance)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <Header />
      <div className="container mx-auto px-4 py-8">
        {onBackToHome && (
          <button
            onClick={onBackToHome}
            className="mb-4 px-4 py-2 text-gray-600 hover:text-gray-800 flex items-center gap-2 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Home</span>
          </button>
        )}
        
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-xl shadow-lg p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">Text Translation Demo</h2>
        
        {/* Language Selection */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <LanguageSelector
            label="Source Language"
            languages={LANGUAGES}
            selectedLanguage={sourceLang}
            onLanguageChange={setSourceLang}
          />
          <LanguageSelector
            label="Target Language"
            languages={LANGUAGES}
            selectedLanguage={targetLang}
            onLanguageChange={setTargetLang}
          />
        </div>

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="mb-6">
          <div className="flex space-x-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Enter text to translate..."
              className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={!inputText.trim() || isLoading}
              className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
            >
              {isLoading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              <span>{isLoading ? 'Translating...' : 'Translate'}</span>
            </button>
          </div>
        </form>

        {/* Translation Results */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900">Translation Results</h3>
          
          {translations.length === 0 ? (
            <div className="text-center text-gray-500 py-8">
              <p>Enter some text above to see translations</p>
            </div>
          ) : (
            <div className="space-y-3">
              {translations.map((translation) => (
                <div key={translation.id} className="bg-gray-50 rounded-lg p-4">
                  <div className="space-y-3">
                    {translation.original && (
                      <div className="border-l-4 border-blue-500 pl-4">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-blue-600 uppercase tracking-wide">
                            Original
                          </span>
                          <button
                            onClick={() => copyToClipboard(translation.original)}
                            className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                        </div>
                        <p className="text-gray-800">{translation.original}</p>
                      </div>
                    )}
                    
                    <div className="border-l-4 border-green-500 pl-4">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-green-600 uppercase tracking-wide">
                          Translated
                        </span>
                        <div className="flex items-center space-x-1">
                          <button
                            onClick={() => copyToClipboard(translation.translated)}
                            className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => speakText(translation.translated)}
                            className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                          >
                            <Volume2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      <p className="text-gray-800">{translation.translated}</p>
                    </div>
                  </div>
                  
                  <div className="mt-2 text-xs text-gray-500">
                    {new Date(translation.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default DemoPage
