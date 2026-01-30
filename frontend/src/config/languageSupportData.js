/**
 * Language Support Data - Single Source of Truth
 * 
 * This file defines which languages are supported by each TTS tier.
 * Data extracted from:
 * - backend/tts/ttsRouting.js (LANGUAGE_TIER_AVAILABILITY)
 * - backend/tts/voiceCatalog/catalogs/gemini_tts.json
 * - backend/tts/voiceCatalog/catalogs/elevenlabs_*.json
 * - LANGUAGE SUPPORT AND SCRIPT FROM GOOGLETTS.md
 * 
 * IMPORTANT: Keep this file in sync with backend/tts/ttsRouting.js
 */

// ============================================================================
// GEMINI SUPPORTED LANGUAGES (87 languages from Vertex AI)
// Source: LANGUAGE SUPPORT AND SCRIPT FROM GOOGLETTS.md
// ============================================================================
export const GEMINI_SUPPORTED_LANGUAGES = new Set([
    // GA (Generally Available - 24 Languages)
    'ar-EG', 'bn-BD', 'nl-NL', 'en-IN', 'en-US', 'fr-FR', 'de-DE', 'hi-IN',
    'id-ID', 'it-IT', 'ja-JP', 'ko-KR', 'mr-IN', 'pl-PL', 'pt-BR', 'ro-RO',
    'ru-RU', 'es-ES', 'ta-IN', 'te-IN', 'th-TH', 'tr-TR', 'uk-UA', 'vi-VN',

    // Preview (63 Languages)
    'af-ZA', 'sq-AL', 'am-ET', 'ar-001', 'hy-AM', 'az-AZ', 'eu-ES', 'be-BY',
    'bg-BG', 'my-MM', 'ca-ES', 'ceb-PH', 'cmn-CN', 'cmn-TW', 'hr-HR', 'cs-CZ',
    'da-DK', 'en-AU', 'en-GB', 'et-EE', 'fil-PH', 'fi-FI', 'fr-CA', 'gl-ES',
    'ka-GE', 'el-GR', 'gu-IN', 'ht-HT', 'he-IL', 'hu-HU', 'is-IS', 'jv-JV',
    'kn-IN', 'kok-IN', 'lo-LA', 'la-VA', 'lv-LV', 'lt-LT', 'lb-LU', 'mk-MK',
    'mai-IN', 'mg-MG', 'ms-MY', 'ml-IN', 'mn-MN', 'ne-NP', 'nb-NO', 'nn-NO',
    'or-IN', 'ps-AF', 'fa-IR', 'pt-PT', 'pa-IN', 'sr-RS', 'sd-IN', 'si-LK',
    'sk-SK', 'sl-SI', 'es-419', 'es-MX', 'sw-KE', 'sv-SE', 'ur-PK'
]);

// ============================================================================
// ELEVENLABS LANGUAGE SUPPORT
// Source: backend/tts/voiceCatalog/catalogs/elevenlabs_*.json
// ============================================================================

// ElevenLabs Flash v2.5 & Turbo v2.5 (29 languages - short codes)
export const ELEVENLABS_FLASH_LANGUAGES = new Set([
    'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'hi', 'hu', 'id',
    'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sv',
    'th', 'tr', 'uk', 'vi', 'zh'
]);

// ElevenLabs Turbo v2.5 (same as Flash)
export const ELEVENLABS_TURBO_LANGUAGES = ELEVENLABS_FLASH_LANGUAGES;

// ElevenLabs v3 (70+ languages - short codes)
export const ELEVENLABS_V3_LANGUAGES = new Set([
    // Core languages (same as Flash)
    'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'hi', 'hu', 'id',
    'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sv',
    'th', 'tr', 'uk', 'vi', 'zh',
    // Extended languages (v3 only)
    'af', 'sq', 'am', 'ar', 'hy', 'az', 'eu', 'be', 'bn', 'my', 'ca', 'ceb',
    'hr', 'et', 'fil', 'gl', 'ka', 'gu', 'ht', 'he', 'is', 'jv', 'kn', 'kok',
    'lo', 'la', 'lv', 'lt', 'lb', 'mk', 'mai', 'mg', 'ml', 'mn', 'ne', 'nn',
    'or', 'ps', 'fa', 'pa', 'sr', 'sd', 'si', 'sl', 'sw', 'ur'
]);

// ElevenLabs Multilingual v2 (same as Flash for compatibility)
export const ELEVENLABS_MULTILINGUAL_LANGUAGES = ELEVENLABS_FLASH_LANGUAGES;

// ============================================================================
// GOOGLE TTS TIER AVAILABILITY PER LANGUAGE
// Source: backend/tts/ttsRouting.js (LANGUAGE_TIER_AVAILABILITY)
// This is the single source of truth for which Google tiers are available
// ============================================================================
export const LANGUAGE_TIER_AVAILABILITY = {
    "af-ZA": ["standard"],
    "ar-XA": ["chirp3_hd", "neural2", "standard"],
    "eu-ES": ["standard"],
    "bn-IN": ["chirp3_hd", "neural2", "standard"],
    "bg-BG": ["chirp3_hd", "standard"],
    "ca-ES": ["standard"],
    "yue-HK": ["chirp3_hd", "standard"],
    "hr-HR": ["chirp3_hd"],
    "cs-CZ": ["chirp3_hd", "neural2", "standard"],
    "da-DK": ["chirp3_hd", "neural2", "standard"],
    "nl-BE": ["chirp3_hd", "neural2", "standard"],
    "nl-NL": ["gemini", "chirp3_hd", "neural2", "standard"],
    "en-AU": ["chirp3_hd", "neural2", "standard"],
    "en-IN": ["gemini", "chirp3_hd", "studio", "neural2", "standard"],
    "en-GB": ["gemini", "chirp3_hd", "studio", "neural2", "standard"],
    "en-US": ["gemini", "chirp3_hd", "studio", "neural2", "standard"],
    "et-EE": ["chirp3_hd", "standard"],
    "fil-PH": ["neural2", "standard"],
    "fi-FI": ["chirp3_hd", "neural2", "standard"],
    "fr-CA": ["chirp3_hd", "neural2", "standard"],
    "fr-FR": ["gemini", "chirp3_hd", "studio", "neural2", "standard"],
    "gl-ES": ["standard"],
    "de-DE": ["gemini", "chirp3_hd", "studio", "neural2", "standard"],
    "el-GR": ["chirp3_hd", "neural2", "standard"],
    "gu-IN": ["chirp3_hd", "neural2", "standard"],
    "he-IL": ["chirp3_hd", "neural2", "standard"],
    "hi-IN": ["gemini", "chirp3_hd", "neural2", "standard"],
    "hu-HU": ["chirp3_hd", "neural2", "standard"],
    "is-IS": ["standard"],
    "id-ID": ["gemini", "chirp3_hd", "neural2", "standard"],
    "it-IT": ["gemini", "chirp3_hd", "neural2", "standard"],
    "ja-JP": ["gemini", "chirp3_hd", "neural2", "standard"],
    "kn-IN": ["chirp3_hd", "neural2", "standard"],
    "ko-KR": ["gemini", "chirp3_hd", "neural2", "standard"],
    "lv-LV": ["chirp3_hd", "standard"],
    "lt-LT": ["chirp3_hd", "standard"],
    "ms-MY": ["neural2", "standard"],
    "ml-IN": ["chirp3_hd", "neural2", "standard"],
    "cmn-CN": ["gemini", "chirp3_hd", "neural2", "standard"],
    "zh-CN": ["gemini", "chirp3_hd", "neural2", "standard"],
    "cmn-TW": ["neural2", "standard"],
    "mr-IN": ["gemini", "chirp3_hd", "neural2", "standard"],
    "nb-NO": ["chirp3_hd", "neural2", "standard"],
    "pl-PL": ["gemini", "chirp3_hd", "neural2", "standard"],
    "pt-BR": ["gemini", "chirp3_hd", "neural2", "standard"],
    "pt-PT": ["gemini", "neural2", "standard"],
    "pa-IN": ["chirp3_hd", "neural2", "standard"],
    "ro-RO": ["gemini", "chirp3_hd", "neural2", "standard"],
    "ru-RU": ["gemini", "chirp3_hd", "neural2", "standard"],
    "sr-RS": ["chirp3_hd", "standard"],
    "sk-SK": ["chirp3_hd", "neural2", "standard"],
    "sl-SI": ["chirp3_hd"],
    "es-ES": ["gemini", "chirp3_hd", "studio", "neural2", "standard"],
    "es-US": ["gemini", "chirp3_hd", "studio", "neural2", "standard"],
    "sv-SE": ["chirp3_hd", "neural2", "standard"],
    "ta-IN": ["gemini", "chirp3_hd", "neural2", "standard"],
    "te-IN": ["gemini", "chirp3_hd", "standard"],
    "th-TH": ["gemini", "chirp3_hd", "neural2", "standard"],
    "tr-TR": ["gemini", "chirp3_hd", "neural2", "standard"],
    "uk-UA": ["gemini", "chirp3_hd", "neural2", "standard"],
    "ur-IN": ["chirp3_hd", "neural2", "standard"],
    "vi-VN": ["gemini", "chirp3_hd", "neural2", "standard"]
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Special language code mappings (bidirectional)
 * cmn is the ISO 639-3 code for Mandarin Chinese, zh is the ISO 639-1 code
 */
const LANGUAGE_CODE_ALIASES = {
    'cmn': 'zh',
    'zh': 'cmn',
    'yue': 'zh-HK',  // Cantonese
    'fil': 'tl',     // Filipino/Tagalog
    'tl': 'fil',
};

/**
 * Get the base language code from a full locale code (e.g., 'en-US' -> 'en', 'cmn-CN' -> 'zh')
 */
function getBaseLanguage(langCode) {
    if (!langCode) return null;
    const base = langCode.split('-')[0].toLowerCase();
    // Map special codes to their short form equivalents
    return LANGUAGE_CODE_ALIASES[base] || base;
}

/**
 * Get all possible base codes for a language (including aliases)
 */
function getAllBaseCodes(langCode) {
    if (!langCode) return [];
    const base = langCode.split('-')[0].toLowerCase();
    const codes = [base];
    if (LANGUAGE_CODE_ALIASES[base]) {
        codes.push(LANGUAGE_CODE_ALIASES[base]);
    }
    return codes;
}

/**
 * Check if a language supports Gemini TTS
 * @param {string} langCode - Full language code (e.g., 'en-US') or base code (e.g., 'en')
 * @returns {boolean}
 */
export function isGeminiSupported(langCode) {
    if (!langCode) return false;

    // Check direct match first
    if (GEMINI_SUPPORTED_LANGUAGES.has(langCode)) return true;

    // Check all base code variants
    const baseCodes = getAllBaseCodes(langCode);
    for (const geminiLang of GEMINI_SUPPORTED_LANGUAGES) {
        const geminiBase = geminiLang.split('-')[0].toLowerCase();
        if (baseCodes.includes(geminiBase) || baseCodes.includes(LANGUAGE_CODE_ALIASES[geminiBase])) {
            return true;
        }
    }
    return false;
}

/**
 * Check if a language supports a specific ElevenLabs tier
 * @param {string} langCode - Full language code (e.g., 'en-US') or base code (e.g., 'en')
 * @param {string} tier - ElevenLabs tier: 'elevenlabs_v3', 'elevenlabs_turbo', 'elevenlabs_flash', 'elevenlabs'
 * @returns {boolean}
 */
export function isElevenLabsSupported(langCode, tier) {
    if (!langCode || !tier) return false;

    // Get all base code variants (original + alias)
    const baseCodes = getAllBaseCodes(langCode);

    const checkSet = (set) => baseCodes.some(code => set.has(code));

    switch (tier) {
        case 'elevenlabs_v3':
            return checkSet(ELEVENLABS_V3_LANGUAGES);
        case 'elevenlabs_turbo':
            return checkSet(ELEVENLABS_TURBO_LANGUAGES);
        case 'elevenlabs_flash':
            return checkSet(ELEVENLABS_FLASH_LANGUAGES);
        case 'elevenlabs':
            return checkSet(ELEVENLABS_MULTILINGUAL_LANGUAGES);
        default:
            return false;
    }
}

/**
 * Check if a language supports a specific Google TTS tier
 * @param {string} langCode - Full language code (e.g., 'en-US')
 * @param {string} tier - Google tier: 'gemini', 'chirp3_hd', 'studio', 'neural2', 'standard'
 * @returns {boolean}
 */
export function isGoogleTierSupported(langCode, tier) {
    if (!langCode || !tier) return false;

    // 1. Check direct match (e.g. 'en-US')
    if (LANGUAGE_TIER_AVAILABILITY[langCode]?.includes(tier)) {
        return true;
    }

    // 2. Check derived locales if input is just base code (e.g. 'ko' -> check 'ko-KR')
    const base = langCode.split('-')[0];
    const supportedLocales = Object.keys(LANGUAGE_TIER_AVAILABILITY);

    // Check if any supported locale for this base language has the tier
    // e.g. input 'en' -> check 'en-US', 'en-GB', 'en-AU', etc.
    const candidates = supportedLocales.filter(l => l.startsWith(base + '-'));
    for (const locale of candidates) {
        if (LANGUAGE_TIER_AVAILABILITY[locale]?.includes(tier)) {
            return true;
        }
    }

    return false;
}

/**
 * Get all available tiers for a language
 * @param {string} langCode - Full language code (e.g., 'en-US')
 * @returns {string[]} Array of available tier names
 */
export function getAvailableTiersForLanguage(langCode) {
    if (!langCode) return ['standard'];

    const googleTiers = LANGUAGE_TIER_AVAILABILITY[langCode] || ['neural2', 'standard'];
    const allTiers = [...googleTiers];

    // Add ElevenLabs tiers if supported
    const base = getBaseLanguage(langCode);
    if (ELEVENLABS_V3_LANGUAGES.has(base)) {
        allTiers.push('elevenlabs_v3');
    }
    if (ELEVENLABS_TURBO_LANGUAGES.has(base)) {
        allTiers.push('elevenlabs_turbo');
    }
    if (ELEVENLABS_FLASH_LANGUAGES.has(base)) {
        allTiers.push('elevenlabs_flash');
    }
    if (ELEVENLABS_MULTILINGUAL_LANGUAGES.has(base)) {
        allTiers.push('elevenlabs');
    }

    return allTiers;
}

/**
 * Check if a tier is supported for a language (any provider)
 * @param {string} langCode - Full language code (e.g., 'en-US')
 * @param {string} tier - Any tier name
 * @returns {boolean}
 */
export function isTierSupported(langCode, tier) {
    if (!langCode || !tier) return false;

    // ElevenLabs tiers
    if (tier.startsWith('elevenlabs')) {
        return isElevenLabsSupported(langCode, tier);
    }

    // Google tiers (gemini, chirp3_hd, studio, neural2, standard)
    return isGoogleTierSupported(langCode, tier);
}
