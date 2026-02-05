/**
 * Admin Home - For church administrators
 * 
 * Features:
 * - Start/host a live session
 * - Generate shareable join link/QR
 * - Solo mode
 * - View church analytics (future)
 */

import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Header } from '../Header';
import { JoinSessionModal } from '@/components/JoinSessionModal';

export function AdminHome({ onHostSession, onSoloMode, onJoinSession, onSignOut }) {
    const { profile, user } = useAuth();
    const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);

    const handleJoin = (code) => {
        if (code && code.trim()) {
            onJoinSession(code.toUpperCase());
            setIsJoinModalOpen(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-white">
            <Header onSignOut={onSignOut} />

            <div className="container mx-auto px-4 py-8">
                <div className="max-w-4xl mx-auto">
                    {/* Welcome */}
                    <div className="text-center mb-8">
                        <h1 className="text-3xl md:text-4xl font-bold text-gray-800 mb-2">
                            Admin Dashboard 👑
                        </h1>
                        {profile?.church_name && (
                            <p className="text-xl font-semibold text-primary mb-1">
                                ⛪ {profile.church_name}
                            </p>
                        )}
                        <p className="text-gray-600">
                            {user?.email} • Administrator
                        </p>
                    </div>

                    {/* Primary: Host Session */}
                    <Card className="mb-6 shadow-xl border-2 border-primary/10">
                        <CardHeader className="text-center">
                            <div className="text-5xl mb-2">🎙️</div>
                            <CardTitle className="text-2xl">Host a Live Session</CardTitle>
                            <CardDescription>
                                Start broadcasting translations to your congregation
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <Button
                                className="w-full py-6 text-lg bg-red-500 hover:bg-red-600"
                                onClick={onHostSession}
                            >
                                Start Broadcasting
                            </Button>
                            <p className="text-center text-sm text-gray-500 mt-3">
                                Listeners will receive a code to join your session
                            </p>
                        </CardContent>
                    </Card>

                    {/* Secondary Actions */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                        {/* Solo Mode */}
                        <Card className="shadow-lg hover:shadow-xl transition-shadow">
                            <CardHeader className="text-center">
                                <div className="text-4xl mb-2">🎧</div>
                                <CardTitle className="text-lg">Solo Mode</CardTitle>
                                <CardDescription className="text-sm">
                                    Personal translation for conversations
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <Button
                                    className="w-full bg-primary hover:bg-primary/90"
                                    onClick={onSoloMode}
                                >
                                    Start Solo
                                </Button>
                            </CardContent>
                        </Card>

                        {/* Join Session */}
                        <Card className="shadow-lg hover:shadow-xl transition-shadow">
                            <CardHeader className="text-center">
                                <div className="text-4xl mb-2">📱</div>
                                <CardTitle className="text-lg">Join Session</CardTitle>
                                <CardDescription className="text-sm">
                                    Scan QR code or enter a session code
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <Button
                                    className="w-full bg-emerald-500 hover:bg-emerald-600"
                                    onClick={() => setIsJoinModalOpen(true)}
                                >
                                    Join Session
                                </Button>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Future: Analytics Card */}
                    <Card className="bg-white/50 border-dashed">
                        <CardHeader className="text-center py-4">
                            <CardTitle className="text-gray-400 text-sm">📊 Analytics Coming Soon</CardTitle>
                            <CardDescription className="text-xs">
                                View session history, listener counts, and usage stats
                            </CardDescription>
                        </CardHeader>
                    </Card>

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
