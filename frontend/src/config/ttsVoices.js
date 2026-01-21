/**
 * TTS Voice Configuration
 * 
 * This file uses the auto-generated ttsVoices.json (extracted from Available languages.txt)
 * and adds language-agnostic Gemini voices and normalization logic.
 */

import ttsVoicesJson from './ttsVoices.json';

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
 * Mapping of language codes to their available voices.
 * Combines auto-generated voices with language-agnostic Gemini and ElevenLabs voices.
 */
export const VOICE_OPTIONS_BY_LANG = Object.keys(ttsVoicesJson).reduce((acc, langCode) => {
    // Start with premium voices (Gemini and ElevenLabs), then language-specific voices
    acc[langCode] = [...GEMINI_VOICE_OPTIONS, ...ELEVENLABS_VOICE_OPTIONS, ...ttsVoicesJson[langCode]];
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
        ...ELEVENLABS_VOICE_OPTIONS,
        { value: `${normalizedCode}-Standard-A`, label: 'Standard-A (Fallback)', tier: 'standard' }
    ];
};
