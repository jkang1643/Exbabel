/**
 * TTS Voice Catalog
 * 
 * Server-authoritative voice catalog for Google TTS (Gemini + Chirp3-HD voices).
 * Provides filtering, validation, and default voice selection.
 * 
 * Voice Naming:
 * - Gemini: Prebuilt IDs without locale (e.g., "Kore", "Puck")
 * - Chirp3-HD: {locale}-Chirp3-HD-{voice} pattern (e.g., "en-US-Chirp3-HD-Kore")
 */

import { TtsEngine } from './tts.types.js';

// Gemini persona voices (prebuilt voice IDs, work across multiple languages)
const GEMINI_VOICES = [
    { voiceName: 'Kore', displayName: 'Kore (Gemini)', model: 'gemini-2.5-flash-tts' },
    { voiceName: 'Puck', displayName: 'Puck (Gemini)', model: 'gemini-2.5-flash-tts' },
    { voiceName: 'Charon', displayName: 'Charon (Gemini)', model: 'gemini-2.5-flash-tts' },
    { voiceName: 'Leda', displayName: 'Leda (Gemini)', model: 'gemini-2.5-flash-tts' },
    { voiceName: 'Aoede', displayName: 'Aoede (Gemini)', model: 'gemini-2.5-flash-tts' },
    { voiceName: 'Fenrir', displayName: 'Fenrir (Gemini)', model: 'gemini-2.5-flash-tts' }
];

// Chirp3-HD voices per language (locale-specific)
// Pattern: {locale}-Chirp3-HD-{baseVoice}
const CHIRP3_HD_VOICES = {
    'en-US': ['Kore', 'Puck', 'Charon', 'Leda'],
    'en-GB': ['Kore', 'Puck'],
    'en-AU': ['Kore'],
    'en-IN': ['Kore'],
    'es-ES': ['Kore', 'Leda'],
    'es-US': ['Kore'],
    'fr-FR': ['Kore', 'Puck'],
    'fr-CA': ['Kore'],
    'de-DE': ['Kore', 'Puck'],
    'it-IT': ['Kore'],
    'pt-BR': ['Kore'],
    'ja-JP': ['Kore'],
    'ko-KR': ['Kore'],
    'cmn-CN': ['Kore'],
    'zh-CN': ['Kore'],
    'hi-IN': ['Kore'],
    'id-ID': ['Kore'],
    'nl-NL': ['Kore'],
    'pl-PL': ['Kore'],
    'pt-PT': ['Kore'],
    'ru-RU': ['Kore'],
    'th-TH': ['Kore'],
    'tr-TR': ['Kore'],
    'vi-VN': ['Kore'],
    'ar-XA': ['Kore'],
    'bg-BG': ['Kore'],
    'bn-IN': ['Kore'],
    'cs-CZ': ['Kore'],
    'da-DK': ['Kore'],
    'el-GR': ['Kore'],
    'fi-FI': ['Kore'],
    'gu-IN': ['Kore'],
    'he-IL': ['Kore'],
    'hr-HR': ['Kore'],
    'hu-HU': ['Kore'],
    'kn-IN': ['Kore'],
    'lt-LT': ['Kore'],
    'lv-LV': ['Kore'],
    'ml-IN': ['Kore'],
    'mr-IN': ['Kore'],
    'nb-NO': ['Kore'],
    'nl-BE': ['Kore'],
    'pa-IN': ['Kore'],
    'ro-RO': ['Kore'],
    'sk-SK': ['Kore'],
    'sl-SI': ['Kore'],
    'sr-RS': ['Kore'],
    'sv-SE': ['Kore'],
    'ta-IN': ['Kore'],
    'te-IN': ['Kore'],
    'uk-UA': ['Kore'],
    'ur-IN': ['Kore'],
    'yue-HK': ['Kore']
};

/**
 * Get all available voices across all tiers
 * @returns {Array} Array of voice objects
 */
export function getAllVoices() {
    const voices = [];

    // Add Gemini voices (multi-language)
    for (const geminiVoice of GEMINI_VOICES) {
        voices.push({
            tier: 'gemini',
            voiceName: geminiVoice.voiceName,
            displayName: geminiVoice.displayName,
            model: geminiVoice.model,
            languageCodes: Object.keys(CHIRP3_HD_VOICES) // Gemini voices work across all supported languages
        });
    }

    // Add Chirp3-HD voices (locale-specific)
    for (const [locale, baseVoices] of Object.entries(CHIRP3_HD_VOICES)) {
        for (const baseVoice of baseVoices) {
            const voiceName = `${locale}-Chirp3-HD-${baseVoice}`;
            voices.push({
                tier: 'chirp3_hd',
                voiceName: voiceName,
                displayName: `${baseVoice} (Chirp3-HD ${locale})`,
                model: 'chirp-3-hd',
                languageCodes: [locale]
            });
        }
    }

    return voices;
}

/**
 * Get voices filtered by language and allowed tiers
 * @param {object} params
 * @param {string} params.languageCode - BCP-47 language code
 * @param {Array<string>} params.allowedTiers - Array of tier names (e.g., ['gemini', 'chirp3_hd'])
 * @returns {Array} Filtered voice objects
 */
export function getVoicesFor({ languageCode, allowedTiers }) {
    const allVoices = getAllVoices();

    return allVoices.filter(voice => {
        // Filter by tier
        if (!allowedTiers.includes(voice.tier)) {
            return false;
        }

        // Filter by language
        if (!voice.languageCodes.includes(languageCode)) {
            return false;
        }

        return true;
    });
}

/**
 * Check if a voice is valid for given language and tier
 * @param {object} params
 * @param {string} params.voiceName - Voice name to validate
 * @param {string} params.languageCode - BCP-47 language code
 * @param {string} params.tier - Tier name
 * @returns {boolean} True if valid
 */
export function isVoiceValid({ voiceName, languageCode, tier }) {
    const allVoices = getAllVoices();

    return allVoices.some(voice =>
        voice.voiceName === voiceName &&
        voice.tier === tier &&
        voice.languageCodes.includes(languageCode)
    );
}

/**
 * Get default voice for a language from catalog
 * @param {object} params
 * @param {string} params.languageCode - BCP-47 language code
 * @param {Array<string>} params.allowedTiers - Array of tier names
 * @returns {object|null} Voice object or null if no default available
 */
export function getDefaultVoice({ languageCode, allowedTiers }) {
    // Prefer Gemini tier if allowed
    if (allowedTiers.includes('gemini')) {
        const geminiVoices = getVoicesFor({ languageCode, allowedTiers: ['gemini'] });
        if (geminiVoices.length > 0) {
            return { tier: 'gemini', voiceName: 'Kore' }; // Default Gemini voice
        }
    }

    // Fallback to Chirp3-HD if available
    if (allowedTiers.includes('chirp3_hd')) {
        const chirpVoices = getVoicesFor({ languageCode, allowedTiers: ['chirp3_hd'] });
        if (chirpVoices.length > 0) {
            return { tier: 'chirp3_hd', voiceName: chirpVoices[0].voiceName };
        }
    }

    // No voices available for this language/tier combination
    return null;
}

/**
 * Build Google TTS API voice selection object
 * @param {object} params
 * @param {string} params.tier - Tier name
 * @param {string} params.languageCode - BCP-47 language code
 * @param {string} params.voiceName - Voice name
 * @returns {object} Google TTS API voice config
 */
export function toGoogleVoiceSelection({ tier, languageCode, voiceName }) {
    const allVoices = getAllVoices();
    const voice = allVoices.find(v => v.voiceName === voiceName && v.tier === tier);

    if (!voice) {
        throw new Error(`Voice not found in catalog: ${voiceName} (tier: ${tier})`);
    }

    const selection = {
        voice: {
            languageCode: languageCode,
            name: voiceName
        },
        audioConfig: {
            audioEncoding: 'MP3' // Default for unary mode
        }
    };

    // Add model name for Gemini and Chirp3-HD
    if (voice.model) {
        selection.voice.modelName = voice.model;
    }

    return selection;
}
