import React from 'react';
import { X, Clock, Volume2, Wifi, Music, Lock } from 'lucide-react';

/**
 * AdvancedSettingsDrawer - Hidden settings panel
 */
export function AdvancedSettingsDrawer({
  isOpen,
  onClose,
  silenceThreshold,
  onSilenceThresholdChange,
  speakerPriority,
  onSpeakerPriorityChange,
  streamingTts,
  onStreamingTtsChange,
  profanityFilter,
  onProfanityFilterChange,
  availableVoices = [],
  selectedVoice,
  onVoiceChange,
  planCode = 'starter'
}) {
  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="drawer-backdrop" onClick={onClose} />

      {/* Drawer */}
      <div className="settings-drawer">
        <div className="drawer-header">
          <h3>Advanced Settings</h3>
          <button className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="drawer-content">
          {/* Silence Threshold */}
          <div className="setting-group">
            <div className="setting-header">
              <Clock size={18} />
              <span>Silence Detection</span>
            </div>
            <p className="setting-desc">
              Time to wait after speech stops before finalizing
            </p>
            <div className="setting-control">
              <input
                type="range"
                min="400"
                max="1500"
                step="100"
                value={silenceThreshold}
                onChange={(e) => onSilenceThresholdChange(Number(e.target.value))}
              />
              <span className="setting-value">{silenceThreshold}ms</span>
            </div>
          </div>

          {/* Speaker Priority */}
          <div className="setting-group">
            <div className="setting-header">
              <Volume2 size={18} />
              <span>Speaker Priority</span>
            </div>
            <p className="setting-desc">
              New speech interrupts and cancels current TTS playback
            </p>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={speakerPriority}
                onChange={(e) => onSpeakerPriorityChange(e.target.checked)}
              />
              <span className="toggle-slider" />
              <span className="toggle-label">
                {speakerPriority ? 'On' : 'Off'}
              </span>
            </label>
          </div>

          {/* Streaming TTS */}
          <div className="setting-group">
            <div className="setting-header">
              <Wifi size={18} />
              <span>Streaming TTS</span>
            </div>
            <p className="setting-desc">
              Real-time audio streaming with lower latency (experimental)
            </p>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={streamingTts}
                onChange={(e) => onStreamingTtsChange(e.target.checked)}
              />
              <span className="toggle-slider" />
              <span className="toggle-label">
                {streamingTts ? 'On' : 'Off'}
              </span>
            </label>
          </div>

          {/* Profanity Filter */}
          <div className="setting-group">
            <div className="setting-header">
              <Lock size={18} />
              <span>Profanity Filter</span>
            </div>
            <p className="setting-desc">
              Filter inappropriate language in transcriptions
            </p>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={profanityFilter}
                onChange={(e) => onProfanityFilterChange(e.target.checked)}
              />
              <span className="toggle-slider" />
              <span className="toggle-text">
                {profanityFilter ? 'Enabled' : 'Disabled'}
              </span>
            </label>
          </div>

          {/* Voice Selection */}
          <div className="setting-group">
            <div className="setting-header">
              <Music size={18} />
              <span>Voice Selection</span>
              <span className="plan-badge">{planCode}</span>
            </div>
            <p className="setting-desc">
              Choose a voice for TTS playback. Locked voices require a plan upgrade.
            </p>
            <select
              className="voice-select"
              value={selectedVoice?.voiceId || ''}
              onChange={(e) => {
                const voice = availableVoices.find(v => v.voiceId === e.target.value);
                if (voice && voice.isAllowed) onVoiceChange(voice);
              }}
            >
              {availableVoices.length === 0 ? (
                <option value="">Loading voices...</option>
              ) : (
                availableVoices.map(voice => (
                  <option
                    key={voice.voiceId}
                    value={voice.voiceId}
                    disabled={!voice.isAllowed}
                    className={voice.isAllowed ? '' : 'locked-voice'}
                  >
                    {voice.isAllowed ? '' : '🔒 '}{voice.displayName || voice.voiceName} ({voice.tier})
                  </option>
                ))
              )}
            </select>
          </div>
        </div>
      </div>

      <style>{`
        .drawer-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.6);
          z-index: 200;
        }
        
        .settings-drawer {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          background: rgba(20, 20, 40, 0.98);
          border-top: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 20px 20px 0 0;
          z-index: 201;
          max-height: 80vh;
          overflow-y: auto;
          animation: slideUp 0.3s ease;
        }
        
        @keyframes slideUp {
          from {
            transform: translateY(100%);
          }
          to {
            transform: translateY(0);
          }
        }
        
        .drawer-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 1.25rem 1.5rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .drawer-header h3 {
          margin: 0;
          font-size: 1.1rem;
          font-weight: 600;
          color: #fff;
        }
        
        .close-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          background: rgba(255, 255, 255, 0.1);
          border: none;
          border-radius: 50%;
          color: rgba(255, 255, 255, 0.7);
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .close-btn:hover {
          background: rgba(255, 255, 255, 0.2);
          color: #fff;
        }
        
        .drawer-content {
          padding: 1.5rem;
        }
        
        .setting-group {
          margin-bottom: 1.5rem;
          padding-bottom: 1.5rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        
        .setting-group:last-child {
          margin-bottom: 0;
          padding-bottom: 0;
          border-bottom: none;
        }
        
        .setting-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          color: #fff;
          font-weight: 500;
          margin-bottom: 0.5rem;
        }
        
        .plan-badge {
          margin-left: auto;
          padding: 0.2rem 0.6rem;
          background: linear-gradient(135deg, #a855f7, #6366f1);
          border-radius: 12px;
          font-size: 0.7rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: #fff;
        }
        
        .setting-desc {
          margin: 0 0 1rem;
          color: rgba(255, 255, 255, 0.5);
          font-size: 0.85rem;
        }
        
        .setting-control {
          display: flex;
          align-items: center;
          gap: 1rem;
        }
        
        .setting-control input[type="range"] {
          flex: 1;
          height: 4px;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 2px;
          appearance: none;
          cursor: pointer;
        }
        
        .setting-control input[type="range"]::-webkit-slider-thumb {
          appearance: none;
          width: 18px;
          height: 18px;
          background: #a855f7;
          border-radius: 50%;
          cursor: pointer;
        }
        
        .setting-value {
          min-width: 60px;
          text-align: right;
          color: #a855f7;
          font-weight: 600;
        }
        
        .toggle-switch {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          cursor: pointer;
        }
        
        .toggle-switch input {
          display: none;
        }
        
        .toggle-slider {
          position: relative;
          width: 48px;
          height: 26px;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 13px;
          transition: background 0.2s;
        }
        
        .toggle-slider::after {
          content: '';
          position: absolute;
          top: 3px;
          left: 3px;
          width: 20px;
          height: 20px;
          background: #fff;
          border-radius: 50%;
          transition: transform 0.2s;
        }
        
        .toggle-switch input:checked + .toggle-slider {
          background: #a855f7;
        }
        
        .toggle-switch input:checked + .toggle-slider::after {
          transform: translateX(22px);
        }
        
        .toggle-label {
          color: rgba(255, 255, 255, 0.7);
          font-size: 0.9rem;
        }
        
        .voice-select {
          width: 100%;
          padding: 0.75rem 1rem;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 8px;
          color: #fff;
          font-size: 0.9rem;
          cursor: pointer;
          appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23fff' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 1rem center;
        }
        
        .voice-select:focus {
          outline: none;
          border-color: #a855f7;
          box-shadow: 0 0 0 2px rgba(168, 85, 247, 0.3);
        }
        
        .voice-select option {
          background: #1a1a2e;
          color: #fff;
          padding: 0.5rem;
        }
      `}</style>
    </>
  );
}

export default AdvancedSettingsDrawer;
