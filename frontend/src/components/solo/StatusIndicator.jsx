import React from 'react';
import { Mic, Volume2, Loader2, Circle } from 'lucide-react';
import { SessionState } from '../../hooks/useSoloSession';

/**
 * StatusIndicator - Central visual status display
 * 
 * Shows current state with animated icons:
 * - Idle: Pulsing circle
 * - Listening: Animated mic
 * - Speaking: Sound waves
 * - Processing: Spinner
 */
export function StatusIndicator({ state, isConnected }) {
  const getStatusConfig = () => {
    if (!isConnected) {
      return {
        icon: Circle,
        color: '#888',
        label: 'Connecting...',
        animate: 'pulse'
      };
    }

    switch (state) {
      case SessionState.LISTENING:
        return {
          icon: Mic,
          color: '#22c55e',
          label: 'Listening...',
          animate: 'pulse-green'
        };
      case SessionState.SPEAKING:
        return {
          icon: Volume2,
          color: '#a855f7',
          label: 'Speaking...',
          animate: 'wave'
        };
      case SessionState.FINALIZING:
        return {
          icon: Loader2,
          color: '#f59e0b',
          label: 'Processing...',
          animate: 'spin'
        };
      case SessionState.IDLE:
      default:
        return {
          icon: Mic,
          color: '#6b7280',
          label: 'Ready',
          animate: 'none'
        };
    }
  };

  const config = getStatusConfig();
  const Icon = config.icon;

  return (
    <div className="status-indicator">
      <div className={`status-icon-wrapper ${config.animate}`}>
        <Icon size={64} color={config.color} />

        {/* Animated rings for listening state */}
        {state === SessionState.LISTENING && (
          <>
            <div className="pulse-ring ring-1" />
            <div className="pulse-ring ring-2" />
            <div className="pulse-ring ring-3" />
          </>
        )}

        {/* Sound waves for speaking state */}
        {state === SessionState.SPEAKING && (
          <div className="sound-waves">
            <div className="wave wave-1" />
            <div className="wave wave-2" />
            <div className="wave wave-3" />
          </div>
        )}
      </div>

      <span className="status-label" style={{ color: config.color }}>
        {config.label}
      </span>

      <style>{`
        .status-indicator {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1rem;
        }
        
        .status-icon-wrapper {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 120px;
          height: 120px;
          background: rgba(255, 255, 255, 0.8);
          border: 1px solid rgba(16, 185, 129, 0.2);
          border-radius: 50%;
          backdrop-filter: blur(10px);
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
        }
        
        .status-icon-wrapper.spin svg {
          animation: spin 1s linear infinite;
        }
        
        .status-label {
          font-size: 1.1rem;
          font-weight: 600;
          letter-spacing: 0.5px;
        }
        
        /* Pulse rings for listening */
        .pulse-ring {
          position: absolute;
          border: 2px solid #22c55e;
          border-radius: 50%;
          opacity: 0;
          animation: ripple 2s ease-out infinite;
        }
        
        .ring-1 {
          width: 100%;
          height: 100%;
          animation-delay: 0s;
        }
        
        .ring-2 {
          width: 100%;
          height: 100%;
          animation-delay: 0.66s;
        }
        
        .ring-3 {
          width: 100%;
          height: 100%;
          animation-delay: 1.33s;
        }
        
        /* Sound waves for speaking */
        .sound-waves {
          position: absolute;
          right: -30px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        
        .wave {
          width: 20px;
          height: 3px;
          background: #a855f7;
          border-radius: 2px;
          animation: wave-anim 0.8s ease-in-out infinite;
        }
        
        .wave-1 {
          animation-delay: 0s;
        }
        
        .wave-2 {
          animation-delay: 0.2s;
          width: 15px;
        }
        
        .wave-3 {
          animation-delay: 0.4s;
          width: 25px;
        }
        
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        
        @keyframes ripple {
          0% {
            transform: scale(1);
            opacity: 0.4;
          }
          100% {
            transform: scale(1.8);
            opacity: 0;
          }
        }
        
        @keyframes wave-anim {
          0%, 100% {
            transform: scaleX(0.5);
            opacity: 0.5;
          }
          50% {
            transform: scaleX(1);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}

export default StatusIndicator;
