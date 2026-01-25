import React from 'react';
import { RefreshCw, ArrowRight } from 'lucide-react';

/**
 * TurnIndicator - Shows current direction in conversation mode
 * 
 * Displays which direction is currently active and allows manual swap
 */
export function TurnIndicator({
  direction,
  sourceLang,
  targetLang,
  onSwap
}) {
  const isForward = direction === 'forward';
  const fromLang = isForward ? sourceLang : targetLang;
  const toLang = isForward ? targetLang : sourceLang;

  return (
    <div className="turn-indicator">
      <div className="turn-info">
        <span className="turn-label">Listening to</span>
        <div className="turn-direction">
          <span className="lang-badge from">{fromLang.toUpperCase()}</span>
          <ArrowRight size={16} />
          <span className="lang-badge to">{toLang.toUpperCase()}</span>
        </div>
      </div>

      <button
        className="swap-button"
        onClick={onSwap}
        aria-label="Swap direction"
      >
        <RefreshCw size={18} />
        <span>Swap</span>
      </button>

      <style>{`
        .turn-indicator {
          display: flex;
          align-items: center;
          gap: 1.5rem;
          padding: 0.75rem 1.25rem;
          background: rgba(255, 255, 255, 0.9);
          border: 1px solid rgba(16, 185, 129, 0.2);
          border-radius: 16px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        }
        
        .turn-info {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        
        .turn-label {
          font-size: 0.75rem;
          color: #6b7280;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        
        .turn-direction {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          color: #374151;
        }
        
        .lang-badge {
          padding: 0.25rem 0.5rem;
          background: rgba(16, 185, 129, 0.1);
          border-radius: 6px;
          font-size: 0.85rem;
          font-weight: 600;
        }
        
        .lang-badge.from {
          background: rgba(16, 185, 129, 0.15);
          color: #059669;
        }
        
        .lang-badge.to {
          background: rgba(16, 185, 129, 0.25);
          color: #047857;
        }
        
        .swap-button {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.5rem 0.75rem;
          background: rgba(16, 185, 129, 0.1);
          border: 1px solid rgba(16, 185, 129, 0.3);
          border-radius: 20px;
          color: #059669;
          font-size: 0.85rem;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .swap-button:hover {
          background: rgba(16, 185, 129, 0.2);
          border-color: rgba(16, 185, 129, 0.5);
          color: #047857;
        }
        
        .swap-button:active {
          transform: scale(0.95);
        }
        
        .swap-button svg {
          transition: transform 0.3s;
        }
        
        .swap-button:hover svg {
          transform: rotate(180deg);
        }
      `}</style>
    </div>
  );
}

export default TurnIndicator;
