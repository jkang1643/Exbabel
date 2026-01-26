import React from 'react';
import { Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react';

/**
 * TtsStreamingControl - UI component for TTS streaming status and controls
 * 
 * Shows connection status, buffering, and playback state.
 */
export function TtsStreamingControl({
    isEnabled,
    isConnected,
    isPlaying,
    bufferedMs,
    stats,
    onToggle
}) {
    if (!isEnabled) {
        return null;
    }

    return (
        <div className="tts-streaming-control">
            {/* Connection Status */}
            <div className="status-row">
                {isConnected ? (
                    <Wifi size={16} className="status-icon connected" />
                ) : (
                    <WifiOff size={16} className="status-icon disconnected" />
                )}
                <span className="status-text">
                    {isConnected ? 'Streaming Connected' : 'Connecting...'}
                </span>
            </div>

            {/* Playback Status */}
            {isConnected && (
                <div className="playback-row">
                    {isPlaying ? (
                        <Volume2 size={16} className="playback-icon playing" />
                    ) : (
                        <VolumeX size={16} className="playback-icon idle" />
                    )}
                    <span className="playback-text">
                        {isPlaying ? `Playing (${Math.round(bufferedMs)}ms buffered)` : 'Ready'}
                    </span>
                </div>
            )}

            {/* Stats (optional, for debugging) */}
            {isConnected && stats && (
                <div className="stats-row">
                    <span className="stats-text">
                        {stats.chunksReceived} chunks • {Math.round(stats.bytesReceived / 1024)}KB
                        {stats.underruns > 0 && ` • ${stats.underruns} underruns`}
                    </span>
                </div>
            )}

            <style>{`
        .tts-streaming-control {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          padding: 0.75rem;
          background: rgba(16, 185, 129, 0.05);
          border: 1px solid rgba(16, 185, 129, 0.2);
          border-radius: 8px;
          font-size: 0.875rem;
        }
        
        .status-row,
        .playback-row,
        .stats-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        
        .status-icon.connected {
          color: #10b981;
        }
        
        .status-icon.disconnected {
          color: #ef4444;
          animation: pulse 2s ease-in-out infinite;
        }
        
        .playback-icon.playing {
          color: #10b981;
          animation: pulse 1.5s ease-in-out infinite;
        }
        
        .playback-icon.idle {
          color: #6b7280;
        }
        
        .status-text,
        .playback-text {
          color: #374151;
          font-weight: 500;
        }
        
        .stats-text {
          color: #6b7280;
          font-size: 0.75rem;
        }
        
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
        </div>
    );
}

export default TtsStreamingControl;
