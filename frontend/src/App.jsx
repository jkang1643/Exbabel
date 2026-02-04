/**
 * Exbabel - Frontend Application
 * Copyright (c) 2025 Exbabel. All Rights Reserved.
 * 
 * Auth + Membership UX:
 * - Visitors can join sessions without login
 * - Members can use Solo mode
 * - Admins can host sessions
 */

import React, { useState, useEffect } from 'react'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { LoginPage } from '@/components/auth/LoginPage'
import { JoinPage } from '@/components/JoinPage'
import { JoinChurchPage } from '@/components/JoinChurchPage'
import { CreateChurchPage } from '@/components/CreateChurchPage'
import { VisitorHome } from '@/components/home/VisitorHome'
import { MemberHome } from '@/components/home/MemberHome'
import { AdminHome } from '@/components/home/AdminHome'
import { SoloPage } from './components/solo'
import { HostPage } from './components/HostPage'
import { ListenerPage } from './components/ListenerPage'
import DemoPage from './components/DemoPage'

function AppContent() {
  const { user, profile, loading, isAuthenticated, isVisitor, isMember, isAdmin, hasChurch, signOut } = useAuth()
  const [mode, setMode] = useState('home') // Default to home (will resolve to correct home based on state)
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

  const handleJoinSession = (code) => {
    setSessionCode(code)
    setMode('listener')
  }

  const handleBackToHome = () => {
    setMode('home')
    setSessionCode('')
  }

  const handleSwitchToLogin = () => {
    setMode('login')
  }

  const handleLoginSuccess = () => {
    // After login, go to home
    setMode('home')
  }

  const handleSignOut = async () => {
    await signOut()
    setMode('home')
  }

  // Navigation handlers
  const handleJoinChurch = () => {
    setMode('join-church')
  }

  const handleCreateChurch = () => {
    // If not authenticated, route to login first
    if (!isAuthenticated) {
      setMode('login')
    } else {
      setMode('create-church')
    }
  }

  const handleChurchJoinSuccess = () => {
    // After joining a church, go to home (will now show MemberHome)
    setMode('home')
  }

  // Show loading spinner while checking auth
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
      </div>
    )
  }

  // Login page
  if (mode === 'login') {
    return <LoginPage onSuccess={handleLoginSuccess} onBack={() => setMode('home')} />
  }

  // Listener page - available to everyone
  if (mode === 'listener') {
    return <ListenerPage sessionCodeProp={sessionCode} onBackToHome={handleBackToHome} />
  }

  // Demo page - available to everyone
  if (mode === 'demo') {
    return <DemoPage onBackToHome={handleBackToHome} />
  }

  // Join church page
  if (mode === 'join-church') {
    return (
      <JoinChurchPage
        onBack={handleBackToHome}
        onSuccess={handleChurchJoinSuccess}
      />
    )
  }

  // Create church page - SaaS-style onboarding for new admins
  if (mode === 'create-church') {
    return (
      <CreateChurchPage
        onBack={handleBackToHome}
        onSuccess={handleChurchJoinSuccess}
      />
    )
  }

  // Solo mode - requires church membership
  if (mode === 'solo') {
    if (!isAuthenticated || isVisitor) {
      setMode('home')
      return null
    }
    return <SoloPage onBackToHome={handleBackToHome} />
  }

  // Host mode - requires admin role
  if (mode === 'host') {
    if (!isAuthenticated || !isAdmin) {
      setMode('home')
      return null
    }
    return <HostPage onBackToHome={handleBackToHome} />
  }

  // Home page - route to appropriate home based on user state
  // Priority: Admin with church > Admin without church (onboarding) > Member > Visitor
  if (mode === 'home' || mode === 'join') {
    if (isAdmin) {
      // Admin without a church -> redirect to onboarding
      if (!hasChurch) {
        return (
          <CreateChurchPage
            onBack={handleSignOut}
            onSuccess={handleChurchJoinSuccess}
          />
        )
      }
      // Admin with a church -> show dashboard
      return (
        <AdminHome
          onHostSession={() => setMode('host')}
          onSoloMode={() => setMode('solo')}
          onJoinSession={handleJoinSession}
          onSignOut={handleSignOut}
        />
      )
    }

    if (isMember) {
      return (
        <MemberHome
          onSoloMode={() => setMode('solo')}
          onJoinSession={handleJoinSession}
          onSignOut={handleSignOut}
          onJoinChurch={handleJoinChurch}
        />
      )
    }

    // Visitor (authenticated but no profile) or anonymous
    return (
      <VisitorHome
        onJoinSession={handleJoinSession}
        onJoinChurch={handleJoinChurch}
        onCreateChurch={handleCreateChurch}
        onSignIn={handleSwitchToLogin}
        onSignOut={handleSignOut}
      />
    )
  }

  // Default: show visitor home
  return (
    <VisitorHome
      onJoinSession={handleJoinSession}
      onJoinChurch={handleJoinChurch}
      onCreateChurch={handleCreateChurch}
      onSignIn={handleSwitchToLogin}
      onSignOut={handleSignOut}
    />
  )
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}

export default App
