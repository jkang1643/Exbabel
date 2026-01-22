/**
 * Catalog Schema Definitions
 * 
 * Defines the canonical structure for voice catalog entries
 */

/**
 * Voice object schema
 * @typedef {object} Voice
 * @property {string} voiceId - Stable unique identifier (provider:family:locale:base)
 * @property {string} voiceName - Provider-specific voice name
 * @property {string} displayName - Human-readable name for UI
 * @property {string} provider - Provider identifier (google_cloud_tts, gemini, elevenlabs)
 * @property {string} family - Voice family (chirp3_hd, neural2, standard, gemini_tts, eleven_all)
 * @property {string} tier - Exbabel tier (gemini, chirp3_hd, neural2, standard, elevenlabs_*)
 * @property {string[]} languageCodes - Supported language codes (['*'] for multilingual)
 * @property {string} [model] - Model name (optional)
 * @property {string} [gender] - Voice gender (optional)
 * @property {number} [sampleRateHz] - Sample rate (optional)
 * @property {string[]} [availableTiers] - For ElevenLabs: which tiers support this voice
 */

/**
 * Catalog file schema
 * @typedef {object} CatalogFile
 * @property {string} provider - Provider identifier
 * @property {string} family - Voice family
 * @property {string|string[]} tier - Tier(s) this catalog represents
 * @property {Voice[]} voices - Array of voice objects
 */

/**
 * Validate a voice object against schema
 * @param {object} voice - Voice object to validate
 * @returns {string|null} Error message or null if valid
 */
export function validateVoice(voice) {
    if (!voice.voiceId || typeof voice.voiceId !== 'string') {
        return 'Missing or invalid voiceId';
    }

    if (!voice.voiceName || typeof voice.voiceName !== 'string') {
        return 'Missing or invalid voiceName';
    }

    if (!voice.displayName || typeof voice.displayName !== 'string') {
        return 'Missing or invalid displayName';
    }

    if (!Array.isArray(voice.languageCodes) || voice.languageCodes.length === 0) {
        return 'Missing or invalid languageCodes array';
    }

    // voiceId format validation: provider:family:locale:base
    const parts = voice.voiceId.split(':');
    if (parts.length !== 4) {
        return `Invalid voiceId format: ${voice.voiceId} (expected provider:family:locale:base)`;
    }

    return null;
}

/**
 * Validate a catalog file against schema
 * @param {object} catalog - Catalog file object
 * @returns {string|null} Error message or null if valid
 */
export function validateCatalog(catalog) {
    if (!catalog.provider || typeof catalog.provider !== 'string') {
        return 'Missing or invalid provider';
    }

    if (!catalog.family || typeof catalog.family !== 'string') {
        return 'Missing or invalid family';
    }

    if (!catalog.tier) {
        return 'Missing tier';
    }

    if (!Array.isArray(catalog.voices)) {
        return 'Missing or invalid voices array';
    }

    // Validate each voice
    for (let i = 0; i < catalog.voices.length; i++) {
        const error = validateVoice(catalog.voices[i]);
        if (error) {
            return `Voice ${i}: ${error}`;
        }
    }

    return null;
}
