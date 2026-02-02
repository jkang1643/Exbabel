/**
 * Join Page
 * 
 * Default entry point for all users (visitors, members, admins).
 * Allows joining a session via code without requiring authentication.
 */

import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

export function JoinPage({ onJoinSession, onSwitchToLogin }) {
    const { isAuthenticated, isVisitor, profile } = useAuth();
    const [sessionCode, setSessionCode] = useState('');
    const [error, setError] = useState(null);
    const [isJoining, setIsJoining] = useState(false);

    const handleJoin = async (e) => {
        e.preventDefault();
        setError(null);

        const code = sessionCode.trim().toUpperCase();
        if (!code) {
            setError('Please enter a session code');
            return;
        }

        if (code.length < 4) {
            setError('Session code must be at least 4 characters');
            return;
        }

        setIsJoining(true);

        // Call parent handler to switch to listener mode
        onJoinSession(code);
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-pink-100 p-4">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <div className="text-5xl mb-4">🌍</div>
                    <CardTitle className="text-2xl">Join a Session</CardTitle>
                    <CardDescription>
                        Enter the session code from your host
                    </CardDescription>
                </CardHeader>

                <CardContent className="space-y-4">
                    {error && (
                        <Alert variant="destructive">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    )}

                    <form onSubmit={handleJoin} className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="sessionCode">Session Code</Label>
                            <Input
                                id="sessionCode"
                                type="text"
                                placeholder="ABCD"
                                value={sessionCode}
                                onChange={(e) => setSessionCode(e.target.value.toUpperCase())}
                                disabled={isJoining}
                                className="text-center text-2xl tracking-widest font-mono"
                                maxLength={6}
                                autoComplete="off"
                            />
                        </div>

                        <Button
                            type="submit"
                            className="w-full"
                            disabled={isJoining || !sessionCode.trim()}
                            size="lg"
                        >
                            {isJoining ? 'Joining...' : 'Join Session'}
                        </Button>
                    </form>

                    <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                            <span className="w-full border-t" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-card px-2 text-muted-foreground">
                                Options
                            </span>
                        </div>
                    </div>

                    <div className="space-y-2">
                        {!isAuthenticated && (
                            <Button
                                variant="outline"
                                className="w-full"
                                onClick={onSwitchToLogin}
                            >
                                Sign in for saved access
                            </Button>
                        )}

                        {isAuthenticated && isVisitor && (
                            <p className="text-center text-sm text-muted-foreground">
                                <strong>You're signed in!</strong> Join a session to become a member of that church.
                            </p>
                        )}

                        {isAuthenticated && profile && (
                            <p className="text-center text-sm text-muted-foreground">
                                <strong>Member of {profile.church_id ? 'your church' : 'a church'}</strong> — you can also access Solo mode from the home screen.
                            </p>
                        )}
                    </div>

                    <p className="text-center text-xs text-muted-foreground mt-4">
                        No account needed to listen. Scan the QR code at your church or enter the code shown.
                    </p>
                </CardContent>
            </Card>
        </div>
    );
}
