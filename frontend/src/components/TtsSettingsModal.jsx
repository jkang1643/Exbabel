
import React, { useMemo } from 'react';
import { Settings, X, ChevronDown, ChevronUp } from 'lucide-react';
import { getAllDeliveryStyles, voiceSupportsSSML, getDeliveryStyle } from '../config/ssmlConfig.js';
import { PROMPT_PRESETS, PROMPT_CATEGORIES, utf8ByteLength, BYTE_LIMITS, getByteStatus } from '../config/promptConfig.js'; // Ensure promptConfig exports getVoicesForLanguage or import it from ttsVoices.js
import { getVoicesForLanguage as getVoices } from '../config/ttsVoices.js'; // Import correctly

export function TtsSettingsModal({
    isOpen,
    onClose,
    settings,
    onSettingsChange,
    selectedVoice,
    targetLang
}) {
    if (!isOpen) return null;

    // Determine standard vs Gemini
    const voices = getVoices(targetLang);
    const voiceOption = voices.find(v => v.value === selectedVoice);
    const tier = voiceOption?.tier || 'neural2';
    const isGemini = tier === 'gemini';
    const deliveryStyles = getAllDeliveryStyles();

    // Handlers
    const handleSettingChange = (key, value) => {
        onSettingsChange({
            ...settings,
            [key]: value
        });
    };

    const promptBytes = utf8ByteLength(settings.customPrompt || '');

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in duration-200">

                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-gray-100">
                    <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                        <Settings className="w-5 h-5 text-gray-600" />
                        Voice Settings
                    </h3>
                    <button
                        onClick={onClose}
                        className="p-1 hover:bg-gray-100 rounded-full transition-colors"
                    >
                        <X className="w-6 h-6 text-gray-500" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-4 space-y-6">

                    {/* Global Rate Control */}
                    <div>
                        <div className="flex justify-between items-center mb-2">
                            <label className="text-sm font-semibold text-gray-700">
                                Speaking Rate: {settings.speakingRate}x
                            </label>
                            <button
                                onClick={() => {
                                    const resetRate = isGemini ? 1.45 : 1.1;
                                    handleSettingChange('speakingRate', resetRate);
                                }}
                                className="text-xs text-blue-600 hover:text-blue-800"
                            >
                                Reset to {isGemini ? '1.45x' : '1.1x'}
                            </button>
                        </div>
                        <input
                            type="range"
                            min="0.25"
                            max="2.0"
                            step="0.05"
                            value={settings.speakingRate}
                            onChange={(e) => handleSettingChange('speakingRate', parseFloat(e.target.value))}
                            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                        />
                        <div className="flex justify-between text-xs text-gray-400 mt-1">
                            <span>Slow (0.25)</span>
                            <span>Normal (1.0)</span>
                            <span>Fast (2.0)</span>
                        </div>
                    </div>

                    <hr className="border-gray-100" />

                    {/* Gemini Specific Controls */}
                    {isGemini ? (
                        <div className="space-y-4">
                            <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-3">
                                <p className="text-sm text-emerald-800 font-medium mb-1"> ✨ Gemini Ultra HD Active</p>
                                <p className="text-xs text-emerald-600">Customize the AI personality and delivery style.</p>
                            </div>

                            {/* Prompt Preset */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Style Preset
                                </label>
                                <select
                                    value={settings.promptPresetId}
                                    onChange={(e) => handleSettingChange('promptPresetId', e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-sm bg-white"
                                >
                                    {PROMPT_CATEGORIES.map((category) => (
                                        <optgroup key={category.id} label={category.label}>
                                            {PROMPT_PRESETS.filter(p => p.category === category.id).map((preset) => (
                                                <option key={preset.id} value={preset.id}>
                                                    {preset.label}
                                                </option>
                                            ))}
                                        </optgroup>
                                    ))}
                                </select>
                            </div>

                            {/* Intensity */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Style Intensity: {settings.intensity}/5
                                </label>
                                <input
                                    type="range"
                                    min="1"
                                    max="5"
                                    step="1"
                                    value={settings.intensity}
                                    onChange={(e) => handleSettingChange('intensity', parseInt(e.target.value))}
                                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                                />
                                <div className="flex justify-between text-xs text-gray-400 mt-1">
                                    <span>Subtle</span>
                                    <span>Moderate</span>
                                    <span>Maximum</span>
                                </div>
                            </div>

                            {/* Custom Prompt */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Custom Instructions
                                </label>
                                <textarea
                                    value={settings.customPrompt}
                                    onChange={(e) => handleSettingChange('customPrompt', e.target.value)}
                                    placeholder="e.g. Speak with a warm, grandfatherly tone..."
                                    rows={3}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-sm"
                                />
                                <div className="text-right text-xs text-gray-400 mt-1">
                                    {promptBytes}/{BYTE_LIMITS.PROMPT_MAX} bytes
                                </div>
                            </div>
                        </div>
                    ) : (
                        // Standard/Chirp Controls
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Delivery Style (Preaching)
                                </label>
                                <select
                                    value={settings.deliveryStyle}
                                    onChange={(e) => {
                                        const newStyle = e.target.value;
                                        handleSettingChange('deliveryStyle', newStyle);
                                        // Auto-update pitch/rate defaults for style if needed (can be handled in parent or here)
                                    }}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-sm bg-white"
                                >
                                    {deliveryStyles.map((style) => (
                                        <option key={style.value} value={style.value}>
                                            {style.icon} {style.label}
                                        </option>
                                    ))}
                                </select>
                                <p className="text-xs text-gray-500 mt-1">Select a predefined preaching cadence.</p>
                            </div>

                            {/* Advanced Prosody Toggle could go here if needed */}
                            <div className="bg-gray-50 p-3 rounded text-center">
                                <p className="text-xs text-gray-500">
                                    {voiceSupportsSSML(selectedVoice, tier)
                                        ? "✅ This voice supports advanced preaching styles."
                                        : "⚠️ Switch to a Chirp 3 HD voice for best preaching results."}
                                </p>
                            </div>
                        </div>
                    )}

                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-100 bg-gray-50 rounded-b-xl flex justify-end">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors"
                    >
                        Done
                    </button>
                </div>

            </div>
        </div>
    );
}
