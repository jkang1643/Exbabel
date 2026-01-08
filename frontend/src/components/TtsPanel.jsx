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

export function TtsPanel({ sendMessage, targetLang, isConnected }) {
    const [controller] = useState(() => new TtsPlayerController(sendMessage));
    const [playerState, setPlayerState] = useState(TtsPlayerState.STOPPED);
    const [enabled, setEnabled] = useState(false);
    const [selectedVoice, setSelectedVoice] = useState('Kore');
    const [selectedMode, setSelectedMode] = useState(TtsMode.UNARY);

    // Subscribe to controller state changes
    useEffect(() => {
        controller.onStateChange = (newState) => {
            setPlayerState(newState);
        };

        controller.onError = (error) => {
            console.error('[TtsPanel] Error:', error);
            alert(`TTS Error: ${error.message}`);
        };
    }, [controller]);

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

        controller.start({
            languageCode: targetLang,
            voiceName: selectedVoice,
            tier: TtsTier.GEMINI,
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
                            Voice
                        </label>
                        <select
                            value={selectedVoice}
                            onChange={(e) => setSelectedVoice(e.target.value)}
                            disabled={!isConnected}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                        >
                            <option value="">Select voice...</option>
                            <option value="Kore">Kore (Female)</option>
                            <option value="Charon">Charon (Male)</option>
                            <option value="Leda">Leda (Female)</option>
                            <option value="Puck">Puck (Male)</option>
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

                    {/* PR2: Temporary Manual Test Button */}
                    {/* TODO PR3: Remove this and integrate auto-synthesis */}
                    {isPlaying && (
                        <div className="pt-2 border-t border-gray-200">
                            <p className="text-xs text-gray-500 mb-2">Manual Test (PR2):</p>
                            <button
                                onClick={() => {
                                    const testText = "Hello, this is a test of the text to speech system.";
                                    const testSegmentId = `test-${Date.now()}`;
                                    controller.speakTextNow(testText, testSegmentId);
                                }}
                                disabled={!isConnected}
                                className="w-full px-3 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                🔊 Speak Test Segment
                            </button>
                        </div>
                    )}

                    {/* Status */}
                    <div className="text-xs text-gray-500 text-center">
                        Status: {playerState} | Language: {targetLang} | Mode: {selectedMode}
                    </div>
                </div>
            )}
        </div>
    );
}
