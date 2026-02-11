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
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { LoginPage } from '@/components/auth/LoginPage'
import { SignUpPage } from '@/components/auth/SignUpPage'
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
import { BillingPage } from './components/BillingPage'
import { CheckoutPage } from './components/CheckoutPage'

// Protected route wrapper for routes that require authentication
function ProtectedRoute({ children, requireAuth = true, requireMember = false, requireAdmin = false }) {
  const { isAuthenticated, isMember, isAdmin, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
      </div>
    )
  }

  if (requireAuth && !isAuthenticated) {
    return <Navigate to="/signin" replace />
  }

  if (requireMember && !isMember && !isAdmin) {
    return <Navigate to="/" replace />
  }

  if (requireAdmin && !isAdmin) {
    return <Navigate to="/" replace />
  }

  return children
}

// Home route that redirects based on user state
function HomeRoute() {
  const { user, profile, loading, isAuthenticated, isVisitor, isMember, isAdmin, hasChurch, signOut } = useAuth()
  const navigate = useNavigate()

  const handleJoinSession = (code) => {
    navigate(`/listener?code=${code}`)
  }

  const handleSignOut = async () => {
    await signOut()
    navigate('/')
  }

  const handleJoinChurch = () => {
    navigate('/join-church')
  }

  const handleCreateChurch = () => {
    if (!isAuthenticated) {
      navigate('/signup')
    } else {
      navigate('/create-church')
    }
  }

  const handleChurchJoinSuccess = () => {
    navigate('/')
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
      </div>
    )
  }

  // Admin without a church -> redirect to onboarding
  if (isAdmin && !hasChurch) {
    return (
      <CreateChurchPage
        onBack={handleSignOut}
        onSuccess={handleChurchJoinSuccess}
      />
    )
  }

  // Admin with a church -> show dashboard
  if (isAdmin) {
    return (
      <AdminHome
        onHostSession={() => navigate('/host')}
        onSoloMode={() => navigate('/solo')}
        onJoinSession={handleJoinSession}
        onSignOut={handleSignOut}
      />
    )
  }

  // Member -> show member home
  if (isMember) {
    return (
      <MemberHome
        onSoloMode={() => navigate('/solo')}
        onJoinSession={handleJoinSession}
        onSignOut={handleSignOut}
        onJoinChurch={handleJoinChurch}
      />
    )
  }

  // Authenticated visitor (has account but no church) -> go to join church
  if (isVisitor) {
    return <Navigate to="/join-church" replace />
  }

  // Anonymous user -> show visitor home
  return (
    <VisitorHome
      onJoinSession={handleJoinSession}
      onJoinChurch={handleJoinChurch}
      onCreateChurch={handleCreateChurch}
      onSignIn={() => navigate('/signin')}
      onSignUp={() => navigate('/signup')}
      onSignOut={handleSignOut}
    />
  )
}

// Login page wrapper
function LoginRoute() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { isAuthenticated, loading } = useAuth()
  const redirectTo = searchParams.get('redirect') || '/'

  // Redirect authenticated users to their destination (handles OAuth callback)
  useEffect(() => {
    if (!loading && isAuthenticated) {
      navigate(redirectTo)
    }
  }, [isAuthenticated, loading, navigate, redirectTo])

  return (
    <LoginPage
      onSuccess={() => navigate(redirectTo)}
      onBack={() => navigate('/')}
      onSwitchToSignUp={() => navigate(`/signup${redirectTo !== '/' ? `?redirect=${encodeURIComponent(redirectTo)}` : ''}`)}
    />
  )
}

// Sign up page wrapper
function SignUpRoute() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { isAuthenticated, loading } = useAuth()
  const redirectTo = searchParams.get('redirect') || '/'

  // Redirect authenticated users to their destination (handles email verification callback)
  useEffect(() => {
    if (!loading && isAuthenticated) {
      navigate(redirectTo)
    }
  }, [isAuthenticated, loading, navigate, redirectTo])

  return (
    <SignUpPage
      onSuccess={() => navigate(redirectTo)}
      onBack={() => navigate('/')}
      onSwitchToSignIn={() => navigate(`/signin${redirectTo !== '/' ? `?redirect=${encodeURIComponent(redirectTo)}` : ''}`)}
      redirectAfter={redirectTo !== '/' ? redirectTo : undefined}
    />
  )
}

// Listener page wrapper with QR code support
function ListenerRoute() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [sessionCode, setSessionCode] = useState('')

  useEffect(() => {
    // Check for session code in URL parameters (from QR code or direct link)
    const code = searchParams.get('code') || searchParams.get('join')
    if (code) {
      setSessionCode(code.toUpperCase())
    }
  }, [searchParams])

  return <ListenerPage sessionCodeProp={sessionCode} onBackToHome={() => navigate('/')} />
}

// Solo page wrapper
function SoloRoute() {
  const navigate = useNavigate()
  return <SoloPage onBackToHome={() => navigate('/')} />
}

// Host page wrapper
function HostRoute() {
  const navigate = useNavigate()
  return <HostPage onBackToHome={() => navigate('/')} />
}

// Demo page wrapper
function DemoRoute() {
  const navigate = useNavigate()
  return <DemoPage onBackToHome={() => navigate('/')} />
}

// Join church page wrapper
function JoinChurchRoute() {
  const navigate = useNavigate()
  return (
    <JoinChurchPage
      onBack={() => navigate('/')}
      onSuccess={() => navigate('/')}
    />
  )
}

// Create church page wrapper
function CreateChurchRoute() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { signOut } = useAuth()
  const redirectTo = searchParams.get('redirect') || '/'

  const handleSignOut = async () => {
    await signOut()
    navigate('/')
  }

  return (
    <CreateChurchPage
      onBack={handleSignOut}
      onSuccess={() => navigate(redirectTo)}
    />
  )
}

function AppContent() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/" element={<HomeRoute />} />
      <Route path="/signin" element={<LoginRoute />} />
      <Route path="/signup" element={<SignUpRoute />} />
      <Route path="/listener" element={<ListenerRoute />} />
      <Route path="/demo" element={<DemoRoute />} />
      <Route path="/join-church" element={<JoinChurchRoute />} />
      <Route path="/checkout" element={<CheckoutPage />} />

      {/* Protected routes */}
      <Route
        path="/solo"
        element={
          <ProtectedRoute requireAuth={true} requireMember={true}>
            <SoloRoute />
          </ProtectedRoute>
        }
      />
      <Route
        path="/host"
        element={
          <ProtectedRoute requireAuth={true} requireAdmin={true}>
            <HostRoute />
          </ProtectedRoute>
        }
      />
      <Route
        path="/create-church"
        element={
          <ProtectedRoute requireAuth={true}>
            <CreateChurchRoute />
          </ProtectedRoute>
        }
      />

      <Route
        path="/billing"
        element={
          <ProtectedRoute requireAuth={true} requireAdmin={true}>
            <BillingPage />
          </ProtectedRoute>
        }
      />

      {/* Catch-all redirect to home */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
