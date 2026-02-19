import React, { useRef, useEffect } from 'react';
import { Copy, Trash2, Play } from 'lucide-react';

/**
 * TranscriptPanel - Displays live and finalized transcripts
 * 
 * Shows:
 * - Live partial transcript (streaming)
 * - Finalized segments with translations
 * - Copy/export functionality
 */
export function TranscriptPanel({
  partialText,
  segments,
  showTranslation = true,
  onClear,
  onPlay
}) {
  const scrollRef = useRef(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [segments, partialText]);

  // Copy all text
  const handleCopy = () => {
    const text = segments
      .map(s => showTranslation && s.translatedText
        ? `${s.originalText}\n→ ${s.translatedText}`
        : s.originalText
      )
      .join('\n\n');

    navigator.clipboard.writeText(text);
  };

  const isEmpty = segments.length === 0 && !partialText;

  return (
    <div className="transcript-panel">
      {/* Header */}
      <div className="transcript-header">
        <span className="transcript-title">Transcript</span>
        <div className="transcript-actions">
          <button
            className="action-btn"
            onClick={handleCopy}
            disabled={isEmpty}
            aria-label="Copy transcript"
          >
            <Copy size={16} />
          </button>
          {onClear && (
            <button
              className="action-btn"
              onClick={onClear}
              disabled={isEmpty}
              aria-label="Clear transcript"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="transcript-content" ref={scrollRef}>
        {isEmpty && (
          <div className="transcript-empty">
            Transcripts will appear here...
          </div>
        )}

        {/* Finalized segments */}
        {segments.map((segment) => (
          <div key={segment.id} className="segment">
            <div className="segment-content">
              <div className="segment-original">{segment.originalText}</div>
              {showTranslation && segment.translatedText &&
                segment.translatedText !== segment.originalText && (
                  <div className="segment-translation">
                    → {segment.translatedText}
                  </div>
                )}
            </div>
            {onPlay && (segment.translatedText || segment.originalText) && (
              <button
                className="play-btn"
                onClick={() => onPlay(segment)}
                aria-label="Play segment"
                title="Play Audio"
              >
                <Play size={16} fill="currentColor" />
              </button>
            )}
          </div>
        ))}

        {/* Live partial */}
        {partialText && (
          <div className="segment partial">
            <div className="segment-original">{partialText}</div>
            <span className="partial-indicator" />
          </div>
        )}
      </div>

      <style>{`
        .transcript-panel {
          display: flex;
          flex-direction: column;
          margin: 0 1rem 1rem;
          background: rgba(255, 255, 255, 0.9);
          border: 1px solid rgba(16, 185, 129, 0.2);
          border-radius: 16px;
          max-height: 300px;
          overflow: hidden;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
        }
        
        .transcript-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.75rem 1rem;
          background: rgba(16, 185, 129, 0.05);
          border-bottom: 1px solid rgba(16, 185, 129, 0.1);
        }
        
        .transcript-title {
          font-size: 0.85rem;
          font-weight: 600;
          color: #059669;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        
        .transcript-actions {
          display: flex;
          gap: 0.5rem;
        }
        
        .action-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          background: rgba(16, 185, 129, 0.1);
          border: none;
          border-radius: 8px;
          color: #059669;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .action-btn:hover:not(:disabled) {
          background: rgba(16, 185, 129, 0.2);
          color: #047857;
        }
        
        .action-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        
        .transcript-content {
          flex: 1;
          padding: 1rem;
          overflow-y: auto;
        }
        
        .transcript-empty {
          color: #9ca3af;
          font-style: italic;
          text-align: center;
          padding: 2rem 1rem;
        }
        
        .segment {
          margin-bottom: 1rem;
          padding-bottom: 1rem;
          border-bottom: 1px solid rgba(16, 185, 129, 0.1);
        }
        
        .segment:last-child {
          margin-bottom: 0;
          padding-bottom: 0;
          border-bottom: none;
        }
        
        .segment-original {
          color: #1f2937;
          font-size: 1rem;
          line-height: 1.5;
        }
        
        .segment-translation {
          margin-top: 0.5rem;
          padding-left: 0.75rem;
          color: #059669;
          font-size: 0.95rem;
          font-style: italic;
          border-left: 2px solid rgba(16, 185, 129, 0.4);
        }
        
        .segment.partial {
          position: relative;
        }
        
        .segment.partial .segment-original {
          color: #6b7280;
        }
        
        .partial-indicator {
          display: inline-block;
          width: 8px;
          height: 8px;
          margin-left: 0.5rem;
          background: #10b981;
          border-radius: 50%;
          animation: blink 1s ease-in-out infinite;
        }
        
        @keyframes blink {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }

        .segment {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1rem;
          margin-bottom: 1rem;
          padding-bottom: 1rem;
          border-bottom: 1px solid rgba(16, 185, 129, 0.1);
        }

        .segment-content {
          flex: 1;
        }

        .play-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border: none;
          background: rgba(59, 91, 255, 0.1);
          color: #3B5BFF;
          border-radius: 50%;
          cursor: pointer;
          transition: all 0.2s;
          flex-shrink: 0;
          margin-top: 0.25rem;
        }

        .play-btn:hover {
          background: rgba(59, 91, 255, 0.2);
          transform: scale(1.1);
        }

        .play-btn:active {
          transform: scale(0.95);
        }
      `}</style>
    </div>
  );
}

export default TranscriptPanel;
