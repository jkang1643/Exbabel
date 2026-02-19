/**
 * BillingPage - Subscription management and billing for admins
 * 
 * Features:
 *   - View current plan and usage
 *   - Upgrade subscription plan
 *   - Purchase additional hours (top-up)
 *   - Access Stripe Customer Portal
 *   - Success/cancel feedback from Stripe checkout with session_id polling
 */

import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Header } from './Header';

const API_URL = import.meta.env.VITE_API_URL || '';

// Plan display info
const PLAN_INFO = {
    starter: { name: 'Starter', emoji: '🌱', color: 'bg-gray-100 border-gray-300', highlight: false },
    pro: { name: 'Pro', emoji: '⚡', color: 'bg-blue-50 border-blue-300', highlight: true },
    unlimited: { name: 'Unlimited', emoji: '🚀', color: 'bg-purple-50 border-purple-300', highlight: false },
};

export function BillingPage() {
    const { getAccessToken, signOut, reloadProfile } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const navigate = useNavigate();

    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);
    const [error, setError] = useState(null);
    const [successMessage, setSuccessMessage] = useState(null);
    const [finalizing, setFinalizing] = useState(false);
    const pollRef = useRef(null);

    // Check for Stripe redirect params
    useEffect(() => {
        const checkout = searchParams.get('checkout');
        const sessionId = searchParams.get('session_id');
        const canceled = searchParams.get('canceled');

        if (checkout === 'success' && sessionId) {
            // Stripe checkout completed — poll for webhook processing
            setFinalizing(true);
            pollCheckoutStatus(sessionId);
        } else if (checkout === 'success') {
            // Legacy success without session_id
            const plan = searchParams.get('plan');
            const topup = searchParams.get('topup');
            showSuccessMessage(plan, topup);
        } else if (canceled === 'true') {
            setError('Checkout was canceled. No charges were made.');
        }

        // Also handle legacy ?success=true format
        if (searchParams.get('success') === 'true') {
            const plan = searchParams.get('plan');
            const topup = searchParams.get('topup');
            showSuccessMessage(plan, topup);
        }

        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    function showSuccessMessage(plan, topup) {
        if (plan) {
            setSuccessMessage(`🎉 Successfully upgraded to ${PLAN_INFO[plan]?.name || plan}!`);
        } else if (topup) {
            setSuccessMessage(`🎉 Successfully purchased additional hours!`);
        } else {
            setSuccessMessage(`🎉 Payment successful!`);
        }
    }

    /**
     * Poll checkout status until webhook has processed.
     * Shows "Finalizing your subscription..." spinner.
     * Max 10 attempts (20 seconds), then shows success anyway.
     */
    async function pollCheckoutStatus(sessionId) {
        let attempts = 0;
        const maxAttempts = 10;

        const poll = async () => {
            attempts++;
            try {
                const token = getAccessToken();
                if (!token) return; // Wait for auth
                const res = await fetch(`${API_URL}/api/billing/checkout-status?session_id=${sessionId}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });

                if (res.ok) {
                    const data = await res.json();

                    // Webhook has processed and role is updated
                    if (data.webhookProcessed && data.profileRole === 'admin') {
                        clearInterval(pollRef.current);
                        pollRef.current = null;
                        setFinalizing(false);

                        const plan = data.plan || searchParams.get('plan');
                        showSuccessMessage(plan, null);

                        // Reload auth profile to reflect admin role
                        await reloadProfile();

                        // Reload billing status
                        await loadBillingStatus();

                        // Clean up URL params
                        setSearchParams({});
                        return;
                    }
                }
            } catch (err) {
                console.error('[Billing] Poll error:', err);
            }

            // Max attempts reached — show success anyway
            if (attempts >= maxAttempts) {
                clearInterval(pollRef.current);
                pollRef.current = null;
                setFinalizing(false);

                const plan = searchParams.get('plan');
                showSuccessMessage(plan, null);

                // Try reloading in case webhook processed after all
                await reloadProfile();
                await loadBillingStatus();
                setSearchParams({});
            }
        };

        // Initial poll immediately, then every 2 seconds
        await poll();
        if (pollRef.current === null && attempts < maxAttempts) {
            pollRef.current = setInterval(poll, 2000);
        }
    }

    // Load billing status
    useEffect(() => {
        loadBillingStatus();
    }, []);

    async function loadBillingStatus() {
        try {
            setLoading(true);
            const token = getAccessToken();
            if (!token) return;
            const res = await fetch(`${API_URL}/api/billing/status`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error('Failed to load billing status');
            const data = await res.json();
            setStatus(data);
        } catch (err) {
            console.error('[Billing] Load error:', err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    async function handleCheckout(endpoint, body = {}) {
        console.log('[DEBUG] handleCheckout called:', { endpoint, body });
        try {
            setActionLoading(endpoint);
            setError(null);
            const token = getAccessToken();
            if (!token) {
                setError("You must be logged in.");
                return;
            }
            const url = `${API_URL}/api/billing/${endpoint}`;
            // Portal now uses POST to support flow_data
            const method = 'POST';
            console.log('[DEBUG] Making request:', { url, method, hasToken: !!token });

            const res = await fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            console.log('[DEBUG] Response status:', res.status, res.ok);

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                console.error('[DEBUG] Error response:', data);
                throw new Error(data.error || 'Request failed');
            }

            const data = await res.json();
            console.log('[DEBUG] Response data:', data);

            if (data.url) {
                console.log('[DEBUG] Redirecting to:', data.url);
                window.location.href = data.url;
            } else {
                console.warn('[DEBUG] No URL in response!');
            }
        } catch (err) {
            console.error(`[Billing] ${endpoint} error:`, err);
            setError(err.message);
        } finally {
            setActionLoading(null);
        }
    }

    async function handleUpgrade(planCode) {
        try {
            setActionLoading('upgrade');
            setError(null);
            const token = getAccessToken();
            if (!token) {
                setError("You must be logged in.");
                return;
            }
            const res = await fetch(`${API_URL}/api/billing/subscription-checkout`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ planCode }),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Upgrade failed');
            }

            const data = await res.json();
            const planName = PLAN_INFO[planCode]?.name || planCode;
            setSuccessMessage(`🎉 Successfully upgraded to ${planName}!`);

            // Reload billing status to show new plan
            await loadBillingStatus();

        } catch (err) {
            console.error('[Billing] Upgrade error:', err);
            setError(err.message);
        } finally {
            setActionLoading(null);
        }
    }

    function formatTime(seconds) {
        if (!seconds && seconds !== 0) return '—';
        const hours = seconds / 3600;
        if (hours >= 1) return `${hours.toFixed(1)} hrs`;
        return `${Math.round(seconds / 60)} min`;
    }

    // Finalizing state (waiting for webhook to process)
    if (finalizing) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-blue-50 to-white">
                <Header onSignOut={signOut} />
                <div className="container mx-auto px-4 py-16 text-center">
                    <div className="max-w-md mx-auto">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto mb-6"></div>
                        <h2 className="text-2xl font-bold text-gray-800 mb-2">
                            Finalizing your subscription...
                        </h2>
                        <p className="text-gray-600">
                            Setting up your account. This usually takes just a moment.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-blue-50 to-white">
                <Header onSignOut={signOut} />
                <div className="container mx-auto px-4 py-16 text-center">
                    <div className="text-2xl">Loading billing...</div>
                </div>
            </div>
        );
    }

    const currentPlan = status?.plan?.code || 'starter';
    const planInfo = PLAN_INFO[currentPlan] || PLAN_INFO.starter;
    const usage = status?.usage;

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-white">
            <Header onSignOut={signOut} />

            <div className="container mx-auto px-4 py-8">
                <div className="max-w-4xl mx-auto">
                    {/* Back button */}
                    <button
                        onClick={() => navigate('/')}
                        className="text-sm text-gray-500 hover:text-gray-700 mb-6 flex items-center gap-1"
                    >
                        ← Back to Dashboard
                    </button>

                    <h1 className="text-3xl font-bold text-gray-800 mb-2">Billing & Subscription</h1>
                    <p className="text-gray-600 mb-8">Manage your plan, usage, and payment methods</p>

                    {/* Success / Error banners */}
                    {successMessage && (
                        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6 flex items-center justify-between">
                            <span className="text-green-800">{successMessage}</span>
                            <button onClick={() => setSuccessMessage(null)} className="text-green-600 hover:text-green-800">✕</button>
                        </div>
                    )}
                    {error && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 flex items-center justify-between">
                            <span className="text-red-800">{error}</span>
                            <button onClick={() => setError(null)} className="text-red-600 hover:text-red-800">✕</button>
                        </div>
                    )}

                    {/* Current Plan */}
                    <Card className={`mb-6 shadow-lg border-2 ${planInfo.color}`}>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div>
                                    <CardTitle className="text-xl">
                                        {planInfo.emoji} Current Plan: {planInfo.name}
                                    </CardTitle>
                                    <CardDescription>
                                        Status: <span className="font-semibold capitalize">{status?.subscription?.status || 'unknown'}</span>
                                        {status?.subscription?.currentPeriodEnd && (
                                            <> • Renews {new Date(status.subscription.currentPeriodEnd).toLocaleDateString()}</>
                                        )}
                                    </CardDescription>
                                </div>
                                <Button
                                    variant="outline"
                                    onClick={() => handleCheckout('portal')}
                                    disabled={!!actionLoading}
                                >
                                    {actionLoading === 'portal' ? 'Loading...' : '⚙️ Manage Billing'}
                                </Button>
                            </div>
                        </CardHeader>

                        {usage && (
                            <CardContent>
                                <div className="space-y-3">
                                    <div className="flex justify-between text-sm text-gray-600">
                                        <span>Monthly Usage</span>
                                        <span>{formatTime(usage.usedSecondsMtd)} / {formatTime(usage.totalAvailableSeconds)} used</span>
                                    </div>
                                    <div className="w-full bg-gray-200 rounded-full h-3">
                                        <div
                                            className={`h-3 rounded-full transition-all ${usage.percentUsed >= 100 ? 'bg-red-500' :
                                                usage.percentUsed >= 80 ? 'bg-yellow-500' : 'bg-blue-500'
                                                }`}
                                            style={{ width: `${Math.min(usage.percentUsed, 100)}%` }}
                                        />
                                    </div>
                                    <div className="flex justify-between text-xs text-gray-500">
                                        <span>{usage.percentUsed}% used</span>
                                        <span>{formatTime(usage.remainingSeconds)} remaining</span>
                                    </div>
                                    {usage.purchasedSecondsMtd > 0 && (
                                        <div className="text-xs text-blue-600 mt-2">
                                            <p className="font-semibold">Purchased credits this month:</p>
                                            <div className="ml-2 mt-1 space-y-0.5">
                                                <p>• Solo: {formatTime(usage.purchasedSoloSecondsMtd || 0)}</p>
                                                <p>• Host: {formatTime(usage.purchasedHostSecondsMtd || 0)}</p>
                                                <p className="font-semibold">Total: {formatTime(usage.purchasedSecondsMtd)}</p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        )}
                    </Card>

                    {/* Upgrade Plan */}
                    {currentPlan !== 'unlimited' && (
                        <Card className="mb-6 shadow-lg">
                            <CardHeader>
                                <CardTitle className="text-xl">⬆️ Upgrade Your Plan</CardTitle>
                                <CardDescription>
                                    Get more hours, better voice quality, and more languages
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {currentPlan === 'starter' && (
                                        <Button
                                            className="py-6 text-lg bg-blue-500 hover:bg-blue-600"
                                            onClick={() => handleCheckout('portal', { flow: 'subscription_update' })}
                                            disabled={!!actionLoading}
                                        >
                                            {actionLoading === 'portal' ? 'Redirecting...' : '⚡ Upgrade to Pro'}
                                        </Button>
                                    )}
                                    <Button
                                        className="py-6 text-lg bg-purple-500 hover:bg-purple-600"
                                        onClick={() => handleCheckout('portal', { flow: 'subscription_update' })}
                                        disabled={!!actionLoading}
                                    >
                                        {actionLoading === 'portal' ? 'Redirecting...' : '🚀 Upgrade to Unlimited'}
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {/* Add Hours */}
                    <Card className="mb-6 shadow-lg">
                        <CardHeader>
                            <CardTitle className="text-xl">⏱️ Add Hours</CardTitle>
                            <CardDescription>
                                Purchase additional translation time (valid this month)
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                {status?.availablePacks && Object.entries(status.availablePacks).map(([packId, pack]) => (
                                    <button
                                        key={packId}
                                        className="border-2 border-gray-200 hover:border-blue-400 rounded-lg p-4 text-center transition-all hover:shadow-md disabled:opacity-50"
                                        onClick={() => handleCheckout('top-up-checkout', { packId })}
                                        disabled={!!actionLoading}
                                    >
                                        <div className="text-2xl font-bold text-gray-800">{pack.label}</div>
                                        <div className="text-lg text-blue-600 font-semibold mt-1">
                                            ${(pack.amountCents / 100).toFixed(2)}
                                        </div>
                                        <div className="text-xs text-gray-500 mt-1">One-time purchase</div>
                                    </button>
                                ))}
                            </div>
                        </CardContent>
                    </Card>

                    {/* Purchased Credits */}
                    {status?.purchasedCredits?.length > 0 && (
                        <Card className="mb-6 shadow-lg">
                            <CardHeader>
                                <CardTitle className="text-lg">📋 Credits This Month</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-2">
                                    {status.purchasedCredits.map((credit, i) => (
                                        <div key={i} className="flex justify-between text-sm text-gray-600 py-2 border-b last:border-0">
                                            <span>{formatTime(credit.amount_seconds)} purchased</span>
                                            <span>{new Date(credit.created_at).toLocaleDateString()}</span>
                                        </div>
                                    ))}
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
}

export default BillingPage;
