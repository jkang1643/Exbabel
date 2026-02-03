/**
 * Member Home - For users with a profile (non-admin)
 * 
 * Features:
 * - Join active sessions from their church
 * - Solo mode for personal translation
 * - Quick join by code
 * - Display current church and leave/join functionality
 */

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Header } from '../Header';
import { JoinSessionModal } from '@/components/JoinSessionModal';
import { Alert, AlertDescription } from '@/components/ui/alert';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export function MemberHome({ onSoloMode, onJoinSession, onSignOut, onJoinChurch }) {
    const { profile, user, reloadProfile, getAccessToken } = useAuth();
    const [isJoinModalOpen, setIsJoinModalOpen] = useState(false);
    const [isLeaving, setIsLeaving] = useState(false);
    const [error, setError] = useState('');
    const [showChurchMenu, setShowChurchMenu] = useState(false);
    const menuRef = useRef(null);

    // Close menu when clicking outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (menuRef.current && !menuRef.current.contains(event.target)) {
                setShowChurchMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleJoin = (code) => {
        if (code && code.trim()) {
            onJoinSession(code.toUpperCase());
            setIsJoinModalOpen(false);
        }
    };

    const handleLeaveChurch = async () => {
        if (!confirm('Are you sure you want to leave this church?')) {
            return;
        }

        setIsLeaving(true);
        setError('');
        setShowChurchMenu(false);

        try {
            const token = getAccessToken();
            const response = await fetch(`${API_URL}/api/churches/leave`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();

            if (data.success) {
                if (reloadProfile) {
                    await reloadProfile();
                }
            } else {
                setError(data.error || 'Failed to leave church');
            }
        } catch (err) {
            console.error('Leave church error:', err);
            setError('Failed to connect to server');
        } finally {
            setIsLeaving(false);
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
                        {/* Church Name with Dropdown */}
                        {profile?.church_name ? (
                            <div className="relative inline-block mt-2" ref={menuRef}>
                                <button
                                    onClick={() => setShowChurchMenu(!showChurchMenu)}
                                    className="inline-flex items-center gap-1 text-lg text-indigo-600 font-medium hover:text-indigo-700 transition-colors"
                                >
                                    ⛪ {profile.church_name}
                                    <svg
                                        className={`w-4 h-4 transition-transform ${showChurchMenu ? 'rotate-180' : ''}`}
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                    </svg>
                                </button>
                                {showChurchMenu && (
                                    <div className="absolute left-1/2 transform -translate-x-1/2 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-10">
                                        <button
                                            onClick={handleLeaveChurch}
                                            disabled={isLeaving}
                                            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                                        >
                                            {isLeaving ? 'Leaving...' : 'Leave Church'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <button
                                onClick={onJoinChurch}
                                className="inline-flex items-center gap-1 mt-2 text-lg text-indigo-600 font-medium hover:text-indigo-700 transition-colors"
                            >
                                ⛪ Join a Church
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                            </button>
                        )}
                    </div>

                    {/* Error Alert */}
                    {error && (
                        <Alert variant="destructive" className="mb-4">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    )}

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

