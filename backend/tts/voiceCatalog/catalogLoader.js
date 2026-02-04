/**
 * Catalog Loader
 * 
 * Loads and normalizes voice catalog JSON files
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateCatalog } from './catalogSchema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CATALOGS_DIR = path.join(__dirname, 'catalogs');

// In-memory cache
let _catalogCache = null;
let _allLanguages = null;

/**
 * Get full list of supported languages from environment or defaults
 * @private
 */
function _getFullLanguageList() {
    // This is the full list of languages Exbabel supports
    return [
        'en-US', 'en-GB', 'en-AU', 'en-IN', 'es-ES', 'es-US', 'fr-FR', 'fr-CA',
        'de-DE', 'it-IT', 'pt-BR', 'ja-JP', 'ko-KR', 'cmn-CN', 'zh-CN', 'hi-IN',
        'id-ID', 'nl-NL', 'pl-PL', 'pt-PT', 'ru-RU', 'th-TH', 'tr-TR', 'vi-VN',
        'ar-001', 'ar-EG', 'ar-XA', 'bg-BG', 'bn-IN', 'cs-CZ', 'da-DK', 'el-GR',
        'fi-FI', 'gu-IN', 'he-IL', 'hr-HR', 'hu-HU', 'kn-IN', 'lt-LT', 'lv-LV',
        'ml-IN', 'mr-IN', 'nb-NO', 'nl-BE', 'pa-IN', 'ro-RO', 'sk-SK', 'sl-SI',
        'sr-RS', 'sv-SE', 'ta-IN', 'te-IN', 'uk-UA', 'ur-IN', 'yue-HK',
        'af-ZA', 'sq-AL', 'am-ET', 'hy-AM', 'az-AZ', 'be-BY', 'bn-BD', 'my-MM',
        'ca-ES', 'ceb-PH', 'cmn-TW', 'et-EE', 'fil-PH', 'gl-ES', 'ka-GE', 'ht-HT',
        'is-IS', 'jv-JV', 'kok-IN', 'lo-LA', 'la-VA', 'lb-LU', 'mk-MK', 'mai-IN',
        'mg-MG', 'ms-MY', 'mn-MN', 'ne-NP', 'nn-NO', 'or-IN', 'ps-AF', 'fa-IR',
        'sd-IN', 'si-LK', 'es-419', 'es-MX', 'sw-KE', 'ur-PK'
    ];
}

/**
 * Expand multilingual voices (languageCodes: ['*']) to full language list
 * @private
 */
function _expandMultilingual(voices) {
    const fullLangList = _getFullLanguageList();

    return voices.map(voice => {
        if (voice.languageCodes.includes('*')) {
            return {
                ...voice,
                languageCodes: fullLangList,
                multilingual: true
            };
        }
        return voice;
    });
}

/**
 * Load a single catalog file
 * @private
 */
async function _loadCatalogFile(filename) {
    const filePath = path.join(CATALOGS_DIR, filename);
    const content = await fs.readFile(filePath, 'utf8');
    const catalog = JSON.parse(content);

    // Validate
    const error = validateCatalog(catalog);
    if (error) {
        throw new Error(`Invalid catalog ${filename}: ${error}`);
    }

    // Expand multilingual voices
    catalog.voices = _expandMultilingual(catalog.voices);

    // Add provider/family/tier to each voice if missing
    catalog.voices = catalog.voices.map(voice => ({
        provider: catalog.provider,
        family: catalog.family,
        tier: catalog.tier, // Use the tier directly from the catalog
        ...voice
    }));

    return catalog;
}

/**
 * Load all catalog files
 * @returns {Promise<object>} Map of tier -> catalog
 */
export async function loadAllCatalogs() {
    if (_catalogCache) {
        return _catalogCache;
    }

    console.log(`[CatalogLoader] Loading voice catalogs from: ${CATALOGS_DIR}`);

    const catalogs = {};

    // Load each catalog file
    const files = [
        { file: 'gemini_tts.json', key: 'gemini' },
        { file: 'google_chirp3_hd.json', key: 'chirp3_hd' },
        { file: 'google_neural2.json', key: 'neural2' },
        { file: 'google_standard.json', key: 'standard' },
        { file: 'google_studio.json', key: 'studio' },
        { file: 'elevenlabs_v3.json', key: 'elevenlabs_v3' },
        { file: 'elevenlabs_turbo.json', key: 'elevenlabs_turbo' },
        { file: 'elevenlabs_flash.json', key: 'elevenlabs_flash' },
        { file: 'elevenlabs_standard.json', key: 'elevenlabs_standard' }
    ];

    for (const { file, key } of files) {
        try {
            const catalog = await _loadCatalogFile(file);
            catalogs[key] = catalog;
            console.log(`[CatalogLoader] Loaded ${catalog.voices.length} voices from ${file}`);
        } catch (error) {
            console.error(`[CatalogLoader] Failed to load ${file} (skipping):`, error.message);
            // Do NOT re-throw, just skip this catalog
        }
    }

    _catalogCache = catalogs;

    console.log(`[CatalogLoader] Total catalogs loaded: ${Object.keys(catalogs).length}`);

    return catalogs;
}

/**
 * Get all voices from all catalogs
 * @returns {Promise<Array>} Array of all voice objects
 */
export async function getAllVoicesFromCatalogs() {
    const catalogs = await loadAllCatalogs();
    const allVoices = [];

    for (const catalog of Object.values(catalogs)) {
        allVoices.push(...catalog.voices);
    }

    return allVoices;
}

/**
 * Get unique list of supported languages from catalogs
 * @returns {Promise<string[]>} Array of language codes
 */
export async function getSupportedLanguagesFromCatalogs() {
    if (_allLanguages) {
        return _allLanguages;
    }

    const voices = await getAllVoicesFromCatalogs();
    const languages = new Set();

    for (const voice of voices) {
        for (const lang of voice.languageCodes) {
            languages.add(lang);
        }
    }

    _allLanguages = Array.from(languages).sort();
    return _allLanguages;
}

/**
 * Clear cache (for testing)
 */
export function clearCache() {
    _catalogCache = null;
    _allLanguages = null;
}
