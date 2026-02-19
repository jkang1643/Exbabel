/**
 * Auth Context
 * 
 * Provides authentication state throughout the app.
 * Supports 3 user states:
 * - Anonymous (not signed in)
 * - Visitor (signed in, no church profile)
 * - Member/Admin (signed in, has church profile)
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

const AuthContext = createContext(null);

// Get API URL from environment variables
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [session, setSession] = useState(null);
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    // Load profile from backend after auth
    const loadProfile = useCallback(async (accessToken) => {
        try {
            const response = await fetch(`${API_URL}/api/me`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                },
            });

            if (response.ok) {
                const data = await response.json();
                // Profile can be null for visitors - that's OK!
                setProfile(data.profile);
                setError(null);
            } else if (response.status === 401) {
                // Token invalid - force sign out to recover from stuck state
                console.warn('[Auth] Token rejected by backend (401), signing out...');
                await supabase.auth.signOut();
                setUser(null);
                setSession(null);
                setProfile(null);
                setError('auth_invalid');
            } else {
                setProfile(null);
                setError('api_error');
            }
        } catch (err) {
            console.error('[Auth] Failed to load profile:', err);
            setProfile(null);
            setError('network_error');
        }
    }, []);

    // Initialize auth state
    useEffect(() => {
        const initAuth = async () => {
            try {
                // Get initial session
                const { data: { session: initialSession }, error: sessionError } = await supabase.auth.getSession();

                if (sessionError) {
                    console.warn('[Auth] Session error:', sessionError.message);
                    // Clear any stale session
                    await supabase.auth.signOut();
                    setLoading(false);
                    return;
                }

                if (initialSession) {
                    // Check if token is about to expire (within 60 seconds)
                    const expiresAt = initialSession.expires_at;
                    const now = Math.floor(Date.now() / 1000);
                    const isExpiringSoon = expiresAt && (expiresAt - now) < 60;

                    if (isExpiringSoon) {
                        console.log('[Auth] Token expiring soon, refreshing...');
                        const { data: { session: refreshedSession }, error: refreshError } = await supabase.auth.refreshSession();

                        if (refreshError || !refreshedSession) {
                            console.warn('[Auth] Token refresh failed:', refreshError?.message);
                            // Token is truly expired, sign out
                            await supabase.auth.signOut();
                            setLoading(false);
                            return;
                        }

                        setSession(refreshedSession);
                        setUser(refreshedSession.user);
                        await loadProfile(refreshedSession.access_token);
                    } else {
                        setSession(initialSession);
                        setUser(initialSession.user);
                        await loadProfile(initialSession.access_token);
                    }
                }
            } catch (err) {
                console.error('[Auth] Init error:', err);
            }
            setLoading(false);
        };

        initAuth();

        // Listen for auth changes
        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            async (event, session) => {
                console.log('[Auth] State changed:', event);

                if (event === 'TOKEN_REFRESHED') {
                    console.log('[Auth] Token refreshed automatically');
                }

                setSession(session);
                setUser(session?.user ?? null);

                if (session?.access_token) {
                    await loadProfile(session.access_token);
                } else {
                    setProfile(null);
                }
            }
        );

        return () => subscription.unsubscribe();
    }, [loadProfile]);


    // Force reload profile (after joining a church)
    const reloadProfile = async () => {
        if (session?.access_token) {
            await loadProfile(session.access_token);
        }
    };

    // Sign up with email (requires email confirmation)
    // redirectAfter: optional URL path to redirect to after email verification
    const signUpWithEmail = async (email, password, redirectAfter) => {
        // Don't set global loading here, let the component handle its own loading state
        // otherwise App.jsx unmounts the page because it listens to global loading
        setError(null);

        try {
            console.log('[AuthContext] Signing up with email:', email);
            // Build emailRedirectTo with optional redirect param
            let emailRedirectTo = `${window.location.origin}/signup`;
            if (redirectAfter) {
                emailRedirectTo += `?redirect=${encodeURIComponent(redirectAfter)}`;
            }

            const { data, error } = await supabase.auth.signUp({
                email,
                password,
                options: {
                    emailRedirectTo,
                },
            });

            console.log('[AuthContext] Sign up response:', { data, error });

            if (error) {
                console.error('[AuthContext] Sign up error:', error);
                setError(error.message);
                return { error };
            }

            console.log('[AuthContext] Sign up successful, user:', data.user?.id);
            return { data };
        } catch (err) {
            console.error('[AuthContext] Unexpected sign up error:', err);
            setError(err.message || 'An unexpected error occurred');
            return { error: err };
        }
    };

    // Sign in with email
    const signInWithEmail = async (email, password) => {
        setLoading(true);
        setError(null);

        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password,
        });

        if (error) {
            setError(error.message);
            setLoading(false);
            return { error };
        }

        setLoading(false);
        return { data };
    };

    // Sign in with Google OAuth
    // redirectAfter: optional URL path to redirect to after OAuth callback
    const signInWithGoogle = async (redirectAfter) => {
        // Build redirectTo with optional redirect param
        let redirectTo = `${window.location.origin}/signin`;
        if (redirectAfter) {
            redirectTo += `?redirect=${encodeURIComponent(redirectAfter)}`;
        }

        const { data, error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo,
            },
        });

        if (error) {
            setError(error.message);
            return { error };
        }

        return { data };
    };

    // Sign out
    const signOut = async () => {
        setLoading(true);
        await supabase.auth.signOut();
        setUser(null);
        setSession(null);
        setProfile(null);
        setError(null);
        setLoading(false);
    };

    // Get current access token
    const getAccessToken = () => session?.access_token;

    // Computed states
    const isAuthenticated = !!user;
    const isVisitor = isAuthenticated && !profile;
    const isMember = isAuthenticated && profile && profile.role === 'member';
    const isAdmin = isAuthenticated && profile?.role === 'admin';
    const hasChurch = !!profile?.church_id;

    const value = {
        user,
        session,
        profile,
        loading,
        error,
        // Auth methods
        signUpWithEmail,
        signInWithEmail,
        signInWithGoogle,
        signOut,
        getAccessToken,
        reloadProfile,
        // Computed states
        isAuthenticated,
        isVisitor,
        isMember,
        isAdmin,
        hasChurch,
    };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
