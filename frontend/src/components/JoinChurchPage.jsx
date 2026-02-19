/**
 * Join Church Page - Search and join churches
 * 
 * Allows users to:
 * - Search for churches by name
 * - View church details
 * - Join a church (requires sign-in)
 */

import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export function JoinChurchPage({ onBack, onSuccess, onSignIn }) {
    const { user, isAuthenticated, reloadProfile } = useAuth();
    const [searchQuery, setSearchQuery] = useState('');
    const [churches, setChurches] = useState([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isJoining, setIsJoining] = useState(null); // churchId being joined
    const [error, setError] = useState('');
    const [successMessage, setSuccessMessage] = useState('');

    // Search churches on query change (debounced)
    useEffect(() => {
        const timer = setTimeout(() => {
            searchChurches(searchQuery);
        }, 300);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    // Initial load - show all churches
    useEffect(() => {
        searchChurches('');
    }, []);

    const searchChurches = async (query) => {
        setIsSearching(true);
        setError('');
        try {
            // Hotfix: Include token if available (endpoints might require it)
            const { supabase } = await import('@/lib/supabase');
            const { data: { session } } = await supabase.auth.getSession();
            const headers = {};
            if (session?.access_token) {
                headers['Authorization'] = `Bearer ${session.access_token}`;
            }

            const response = await fetch(
                `${API_URL}/api/churches/search?q=${encodeURIComponent(query)}&limit=20`,
                { headers }
            );
            const data = await response.json();

            if (data.success) {
                setChurches(data.churches);
            } else {
                setError(data.error || 'Failed to search churches');
            }
        } catch (err) {
            console.error('Search error:', err);
            setError('Failed to connect to server');
        } finally {
            setIsSearching(false);
        }
    };

    const handleJoinChurch = async (churchId, churchName) => {
        if (!isAuthenticated) {
            setError('Please sign in to join a church');
            return;
        }

        setIsJoining(churchId);
        setError('');
        setSuccessMessage('');

        try {
            // Get auth token
            const { supabase } = await import('@/lib/supabase');
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                setError('Please sign in to join a church');
                return;
            }

            const response = await fetch(`${API_URL}/api/churches/join`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ churchId })
            });

            const data = await response.json();

            if (data.success) {
                setSuccessMessage(data.message || `Welcome to ${churchName}!`);

                // Reload profile to update auth context
                if (reloadProfile) {
                    await reloadProfile();
                }

                // Navigate to home after a short delay
                setTimeout(() => {
                    if (onSuccess) onSuccess();
                }, 1500);
            } else {
                setError(data.error || 'Failed to join church');
            }
        } catch (err) {
            console.error('Join error:', err);
            setError('Failed to connect to server');
        } finally {
            setIsJoining(null);
        }
    };

    const [copiedId, setCopiedId] = useState(null);

    const copyToClipboard = (text, id) => {
        navigator.clipboard.writeText(text);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-100">
            {/* Header */}
            <header className="bg-white/80 backdrop-blur-sm border-b border-gray-200 sticky top-0 z-10">
                <div className="container mx-auto px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <button onClick={onBack} className="text-gray-600 hover:text-gray-800">
                            ← Back
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-2xl">🌍</span>
                        <span className="font-bold text-xl text-gray-800">Exbabel</span>
                    </div>
                    <div className="w-16"></div>
                </div>
            </header>

            <div className="container mx-auto px-4 py-8">
                <div className="max-w-2xl mx-auto">
                    {/* Title */}
                    <div className="text-center mb-8">
                        <div className="text-5xl mb-3">⛪</div>
                        <h1 className="text-3xl font-bold text-gray-800 mb-2">Join a Church</h1>
                        <p className="text-gray-600">
                            Find and join a church to access their translation sessions
                        </p>
                    </div>

                    {/* Search */}
                    <div className="mb-6">
                        <Label htmlFor="search">Search churches</Label>
                        <Input
                            id="search"
                            type="text"
                            placeholder="Type to search..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="mt-1"
                        />
                    </div>

                    {/* Messages */}
                    {error && (
                        <Alert variant="destructive" className="mb-4">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    )}

                    {successMessage && (
                        <Alert className="mb-4 border-green-200 bg-green-50">
                            <AlertDescription className="text-green-800">
                                ✅ {successMessage}
                            </AlertDescription>
                        </Alert>
                    )}

                    {/* Sign in prompt */}
                    {!isAuthenticated && (
                        <Alert className="mb-4">
                            <AlertDescription>
                                <button
                                    onClick={onSignIn}
                                    className="text-purple-600 hover:text-purple-800 font-semibold underline underline-offset-2 transition-colors inline-block"
                                >
                                    Sign in
                                </button>
                                <span className="ml-1">
                                    to join a church and access member features.
                                </span>
                            </AlertDescription>
                        </Alert>
                    )}

                    {/* Results */}
                    <div className="space-y-3">
                        {isSearching && churches.length === 0 ? (
                            <div className="text-center py-8 text-gray-500">
                                <div className="animate-spin inline-block w-6 h-6 border-2 border-purple-600 border-t-transparent rounded-full mb-2"></div>
                                <p>Searching...</p>
                            </div>
                        ) : churches.length === 0 ? (
                            <div className="text-center py-8 text-gray-500">
                                <p>No churches found. Try a different search.</p>
                            </div>
                        ) : (
                            churches.map((church) => (
                                <Card key={church.id} className="hover:shadow-md transition-all duration-200">
                                    <CardHeader className="py-4">
                                        <div className="flex items-center justify-between gap-4">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <CardTitle className="text-lg font-bold text-gray-800 truncate">
                                                        {church.name}
                                                    </CardTitle>
                                                    {church.member_count > 0 && (
                                                        <span className="bg-purple-100 text-purple-700 text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0">
                                                            {church.member_count} {church.member_count === 1 ? 'member' : 'members'}
                                                        </span>
                                                    )}
                                                </div>

                                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-[11px] leading-tight select-all">
                                                            {church.id.split('-')[0]}...
                                                        </span>
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                copyToClipboard(church.id, church.id);
                                                            }}
                                                            className="text-gray-400 hover:text-purple-600 transition-colors"
                                                            title="Copy Full UUID"
                                                        >
                                                            {copiedId === church.id ? (
                                                                <span className="text-[10px] font-bold text-green-600">Copied!</span>
                                                            ) : (
                                                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                                            )}
                                                        </button>
                                                    </div>
                                                    <span className="flex items-center gap-1">
                                                        <span className="text-xs">📅</span>
                                                        {new Date(church.created_at).toLocaleDateString()}
                                                    </span>
                                                </div>
                                            </div>

                                            <Button
                                                onClick={() => handleJoinChurch(church.id, church.name)}
                                                disabled={isJoining === church.id || !isAuthenticated}
                                                size="sm"
                                                className="flex-shrink-0"
                                            >
                                                {isJoining === church.id ? 'Joining...' : 'Join'}
                                            </Button>
                                        </div>
                                    </CardHeader>
                                </Card>
                            ))
                        )}
                    </div>

                    {/* Back button */}
                    <div className="mt-8 text-center">
                        <Button variant="outline" onClick={onBack}>
                            Back to Home
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
