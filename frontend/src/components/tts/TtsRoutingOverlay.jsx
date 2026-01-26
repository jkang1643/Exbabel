import React from 'react';
import { Route, Layers, Network, Mic } from 'lucide-react';

/**
 * TtsRoutingOverlay - Visualizes active TTS routing decisions
 * Shows: Voice Name, Provider/Engine, Tier, Latency
 */
export function TtsRoutingOverlay({
    isActive,
    voiceName,
    provider,
    tier,
    latencyMs
}) {
    if (!isActive) return null;

    // Determine color based on provider
    const getProviderColor = (p) => {
        const prov = p?.toLowerCase() || '';
        if (prov.includes('google')) return '#4285F4';
        if (prov.includes('eleven')) return '#F43F5E'; // Rose for ElevenLabs
        if (prov.includes('openai')) return '#10A37F';
        return '#8B5CF6'; // Purple default
    };

    const color = getProviderColor(provider);

    return (
        <div className="tts-routing-overlay">
            <div className="routing-header">
                <Route size={14} className="icon" />
                <span className="label">ACTIVE ROUTE</span>
            </div>

            <div className="routing-content">
                <div className="voice-info">
                    <Mic size={16} style={{ color }} />
                    <span className="voice-name">{voiceName || 'Unknown Voice'}</span>
                </div>

                <div className="meta-info">
                    <div className="tag provider" style={{ borderColor: color, color: color }}>
                        {provider || 'Provider'}
                    </div>
                    {tier && (
                        <div className="tag tier">
                            <Layers size={10} />
                            {tier}
                        </div>
                    )}
                    {latencyMs && (
                        <div className="tag latency">
                            <Network size={10} />
                            {latencyMs}ms
                        </div>
                    )}
                </div>
            </div>

            <style>{`
                .tts-routing-overlay {
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    background: rgba(15, 23, 42, 0.95);
                    backdrop-filter: blur(8px);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-left: 4px solid ${color};
                    border-radius: 8px;
                    padding: 12px 16px;
                    color: #fff;
                    font-family: 'Inter', sans-serif;
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
                    z-index: 10000;
                    min-width: 220px;
                    opacity: 1;
                    pointer-events: none;
                    animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                }

                @keyframes slideIn {
                    from { transform: translateX(20px); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }

                .routing-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    margin-bottom: 6px;
                    opacity: 0.7;
                    font-size: 0.7rem;
                    font-weight: 700;
                    letter-spacing: 0.05em;
                }

                .voice-info {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 8px;
                    font-weight: 600;
                    font-size: 0.95rem;
                }

                .meta-info {
                    display: flex;
                    gap: 6px;
                    flex-wrap: wrap;
                }

                .tag {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 0.75rem;
                    background: rgba(255, 255, 255, 0.05);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }

                .tag.provider {
                    font-weight: 600;
                    background: rgba(255, 255, 255, 0.08);
                }
            `}</style>
        </div>
    );
}

export default TtsRoutingOverlay;
