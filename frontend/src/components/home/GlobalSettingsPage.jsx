/**
 * GlobalSettingsPage - Church-wide settings for admins
 *
 * Sections:
 *  1. Billing (link card → /billing)
 *  2. QR Code & Session Settings
 *     - Permanent QR code display + copy + download
 *     - Regenerate code button
 *     - Conference Mode toggle
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Header } from '../Header';
import QRCode from 'qrcode';

const API_URL = import.meta.env.VITE_API_URL || '';
const APP_URL = import.meta.env.VITE_APP_URL || window.location.origin;

export function GlobalSettingsPage() {
    const { getAccessToken, signOut } = useAuth();
    const navigate = useNavigate();

    const [settings, setSettings] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [successMsg, setSuccessMsg] = useState(null);

    const [qrDataUrl, setQrDataUrl] = useState(null);
    const [copying, setCopying] = useState(false);
    const [regenerating, setRegenerating] = useState(false);
    const [savingMode, setSavingMode] = useState(false);

    // Load settings on mount
    useEffect(() => {
        loadSettings();
    }, []);

    // Regenerate QR image whenever the code changes
    useEffect(() => {
        if (settings?.permanentCode) {
            const joinUrl = `${APP_URL}/listener?code=${settings.permanentCode}`;
            QRCode.toDataURL(joinUrl, {
                width: 300,
                margin: 2,
                color: { dark: '#1e293b', light: '#ffffff' },
            }).then(setQrDataUrl).catch(console.error);
        }
    }, [settings?.permanentCode]);

    async function loadSettings() {
        try {
            setLoading(true);
            setError(null);
            const token = getAccessToken();
            if (!token) return;
            const res = await fetch(`${API_URL}/api/church/settings`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error('Failed to load settings');
            const data = await res.json();
            setSettings(data.settings);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    async function handleRegenerateCode() {
        if (!confirm('Generate a new QR code? Your old printed QR codes will stop working.')) return;
        try {
            setRegenerating(true);
            setError(null);
            const token = getAccessToken();
            if (!token) { setError("Not authenticated"); return; }
            const res = await fetch(`${API_URL}/api/church/settings/regenerate-code`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) throw new Error('Failed to regenerate code');
            const data = await res.json();
            setSettings(prev => ({ ...prev, permanentCode: data.permanentCode }));
            setSuccessMsg('✅ New QR code generated!');
        } catch (err) {
            setError(err.message);
        } finally {
            setRegenerating(false);
        }
    }

    async function handleConferenceModeToggle(newValue) {
        try {
            setSavingMode(true);
            setError(null);
            const token = getAccessToken();
            if (!token) { setError("Not authenticated"); return; }
            const res = await fetch(`${API_URL}/api/church/settings`, {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ conferenceMode: newValue }),
            });
            if (!res.ok) throw new Error('Failed to update setting');
            setSettings(prev => ({ ...prev, conferenceMode: newValue }));
            setSuccessMsg(newValue
                ? '✅ Conference Mode enabled — fresh code each session'
                : '✅ Regular Service mode — permanent QR code active'
            );
        } catch (err) {
            setError(err.message);
        } finally {
            setSavingMode(false);
        }
    }

    async function handleCopyCode() {
        if (!settings?.permanentCode) return;
        try {
            await navigator.clipboard.writeText(settings.permanentCode);
            setCopying(true);
            setTimeout(() => setCopying(false), 2000);
        } catch {
            setError('Could not copy to clipboard');
        }
    }

    function handleDownloadQR() {
        if (!qrDataUrl || !settings?.permanentCode) return;
        const link = document.createElement('a');
        link.href = qrDataUrl;
        link.download = `exbabel-qr-${settings.permanentCode}.png`;
        link.click();
    }

    if (loading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-blue-50 to-white">
                <Header onSignOut={signOut} />
                <div className="container mx-auto px-4 py-16 text-center text-2xl">
                    Loading settings...
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-white">
            <Header onSignOut={signOut} />

            <div className="container mx-auto px-4 py-8">
                <div className="max-w-2xl mx-auto">
                    {/* Back */}
                    <button
                        onClick={() => navigate('/')}
                        className="text-sm text-gray-500 hover:text-gray-700 mb-6 flex items-center gap-1"
                    >
                        ← Back to Dashboard
                    </button>

                    <h1 className="text-3xl font-bold text-gray-800 mb-2">⚙️ Global Settings</h1>
                    <p className="text-gray-600 mb-8">
                        {settings?.churchName && <span className="font-semibold">⛪ {settings.churchName} · </span>}
                        Church-wide configuration
                    </p>

                    {/* Banners */}
                    {successMsg && (
                        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6 flex items-center justify-between">
                            <span className="text-green-800">{successMsg}</span>
                            <button onClick={() => setSuccessMsg(null)} className="text-green-600 hover:text-green-800">✕</button>
                        </div>
                    )}
                    {error && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 flex items-center justify-between">
                            <span className="text-red-800">{error}</span>
                            <button onClick={() => setError(null)} className="text-red-600 hover:text-red-800">✕</button>
                        </div>
                    )}

                    {/* ── Section 1: Billing ── */}
                    <Card
                        className="mb-6 shadow-lg border-2 border-gray-100 hover:border-primary/30 transition-colors cursor-pointer"
                        onClick={() => navigate('/billing')}
                    >
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div>
                                    <CardTitle className="text-xl">💳 Billing & Subscription</CardTitle>
                                    <CardDescription>Manage your plan, usage, and payment methods</CardDescription>
                                </div>
                                <span className="text-gray-400 text-xl">→</span>
                            </div>
                        </CardHeader>
                    </Card>

                    {/* ── Section 2: QR Code & Session Settings ── */}
                    <Card className="mb-6 shadow-lg border-2 border-primary/10">
                        <CardHeader>
                            <CardTitle className="text-xl">📱 QR Code & Session Settings</CardTitle>
                            <CardDescription>
                                Control how your congregation joins live translation sessions
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">

                            {/* QR Code display */}
                            {settings?.permanentCode && (
                                <div className="flex flex-col items-center gap-4 p-6 bg-gray-50 rounded-xl border border-gray-200">
                                    {qrDataUrl ? (
                                        <img
                                            src={qrDataUrl}
                                            alt={`QR code for session ${settings.permanentCode}`}
                                            className="w-48 h-48 rounded-lg shadow-md"
                                        />
                                    ) : (
                                        <div className="w-48 h-48 bg-gray-200 rounded-lg animate-pulse" />
                                    )}

                                    {/* Code + copy */}
                                    <div className="flex items-center gap-3">
                                        <span className="text-3xl font-mono font-bold tracking-widest text-gray-800">
                                            {settings.permanentCode}
                                        </span>
                                        <button
                                            onClick={handleCopyCode}
                                            className="text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-300 hover:bg-gray-100 transition-colors"
                                            title="Copy code"
                                        >
                                            {copying ? '✅ Copied!' : '📋 Copy'}
                                        </button>
                                    </div>

                                    <p className="text-xs text-gray-500 text-center max-w-xs">
                                        Congregation scans this QR or enters the code at{' '}
                                        <span className="font-mono">{APP_URL}/listener</span>
                                    </p>

                                    {/* Action buttons */}
                                    <div className="flex gap-3 flex-wrap justify-center">
                                        <Button
                                            variant="outline"
                                            onClick={handleDownloadQR}
                                            disabled={!qrDataUrl}
                                            className="gap-2"
                                        >
                                            ⬇️ Download QR
                                        </Button>
                                        <Button
                                            variant="outline"
                                            onClick={handleRegenerateCode}
                                            disabled={regenerating}
                                            className="gap-2 text-orange-600 border-orange-300 hover:bg-orange-50"
                                        >
                                            {regenerating ? 'Generating...' : '🔄 Regenerate Code'}
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {/* Conference Mode toggle */}
                            <div className="flex items-start justify-between gap-4 p-4 rounded-xl border border-gray-200 bg-white">
                                <div className="flex-1">
                                    <div className="font-semibold text-gray-800 mb-1">
                                        🎪 Conference Mode
                                    </div>
                                    {settings?.conferenceMode ? (
                                        <p className="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                                            <strong>ON</strong> — A fresh code is generated for each session. Good for events, guest speakers, or multi-track conferences where you don't want the permanent code shared.
                                        </p>
                                    ) : (
                                        <p className="text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">
                                            <strong>OFF</strong> — Your permanent QR code is reused every week. Print it once and you're done.
                                        </p>
                                    )}
                                </div>
                                <button
                                    onClick={() => handleConferenceModeToggle(!settings?.conferenceMode)}
                                    disabled={savingMode}
                                    className={`relative inline-flex h-7 w-12 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${settings?.conferenceMode ? 'bg-amber-500' : 'bg-green-500'
                                        } ${savingMode ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    role="switch"
                                    aria-checked={settings?.conferenceMode}
                                >
                                    <span
                                        className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${settings?.conferenceMode ? 'translate-x-5' : 'translate-x-0'
                                            }`}
                                    />
                                </button>
                            </div>

                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}

export default GlobalSettingsPage;
