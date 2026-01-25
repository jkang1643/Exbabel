import React from 'react';
import { X, Clock, Volume2 } from 'lucide-react';

/**
 * AdvancedSettingsDrawer - Hidden settings panel
 */
export function AdvancedSettingsDrawer({
    isOpen,
    onClose,
    silenceThreshold,
    onSilenceThresholdChange,
    speakerPriority,
    onSpeakerPriorityChange
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
      `}</style>
        </>
    );
}

export default AdvancedSettingsDrawer;
