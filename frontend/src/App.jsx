/**
 * Exbabel - Frontend Application
 * Copyright (c) 2025 Exbabel. All Rights Reserved.
 * 
 * PROPRIETARY AND CONFIDENTIAL
 * Reverted to api.exbabel.com
 */

import React, { useState, useEffect } from 'react'
import { HomePage } from './components/HomePage'
import TranslationInterface from './components/TranslationInterface'
import { HostPage } from './components/HostPage'
import { ListenerPage } from './components/ListenerPage'
import DemoPage from './components/DemoPage'

function App() {
  const [mode, setMode] = useState('home') // 'home', 'solo', 'host', 'listener', 'demo'
  const [sessionCode, setSessionCode] = useState('')

  // Check URL parameters for direct join links (from QR code)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const joinCode = params.get('join')

    if (joinCode) {
      setSessionCode(joinCode.toUpperCase())
      setMode('listener')
      // Clean URL after reading parameter
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  const handleSelectMode = (selectedMode, code = '') => {
    setMode(selectedMode)
    if (code) {
      setSessionCode(code)
    }
  }

  const handleBackToHome = () => {
    setMode('home')
    setSessionCode('')
  }

  // Render based on mode
  if (mode === 'home') {
    return <HomePage onSelectMode={handleSelectMode} />
  }

  if (mode === 'solo') {
    return <TranslationInterface onBackToHome={handleBackToHome} />
  }

  if (mode === 'host') {
    return <HostPage onBackToHome={handleBackToHome} />
  }

  if (mode === 'listener') {
    return <ListenerPage sessionCodeProp={sessionCode} onBackToHome={handleBackToHome} />
  }

  if (mode === 'demo') {
    return <DemoPage onBackToHome={handleBackToHome} />
  }

  // Default fallback
  return <HomePage onSelectMode={handleSelectMode} />
}

export default App
