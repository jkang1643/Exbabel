/**
 * TTS UI Component (Minimal Scaffold for PR1)
 * 
 * Simple TTS control panel for listener page.
 * Only visible when VITE_TTS_UI_ENABLED=true
 * 
 * PR1: Basic UI controls (no actual playback)
 * PR3: Full integration with audio playback
 */

import { useState, useEffect } from 'react';
import { Volume2, VolumeX, Play, Square } from 'lucide-react';
import { TtsPlayerController } from '../tts/TtsPlayerController.js';
import { TtsPlayerState, TtsTier, TtsMode } from '../tts/types.js';

// Voice mappings by language (matching backend FALLBACK_VOICES)
const VOICE_OPTIONS_BY_LANG = {
    // Spanish - Gemini support added
    'es-ES': [
        // Gemini voices (language-agnostic)
        { value: 'Kore', label: 'Kore (Gemini, Female)', tier: 'gemini' },
        { value: 'Charon', label: 'Charon (Gemini, Male)', tier: 'gemini' },
        { value: 'Leda', label: 'Leda (Gemini, Female)', tier: 'gemini' },
        { value: 'Puck', label: 'Puck (Gemini, Male)', tier: 'gemini' },
        // Chirp3 HD voices
        { value: 'es-ES-Chirp3-HD-Kore', label: 'Chirp3 HD Kore (Female)', tier: 'chirp3_hd' },
        // Neural2 voices
        { value: 'es-ES-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        // Standard voices
        { value: 'es-ES-Standard-E', label: 'Standard-E (Female)', tier: 'standard' }
    ],
    'es-US': [
        { value: 'es-US-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        { value: 'es-US-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],

    // English
    'en-US': [
        { value: 'Kore', label: 'Kore (Gemini, Female)', tier: 'gemini' },
        { value: 'en-US-Chirp3-HD-Kore', label: 'Chirp3 HD Kore (Female)', tier: 'chirp3_hd' },
        { value: 'en-US-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        { value: 'en-US-Standard-A', label: 'Standard-A (Female)', tier: 'standard' },
        { value: 'Charon', label: 'Charon (Gemini, Male)', tier: 'gemini' },
        { value: 'Puck', label: 'Puck (Gemini, Male)', tier: 'gemini' }
    ],
    'en-GB': [
        { value: 'en-GB-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        { value: 'en-GB-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],

    // French - Gemini support added
    'fr-FR': [
        // Gemini voices (language-agnostic)
        { value: 'Kore', label: 'Kore (Gemini, Female)', tier: 'gemini' },
        { value: 'Charon', label: 'Charon (Gemini, Male)', tier: 'gemini' },
        { value: 'Leda', label: 'Leda (Gemini, Female)', tier: 'gemini' },
        { value: 'Puck', label: 'Puck (Gemini, Male)', tier: 'gemini' },
        // Neural2 voices
        { value: 'fr-FR-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        // Standard voices
        { value: 'fr-FR-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],

    // German - Gemini support added
    'de-DE': [
        // Gemini voices (language-agnostic)
        { value: 'Kore', label: 'Kore (Gemini, Female)', tier: 'gemini' },
        { value: 'Charon', label: 'Charon (Gemini, Male)', tier: 'gemini' },
        { value: 'Leda', label: 'Leda (Gemini, Female)', tier: 'gemini' },
        { value: 'Puck', label: 'Puck (Gemini, Male)', tier: 'gemini' },
        // Neural2 voices
        { value: 'de-DE-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        // Standard voices
        { value: 'de-DE-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],

    // Italian - Gemini support added
    'it-IT': [
        // Gemini voices (language-agnostic)
        { value: 'Kore', label: 'Kore (Gemini, Female)', tier: 'gemini' },
        { value: 'Charon', label: 'Charon (Gemini, Male)', tier: 'gemini' },
        { value: 'Leda', label: 'Leda (Gemini, Female)', tier: 'gemini' },
        { value: 'Puck', label: 'Puck (Gemini, Male)', tier: 'gemini' },
        // Neural2 voices
        { value: 'it-IT-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        // Standard voices
        { value: 'it-IT-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],

    // Portuguese - Gemini support added
    'pt-BR': [
        // Gemini voices (language-agnostic)
        { value: 'Kore', label: 'Kore (Gemini, Female)', tier: 'gemini' },
        { value: 'Charon', label: 'Charon (Gemini, Male)', tier: 'gemini' },
        { value: 'Leda', label: 'Leda (Gemini, Female)', tier: 'gemini' },
        { value: 'Puck', label: 'Puck (Gemini, Male)', tier: 'gemini' },
        // Neural2 voices
        { value: 'pt-BR-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        // Standard voices
        { value: 'pt-BR-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],
    'pt-PT': [
        { value: 'pt-PT-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        { value: 'pt-PT-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],

    // Japanese - Gemini support added
    'ja-JP': [
        // Gemini voices (language-agnostic)
        { value: 'Kore', label: 'Kore (Gemini, Female)', tier: 'gemini' },
        { value: 'Charon', label: 'Charon (Gemini, Male)', tier: 'gemini' },
        { value: 'Leda', label: 'Leda (Gemini, Female)', tier: 'gemini' },
        { value: 'Puck', label: 'Puck (Gemini, Male)', tier: 'gemini' },
        // Neural2 voices
        { value: 'ja-JP-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        // Standard voices
        { value: 'ja-JP-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],

    // Korean - Gemini support added
    'ko-KR': [
        // Gemini voices (language-agnostic)
        { value: 'Kore', label: 'Kore (Gemini, Female)', tier: 'gemini' },
        { value: 'Charon', label: 'Charon (Gemini, Male)', tier: 'gemini' },
        { value: 'Leda', label: 'Leda (Gemini, Female)', tier: 'gemini' },
        { value: 'Puck', label: 'Puck (Gemini, Male)', tier: 'gemini' },
        // Neural2 voices
        { value: 'ko-KR-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        // Standard voices
        { value: 'ko-KR-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],

    // Chinese
    'cmn-CN': [
        { value: 'cmn-CN-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        { value: 'cmn-CN-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],
    'zh-CN': [ // Alias for cmn-CN
        { value: 'cmn-CN-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        { value: 'cmn-CN-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],

    // Arabic
    'ar-XA': [
        { value: 'ar-XA-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        { value: 'ar-XA-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],

    // Hindi
    'hi-IN': [
        { value: 'hi-IN-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        { value: 'hi-IN-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ],

    // Russian
    'ru-RU': [
        { value: 'ru-RU-Neural2-A', label: 'Neural2-A (Female)', tier: 'neural2' },
        { value: 'ru-RU-Standard-A', label: 'Standard-A (Female)', tier: 'standard' }
    ]
};

// Helper function to normalize language code (e.g., 'es' -> 'es-ES')
const normalizeLanguageCode = (languageCode) => {
    if (!languageCode) return null;

    // If already in full format (e.g., 'es-ES'), return as-is
    if (languageCode.includes('-')) {
        return languageCode;
    }

    // Map short codes to full locale codes
    const languageMap = {
        'es': 'es-ES',
        'en': 'en-US',
        'fr': 'fr-FR',
        'de': 'de-DE',
        'it': 'it-IT',
        'pt': 'pt-BR',
        'ja': 'ja-JP',
        'ko': 'ko-KR',
        'zh': 'cmn-CN', // Map Chinese to Mandarin Chinese
        'ar': 'ar-XA',
        'hi': 'hi-IN',
        'ru': 'ru-RU'
    };

    return languageMap[languageCode] || `${languageCode}-${languageCode.toUpperCase()}`;
};

// Helper function to get available voices for a language
const getVoicesForLanguage = (languageCode) => {
    const normalizedCode = normalizeLanguageCode(languageCode);
    return VOICE_OPTIONS_BY_LANG[normalizedCode] || [
        { value: `${normalizedCode}-Neural2-A`, label: 'Neural2-A (Default)' }
    ];
};

export function TtsPanel({ sendMessage, targetLang, isConnected, onControllerReady, translations }) {
    const [controller] = useState(() => new TtsPlayerController(sendMessage));
    const [playerState, setPlayerState] = useState(TtsPlayerState.STOPPED);
    const [enabled, setEnabled] = useState(false);
    const [selectedVoice, setSelectedVoice] = useState('Kore');
    const [selectedMode, setSelectedMode] = useState(TtsMode.UNARY);
    const [resolvedRoute, setResolvedRoute] = useState(null);

    // Get available voices for current language
    const availableVoices = getVoicesForLanguage(targetLang);


    // Subscribe to controller state changes
    useEffect(() => {
        controller.onStateChange = (newState) => {
            setPlayerState(newState);
        };

        controller.onError = (error) => {
            console.error('[TtsPanel] Error:', error);
            alert(`TTS Error: ${error.message}`);
        };

        controller.onRouteResolved = (route) => {
            console.log('[TtsPanel] Route resolved:', route);
            setResolvedRoute(route);
        };

        // Expose controller to parent component
        if (onControllerReady) {
            onControllerReady(controller);
        }
    }, [controller, onControllerReady]);

    // Update controller language when targetLang changes
    useEffect(() => {
        if (controller && targetLang) {
            const normalizedLang = normalizeLanguageCode(targetLang);
            console.log('[TtsPanel] Updating controller language:', { from: targetLang, to: normalizedLang });
            controller.currentLanguageCode = normalizedLang;
        }
    }, [controller, targetLang]);

    // Update selected voice when language changes
    useEffect(() => {
        if (targetLang && availableVoices.length > 0) {
            // If current selected voice is not available for new language, switch to first available
            const isCurrentVoiceAvailable = availableVoices.some(voice => voice.value === selectedVoice);
            if (!isCurrentVoiceAvailable) {
                console.log('[TtsPanel] Switching voice for language change:', {
                    from: selectedVoice,
                    to: availableVoices[0].value,
                    language: targetLang
                });
                setSelectedVoice(availableVoices[0].value);
            }
        }
    }, [targetLang, availableVoices, selectedVoice]);

    // Update controller voice when selectedVoice changes
    useEffect(() => {
        if (controller && selectedVoice) {
            console.log('[TtsPanel] Updating controller voice to:', selectedVoice);
            controller.currentVoiceName = selectedVoice;
        }
    }, [controller, selectedVoice]);

    const handleToggleEnabled = () => {
        setEnabled(!enabled);
        if (enabled && playerState === TtsPlayerState.PLAYING) {
            controller.stop();
        }
    };

    const handlePlay = () => {
        if (!isConnected) {
            alert('Not connected to session');
            return;
        }

        // Find selected voice object to get its tier
        const voiceOption = availableVoices.find(v => v.value === selectedVoice);
        const tier = voiceOption?.tier || 'neural2';

        controller.start({
            languageCode: targetLang,
            voiceName: selectedVoice,
            tier: tier,
            mode: selectedMode
        });
    };

    const handleStop = () => {
        controller.stop();
    };

    const isPlaying = playerState === TtsPlayerState.PLAYING;

    return (
        <div className="bg-white rounded-lg shadow-md p-4 mb-4">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                    {enabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
                    Text-to-Speech
                </h3>
                <label className="flex items-center gap-2 cursor-pointer">
                    <span className="text-sm text-gray-600">Enable Speech</span>
                    <input
                        type="checkbox"
                        checked={enabled}
                        onChange={handleToggleEnabled}
                        className="w-4 h-4"
                    />
                </label>
            </div>

            {enabled && (
                <div className="space-y-3">
                    {/* Voice Selection */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Voice ({availableVoices.length} available)
                        </label>
                        <select
                            value={selectedVoice}
                            onChange={(e) => setSelectedVoice(e.target.value)}
                            disabled={!isConnected}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                        >
                            <option value="">Select voice...</option>
                            {availableVoices.map((voice) => (
                                <option key={voice.value} value={voice.value}>
                                    {voice.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Mode Selection */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Mode
                        </label>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setSelectedMode(TtsMode.UNARY)}
                                disabled={!isConnected}
                                className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${selectedMode === TtsMode.UNARY
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                            >
                                Unary
                            </button>
                            <button
                                onClick={() => setSelectedMode(TtsMode.STREAMING)}
                                disabled={!isConnected}
                                className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${selectedMode === TtsMode.STREAMING
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                            >
                                Streaming
                            </button>
                        </div>
                    </div>

                    {/* Playback Controls */}
                    <div className="flex gap-2 pt-2">
                        {!isPlaying ? (
                            <button
                                onClick={handlePlay}
                                disabled={!isConnected || !selectedVoice}
                                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Play className="w-4 h-4" />
                                Play
                            </button>
                        ) : (
                            <button
                                onClick={handleStop}
                                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
                            >
                                <Square className="w-4 h-4" />
                                Stop
                            </button>
                        )}
                    </div>

                    {/* PR2: Temporary Manual Test Buttons */}
                    {/* TODO PR3: Remove this and integrate auto-synthesis */}
                    {isPlaying && (
                        <div className="pt-2 border-t border-gray-200 space-y-2">
                            <p className="text-xs text-gray-500 mb-2">
                                Manual Test (PR2): {translations ? `${translations.length} segments` : 'No segments'}
                                {translations && translations.length > 0 && (
                                    <span className="block mt-1">
                                        Last: {(() => {
                                            const last = translations[translations.length - 1];
                                            return `${(last.translated || last.translatedText || last.original || last.text || 'no text').substring(0, 30)}...`;
                                        })()}
                                    </span>
                                )}
                            </p>

                            {/* Speak Test Segment */}
                            <button
                                onClick={() => {
                                    const testText = "Hello, this is a test of the text to speech system.";
                                    const testSegmentId = `test-${Date.now()}`;

                                    const voiceOption = availableVoices.find(v => v.value === selectedVoice);
                                    const tier = voiceOption?.tier || 'neural2';

                                    controller.speakTextNow(testText, testSegmentId, { tier });
                                }}
                                disabled={!isConnected}
                                className="w-full px-3 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                🔊 Speak Test Segment
                            </button>

                            {/* Speak Last Final Segment */}
                            {true && (
                                <button
                                    onClick={() => {
                                        console.log('[TtsPanel] Speak Last Final Segment clicked!');
                                        console.log('[TtsPanel] Available translations:', translations);

                                        if (!translations || translations.length === 0) {
                                            console.log('[TtsPanel] No translations available');
                                            alert('No translations available');
                                            return;
                                        }

                                        // Get the most recent final segment
                                        const lastSegment = [...translations].reverse().find(t => {
                                            // Check if this is a valid final segment
                                            // Priority: translated text > original text
                                            const hasTranslatedText = !!(t.translated || t.translatedText);
                                            const hasOriginalText = !!(t.original || t.text || t.originalText);
                                            let isValid = hasTranslatedText || hasOriginalText;

                                            // For auto-segmented entries: must not be partial
                                            if (t.isPartial !== undefined) {
                                                isValid = isValid && !t.isPartial;
                                            }

                                            return isValid;
                                        });

                                        console.log('[TtsPanel] Found last segment:', lastSegment);

                                        if (lastSegment) {
                                            // Prioritize translated text over original text
                                            const segmentText = lastSegment.translated || lastSegment.translatedText || lastSegment.original || lastSegment.text;
                                            const segmentId = `final-${Date.now()}`;

                                            const voiceOption = availableVoices.find(v => v.value === selectedVoice);
                                            const tier = voiceOption?.tier || 'neural2';

                                            console.log('[TtsPanel] Speaking last final segment:', {
                                                text: segmentText.substring(0, 50) + '...',
                                                segmentId,
                                                tier,
                                                controller: !!controller
                                            });

                                            if (controller && segmentText && segmentText.trim()) {
                                                console.log('[TtsPanel] Calling controller.speakTextNow with:', segmentText, segmentId, tier);
                                                controller.speakTextNow(segmentText, segmentId, { tier });
                                                alert(`Speaking: "${segmentText.substring(0, 50)}..."`);
                                            } else {
                                                console.error('[TtsPanel] Cannot speak - controller:', !!controller, 'text:', !!segmentText);
                                                alert('Cannot speak - check console for details');
                                            }
                                        } else {
                                            console.log('[TtsPanel] No final segments found');
                                            alert('No final segments available to speak');
                                        }
                                    }}
                                    disabled={!isConnected}
                                    title={isConnected ? 'Click to speak last final segment' : 'Not connected'}
                                    className="w-full px-3 py-2 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    🎤 Speak Last Final Segment
                                </button>
                            )}
                        </div>
                    )}

                    {/* Resolved Route Information */}
                    {resolvedRoute && (
                        <div className="pt-3 border-t border-gray-200">
                            <h4 className="text-sm font-medium text-gray-700 mb-2">Resolved Route</h4>
                            <div className="text-xs space-y-1 bg-gray-50 p-2 rounded">
                                <div><strong>Tier:</strong> {resolvedRoute.tier}</div>
                                <div><strong>Voice:</strong> {resolvedRoute.voiceName}</div>
                                <div><strong>Language:</strong> {resolvedRoute.languageCode}</div>
                                <div><strong>Model:</strong> {resolvedRoute.model || 'N/A'}</div>
                                <div><strong>Encoding:</strong> {resolvedRoute.audioEncoding}</div>
                                {resolvedRoute.fallbackFrom && (
                                    <div className="text-orange-600">
                                        <strong>Fallback from:</strong> {resolvedRoute.fallbackFrom.tier} → {resolvedRoute.tier}
                                    </div>
                                )}
                                <div className="text-gray-500 mt-1">
                                    <strong>Reason:</strong> {resolvedRoute.reason}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Status */}
                    <div className="text-xs text-gray-500 text-center pt-2">
                        Status: {playerState} | Language: {targetLang} | Mode: {selectedMode}
                    </div>
                </div>
            )}
        </div>
    );
}
