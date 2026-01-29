/**
 * TTS Voice Catalog (Refactored)
 * 
 * Server-authoritative voice catalog for all TTS providers and tiers.
 * Now loads from JSON catalog files instead of hardcoded arrays.
 * Provides filtering, validation, and default voice selection.
 * 
 * Voice ID Format: provider:family:locale:base
 * Examples:
 * - google_cloud_tts:chirp3_hd:en-US:Kore
 * - gemini:gemini_tts:-:Kore
 * - elevenlabs:eleven_all:-:21m00Tcm4TlvDq8ikWAM
 */

import { getAllVoicesFromCatalogs, getSupportedLanguagesFromCatalogs } from './catalogLoader.js';

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Normalize language code to { full, base } format
 * @param {string} languageCode - BCP-47 language code
 * @returns {object} { full, base }
 */
export function normalizeLanguageCode(languageCode) {
    if (!languageCode) {
        return { full: 'en-US', base: 'en' };
    }

    // Handle special cases
    const normalized = languageCode.toLowerCase();

    // Chinese variants
    if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'cmn') {
        return { full: 'cmn-CN', base: 'cmn' };
    }
    if (normalized === 'zh-tw' || normalized === 'cmn-tw') {
        return { full: 'cmn-TW', base: 'cmn' };
    }
    if (normalized === 'yue' || normalized === 'yue-hk') {
        return { full: 'yue-HK', base: 'yue' };
    }

    // Filipino
    if (normalized === 'fil' || normalized === 'fil-ph') {
        return { full: 'fil-PH', base: 'fil' };
    }

    // Standard BCP-47 format: xx-YY
    const parts = languageCode.split('-');
    if (parts.length >= 2) {
        const base = parts[0].toLowerCase();
        const region = parts[1].toUpperCase();
        return { full: `${base}-${region}`, base };
    }

    // Just base language code
    const base = parts[0].toLowerCase();
    // Try to infer full code (default to primary region)
    const primaryRegions = {
        'en': 'en-US',
        'es': 'es-ES',
        'fr': 'fr-FR',
        'de': 'de-DE',
        'it': 'it-IT',
        'pt': 'pt-BR',
        'ja': 'ja-JP',
        'ko': 'ko-KR',
        'ar': 'ar-XA',
        'hi': 'hi-IN',
        'ru': 'ru-RU',
        'th': 'th-TH',
        'tr': 'tr-TR',
        'vi': 'vi-VN',
        'id': 'id-ID',
        'nl': 'nl-NL',
        'pl': 'pl-PL'
    };

    return { full: primaryRegions[base] || `${base}-${base.toUpperCase()}`, base };
}

// ==========================================
// EXPORTED FUNCTIONS
// ==========================================

/**
 * Get all available voices across all tiers
 * @returns {Promise<Array>} Array of voice objects
 */
export async function getAllVoices() {
    return await getAllVoicesFromCatalogs();
}

/**
 * Get voices filtered by language and allowed tiers
 * Implements locale fallback: exact → base → multilingual → English
 * 
 * @param {object} params
 * @param {string} params.languageCode - BCP-47 language code
 * @param {Array<string>} params.allowedTiers - Array of tier names
 * @returns {Promise<Array>} Filtered voice objects
 */
export async function getVoicesFor({ languageCode, allowedTiers }) {
    const allVoices = await getAllVoices();
    const { full, base } = normalizeLanguageCode(languageCode);

    // Filter voices that match either exact region OR base language OR are multilingual
    let matches = allVoices.filter(voice => {
        if (!allowedTiers.includes(voice.tier)) return false;

        // Multilingual flag
        if (voice.multilingual) return true;

        // Check language codes
        return voice.languageCodes.some(lang =>
            lang === full || // Exact match (e.g. 'es-ES')
            lang === base    // Generic match (e.g. 'es')
        );
    });

    if (matches.length > 0) {
        return matches;
    }

    // Fallback to English
    console.warn(`[VoiceCatalog] No voices found for ${languageCode}, falling back to English`);
    return allVoices.filter(voice => {
        if (!allowedTiers.includes(voice.tier)) return false;
        // Check for 'en' or 'en-US'
        return voice.languageCodes.includes('en') || voice.languageCodes.includes('en-US');
    });
}

/**
 * Check if a voice is valid for given language and tier
 * Accepts either voiceId or voiceName
 * 
 * @param {object} params
 * @param {string} [params.voiceId] - Stable voice ID
 * @param {string} [params.voiceName] - Provider voice name
 * @param {string} params.languageCode - BCP-47 language code
 * @param {string} params.tier - Tier name
 * @returns {Promise<boolean>} True if valid
 */
export async function isVoiceValid({ voiceId, voiceName, languageCode, tier }) {
    const allVoices = await getAllVoices();
    const { full, base } = normalizeLanguageCode(languageCode);

    return allVoices.some(voice => {
        // Match by voiceId or voiceName
        // For ElevenLabs, we support flexible ID matching (raw ID or tier/ID)
        const idMatch = voiceId ? (
            voice.voiceId === voiceId ||
            (voice.provider === 'elevenlabs' && voice.voiceId.endsWith(voiceId)) ||
            (voice.provider === 'elevenlabs' && voiceId.includes('/') && voice.voiceId.endsWith(voiceId.split('/').pop()))
        ) : voice.voiceName === voiceName;

        if (!idMatch) return false;

        // Check tier
        if (voice.tier !== tier) return false;

        // Check language (multilingual voices support all)
        if (voice.multilingual) return true;

        // Check language codes (allow exact or base match)
        return voice.languageCodes.some(lang =>
            lang === full || // Exact match (e.g. 'es-ES')
            lang === base    // Generic match (e.g. 'es')
        );
    });
}

/**
 * Get default voice for a language from catalog
 * @param {object} params
 * @param {string} params.languageCode - BCP-47 language code
 * @param {Array<string>} params.allowedTiers - Array of tier names
 * @returns {Promise<object|null>} Voice object or null if no default available
 */
export async function getDefaultVoice({ languageCode, allowedTiers }) {
    // Tier-aware priority: Select the best voice for the user's plan
    // - Starter: standard (basic quality, cost-effective)
    // - Pro: chirp3_hd (high-fidelity, production-ready)
    // - Unlimited: elevenlabs_flash (premium, ultra-realistic)

    // Define tier priorities based on business plan positioning
    let tierPriority;

    if (allowedTiers.includes('elevenlabs_flash') || allowedTiers.includes('elevenlabs')) {
        // Unlimited tier - prioritize premium voices
        tierPriority = ['elevenlabs_flash', 'elevenlabs_turbo', 'elevenlabs_v3', 'elevenlabs', 'gemini', 'chirp3_hd', 'neural2', 'standard'];
    } else if (allowedTiers.includes('chirp3_hd')) {
        // Pro tier - prioritize Chirp3 HD
        tierPriority = ['chirp3_hd', 'neural2', 'studio', 'standard'];
    } else {
        // Starter tier - prioritize standard voices
        tierPriority = ['standard', 'neural2', 'studio'];
    }

    for (const tier of tierPriority) {
        if (!allowedTiers.includes(tier)) continue;

        const voices = await getVoicesFor({ languageCode, allowedTiers: [tier] });
        if (voices.length > 0) {
            const voice = voices[0];
            console.log(`[VoiceCatalog] Selected default voice for ${languageCode}: ${voice.voiceName} (tier: ${voice.tier}) from priority: ${tier}`);
            return {
                tier: voice.tier,
                voiceId: voice.voiceId,
                voiceName: voice.voiceName
            };
        }
    }

    return null;
}

/**
 * Build Google TTS API voice selection object
 * @param {object} params
 * @param {string} params.tier - Tier name
 * @param {string} params.languageCode - BCP-47 language code
 * @param {string} params.voiceName - Voice name
 * @returns {Promise<object>} Google TTS API voice config
 */
export async function toGoogleVoiceSelection({ tier, languageCode, voiceName }) {
    // Verify this is a Google tier
    if (!['gemini', 'chirp3_hd', 'neural2', 'standard'].includes(tier)) {
        throw new Error(`Tier '${tier}' is not a Google TTS tier.`);
    }

    const allVoices = await getAllVoices();
    const voice = allVoices.find(v => v.voiceName === voiceName && v.tier === tier);

    if (!voice) {
        throw new Error(`Voice not found in catalog: ${voiceName} (tier: ${tier})`);
    }

    const { full } = normalizeLanguageCode(languageCode);

    const selection = {
        voice: {
            languageCode: full,
            name: voiceName
        },
        audioConfig: {
            audioEncoding: 'MP3'
        }
    };

    if (voice.model) {
        selection.voice.modelName = voice.model;
    }

    return selection;
}

/**
 * Get supported languages (derived from catalog)
 * @param {object} [params]
 * @param {Array<string>} [params.allowedTiers] - Optional tier filter
 * @returns {Promise<string[]>} Array of language codes
 */
export async function getSupportedLanguages({ allowedTiers } = {}) {
    if (!allowedTiers) {
        // Return all languages from all catalogs
        return await getSupportedLanguagesFromCatalogs();
    }

    // Filter by allowed tiers
    const allVoices = await getAllVoices();
    const languages = new Set();

    for (const voice of allVoices) {
        if (allowedTiers.includes(voice.tier)) {
            for (const lang of voice.languageCodes) {
                languages.add(lang);
            }
        }
    }

    return Array.from(languages).sort();
}

/**
 * Get catalog coverage report
 * @param {object} [params]
 * @param {Array<string>} [params.allowedTiers] - Optional tier filter
 * @returns {Promise<object>} Coverage statistics
 */
export async function getCatalogCoverage({ allowedTiers } = {}) {
    const allVoices = await getAllVoices();
    const voices = allowedTiers
        ? allVoices.filter(v => allowedTiers.includes(v.tier))
        : allVoices;

    const languages = new Set();
    const voicesByLanguage = {};

    for (const voice of voices) {
        for (const lang of voice.languageCodes) {
            languages.add(lang);

            if (!voicesByLanguage[lang]) {
                voicesByLanguage[lang] = { count: 0, voices: [] };
            }

            voicesByLanguage[lang].count++;
            if (voicesByLanguage[lang].voices.length < 5) {
                voicesByLanguage[lang].voices.push(voice.displayName);
            }
        }
    }

    return {
        totalVoices: voices.length,
        totalLanguages: languages.size,
        voicesByLanguage
    };
}
