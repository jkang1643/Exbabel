import React, { useState } from 'react';
import { ChevronDown, ArrowRight } from 'lucide-react';
import { TRANSCRIPTION_LANGUAGES, TRANSLATION_LANGUAGES } from '../../config/languages';
import {
    isGeminiSupported,
    isElevenLabsSupported,
    isGoogleTierSupported,
    LANGUAGE_TIER_AVAILABILITY
} from '../../config/languageSupportData';

/**
 * Get TTS indicator based on support level - MATCHES HOST MODE LOGIC
 * 🔊 = Standard support available (60 languages)
 * 🔊⭐ = Premium ONLY (Gemini/ElevenLabs only, no Standard voices) (27 languages)
 */
const getTtsIndicator = (code) => {
    if (!code) return null;

    // 1. Check for Standard tier support (Priority)
    // If a language has standard voices, it gets the standard icon (no star)
    // This prevents starring languages that have both Standard AND Premium
    if (isGoogleTierSupported(code, 'standard')) {
        return '🔊';
    }

    // 2. Check for Premium-only support
    // If no standard voices but has Gemini/ElevenLabs, it gets the star
    if (isGeminiSupported(code) || isElevenLabsSupported(code, 'elevenlabs_v3')) {
        return '🔊⭐';
    }

    return null;
};
/**
 * LanguageSelector - Input/Output language pills
 * 
 * Displays source → target with dropdown selectors
 */
export function LanguageSelector({
    sourceLang,
    targetLang,
    onSourceChange,
    onTargetChange
}) {
    const [showSourceDropdown, setShowSourceDropdown] = useState(false);
    const [showTargetDropdown, setShowTargetDropdown] = useState(false);

    // Get language display name
    const getLanguageName = (code) => {
        const lang = TRANSCRIPTION_LANGUAGES.find(l => l.code === code) ||
            TRANSLATION_LANGUAGES.find(l => l.code === code);
        return lang?.name || code.toUpperCase();
    };

    // Get language flag emoji
    const getLanguageFlag = (code) => {
        const flags = {
            en: '🇺🇸', es: '🇪🇸', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹',
            pt: '🇵🇹', ru: '🇷🇺', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳',
            ar: '🇸🇦', hi: '🇮🇳', nl: '🇳🇱', pl: '🇵🇱', tr: '🇹🇷',
            vi: '🇻🇳', th: '🇹🇭', id: '🇮🇩', ms: '🇲🇾', he: '🇮🇱'
        };
        return flags[code] || '🌐';
    };

    return (
        <div className="language-selector">
            {/* Source Language */}
            <div className="language-pill-container">
                <button
                    className="language-pill"
                    onClick={() => {
                        setShowSourceDropdown(!showSourceDropdown);
                        setShowTargetDropdown(false);
                    }}
                >
                    <span className="lang-flag">{getLanguageFlag(sourceLang)}</span>
                    <span className="lang-code">{sourceLang.toUpperCase()}</span>
                    <ChevronDown size={14} />
                </button>

                {showSourceDropdown && (
                    <div className="language-dropdown">
                        {TRANSCRIPTION_LANGUAGES.map((lang) => (
                            <button
                                key={lang.code}
                                className={`dropdown-item ${lang.code === sourceLang ? 'active' : ''}`}
                                onClick={() => {
                                    onSourceChange(lang.code);
                                    setShowSourceDropdown(false);
                                }}
                            >
                                <span className="lang-flag">{getLanguageFlag(lang.code)}</span>
                                <span>{lang.name}</span>
                                {getTtsIndicator(lang.code) && <span className="tts-indicator" title="TTS Available">{getTtsIndicator(lang.code)}</span>}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Arrow */}
            <div className="language-arrow">
                <ArrowRight size={20} />
            </div>

            {/* Target Language */}
            <div className="language-pill-container">
                <button
                    className="language-pill"
                    onClick={() => {
                        setShowTargetDropdown(!showTargetDropdown);
                        setShowSourceDropdown(false);
                    }}
                >
                    <span className="lang-flag">{getLanguageFlag(targetLang)}</span>
                    <span className="lang-code">{targetLang.toUpperCase()}</span>
                    <ChevronDown size={14} />
                </button>

                {showTargetDropdown && (
                    <div className="language-dropdown">
                        {TRANSLATION_LANGUAGES.map((lang) => (
                            <button
                                key={lang.code}
                                className={`dropdown-item ${lang.code === targetLang ? 'active' : ''}`}
                                onClick={() => {
                                    onTargetChange(lang.code);
                                    setShowTargetDropdown(false);
                                }}
                            >
                                <span className="lang-flag">{getLanguageFlag(lang.code)}</span>
                                <span>{lang.name}</span>
                                {getTtsIndicator(lang.code) && <span className="tts-indicator" title="TTS Available">{getTtsIndicator(lang.code)}</span>}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <style>{`
        .language-selector {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.75rem;
          padding: 0.75rem 1rem;
        }
        
        .language-pill-container {
          position: relative;
        }
        
        .language-pill {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.6rem 1rem;
          background: rgba(255, 255, 255, 0.9);
          border: 1px solid rgba(16, 185, 129, 0.3);
          border-radius: 20px;
          color: #1f2937;
          font-size: 0.95rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
        }
        
        .language-pill:hover {
          background: rgba(255, 255, 255, 1);
          border-color: rgba(16, 185, 129, 0.6);
          box-shadow: 0 2px 8px rgba(16, 185, 129, 0.2);
        }
        
        .lang-flag {
          font-size: 1.1rem;
        }
        
        .lang-code {
          font-weight: 600;
          color: #059669;
        }
        
        .language-arrow {
          color: #6b7280;
        }
        
        .language-dropdown {
          position: absolute;
          top: 100%;
          left: 50%;
          transform: translateX(-50%);
          margin-top: 0.5rem;
          background: rgba(255, 255, 255, 0.98);
          border: 1px solid rgba(16, 185, 129, 0.2);
          border-radius: 12px;
          padding: 0.5rem;
          min-width: 180px;
          max-height: 300px;
          overflow-y: auto;
          z-index: 100;
          box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
        }
        
        .dropdown-item {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          width: 100%;
          padding: 0.6rem 0.75rem;
          background: transparent;
          border: none;
          border-radius: 8px;
          color: #374151;
          font-size: 0.9rem;
          text-align: left;
          cursor: pointer;
          transition: all 0.15s;
        }
        
        .dropdown-item:hover {
          background: rgba(16, 185, 129, 0.1);
          color: #059669;
        }
        
        .dropdown-item.active {
          background: rgba(16, 185, 129, 0.2);
          color: #059669;
          font-weight: 600;
        }
        
        .tts-indicator {
          margin-left: auto;
          font-size: 0.85rem;
          opacity: 0.8;
        }
      `}</style>
        </div>
    );
}

export default LanguageSelector;
