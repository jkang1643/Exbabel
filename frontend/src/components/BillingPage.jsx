/**
 * BillingPage - Subscription management and billing for admins
 * 
 * Features:
 *   - View current plan and usage
 *   - Upgrade subscription plan
 *   - Purchase additional hours (top-up)
 *   - Access Stripe Customer Portal
 *   - Success/cancel feedback from Stripe checkout
 */

import { useState, useEffect } from 'react';
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
    const { getAccessToken, signOut } = useAuth();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(null);
    const [error, setError] = useState(null);
    const [successMessage, setSuccessMessage] = useState(null);

    // Check for Stripe redirect params
    useEffect(() => {
        if (searchParams.get('success') === 'true') {
            const plan = searchParams.get('plan');
            const topup = searchParams.get('topup');
            if (plan) {
                setSuccessMessage(`🎉 Successfully upgraded to ${PLAN_INFO[plan]?.name || plan}!`);
            } else if (topup) {
                setSuccessMessage(`🎉 Successfully purchased additional hours!`);
            } else {
                setSuccessMessage(`🎉 Payment successful!`);
            }
        } else if (searchParams.get('canceled') === 'true') {
            setError('Checkout was canceled. No charges were made.');
        }
    }, [searchParams]);

    // Load billing status
    useEffect(() => {
        loadBillingStatus();
    }, []);

    async function loadBillingStatus() {
        try {
            setLoading(true);
            const token = await getAccessToken();
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
        try {
            setActionLoading(endpoint);
            setError(null);
            const token = await getAccessToken();
            const res = await fetch(`${API_URL}/api/billing/${endpoint}`, {
                method: endpoint === 'portal' ? 'GET' : 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: endpoint === 'portal' ? undefined : JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Request failed');
            }
            const data = await res.json();
            if (data.url) {
                window.location.href = data.url;
            }
        } catch (err) {
            console.error(`[Billing] ${endpoint} error:`, err);
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
                                        <p className="text-xs text-blue-600">
                                            Includes {formatTime(usage.purchasedSecondsMtd)} from purchased credits this month
                                        </p>
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
                                            onClick={() => handleCheckout('subscription-checkout', { planCode: 'pro' })}
                                            disabled={!!actionLoading}
                                        >
                                            {actionLoading === 'subscription-checkout' ? 'Redirecting...' : '⚡ Upgrade to Pro'}
                                        </Button>
                                    )}
                                    <Button
                                        className="py-6 text-lg bg-purple-500 hover:bg-purple-600"
                                        onClick={() => handleCheckout('subscription-checkout', { planCode: 'unlimited' })}
                                        disabled={!!actionLoading}
                                    >
                                        {actionLoading === 'subscription-checkout' ? 'Redirecting...' : '🚀 Upgrade to Unlimited'}
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
