/**
 * Login Page
 * 
 * Email + Google OAuth login using shadcn/ui components.
 */

import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

export function LoginPage({ onSuccess, onBack, onSwitchToSignUp, redirectAfter }) {
    const { signInWithEmail, signInWithGoogle, loading, error } = useAuth();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [localError, setLocalError] = useState(null);

    const handleEmailLogin = async (e) => {
        e.preventDefault();
        setLocalError(null);
        setIsSubmitting(true);

        if (!email || !password) {
            setLocalError('Please enter both email and password');
            setIsSubmitting(false);
            return;
        }

        const result = await signInWithEmail(email, password);

        if (result.error) {
            setLocalError(result.error.message || 'Login failed');
        } else if (onSuccess) {
            onSuccess();
        }

        setIsSubmitting(false);
    };

    const handleGoogleLogin = async () => {
        setLocalError(null);
        const result = await signInWithGoogle(redirectAfter);

        if (result.error) {
            setLocalError(result.error.message || 'Google login failed');
        }
    };

    const displayError = localError || error;

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-100">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-100 p-4">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <div className="text-5xl mb-4">🌍</div>
                    <CardTitle className="text-2xl">Welcome to Exbabel</CardTitle>
                    <CardDescription>
                        Sign in to start translating
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
                        onClick={handleGoogleLogin}
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
                        Sign in with Google
                    </Button>

                    <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                            <span className="w-full border-t" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-card px-2 text-muted-foreground">
                                Or continue with email
                            </span>
                        </div>
                    </div>

                    {/* Email/Password Form */}
                    <form onSubmit={handleEmailLogin} className="space-y-4">
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

                        <Button
                            type="submit"
                            className="w-full"
                            disabled={isSubmitting}
                        >
                            {isSubmitting ? 'Signing in...' : 'Sign In'}
                        </Button>
                    </form>

                    {onBack && (
                        <Button
                            variant="ghost"
                            className="w-full"
                            onClick={onBack}
                        >
                            ← Back to Join
                        </Button>
                    )}

                    <p className="text-center text-sm text-muted-foreground">
                        Don't have an account?{' '}
                        <button
                            onClick={onSwitchToSignUp}
                            className="text-primary hover:underline font-medium"
                        >
                            Sign up
                        </button>
                    </p>

                    <p className="text-center text-sm text-muted-foreground">
                        You can join sessions without signing in
                    </p>
                </CardContent>
            </Card>
        </div>
    );
}
