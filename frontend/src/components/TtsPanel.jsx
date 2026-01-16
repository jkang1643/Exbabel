/**
 * TTS UI Component (Minimal Scaffold for PR1)
 * 
 * Simple TTS control panel for listener page.
 * Only visible when VITE_TTS_UI_ENABLED=true
 * 
 * PR1: Basic UI controls (no actual playback)
 * PR3: Full integration with audio playback
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { Volume2, VolumeX, Play, Square, ChevronDown, ChevronUp } from 'lucide-react';
import { TtsPlayerController } from '../tts/TtsPlayerController.js';
import { TtsPlayerState, TtsTier, TtsMode } from '../tts/types.js';

import { getVoicesForLanguage, normalizeLanguageCode } from '../config/ttsVoices.js';
import { getAllDeliveryStyles, voiceSupportsSSML, getDeliveryStyle } from '../config/ssmlConfig.js';
import { PROMPT_PRESETS, PROMPT_CATEGORIES, utf8ByteLength, BYTE_LIMITS, getByteStatus } from '../config/promptConfig.js';

export function TtsPanel({ controller, targetLang, isConnected, translations }) {
    // Controller is now passed from parent (ListenerPage) to ensure stability across re-renders
    if (!controller) {
        console.warn('[TtsPanel] No controller provided!');
    }

    const [playerState, setPlayerState] = useState(TtsPlayerState.STOPPED);
    const [enabled, setEnabled] = useState(false);
    const [selectedVoice, setSelectedVoice] = useState('Kore');
    const [selectedMode, setSelectedMode] = useState(TtsMode.UNARY);
    const [resolvedRoute, setResolvedRoute] = useState(null);

    // SSML state (Chirp 3 HD)
    const [deliveryStyle, setDeliveryStyle] = useState('standard_preaching');
    const [speakingRate, setSpeakingRate] = useState(1.45); // Default to 1.45 (Gemini optimized)
    const [pitchAdjust, setPitchAdjust] = useState('+1st');
    const [powerWordsEnabled, setPowerWordsEnabled] = useState(true);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [ssmlEnabled, setSsmlEnabled] = useState(true);

    // Gemini-TTS prompt state
    const [promptPresetId, setPromptPresetId] = useState('preacher_warm_build');
    const [customPrompt, setCustomPrompt] = useState('');
    const [intensity, setIntensity] = useState(3); // 1-5 scale
    const [promptBytes, setPromptBytes] = useState(0);
    const [textBytes, setTextBytes] = useState(0);

    // Radio mode queue status
    const [queueStatus, setQueueStatus] = useState(null);

    // Get available voices for current language
    const availableVoices = getVoicesForLanguage(targetLang);

    // Helper: Check if current voice is Gemini
    const isGeminiVoice = useMemo(() => {
        const voiceOption = availableVoices.find(v => v.value === selectedVoice);
        const tier = voiceOption?.tier || 'neural2';
        if (tier === 'gemini') return true;

        // Check if it's a Gemini studio voice name
        const geminiVoices = ['Kore', 'Charon', 'Leda', 'Puck', 'Aoede', 'Fenrir',
            'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam'];
        return geminiVoices.includes(selectedVoice);
    }, [selectedVoice, availableVoices]);

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

        controller.onRouteResolved = (route) => {
            console.log('[TtsPanel] Route resolved:', route);
            setResolvedRoute(route);
        };

        return () => {
            console.log('[TtsPanel] Component unmounting, clearing listeners');
            // Remove listeners when panel unmounts, but do NOT dispose controller
            controller.onStateChange = null;
            controller.onError = null;
            controller.onRouteResolved = null;
        };
    }, [controller]);

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

        // We now always send at least the rate if SSML is enabled or if using standard voices
        // Note: voiceSupportsSSML specifically refers to phrase-level prosody (Chirp 3 HD)
        return {
            enabled: ssmlEnabled,
            deliveryStyle: deliveryStyle,
            rate: speakingRate,
            pitch: pitchAdjust,
            pauseIntensity: getDeliveryStyle(deliveryStyle).pauseIntensity,
            emphasizePowerWords: powerWordsEnabled,
            emphasisLevel: 'moderate',
            supportsPhraseProsody: voiceSupportsSSML(selectedVoice, tier)
        };
    }, [ssmlEnabled, selectedVoice, availableVoices, deliveryStyle, speakingRate, pitchAdjust, powerWordsEnabled]);

    // Sync SSML options to controller when they change
    useEffect(() => {
        if (controller) {
            console.log('[TtsPanel] Syncing SSML options to controller:', currentSsmlOptions);
            controller.ssmlOptions = currentSsmlOptions;
        }
    }, [controller, currentSsmlOptions]);

    // Sync Gemini prompt settings to controller when they change
    useEffect(() => {
        if (controller) {
            console.log('[TtsPanel] Syncing Gemini prompt settings to controller:', {
                promptPresetId,
                customPrompt: customPrompt ? 'yes' : 'no',
                intensity
            });
            controller.promptPresetId = promptPresetId;
            controller.ttsPrompt = customPrompt;
            controller.intensity = intensity;
        }
    }, [controller, promptPresetId, customPrompt, intensity]);

    // Update prompt bytes when custom prompt changes
    useEffect(() => {
        if (customPrompt) {
            const bytes = utf8ByteLength(customPrompt);
            setPromptBytes(bytes);
        } else {
            setPromptBytes(0);
        }
    }, [customPrompt]);

    // Poll queue status when playing (radio mode)
    useEffect(() => {
        if (playerState === TtsPlayerState.PLAYING && controller) {
            const interval = setInterval(() => {
                const status = controller.getQueueStatus();
                setQueueStatus(status);
            }, 500); // Update every 500ms

            return () => clearInterval(interval);
        } else {
            setQueueStatus(null);
        }
    }, [playerState, controller]);

    const handleToggleEnabled = () => {
        setEnabled(!enabled);
        if (enabled && playerState === TtsPlayerState.PLAYING) {
            controller.stop();
        }
    };
    const handlePlay = () => {
        // CRITICAL: iOS Safari audio unlock MUST be called FIRST, synchronously in the gesture handler
        // This must happen before ANY async operations, state updates, or other code that could yield
        if (window.audioDebug) {
            window.audioDebug('PLAY TAP (user gesture)', {});
        }

        // Call unlock on the controller's persistent audio element (iOS Safari requirement)
        controller.unlockFromUserGesture();
        if (window.audioDebug) {
            window.audioDebug('unlockFromUserGesture() called', {});
        }

        if (!isConnected) {
            alert('Not connected to session');
            return;
        }

        // Find selected voice object to get its tier
        const voiceOption = availableVoices.find(v => v.value === selectedVoice);
        const tier = voiceOption?.tier || 'neural2';

        // Build request with prompt data for Gemini voices
        const requestData = {
            languageCode: targetLang,
            voiceName: selectedVoice,
            tier: tier,
            mode: selectedMode,
            ssmlOptions: currentSsmlOptions,
            // Radio mode: Start from "now" - use current timestamp as marker
            startFromSegmentId: Date.now()
        };

        // Add Gemini-TTS prompt fields if using Gemini voice
        if (isGeminiVoice) {
            requestData.promptPresetId = promptPresetId;
            requestData.ttsPrompt = customPrompt || undefined;
            requestData.intensity = intensity;
            console.log('[TtsPanel] Starting with Gemini prompts:', {
                preset: promptPresetId,
                customPrompt: customPrompt ? 'yes' : 'no',
                intensity
            });
        }

        console.log('[TtsPanel] Starting radio mode with startFromSegmentId:', requestData.startFromSegmentId);
        controller.start(requestData);
    };

    const handleStop = () => {
        controller.stop();
    };

    const handlePause = () => {
        controller.pause();
    };

    const handleResume = () => {
        controller.resume();
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
                            onChange={(e) => {
                                const newVoice = e.target.value;
                                setSelectedVoice(newVoice);

                                // Nudge speed for Gemini/Chirp3 if currently at default 1.0x
                                const voiceOption = availableVoices.find(v => v.value === newVoice);
                                if (voiceOption) {
                                    const tier = voiceOption.tier || 'standard';
                                    const isGemini = tier === 'gemini' || voiceOption.label?.includes('Studio');
                                    const isChirp3 = tier === 'chirp3_hd';

                                    if (isGemini && speakingRate === 1.0) {
                                        console.log('[TtsPanel] Nudging speaking rate to 1.45x for Gemini voice');
                                        setSpeakingRate(1.45);
                                    } else if (isChirp3 && speakingRate === 1.0) {
                                        console.log('[TtsPanel] Nudging speaking rate to 1.1x for Chirp3 voice');
                                        setSpeakingRate(1.1);
                                    }
                                }
                            }}
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

                    {/* Delivery Style / Prompt Controls (Chirp 3 HD SSML or Gemini Prompts) */}
                    {(() => {
                        const voiceOption = availableVoices.find(v => v.value === selectedVoice);
                        const tier = voiceOption?.tier || 'neural2';
                        const supportsSSML = voiceSupportsSSML(selectedVoice, tier);
                        const supportsPrompts = isGeminiVoice;

                        // Show controls if voice supports SSML (Chirp 3) OR prompts (Gemini)
                        if (!supportsSSML && !supportsPrompts) return null;

                        const deliveryStyles = getAllDeliveryStyles();

                        return (
                            <div className="space-y-3 pt-3 border-t border-blue-100">
                                <div className="flex items-center justify-between">
                                    <label className="block text-sm font-medium text-blue-700">
                                        {supportsPrompts ? '🎯 Prompted Delivery (Gemini)' : '🎤 Preaching Delivery Style'}
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
                                        {/* Global Speaking Rate (Visible for all engines) */}
                                        <div className="space-y-1 p-3 bg-blue-50/50 rounded-md border border-blue-100">
                                            <div className="flex justify-between items-center">
                                                <label className="block text-xs font-semibold text-blue-800">
                                                    Speaking Speed: {speakingRate.toFixed(2)}x
                                                </label>
                                                <button
                                                    onClick={() => {
                                                        const rate = isGeminiVoice ? 1.45 : (supportsSSML ? 1.1 : 1.0);
                                                        setSpeakingRate(rate);
                                                    }}
                                                    className="text-[10px] text-blue-600 hover:underline"
                                                >
                                                    Reset to {isGeminiVoice ? '1.45x' : (supportsSSML ? '1.1x' : '1.0x')}
                                                </button>
                                            </div>
                                            <input
                                                type="range"
                                                min="0.25"
                                                max="2.0"
                                                step="0.05"
                                                value={speakingRate}
                                                onChange={(e) => setSpeakingRate(parseFloat(e.target.value))}
                                                className="w-full h-1.5 bg-blue-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                                            />
                                            <div className="flex justify-between text-[10px] text-blue-500 px-1">
                                                <span>0.25x</span>
                                                <span>1.0x (Normal)</span>
                                                <span>2.0x</span>
                                            </div>
                                        </div>

                                        {/* Gemini Prompt Preset Selection */}
                                        {supportsPrompts ? (
                                            <>
                                                <select
                                                    value={promptPresetId}
                                                    onChange={(e) => setPromptPresetId(e.target.value)}
                                                    disabled={!isConnected}
                                                    className="w-full px-3 py-2 border border-blue-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed bg-white"
                                                >
                                                    {PROMPT_CATEGORIES.map((category) => (
                                                        <optgroup key={category.id} label={category.label}>
                                                            {PROMPT_PRESETS.filter(p => p.category === category.id).map((preset) => (
                                                                <option key={preset.id} value={preset.id}>
                                                                    {preset.label} - {preset.description}
                                                                </option>
                                                            ))}
                                                        </optgroup>
                                                    ))}
                                                </select>

                                                {/* Custom Prompt Input */}
                                                <div>
                                                    <label className="block text-xs font-medium text-gray-700 mb-1">
                                                        Custom Style Instructions (Optional)
                                                    </label>
                                                    <textarea
                                                        value={customPrompt}
                                                        onChange={(e) => setCustomPrompt(e.target.value)}
                                                        placeholder="e.g., Speak like a wise elder, whispering intermittently..."
                                                        disabled={!isConnected}
                                                        rows={2}
                                                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed text-sm"
                                                    />
                                                    <div className="flex justify-between items-center mt-1 text-xs">
                                                        <span className={`${getByteStatus(promptBytes, BYTE_LIMITS.PROMPT_MAX) === 'error' ? 'text-red-600 font-bold' :
                                                            getByteStatus(promptBytes, BYTE_LIMITS.PROMPT_MAX) === 'warning' ? 'text-orange-600 font-medium' :
                                                                'text-gray-500'
                                                            }`}>
                                                            Prompt: {promptBytes} / {BYTE_LIMITS.PROMPT_MAX} bytes
                                                        </span>
                                                    </div>
                                                </div>

                                                {/* Intensity Slider */}
                                                <div>
                                                    <div className="flex justify-between items-center mb-1">
                                                        <label className="block text-xs font-medium text-gray-700">
                                                            Style Intensity: {intensity}
                                                        </label>
                                                    </div>
                                                    <input
                                                        type="range"
                                                        min="1"
                                                        max="5"
                                                        step="1"
                                                        value={intensity}
                                                        onChange={(e) => setIntensity(parseInt(e.target.value))}
                                                        disabled={!isConnected}
                                                        className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                                    />
                                                    <div className="flex justify-between text-[10px] text-gray-400">
                                                        <span>Subtle</span>
                                                        <span>Moderate</span>
                                                        <span>Maximum</span>
                                                    </div>
                                                </div>
                                            </>
                                        ) : (
                                            /* Chirp 3 HD SSML Delivery Styles */
                                            <div className="space-y-2">
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
                                                    className="w-full px-3 py-2 border border-blue-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed bg-white"
                                                >
                                                    {deliveryStyles.map((style) => (
                                                        <option key={style.value} value={style.value}>
                                                            {style.icon} {style.label} - {style.description}
                                                        </option>
                                                    ))}
                                                </select>

                                                {/* Power Words Toggle (Chirp 3 only) */}
                                                {supportsSSML && (
                                                    <label className="flex items-center gap-2 text-[11px] text-gray-600 cursor-pointer">
                                                        <input
                                                            type="checkbox"
                                                            checked={powerWordsEnabled}
                                                            onChange={(e) => setPowerWordsEnabled(e.target.checked)}
                                                            className="w-3.5 h-3.5"
                                                        />
                                                        <span>✨ Emphasize spiritual keywords (Jesus, faith, etc.)</span>
                                                    </label>
                                                )}

                                                {/* Advanced Prosody Toggle (Chirp 3 / Neural2 only) */}
                                                <button
                                                    onClick={() => setShowAdvanced(!showAdvanced)}
                                                    className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 transition-colors"
                                                >
                                                    {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                                    Advanced Prosody Controls
                                                </button>

                                                {/* Advanced Prosody Controls */}
                                                {showAdvanced && (
                                                    <div className="space-y-3 p-3 bg-gray-50 rounded-md border border-gray-200 mt-1">
                                                        {/* Pitch Adjustment */}
                                                        <div>
                                                            <label className="block text-[10px] font-medium text-gray-700 mb-1 uppercase tracking-wider">
                                                                Pitch Adjustment
                                                            </label>
                                                            <select
                                                                value={pitchAdjust}
                                                                onChange={(e) => setPitchAdjust(e.target.value)}
                                                                className="w-full px-2 py-1 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                            >
                                                                <option value="-2st">-2 semitones (Lower)</option>
                                                                <option value="-1st">-1 semitone</option>
                                                                <option value="0st">Normal (0)</option>
                                                                <option value="+1st">+1 semitone (Warm)</option>
                                                                <option value="+2st">+2 semitones (Higher)</option>
                                                            </select>
                                                        </div>

                                                        <p className="text-[10px] text-gray-400 italic">
                                                            💡 Tip: Preaching cadence typically uses 0.90x-0.95x rate with +1 semitone
                                                        </p>
                                                    </div>
                                                )}
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

                    {/* Radio Mode Section */}
                    <div className="space-y-3 pt-3 border-t-2 border-green-200 bg-green-50/30 p-3 rounded-md">
                        <div className="flex items-center justify-between">
                            <h4 className="text-sm font-semibold text-green-800 flex items-center gap-2">
                                📻 Radio Mode
                                <span className="text-xs font-normal text-gray-600">(Auto-play new segments)</span>
                            </h4>
                        </div>

                        {/* Radio Mode Controls */}
                        <div className="flex gap-2">
                            {playerState === TtsPlayerState.STOPPED && (
                                <button
                                    onClick={handlePlay}
                                    disabled={!isConnected || !selectedVoice}
                                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                                >
                                    <Play className="w-5 h-5" />
                                    Start Radio Mode
                                </button>
                            )}
                            {playerState === TtsPlayerState.PLAYING && (
                                <>
                                    <button
                                        onClick={handlePause}
                                        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-yellow-600 text-white rounded-md hover:bg-yellow-700 transition-colors font-medium"
                                    >
                                        <Square className="w-5 h-5" />
                                        Pause
                                    </button>
                                    <button
                                        onClick={handleStop}
                                        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors font-medium"
                                    >
                                        <Square className="w-5 h-5" />
                                        Stop
                                    </button>
                                </>
                            )}
                            {playerState === TtsPlayerState.PAUSED && (
                                <>
                                    <button
                                        onClick={handleResume}
                                        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors font-medium"
                                    >
                                        <Play className="w-5 h-5" />
                                        Resume
                                    </button>
                                    <button
                                        onClick={handleStop}
                                        className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors font-medium"
                                    >
                                        <Square className="w-5 h-5" />
                                        Stop
                                    </button>
                                </>
                            )}
                        </div>

                        {/* Queue Status Display */}
                        {queueStatus && playerState === TtsPlayerState.PLAYING && (
                            <div className="space-y-2 p-3 bg-white/80 rounded border border-green-200">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-semibold text-gray-700">Queue Status</span>
                                    <span className="text-xs text-gray-500">
                                        {queueStatus.queueLength} total | {queueStatus.readyCount} ready | {queueStatus.pendingCount} pending
                                    </span>
                                </div>

                                {queueStatus.currentSegmentId && (
                                    <div className="p-2 bg-green-100 rounded border border-green-300">
                                        <div className="text-xs font-medium text-green-800 mb-1">
                                            🎵 Now Playing: {queueStatus.currentSegmentId}
                                        </div>
                                        <div className="text-xs text-gray-700 line-clamp-2">
                                            {queueStatus.currentText || 'Loading...'}
                                        </div>
                                    </div>
                                )}

                                {!queueStatus.currentSegmentId && queueStatus.queueLength > 0 && (
                                    <div className="text-xs text-gray-600 italic p-2 bg-yellow-50 rounded border border-yellow-200">
                                        ⏳ Waiting for next segment...
                                    </div>
                                )}

                                {queueStatus.queueLength === 0 && (
                                    <div className="text-xs text-gray-500 italic p-2">
                                        📭 Queue empty - waiting for new finalized segments
                                    </div>
                                )}

                                {/* Debug Info */}
                                <div className="text-[10px] text-gray-400 font-mono pt-1 border-t border-gray-200">
                                    Requesting: {queueStatus.inFlightCount} | Ready: {queueStatus.readyCount} | Pending: {queueStatus.pendingCount}
                                </div>
                            </div>
                        )}

                        <p className="text-xs text-gray-600 italic">
                            💡 Radio mode automatically speaks new finalized segments as they arrive
                        </p>
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
                                            // Removed alert(...) to prevent breaking user gesture chain and timing issues
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
