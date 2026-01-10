/**
 * TTS Voice Configuration
 * 
 * This file uses the auto-generated ttsVoices.json (extracted from Available languages.txt)
 * and adds language-agnostic Gemini voices and normalization logic.
 */

import ttsVoicesJson from './ttsVoices.json';

// Gemini voices (language-agnostic Studio voices)
export const GEMINI_VOICE_OPTIONS = [
    { value: 'Kore', label: 'Kore (Gemini, Female)', tier: 'gemini' },
    { value: 'Charon', label: 'Charon (Gemini, Male)', tier: 'gemini' },
    { value: 'Leda', label: 'Leda (Gemini, Female)', tier: 'gemini' },
    { value: 'Puck', label: 'Puck (Gemini, Male)', tier: 'gemini' },
    { value: 'Aoede', label: 'Aoede (Gemini, Female)', tier: 'gemini' },
    { value: 'Fenrir', label: 'Fenrir (Gemini, Male)', tier: 'gemini' }
];

/**
 * Mapping of language codes to their available voices.
 * Combines auto-generated voices with language-agnostic Gemini voices.
 */
export const VOICE_OPTIONS_BY_LANG = Object.keys(ttsVoicesJson).reduce((acc, langCode) => {
    // Start with Gemini voices
    acc[langCode] = [...GEMINI_VOICE_OPTIONS, ...ttsVoicesJson[langCode]];
    return acc;
}, {});

/**
 * Normalize language code to full locale (frontend version)
 */
export const normalizeLanguageCode = (languageCode) => {
    if (!languageCode) return null;
    if (languageCode.includes('-')) {
        // Handle special case where backend/STT might use 'zh' or 'zh-CN' which maps to 'cmn-CN'
        if (languageCode === 'zh-CN' || languageCode === 'zh') return 'cmn-CN';
        return languageCode;
    }

    const languageMap = {
        'es': 'es-ES',
        'en': 'en-US',
        'fr': 'fr-FR',
        'de': 'de-DE',
        'it': 'it-IT',
        'pt': 'pt-BR',
        'ja': 'ja-JP',
        'ko': 'ko-KR',
        'zh': 'cmn-CN',
        'ar': 'ar-XA',
        'hi': 'hi-IN',
        'ru': 'ru-RU'
    };

    return languageMap[languageCode] || `${languageCode}-${languageCode.toUpperCase()}`;
};

/**
 * Get available voices for a language
 */
export const getVoicesForLanguage = (languageCode) => {
    const normalizedCode = normalizeLanguageCode(languageCode);
    const voices = VOICE_OPTIONS_BY_LANG[normalizedCode];

    if (voices && voices.length > 0) {
        return voices;
    }

    // Fallback if the specific locale or normalization didn't find voices
    return [
        ...GEMINI_VOICE_OPTIONS,
        { value: `${normalizedCode}-Standard-A`, label: 'Standard-A (Fallback)', tier: 'standard' }
    ];
};
