import React from 'react';
import { Mic, Radio, FileText } from 'lucide-react';
import { SoloMode } from '../../hooks/useSoloSession';

/**
 * ModeSelector - Toggle between solo modes
 * 
 * Modes:
 * - Preaching: One-way, continuous listening with TTS queue
 * - Conversation: Two-way, auto-swap after each turn
 * - Text Only: Transcription without TTS
 */
export function ModeSelector({ mode, onChange }) {
    const modes = [
        {
            id: SoloMode.PREACHING,
            label: 'Live',
            icon: Radio,
            description: 'One-way translation'
        },
        {
            id: SoloMode.CONVERSATION,
            label: 'Chat',
            icon: Mic,
            description: 'Two-way conversation'
        },
        {
            id: SoloMode.TEXT_ONLY,
            label: 'Text',
            icon: FileText,
            description: 'Transcription only'
        }
    ];

    return (
        <div className="mode-selector">
            {modes.map((m) => {
                const Icon = m.icon;
                const isActive = mode === m.id;

                return (
                    <button
                        key={m.id}
                        className={`mode-option ${isActive ? 'active' : ''}`}
                        onClick={() => onChange(m.id)}
                        aria-pressed={isActive}
                        aria-label={m.description}
                    >
                        <Icon size={18} />
                        <span>{m.label}</span>
                    </button>
                );
            })}

            <style>{`
        .mode-selector {
          display: flex;
          gap: 0.5rem;
          padding: 0.5rem 1rem;
          justify-content: center;
        }
        
        .mode-option {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.6rem 1.25rem;
          background: rgba(255, 255, 255, 0.8);
          border: 1px solid rgba(16, 185, 129, 0.2);
          border-radius: 25px;
          color: #4b5563;
          font-size: 0.9rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.25s ease;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
        }
        
        .mode-option:hover {
          background: rgba(255, 255, 255, 1);
          color: #059669;
          border-color: rgba(16, 185, 129, 0.4);
        }
        
        .mode-option.active {
          background: linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(5, 150, 105, 0.2));
          border-color: rgba(16, 185, 129, 0.5);
          color: #059669;
          box-shadow: 0 0 20px rgba(16, 185, 129, 0.15);
        }
      `}</style>
        </div>
    );
}

export default ModeSelector;
