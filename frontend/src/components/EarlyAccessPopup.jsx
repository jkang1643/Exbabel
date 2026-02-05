import React, { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { X, Check, Globe, Mic, Volume2, PenTool, Zap, Lock } from 'lucide-react';

export function EarlyAccessPopup({ isOpen, onClose, onSignUp }) {
    if (!isOpen) return null;

    useEffect(() => {
        // Prevent background scrolling when modal is open
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = 'unset';
        };
    }, []);

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto relative flex flex-col animate-in zoom-in-95 duration-300">

                {/* Close Button */}
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-2 bg-gray-100 hover:bg-gray-200 rounded-full transition-colors z-10"
                >
                    <X size={20} className="text-gray-600" />
                </button>

                {/* Content */}
                <div className="p-6 md:p-8 space-y-8">

                    {/* Header Section */}
                    <div className="text-center space-y-2">
                        <div className="inline-block px-4 py-1.5 bg-primary/10 text-primary font-bold rounded-full text-sm mb-2">
                            🎉 You’re Early — and That Matters
                        </div>
                        <h2 className="text-3xl md:text-4xl font-extrabold text-gray-900">
                            Welcome to <span className="text-primary">Exbabel</span>
                        </h2>
                        <p className="text-lg text-gray-600 font-medium">
                            It looks like you're one of our very first visitors.
                        </p>
                        <p className="text-gray-500">
                            And early access comes with real perks.
                        </p>
                    </div>

                    <div className="h-px bg-gray-100 w-full" />

                    {/* Reward Section */}
                    <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-100 rounded-xl p-6 text-center shadow-sm">
                        <div className="text-4xl mb-3">🎁</div>
                        <h3 className="text-xl font-bold text-amber-900 mb-2">Early Visitor Reward</h3>
                        <div className="text-2xl font-black text-amber-600 mb-4">FREE Admin Account</div>

                        <div className="flex flex-wrap justify-center gap-2 mb-4">
                            <span className="bg-white/60 px-3 py-1 rounded-md text-amber-800 text-sm font-semibold border border-amber-100">Starter limits included — on us.</span>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm text-amber-800/80 font-medium">
                            <div className="flex items-center justify-center gap-1">
                                <Check size={16} className="text-green-600" /> No credit card
                            </div>
                            <div className="flex items-center justify-center gap-1">
                                <Check size={16} className="text-green-600" /> No trial countdown
                            </div>
                            <div className="flex items-center justify-center gap-1">
                                <Check size={16} className="text-green-600" /> No pressure
                            </div>
                        </div>
                        <p className="mt-4 text-amber-900 font-medium">Just full admin power to explore Exbabel 🚀</p>
                    </div>

                    <div className="h-px bg-gray-100 w-full" />

                    {/* Why Exbabel Wins */}
                    <div className="space-y-4">
                        <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                            <span className="text-2xl">🚀</span> Why Exbabel Wins
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="flex items-start gap-3">
                                <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
                                    <Globe size={20} />
                                </div>
                                <div>
                                    <h4 className="font-bold text-gray-900">190+ Languages</h4>
                                    <p className="text-sm text-gray-600">Reach audiences across the globe — instantly.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <div className="p-2 bg-pink-50 text-pink-600 rounded-lg">
                                    <Volume2 size={20} />
                                </div>
                                <div>
                                    <h4 className="font-bold text-gray-900">90+ Text-to-Speech Languages</h4>
                                    <p className="text-sm text-gray-600">Listeners can read <span className="italic">or</span> hear the message.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <div className="p-2 bg-purple-50 text-purple-600 rounded-lg">
                                    <Mic size={20} />
                                </div>
                                <div>
                                    <h4 className="font-bold text-gray-900">Real Human-Sounding Voices</h4>
                                    <p className="text-sm text-gray-600">Not robotic. Not flat. Natural, expressive speech.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <div className="p-2 bg-emerald-50 text-emerald-600 rounded-lg">
                                    <PenTool size={20} />
                                </div>
                                <div>
                                    <h4 className="font-bold text-gray-900">Smart Grammar Correction</h4>
                                    <p className="text-sm text-gray-600">Clean up grammar and clarity in real time.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3 md:col-span-2">
                                <div className="p-2 bg-yellow-50 text-yellow-600 rounded-lg">
                                    <Zap size={20} />
                                </div>
                                <div>
                                    <h4 className="font-bold text-gray-900">Built for Live Moments</h4>
                                    <p className="text-sm text-gray-600">Speak once. Everyone understands.</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="h-px bg-gray-100 w-full" />

                    {/* How It Works */}
                    <div className="bg-gray-50 rounded-xl p-6">
                        <h3 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                            <span className="text-2xl">📱</span> How It Works (For Your Audience)
                        </h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                            <div className="flex flex-col items-center gap-2">
                                <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-sm text-xl border border-gray-100">📷</div>
                                <span className="text-sm font-medium text-gray-700">Scan QR / Click Link</span>
                            </div>
                            <div className="flex flex-col items-center gap-2">
                                <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-sm text-xl border border-gray-100">🌍</div>
                                <span className="text-sm font-medium text-gray-700">Pick Language</span>
                            </div>
                            <div className="flex flex-col items-center gap-2">
                                <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-sm text-xl border border-gray-100">📝</div>
                                <span className="text-sm font-medium text-gray-700">Read Captions</span>
                            </div>
                            <div className="flex flex-col items-center gap-2">
                                <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-sm text-xl border border-gray-100">🔊</div>
                                <span className="text-sm font-medium text-gray-700">Hear Aloud</span>
                            </div>
                        </div>
                        <p className="text-center font-bold text-gray-800 mt-4">One speaker. Infinite understanding.</p>
                    </div>

                    {/* Comparison */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-white border border-gray-100 rounded-xl p-6 shadow-sm">
                        <div>
                            <h4 className="font-bold text-red-600 mb-3 flex items-center gap-2">
                                <span className="text-xl">🆚</span> Tired of “Translation Tools”?
                            </h4>
                            <ul className="space-y-2 text-sm text-gray-600">
                                <li className="flex items-center gap-2"><X size={14} className="text-red-500" /> Limited languages</li>
                                <li className="flex items-center gap-2"><X size={14} className="text-red-500" /> Robotic voices</li>
                                <li className="flex items-center gap-2"><X size={14} className="text-red-500" /> Paywalls before value</li>
                            </ul>
                        </div>
                        <div className="border-l border-gray-100 pl-4 md:pl-6">
                            <h4 className="font-bold text-green-600 mb-3">
                                ✅ Exbabel delivers
                            </h4>
                            <ul className="space-y-2 text-sm text-gray-800 font-medium">
                                <li className="flex items-center gap-2"><Check size={14} className="text-green-500" /> Clarity</li>
                                <li className="flex items-center gap-2"><Check size={14} className="text-green-500" /> Realism</li>
                                <li className="flex items-center gap-2"><Check size={14} className="text-green-500" /> Reach</li>
                            </ul>
                        </div>
                    </div>

                    {/* Urgency */}
                    <div className="text-center bg-gray-900 rounded-xl p-4 text-white">
                        <h4 className="font-bold text-lg mb-1 flex items-center justify-center gap-2">
                            <Lock size={18} /> Early Access Is Limited
                        </h4>
                        <p className="text-sm text-gray-300">
                            This free admin access is only for early visitors. Once it’s gone — it’s gone.
                        </p>
                    </div>

                    {/* CTA Section */}
                    <div className="text-center space-y-4 pt-4">
                        <Button
                            onClick={onSignUp}
                            className="w-full py-8 text-xl font-bold bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/30 transform hover:scale-[1.02] transition-all rounded-xl flex items-center justify-center gap-2"
                        >
                            🚀 Sign Up for Free Admin Access
                        </Button>
                        <button onClick={onClose} className="text-sm text-gray-400 hover:text-gray-600 transition-colors">
                            No thanks, I'll explore first
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
