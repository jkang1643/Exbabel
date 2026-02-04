/**
 * Create Church Page - SaaS-style onboarding for new admins
 * 
 * Features:
 * - Getting started card with step indicator
 * - Church name input
 * - Creates church + admin profile + starter subscription
 * - Success welcome message before redirect
 */

import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export function CreateChurchPage({ onBack, onSuccess }) {
    const { user, isAuthenticated, reloadProfile } = useAuth();
    const [churchName, setChurchName] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [error, setError] = useState('');
    const [step, setStep] = useState('input'); // 'input' | 'creating' | 'success'
    const [createdChurch, setCreatedChurch] = useState(null);

    const handleCreate = async () => {
        if (!isAuthenticated) {
            setError('Please sign in to create a church');
            return;
        }

        const trimmedName = churchName.trim();
        if (trimmedName.length < 2) {
            setError('Church name must be at least 2 characters');
            return;
        }

        if (trimmedName.length > 100) {
            setError('Church name must be less than 100 characters');
            return;
        }

        setIsCreating(true);
        setError('');
        setStep('creating');

        try {
            const { supabase } = await import('@/lib/supabase');
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                setError('Please sign in to create a church');
                setStep('input');
                return;
            }

            const response = await fetch(`${API_URL}/api/churches/create`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ name: trimmedName })
            });

            const data = await response.json();

            if (data.success) {
                setCreatedChurch(data.church);
                setStep('success');

                // Reload profile to update auth context
                if (reloadProfile) {
                    await reloadProfile();
                }

                // Navigate to admin home after showing success
                setTimeout(() => {
                    if (onSuccess) onSuccess();
                }, 2500);
            } else {
                setError(data.error || 'Failed to create church');
                setStep('input');
            }
        } catch (err) {
            console.error('Create church error:', err);
            setError('Failed to connect to server');
            setStep('input');
        } finally {
            setIsCreating(false);
        }
    };

    // Success state - Welcome screen
    if (step === 'success' && createdChurch) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-100 flex items-center justify-center p-4">
                <Card className="max-w-md w-full shadow-2xl border-0 bg-white/95 backdrop-blur">
                    <CardContent className="pt-8 pb-8 text-center">
                        <div className="text-6xl mb-4 animate-bounce">🎉</div>
                        <h1 className="text-2xl font-bold text-gray-800 mb-2">
                            Welcome, Admin!
                        </h1>
                        <p className="text-gray-600 mb-4">
                            <span className="font-semibold">{createdChurch.name}</span> has been created successfully.
                        </p>
                        <div className="bg-green-50 rounded-lg p-4 mb-4 border border-green-200">
                            <p className="text-sm text-green-800">
                                ✅ You're now the administrator with full broadcast capabilities
                            </p>
                        </div>
                        <div className="text-sm text-gray-500">
                            <div className="animate-spin inline-block w-4 h-4 border-2 border-amber-600 border-t-transparent rounded-full mr-2"></div>
                            Setting up your dashboard...
                        </div>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-purple-50 to-pink-100 flex items-center justify-center p-4">
            {/* Onboarding Card */}
            <Card className="max-w-lg w-full shadow-2xl border-0 bg-white/95 backdrop-blur">
                {/* Progress indicator */}
                <div className="px-6 pt-6">
                    <div className="flex items-center justify-between text-sm text-gray-500 mb-2">
                        <span>Getting Started</span>
                        <span>Step 1 of 1</span>
                    </div>
                    <div className="h-1 bg-gray-200 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-purple-500 to-pink-500 w-full transition-all duration-500"></div>
                    </div>
                </div>

                <CardHeader className="text-center pb-2">
                    <div className="text-5xl mb-3">⛪✨</div>
                    <CardTitle className="text-2xl">Create Your Church</CardTitle>
                    <CardDescription className="text-base">
                        Set up your organization to start broadcasting real-time translations to your congregation
                    </CardDescription>
                </CardHeader>

                <CardContent className="space-y-6">
                    {/* Error message */}
                    {error && (
                        <Alert variant="destructive">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    )}

                    {/* Sign in prompt */}
                    {!isAuthenticated && (
                        <Alert>
                            <AlertDescription>
                                Please sign in to create a church.
                            </AlertDescription>
                        </Alert>
                    )}

                    {/* Church name input */}
                    <div className="space-y-2">
                        <Label htmlFor="churchName" className="text-base font-medium">
                            Church Name
                        </Label>
                        <Input
                            id="churchName"
                            type="text"
                            placeholder="e.g., Grace Community Church"
                            value={churchName}
                            onChange={(e) => setChurchName(e.target.value)}
                            disabled={isCreating}
                            className="h-12 text-lg"
                            autoFocus
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !isCreating && isAuthenticated) {
                                    handleCreate();
                                }
                            }}
                        />
                        <p className="text-sm text-gray-500">
                            This will be visible to members when they join your sessions
                        </p>
                    </div>

                    {/* What you get */}
                    <div className="bg-gradient-to-r from-purple-50 to-pink-50 rounded-lg p-4">
                        <p className="font-medium text-gray-800 mb-2">What's included:</p>
                        <ul className="space-y-1 text-sm text-gray-600">
                            <li className="flex items-center gap-2">
                                <span className="text-green-500">✓</span> Free Starter plan (4 hrs solo + 6 hrs broadcast/month)
                            </li>
                            <li className="flex items-center gap-2">
                                <span className="text-green-500">✓</span> Unlimited listener connections
                            </li>
                            <li className="flex items-center gap-2">
                                <span className="text-green-500">✓</span> 180+ supported languages with 60+ text-to-speech voices
                            </li>
                            <li className="flex items-center gap-2">
                                <span className="text-green-500">✓</span> Real-time grammar correction
                            </li>
                            <li className="flex items-center gap-2">
                                <span className="text-green-500">✓</span> Bible verse detection & phrase bank
                            </li>
                        </ul>
                    </div>

                    {/* Action buttons */}
                    <div className="space-y-3">
                        <Button
                            className="w-full h-12 text-lg bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
                            onClick={handleCreate}
                            disabled={isCreating || !isAuthenticated || churchName.trim().length < 2}
                        >
                            {isCreating ? (
                                <>
                                    <div className="animate-spin inline-block w-5 h-5 border-2 border-white border-t-transparent rounded-full mr-2"></div>
                                    Creating...
                                </>
                            ) : (
                                'Create Church & Start'
                            )}
                        </Button>

                        <Button
                            variant="ghost"
                            className="w-full text-gray-500"
                            onClick={onBack}
                            disabled={isCreating}
                        >
                            Sign out & return to visitor mode
                        </Button>
                    </div>

                    {/* User info */}
                    {isAuthenticated && user && (
                        <p className="text-center text-sm text-gray-500">
                            Signed in as {user.email}
                        </p>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
