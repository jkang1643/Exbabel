import React from 'react';
import { ArrowLeftRight } from 'lucide-react';

/**
 * TurnIndicator - Shows active languages in auto-detect mode
 * 
 * Displays both languages as active listeners since we now support
 * true bi-directional auto-detection.
 */
export function TurnIndicator({
  sourceLang,
  targetLang
}) {
  return (
    <div className="turn-indicator">
      <div className="turn-info">
        <span className="turn-label">Listening for</span>
        <div className="turn-direction">
          <span className="lang-badge from">{sourceLang.toUpperCase()}</span>
          <ArrowLeftRight size={16} className="bidirectional-arrow" />
          <span className="lang-badge to">{targetLang.toUpperCase()}</span>
        </div>
      </div>

      <style>{`
        .turn-indicator {
          display: flex;
          align-items: center;
          gap: 1.5rem;
          padding: 0.75rem 1.25rem;
          background: rgba(255, 255, 255, 0.9);
          border: 1px solid rgba(59, 91, 255, 0.2);
          border-radius: 16px;
          box-shadow: 0 4px 12px rgba(59, 91, 255, 0.08);
        }
        
        .turn-info {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.25rem;
        }
        
        .turn-label {
          font-size: 0.75rem;
          color: #6b7280;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          font-weight: 500;
        }
        
        .turn-direction {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          color: #374151;
        }
        
        .lang-badge {
          padding: 0.35rem 0.75rem;
          background: rgba(59, 91, 255, 0.08);
          border-radius: 8px;
          font-size: 0.9rem;
          font-weight: 600;
          color: #3B5BFF;
          border: 1px solid rgba(59, 91, 255, 0.1);
        }
        
        .bidirectional-arrow {
          color: #94a3b8;
        }
      `}</style>
    </div>
  );
}

export default TurnIndicator;
