/**
 * Google Cloud TTS Inventory Collector
 * 
 * Fetches latest voice inventory from Google Cloud Text-to-Speech API
 * and normalizes into standard inventory format
 */

import textToSpeech from '@google-cloud/text-to-speech';

/**
 * Classify voice family based on voice name pattern
 * @private
 */
function _classifyFamily(voiceName) {
    if (voiceName.includes('-Chirp3-HD-')) return 'chirp3_hd';
    if (voiceName.includes('-Neural2-')) return 'neural2';
    if (voiceName.includes('-Wavenet-')) return 'neural2'; // Legacy, map to neural2
    if (voiceName.includes('-Standard-')) return 'standard';
    if (voiceName.includes('-Journey-')) return 'journey';
    if (voiceName.includes('-Studio-')) return 'studio';
    return 'unknown';
}

/**
 * Extract locale from voice name
 * @private
 */
function _extractLocale(voiceName) {
    // Pattern: {locale}-{Family}-{Variant}
    // Example: en-US-Neural2-A → en-US
    const match = voiceName.match(/^([a-z]{2,3}-[A-Z]{2})/);
    return match ? match[1] : null;
}

/**
 * Extract base voice name from full voice name
 * @private
 */
function _extractBaseName(voiceName, family, locale) {
    // For Chirp3-HD: en-US-Chirp3-HD-Kore → Kore
    if (family === 'chirp3_hd') {
        const match = voiceName.match(/-Chirp3-HD-(.+)$/);
        return match ? match[1] : voiceName;
    }

    // For Neural2/Standard: en-US-Neural2-A → A
    if (family === 'neural2' || family === 'standard') {
        const match = voiceName.match(/-(Neural2|Wavenet|Standard)-(.+)$/);
        return match ? match[2] : voiceName;
    }

    return voiceName;
}

/**
 * Generate stable voiceId
 * @private
 */
function _generateVoiceId(provider, family, locale, baseName) {
    const localeStr = locale || '-';
    return `${provider}:${family}:${localeStr}:${baseName}`;
}

/**
 * Fetch Google Cloud TTS inventory
 * @returns {Promise<object>} Inventory snapshot
 */
export async function fetchGoogleCloudInventory() {
    console.log('[GoogleCloudTts] Fetching voice inventory...');

    const client = new textToSpeech.TextToSpeechClient();
    const [result] = await client.listVoices({});

    const voices = result.voices.map(voice => {
        const voiceName = voice.name;
        const family = _classifyFamily(voiceName);
        const locale = _extractLocale(voiceName);
        const baseName = _extractBaseName(voiceName, family, locale);
        const voiceId = _generateVoiceId('google_cloud_tts', family, locale, baseName);

        return {
            voiceId,
            provider: 'google_cloud_tts',
            family,
            voiceName,
            languageCodes: voice.languageCodes || [],
            gender: voice.ssmlGender || 'UNKNOWN',
            sampleRateHz: voice.naturalSampleRateHertz || 24000
        };
    });

    const snapshot = {
        fetchedAt: new Date().toISOString(),
        providerKey: 'google_cloud_tts',
        voices
    };

    console.log(`[GoogleCloudTts] Fetched ${voices.length} voices`);
    console.log(`[GoogleCloudTts] Families: ${[...new Set(voices.map(v => v.family))].join(', ')}`);

    return snapshot;
}
