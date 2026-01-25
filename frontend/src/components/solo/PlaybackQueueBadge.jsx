import React from 'react';
import { ListMusic } from 'lucide-react';

/**
 * PlaybackQueueBadge - Shows number of segments waiting in TTS queue
 */
export function PlaybackQueueBadge({ count }) {
    if (count === 0) return null;

    return (
        <div className="queue-badge">
            <ListMusic size={16} />
            <span>Queue: {count}</span>

            <style>{`
        .queue-badge {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 1rem;
          background: rgba(245, 158, 11, 0.2);
          border: 1px solid rgba(245, 158, 11, 0.4);
          border-radius: 20px;
          color: #f59e0b;
          font-size: 0.85rem;
          font-weight: 500;
        }
      `}</style>
        </div>
    );
}

export default PlaybackQueueBadge;
