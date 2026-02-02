/**
 * Member Home - For users with a profile (non-admin)
 * 
 * Features:
 * - Join active sessions from their church
 * - Solo mode for personal translation
 * - Quick join by code
 */

import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Header } from '../Header';
import { JoinSessionModal } from '@/components/JoinSessionModal';

export function MemberHome({ onSoloMode, onJoinSession, onSignOut }) {
    const { profile, user } = useAuth();
    const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);

    const handleJoin = (code) => {
        if (code && code.trim()) {
            onJoinSession(code.toUpperCase());
            setIsJoinModalOpen(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
            <Header onSignOut={onSignOut} />

            <div className="container mx-auto px-4 py-8">
                <div className="max-w-4xl mx-auto">
                    {/* Welcome */}
                    <div className="text-center mb-8">
                        <h1 className="text-3xl md:text-4xl font-bold text-gray-800 mb-2">
                            Welcome back! 👋
                        </h1>
                        <p className="text-gray-600">
                            {user?.email} • Member
                        </p>
                    </div>

                    {/* Main Actions */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                        {/* Solo Mode */}
                        <Card className="shadow-xl hover:shadow-2xl transition-shadow">
                            <CardHeader className="text-center">
                                <div className="text-5xl mb-2">🎧</div>
                                <CardTitle className="text-xl">Solo Mode</CardTitle>
                                <CardDescription>
                                    Use translation for yourself - perfect for personal conversations
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <Button
                                    className="w-full py-5 text-lg bg-blue-500 hover:bg-blue-600"
                                    onClick={onSoloMode}
                                >
                                    Start Solo Session
                                </Button>
                            </CardContent>
                        </Card>

                        {/* Join Session */}
                        <Card className="shadow-xl hover:shadow-2xl transition-shadow">
                            <CardHeader className="text-center">
                                <div className="text-5xl mb-2">📱</div>
                                <CardTitle className="text-xl">Join Session</CardTitle>
                                <CardDescription>
                                    Scan QR code or enter a session code from your host
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <Button
                                    className="w-full py-5 text-lg bg-emerald-500 hover:bg-emerald-600"
                                    onClick={() => setIsJoinModalOpen(true)}
                                >
                                    Tap to Join Session
                                </Button>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Quick Stats / Info */}
                    <div className="bg-white/50 rounded-lg p-4 text-center">
                        <p className="text-sm text-gray-600">
                            Need to host sessions? Ask your church admin for admin access.
                        </p>
                    </div>

                    {/* Sign Out */}
                    <div className="mt-8 text-center">
                        <button
                            onClick={onSignOut}
                            className="text-sm text-gray-500 hover:text-gray-700 underline"
                        >
                            Sign out
                        </button>
                    </div>
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
