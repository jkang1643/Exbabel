/**
 * ElevenLabs Inventory Collector
 * 
 * Fetches latest voice inventory from ElevenLabs API
 * and normalizes into standard inventory format, splitting by tiers
 */

import fetch from 'node-fetch';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

// Model/Tier language mapping (simplified)
const TIER_LANGUAGES = {
    elevenlabs_v3: [
        "bg", "cs", "da", "de", "el", "en", "es", "fi", "fr", "hi", "hu", "id", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "th", "tr", "uk", "vi", "zh",
        // Extended v3 languages (approximate 70+ based on user feedback/docs)
        "af", "sq", "am", "ar", "hy", "az", "eu", "be", "bn", "my", "ca", "ceb", "hr", "et", "fil", "gl", "ka", "gu", "ht", "he", "is", "jv", "kn", "kok", "lo", "la", "lv", "lt", "lb", "mk", "mai", "mg", "ml", "mn", "ne", "nn", "or", "ps", "fa", "pa", "sr", "sd", "si", "sl", "sw", "ur"
    ],
    elevenlabs_turbo: [
        "bg", "cs", "da", "de", "el", "en", "es", "fi", "fr", "hi", "hu", "id", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "th", "tr", "uk", "vi", "zh"
    ],
    elevenlabs_flash: [
        "bg", "cs", "da", "de", "el", "en", "es", "fi", "fr", "hi", "hu", "id", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "th", "tr", "uk", "vi", "zh"
    ],
    elevenlabs: ["en"] // Legacy/standard
};

/**
 * Generate stable voiceId for ElevenLabs
 * @private
 */
function _generateVoiceId(family, voiceIdStr) {
    return `elevenlabs:${family}:-:${voiceIdStr}`;
}

/**
 * Fetch ElevenLabs inventory
 * @returns {Promise<object>} Inventory snapshot
 */
export async function fetchElevenLabsInventory() {
    console.log('[ElevenLabs] Fetching voice inventory...');

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        throw new Error('ELEVENLABS_API_KEY environment variable not set');
    }

    const response = await fetch(`${ELEVENLABS_API_BASE}/voices`, {
        headers: {
            'xi-api-key': apiKey
        }
    });

    if (!response.ok) {
        throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const inventoryVoices = [];

    for (const voice of data.voices) {
        // Emit one entry for each supported tier so reporter can aggregate
        for (const [tier, languages] of Object.entries(TIER_LANGUAGES)) {
            inventoryVoices.push({
                voiceId: _generateVoiceId(tier, voice.voice_id),
                provider: 'elevenlabs',
                family: tier,
                voiceName: voice.voice_id,
                displayName: voice.name,
                languageCodes: languages,
                category: voice.category || 'unknown',
                labels: voice.labels || {}
            });
        }
    }

    const snapshot = {
        fetchedAt: new Date().toISOString(),
        providerKey: 'elevenlabs',
        voices: inventoryVoices
    };

    console.log(`[ElevenLabs] Fetched ${data.voices.length} physical voices, expanded to ${inventoryVoices.length} tier mappings`);
    console.log(`[ElevenLabs] Tiers: ${Object.keys(TIER_LANGUAGES).join(', ')}`);

    return snapshot;
}
