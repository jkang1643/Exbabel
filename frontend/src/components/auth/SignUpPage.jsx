/**
 * Sign Up Page
 * 
 * Email + Google OAuth sign up using shadcn/ui components.
 * Requires email confirmation before access.
 */

import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

export function SignUpPage({ onSuccess, onBack, onSwitchToSignIn, redirectAfter }) {
    const { signUpWithEmail, signInWithGoogle, loading, error } = useAuth();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [localError, setLocalError] = useState(null);
    const [showConfirmation, setShowConfirmation] = useState(false);

    const handleEmailSignUp = async (e) => {
        e.preventDefault();
        setLocalError(null);
        setIsSubmitting(true);

        // Validation
        if (!email || !password || !confirmPassword) {
            setLocalError('Please fill in all fields');
            setIsSubmitting(false);
            return;
        }

        if (password !== confirmPassword) {
            setLocalError('Passwords do not match');
            setIsSubmitting(false);
            return;
        }

        if (password.length < 6) {
            setLocalError('Password must be at least 6 characters');
            setIsSubmitting(false);
            return;
        }

        console.log('[SignUp] Attempting sign up for:', email);

        try {
            const result = await signUpWithEmail(email, password, redirectAfter);
            console.log('[SignUp] Sign up result:', result);

            if (result.error) {
                console.error('[SignUp] Error:', result.error);
                setLocalError(result.error.message || 'Sign up failed');
                setIsSubmitting(false);
            } else if (result.data) {
                // Show confirmation message
                console.log('[SignUp] Success! Showing confirmation screen');
                setShowConfirmation(true);
                setIsSubmitting(false);
            } else {
                console.error('[SignUp] Unexpected result - no error and no data');
                setLocalError('Unexpected error during sign up');
                setIsSubmitting(false);
            }
        } catch (e) {
            console.error('[SignUp] Exception:', e);
            setLocalError('An error occurred. Please try again.');
            setIsSubmitting(false);
        }
    };

    const handleGoogleSignUp = async () => {
        setLocalError(null);
        const result = await signInWithGoogle();

        if (result.error) {
            setLocalError(result.error.message || 'Google sign up failed');
        }
        // Note: Google OAuth handles both sign-in and sign-up automatically
        // The redirect will be handled by Supabase
    };

    const displayError = localError || error;

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-100">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
        );
    }

    // Show confirmation message after successful sign-up
    if (showConfirmation) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-100 p-4">
                <Card className="w-full max-w-md">
                    <CardHeader className="text-center">
                        <div className="text-5xl mb-4">✉️</div>
                        <CardTitle className="text-2xl">Check Your Email</CardTitle>
                        <CardDescription>
                            We've sent a confirmation link to <strong>{email}</strong>
                        </CardDescription>
                    </CardHeader>

                    <CardContent className="space-y-4">
                        <Alert>
                            <AlertDescription>
                                Please check your email and click the confirmation link to activate your account.
                                You can close this page.
                            </AlertDescription>
                        </Alert>

                        {onBack && (
                            <Button
                                variant="outline"
                                className="w-full"
                                onClick={onBack}
                            >
                                ← Back to Home
                            </Button>
                        )}
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-100 p-4">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <div className="text-5xl mb-4">🌍</div>
                    <CardTitle className="text-2xl">Create Your Account</CardTitle>
                    <CardDescription>
                        Get started with Exbabel
                    </CardDescription>
                </CardHeader>

                <CardContent className="space-y-4">
                    {displayError && (
                        <Alert variant="destructive">
                            <AlertDescription>{displayError}</AlertDescription>
                        </Alert>
                    )}

                    {/* Google OAuth */}
                    <Button
                        variant="outline"
                        className="w-full"
                        onClick={handleGoogleSignUp}
                        disabled={isSubmitting}
                    >
                        <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                            <path
                                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                                fill="#4285F4"
                            />
                            <path
                                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                                fill="#34A853"
                            />
                            <path
                                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                                fill="#FBBC05"
                            />
                            <path
                                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                                fill="#EA4335"
                            />
                        </svg>
                        Sign up with Google
                    </Button>

                    <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                            <span className="w-full border-t" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-card px-2 text-muted-foreground">
                                Or sign up with email
                            </span>
                        </div>
                    </div>

                    {/* Email/Password Form */}
                    <form onSubmit={handleEmailSignUp} className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="email">Email</Label>
                            <Input
                                id="email"
                                type="email"
                                placeholder="you@example.com"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                disabled={isSubmitting}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="password">Password</Label>
                            <Input
                                id="password"
                                type="password"
                                placeholder="••••••••"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                disabled={isSubmitting}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="confirmPassword">Confirm Password</Label>
                            <Input
                                id="confirmPassword"
                                type="password"
                                placeholder="••••••••"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                disabled={isSubmitting}
                            />
                        </div>

                        <Button
                            type="submit"
                            className="w-full"
                            disabled={isSubmitting}
                        >
                            {isSubmitting ? 'Creating account...' : 'Create Account'}
                        </Button>
                    </form>

                    {onBack && (
                        <Button
                            variant="ghost"
                            className="w-full"
                            onClick={onBack}
                        >
                            ← Back to Home
                        </Button>
                    )}

                    <p className="text-center text-sm text-muted-foreground">
                        Already have an account?{' '}
                        <button
                            onClick={onSwitchToSignIn}
                            className="text-primary hover:underline font-medium"
                        >
                            Sign in
                        </button>
                    </p>
                </CardContent>
            </Card>
        </div>
    );
}
