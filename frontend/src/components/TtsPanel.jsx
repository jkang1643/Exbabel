/**
 * TTS UI Component (Minimal Scaffold for PR1)
 * 
 * Simple TTS control panel for listener page.
 * Only visible when VITE_TTS_UI_ENABLED=true
 * 
 * PR1: Basic UI controls (no actual playback)
 * PR3: Full integration with audio playback
 */

import { useState, useEffect, useMemo } from 'react';
import { Volume2, VolumeX, Play, Square, ChevronDown, ChevronUp } from 'lucide-react';
import { TtsPlayerController } from '../tts/TtsPlayerController.js';
import { TtsPlayerState, TtsTier, TtsMode } from '../tts/types.js';

import { getVoicesForLanguage, normalizeLanguageCode } from '../config/ttsVoices.js';
import { getAllDeliveryStyles, voiceSupportsSSML, getDeliveryStyle } from '../config/ssmlConfig.js';

export function TtsPanel({ sendMessage, targetLang, isConnected, onControllerReady, translations }) {
    const [controller] = useState(() => new TtsPlayerController(sendMessage));
    const [playerState, setPlayerState] = useState(TtsPlayerState.STOPPED);
    const [enabled, setEnabled] = useState(false);
    const [selectedVoice, setSelectedVoice] = useState('Kore');
    const [selectedMode, setSelectedMode] = useState(TtsMode.UNARY);
    const [resolvedRoute, setResolvedRoute] = useState(null);

    // SSML state
    const [deliveryStyle, setDeliveryStyle] = useState('standard_preaching');
    const [speakingRate, setSpeakingRate] = useState(0.92);
    const [pitchAdjust, setPitchAdjust] = useState('+1st');
    const [powerWordsEnabled, setPowerWordsEnabled] = useState(true);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [ssmlEnabled, setSsmlEnabled] = useState(true);

    // Get available voices for current language
    const availableVoices = getVoicesForLanguage(targetLang);

    // Group voices by tier for organized display
    const groupedVoices = useMemo(() => {
        const groups = {
            gemini: { label: 'Gemini & Studio (Ultra HD)', voices: [] },
            chirp3_hd: { label: 'Chirp 3 HD (Premium)', voices: [] },
            neural2: { label: 'Neural2 (High-Definition)', voices: [] },
            standard: { label: 'Standard (Legacy)', voices: [] }
        };

        availableVoices.forEach(voice => {
            const tier = voice.tier || 'standard';
            const label = voice.label || '';
            const value = voice.value || '';

            // Grouping logic: Studio voices go to Gemini group for better UX visibility
            if (tier === 'gemini' || label.includes('Studio') || value.includes('Studio')) {
                groups.gemini.voices.push(voice);
            } else if (tier === 'chirp3_hd') {
                groups.chirp3_hd.voices.push(voice);
            } else if (tier === 'neural2') {
                groups.neural2.voices.push(voice);
            } else {
                groups.standard.voices.push(voice);
            }
        });

        return groups;
    }, [availableVoices]);


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

    // Build SSML options object
    const currentSsmlOptions = useMemo(() => {
        const voiceOption = availableVoices.find(v => v.value === selectedVoice);
        const tier = voiceOption?.tier || 'neural2';

        if (!ssmlEnabled || !voiceSupportsSSML(selectedVoice, tier)) {
            return null;
        }

        return {
            enabled: true,
            deliveryStyle: deliveryStyle,
            rate: speakingRate,
            pitch: pitchAdjust,
            pauseIntensity: getDeliveryStyle(deliveryStyle).pauseIntensity,
            emphasizePowerWords: powerWordsEnabled,
            emphasisLevel: 'moderate'
        };
    }, [ssmlEnabled, selectedVoice, availableVoices, deliveryStyle, speakingRate, pitchAdjust, powerWordsEnabled]);

    // Sync SSML options to controller when they change
    useEffect(() => {
        if (controller) {
            console.log('[TtsPanel] Syncing SSML options to controller:', currentSsmlOptions);
            controller.ssmlOptions = currentSsmlOptions;
        }
    }, [controller, currentSsmlOptions]);

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
            mode: selectedMode,
            ssmlOptions: currentSsmlOptions
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
                            {Object.entries(groupedVoices).map(([tier, group]) => (
                                group.voices.length > 0 && (
                                    <optgroup key={tier} label={group.label}>
                                        {group.voices.map((voice) => (
                                            <option key={voice.value} value={voice.value}>
                                                {voice.label}
                                            </option>
                                        ))}
                                    </optgroup>
                                )
                            ))}
                        </select>

                        {/* SSML Availability Hint */}
                        {(() => {
                            const voiceOption = availableVoices.find(v => v.value === selectedVoice);
                            const tier = voiceOption?.tier || 'neural2';
                            const supportsSSML = voiceSupportsSSML(selectedVoice, tier);

                            if (!supportsSSML && availableVoices.some(v => voiceSupportsSSML(v.value, v.tier))) {
                                return (
                                    <p className="text-xs text-blue-600 mt-1 italic">
                                        💡 Select a Chirp 3 HD voice to enable preaching delivery styles
                                    </p>
                                );
                            }

                            if (supportsSSML) {
                                return (
                                    <p className="text-xs text-green-600 mt-1 font-medium">
                                        ✅ SSML preaching delivery enabled for this voice
                                    </p>
                                );
                            }

                            return null;
                        })()}
                    </div>

                    {/* SSML Delivery Style (Chirp 3 HD only) */}
                    {(() => {
                        const voiceOption = availableVoices.find(v => v.value === selectedVoice);
                        const tier = voiceOption?.tier || 'neural2';
                        const supportsSSML = voiceSupportsSSML(selectedVoice, tier);

                        if (!supportsSSML) return null;

                        const deliveryStyles = getAllDeliveryStyles();

                        return (
                            <div className="space-y-3 pt-3 border-t border-blue-100">
                                <div className="flex items-center justify-between">
                                    <label className="block text-sm font-medium text-blue-700">
                                        🎤 Preaching Delivery Style
                                    </label>
                                    <label className="flex items-center gap-1 text-xs">
                                        <input
                                            type="checkbox"
                                            checked={ssmlEnabled}
                                            onChange={(e) => setSsmlEnabled(e.target.checked)}
                                            className="w-3 h-3"
                                        />
                                        <span className="text-gray-600">Enable SSML</span>
                                    </label>
                                </div>

                                {ssmlEnabled && (
                                    <>
                                        <select
                                            value={deliveryStyle}
                                            onChange={(e) => {
                                                const newStyle = e.target.value;
                                                setDeliveryStyle(newStyle);
                                                const style = getDeliveryStyle(newStyle);
                                                setSpeakingRate(style.defaultRate);
                                                setPitchAdjust(style.defaultPitch);
                                            }}
                                            disabled={!isConnected}
                                            className="w-full px-3 py-2 border border-blue-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed bg-blue-50"
                                        >
                                            {deliveryStyles.map((style) => (
                                                <option key={style.value} value={style.value}>
                                                    {style.icon} {style.label} - {style.description}
                                                </option>
                                            ))}
                                        </select>

                                        {/* Power Words Toggle */}
                                        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={powerWordsEnabled}
                                                onChange={(e) => setPowerWordsEnabled(e.target.checked)}
                                                className="w-4 h-4"
                                            />
                                            <span>✨ Emphasize spiritual keywords (Jesus, faith, grace, etc.)</span>
                                        </label>

                                        {/* Advanced Settings Toggle */}
                                        <button
                                            onClick={() => setShowAdvanced(!showAdvanced)}
                                            className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 transition-colors"
                                        >
                                            {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                            Advanced Prosody Controls
                                        </button>

                                        {/* Advanced Prosody Controls */}
                                        {showAdvanced && (
                                            <div className="space-y-3 p-3 bg-gray-50 rounded-md border border-gray-200">
                                                {/* Speaking Rate */}
                                                <div>
                                                    <label className="block text-xs font-medium text-gray-700 mb-1">
                                                        Speaking Rate: {speakingRate.toFixed(2)}x
                                                    </label>
                                                    <input
                                                        type="range"
                                                        min="0.5"
                                                        max="1.5"
                                                        step="0.05"
                                                        value={speakingRate}
                                                        onChange={(e) => setSpeakingRate(parseFloat(e.target.value))}
                                                        className="w-full"
                                                    />
                                                    <div className="flex justify-between text-xs text-gray-500 mt-1">
                                                        <span>Slower (0.5x)</span>
                                                        <span>Sermon (0.92x)</span>
                                                        <span>Faster (1.5x)</span>
                                                    </div>
                                                </div>

                                                {/* Pitch Adjustment */}
                                                <div>
                                                    <label className="block text-xs font-medium text-gray-700 mb-1">
                                                        Pitch Adjustment
                                                    </label>
                                                    <select
                                                        value={pitchAdjust}
                                                        onChange={(e) => setPitchAdjust(e.target.value)}
                                                        className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                    >
                                                        <option value="-2st">-2 semitones (Lower)</option>
                                                        <option value="-1st">-1 semitone</option>
                                                        <option value="0st">Normal (0)</option>
                                                        <option value="+1st">+1 semitone (Warm)</option>
                                                        <option value="+2st">+2 semitones (Higher)</option>
                                                    </select>
                                                </div>

                                                <p className="text-xs text-gray-500 italic">
                                                    💡 Tip: Sermon cadence typically uses 88-94% rate with +1 to +2 semitone pitch
                                                </p>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        );
                    })()}

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
                            <div className="text-[10px] space-y-1 bg-gray-50 p-2 rounded border border-gray-100 font-mono">
                                <div><span className="text-gray-500">resolvedEngine:</span> {resolvedRoute.engine} ({resolvedRoute.provider})</div>
                                <div><span className="text-gray-500">resolvedTier:</span> {resolvedRoute.tier}</div>
                                <div><span className="text-gray-500">resolvedModel:</span> {resolvedRoute.model || 'N/A'}</div>
                                <div><span className="text-gray-500">resolvedVoiceName:</span> {resolvedRoute.voiceName}</div>
                                <div><span className="text-gray-500">resolvedLanguageCode:</span> {resolvedRoute.languageCode}</div>
                                <div><span className="text-gray-500">audioEncoding:</span> {resolvedRoute.audioEncoding}</div>

                                {resolvedRoute.fallbackFrom && (
                                    <div className="text-orange-600 mt-1 pt-1 border-t border-orange-100">
                                        <span className="font-bold">FALLBACK:</span> {resolvedRoute.fallbackFrom.tier} &rarr; {resolvedRoute.tier}
                                    </div>
                                )}

                                <div className="text-blue-600 mt-1 italic">
                                    <span className="text-gray-500 font-bold not-italic">reason:</span> {resolvedRoute.reason}
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
