/**
 * Visitor Home - For users without a profile
 * 
 * Primary actions:
 * - Join a session (default)
 * - Join a church (search)
 * - Create a church (small link)
 */

import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Header } from '@/components/Header';
import { JoinSessionModal } from '@/components/JoinSessionModal';

export function VisitorHome({ onJoinSession, onJoinChurch, onCreateChurch, onSignIn, onSignOut }) {
    const { user, isAuthenticated } = useAuth();
    const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);

    const handleJoin = (code) => {
        if (code && code.trim()) {
            onJoinSession(code.toUpperCase());
            setIsJoinModalOpen(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-100">
            <Header onSignIn={onSignIn} onSignOut={onSignOut} />

            <div className="container mx-auto px-4 py-8 md:py-16">
                <div className="max-w-2xl mx-auto">
                    {/* Hero */}
                    <div className="text-center mb-10">
                        <h1 className="text-4xl md:text-5xl font-bold text-gray-800 mb-4">
                            Real-Time Translation
                        </h1>
                        <p className="text-lg text-gray-600">
                            Join a live session and hear translations in your language instantly
                        </p>
                    </div>

                    {/* Primary: Join Session */}
                    <Card className="mb-6 shadow-xl">
                        <CardHeader className="text-center pb-2">
                            <div className="text-5xl mb-2">📱</div>
                            <CardTitle className="text-2xl">Join a Session</CardTitle>
                            <CardDescription>
                                Scan a QR code or enter a session code to join
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <Button
                                className="w-full py-6 text-lg bg-emerald-500 hover:bg-emerald-600"
                                onClick={() => setIsJoinModalOpen(true)}
                            >
                                Tap to Join Session
                            </Button>
                        </CardContent>
                    </Card>

                    {/* Secondary Options */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={onJoinChurch}>
                            <CardHeader className="text-center p-4">
                                <div className="text-3xl mb-1">⛪</div>
                                <CardTitle className="text-lg">Join a Church</CardTitle>
                                <CardDescription className="text-sm">
                                    Become a member for regular access
                                </CardDescription>
                            </CardHeader>
                        </Card>

                        <Card className="hover:shadow-lg transition-shadow cursor-pointer" onClick={onCreateChurch}>
                            <CardHeader className="text-center p-4">
                                <div className="text-3xl mb-1">✨</div>
                                <CardTitle className="text-lg">Create a Church</CardTitle>
                                <CardDescription className="text-sm">
                                    Start your own translation ministry
                                </CardDescription>
                            </CardHeader>
                        </Card>
                    </div>

                    {/* Sign in prompt for visitors */}
                    {!isAuthenticated && (
                        <p className="text-center text-gray-500 text-sm mt-8">
                            Already have an account?{' '}
                            <button onClick={onSignIn} className="text-purple-600 hover:underline font-medium">
                                Sign in
                            </button>
                        </p>
                    )}

                    {/* Signed in but no profile */}
                    {isAuthenticated && (
                        <p className="text-center text-gray-500 text-sm mt-8">
                            Signed in as {user?.email}. Join a session or church to get started!
                        </p>
                    )}
                </div>
            </div>

            <JoinSessionModal
                isOpen={isJoinModalOpen}
                onClose={() => setIsJoinModalOpen(false)}
                onJoin={handleJoin}
            />
        </div>
    );
}
