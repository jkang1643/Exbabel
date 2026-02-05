/**
 * TTS Voice Configuration
 * 
 * This file uses the auto-generated ttsVoices.json (extracted from Available languages.txt)
 * and filters voices based on actual language support using languageSupportData.js.
 */

import ttsVoicesJson from './ttsVoices.json' with { type: 'json' };
import {
    isGeminiSupported,
    isElevenLabsSupported,
    isGoogleTierSupported,
    LANGUAGE_TIER_AVAILABILITY
} from './languageSupportData.js';

// Gemini voices (language-agnostic Studio voices)
export const GEMINI_VOICE_OPTIONS = [
    { value: 'gemini-Kore', label: 'Kore (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Charon', label: 'Charon (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Leda', label: 'Leda (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Puck', label: 'Puck (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Aoede', label: 'Aoede (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Fenrir', label: 'Fenrir (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Achernar', label: 'Achernar (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Achird', label: 'Achird (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Algenib', label: 'Algenib (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Algieba', label: 'Algieba (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Alnilam', label: 'Alnilam (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Autonoe', label: 'Autonoe (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Callirrhoe', label: 'Callirrhoe (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Despina', label: 'Despina (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Enceladus', label: 'Enceladus (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Erinome', label: 'Erinome (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Gacrux', label: 'Gacrux (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Iapetus', label: 'Iapetus (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Laomedeia', label: 'Laomedeia (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Orus', label: 'Orus (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Pulcherrima', label: 'Pulcherrima (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Rasalgethi', label: 'Rasalgethi (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Sadachbia', label: 'Sadachbia (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Sadaltager', label: 'Sadaltager (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Schedar', label: 'Schedar (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Sulafat', label: 'Sulafat (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Umbriel', label: 'Umbriel (Gemini, Male)', tier: 'gemini' },
    { value: 'gemini-Vindemiatrix', label: 'Vindemiatrix (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Zephyr', label: 'Zephyr (Gemini, Female)', tier: 'gemini' },
    { value: 'gemini-Zubenelgenubi', label: 'Zubenelgenubi (Gemini, Male)', tier: 'gemini' }
];

// ElevenLabs voices (all tiers: v3, turbo, flash, multilingual)
// Custom voice ID for Pastor John Brown
const CUSTOM_VOICE_ID = 'DfCUQ0uJkSQyc3SLt6SR';

export const ELEVENLABS_VOICE_OPTIONS = [
    // Eleven v3 (alpha) - Most expressive, 70+ languages
    { value: 'elevenlabs-JBFqnCBsd6RMkjVDRZzb__elevenlabs_v3', label: 'George (ElevenLabs v3, Male)', tier: 'elevenlabs_v3' },
    { value: 'elevenlabs-21m00Tcm4TlvDq8ikWAM__elevenlabs_v3', label: 'Rachel (ElevenLabs v3, Female)', tier: 'elevenlabs_v3' },
    { value: 'elevenlabs-EXAVITQu4vr4xnSDxMaL__elevenlabs_v3', label: 'Sarah (ElevenLabs v3, Female)', tier: 'elevenlabs_v3' },
    { value: 'elevenlabs-D38z5RcWu1voky8WS1ja__elevenlabs_v3', label: 'Fin (ElevenLabs v3, Male)', tier: 'elevenlabs_v3' },
    { value: 'elevenlabs-pNInz6obpgDQGcFmaJgB__elevenlabs_v3', label: 'Adam (ElevenLabs v3, Male)', tier: 'elevenlabs_v3' },
    { value: 'elevenlabs-ODq5zmih8GrVes37Dizd__elevenlabs_v3', label: 'Patrick (ElevenLabs v3, Male)', tier: 'elevenlabs_v3' },
    { value: `elevenlabs-${CUSTOM_VOICE_ID}__elevenlabs_v3`, label: 'Pastor John Brown (Eleven v3 alpha)', tier: 'elevenlabs_v3' },

    // Eleven Turbo v2.5 - Balanced quality/speed, 32 languages
    { value: 'elevenlabs-JBFqnCBsd6RMkjVDRZzb__elevenlabs_turbo', label: 'George (ElevenLabs Turbo, Male)', tier: 'elevenlabs_turbo' },
    { value: 'elevenlabs-21m00Tcm4TlvDq8ikWAM__elevenlabs_turbo', label: 'Rachel (ElevenLabs Turbo, Female)', tier: 'elevenlabs_turbo' },
    { value: 'elevenlabs-EXAVITQu4vr4xnSDxMaL__elevenlabs_turbo', label: 'Sarah (ElevenLabs Turbo, Female)', tier: 'elevenlabs_turbo' },
    { value: `elevenlabs-${CUSTOM_VOICE_ID}__elevenlabs_turbo`, label: 'Pastor John Brown (Turbo v2.5)', tier: 'elevenlabs_turbo' },

    // Eleven Flash v2.5 - Ultra low latency, 32 languages
    { value: 'elevenlabs-JBFqnCBsd6RMkjVDRZzb__elevenlabs_flash', label: 'George (ElevenLabs Flash, Male)', tier: 'elevenlabs_flash' },
    { value: 'elevenlabs-21m00Tcm4TlvDq8ikWAM__elevenlabs_flash', label: 'Rachel (ElevenLabs Flash, Female)', tier: 'elevenlabs_flash' },
    { value: `elevenlabs-${CUSTOM_VOICE_ID}__elevenlabs_flash`, label: 'Pastor John Brown (Flash v2.5)', tier: 'elevenlabs_flash' },

    // Eleven Multilingual v2 - Stable, 29 languages
    { value: 'elevenlabs-JBFqnCBsd6RMkjVDRZzb__elevenlabs', label: 'George (ElevenLabs, Male)', tier: 'elevenlabs' },
    { value: 'elevenlabs-21m00Tcm4TlvDq8ikWAM__elevenlabs', label: 'Rachel (ElevenLabs, Female)', tier: 'elevenlabs' },
    { value: 'elevenlabs-EXAVITQu4vr4xnSDxMaL__elevenlabs', label: 'Sarah (ElevenLabs, Female)', tier: 'elevenlabs' },
    { value: 'elevenlabs-D38z5RcWu1voky8WS1ja__elevenlabs', label: 'Fin (ElevenLabs, Male)', tier: 'elevenlabs' },
    { value: 'elevenlabs-pNInz6obpgDQGcFmaJgB__elevenlabs', label: 'Adam (ElevenLabs, Male)', tier: 'elevenlabs' },
    { value: 'elevenlabs-ODq5zmih8GrVes37Dizd__elevenlabs', label: 'Patrick (ElevenLabs, Male)', tier: 'elevenlabs' },
    { value: `elevenlabs-${CUSTOM_VOICE_ID}__elevenlabs`, label: 'Pastor John Brown (Multilingual)', tier: 'elevenlabs' }
];


/**
 * Normalize language code to full locale
 * Maps short codes (zh, he) to full locale (cmn-CN, he-IL) for ttsVoices.json lookup
 */
const LOCALE_MAP = {
    'es': 'es-ES', 'en': 'en-US', 'fr': 'fr-FR', 'de': 'de-DE', 'it': 'it-IT',
    'pt': 'pt-BR', 'ja': 'ja-JP', 'ko': 'ko-KR', 'zh': 'cmn-CN', 'ar': 'ar-XA',
    'hi': 'hi-IN', 'ru': 'ru-RU', 'he': 'he-IL', 'nl': 'nl-NL', 'pl': 'pl-PL',
    'tr': 'tr-TR', 'cs': 'cs-CZ', 'da': 'da-DK', 'fi': 'fi-FI', 'el': 'el-GR',
    'hu': 'hu-HU', 'id': 'id-ID', 'ms': 'ms-MY', 'nb': 'nb-NO', 'ro': 'ro-RO',
    'sk': 'sk-SK', 'sv': 'sv-SE', 'th': 'th-TH', 'uk': 'uk-UA', 'vi': 'vi-VN',
    'bg': 'bg-BG', 'hr': 'hr-HR', 'lt': 'lt-LT', 'lv': 'lv-LV', 'sl': 'sl-SI',
    'sr': 'sr-RS', 'af': 'af-ZA', 'bn': 'bn-IN', 'ca': 'ca-ES', 'eu': 'eu-ES',
    'fil': 'fil-PH', 'gl': 'gl-ES', 'gu': 'gu-IN', 'is': 'is-IS', 'kn': 'kn-IN',
    'ml': 'ml-IN', 'mr': 'mr-IN', 'pa': 'pa-IN', 'ta': 'ta-IN', 'te': 'te-IN',
    'ur': 'ur-IN', 'cy': 'cy-GB', 'et': 'et-EE',

    // Regional Overrides (Process before generic dash check)
    'zh-CN': 'cmn-CN',  // Mandarin (China)
    'zh-SG': 'cmn-CN',  // Singapore uses Mandarin (Simplified)
    'zh-TW': 'cmn-TW',  // Mandarin (Taiwan)
    'zh-HK': 'yue-HK',  // Cantonese (Hong Kong)
};

export const normalizeLanguageCode = (languageCode) => {
    if (!languageCode) return null;

    // 1. Check map FIRST (allows overriding explicit locales like ar-EG)
    if (LOCALE_MAP[languageCode]) return LOCALE_MAP[languageCode];

    // 2. If already full locale, return as-is
    if (languageCode.includes('-')) return languageCode;

    // 3. Map short code to full locale (fallback)
    return `${languageCode}-${languageCode.toUpperCase()}`;
};

/**
 * Get available voices for a language - computed ON DEMAND
 * 
 * Rules:
 * 1. Base voices = exactly what's in ttsVoices.json (CANONICAL)
 * 2. Gemini/ElevenLabs are additive ONLY if language is supported
 * 3. If language NOT in ttsVoices.json AND not Gemini/ElevenLabs = empty array
 * 
 * @param {string} languageCode - Short (zh) or full locale (cmn-CN)
 * @returns {Array} Voice options for the language
 */
export const getVoicesForLanguage = (languageCode) => {
    if (!languageCode) return [];

    const normalizedCode = normalizeLanguageCode(languageCode);
    const voices = [];

    // 1. BASE VOICES from ttsVoices.json (CANONICAL - never filter, never reshape)
    if (ttsVoicesJson[normalizedCode]) {
        voices.push(...ttsVoicesJson[normalizedCode]);
    }

    // 2. GEMINI voices (additive, only if supported)
    if (isGeminiSupported(languageCode) || isGeminiSupported(normalizedCode)) {
        voices.unshift(...GEMINI_VOICE_OPTIONS);
    }

    // 3. ELEVENLABS voices (additive, only if supported per tier)
    const elevenLabsToAdd = [];
    for (const voice of ELEVENLABS_VOICE_OPTIONS) {
        if (isElevenLabsSupported(languageCode, voice.tier) ||
            isElevenLabsSupported(normalizedCode, voice.tier)) {
            elevenLabsToAdd.push(voice);
        }
    }
    if (elevenLabsToAdd.length > 0) {
        // Insert after Gemini but before base voices
        const geminiCount = (isGeminiSupported(languageCode) || isGeminiSupported(normalizedCode))
            ? GEMINI_VOICE_OPTIONS.length : 0;
        voices.splice(geminiCount, 0, ...elevenLabsToAdd);
    }

    return voices;
};

/**
 * DEPRECATED: Use getVoicesForLanguage instead
 * Kept for backwards compatibility - maps to on-demand function
 */
export const VOICE_OPTIONS_BY_LANG = new Proxy({}, {
    get: (target, prop) => {
        if (typeof prop === 'string') {
            return getVoicesForLanguage(prop);
        }
        return undefined;
    },
    has: (target, prop) => {
        const voices = getVoicesForLanguage(prop);
        return voices.length > 0;
    },
    ownKeys: () => Object.keys(ttsVoicesJson)
});
