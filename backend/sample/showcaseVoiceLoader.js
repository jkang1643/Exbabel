/**
 * Showcase Voice Loader
 * 
 * Loads ALL voices from inventory snapshots for the showcase.
 * This is separate from the curated catalog used by the main app.
 * The showcase demonstrates every tier and all available voices.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache for loaded voices
let cachedVoices = null;
let cachedLanguages = null;

/**
 * Load all voices from inventory snapshots
 * @returns {Promise<Array>} All voices from all providers
 */
export async function loadShowcaseVoices() {
    if (cachedVoices) {
        return cachedVoices;
    }

    const voices = [];
    const snapshotDir = path.join(__dirname, '../tts/inventory/snapshots');
    const catalogDir = path.join(__dirname, '../tts/voiceCatalog/catalogs');

    // 1. Load Google Cloud TTS voices from inventory snapshot
    const googleSnapshotPath = path.join(snapshotDir, 'google_cloud_tts/2026-01-22.json');
    if (fs.existsSync(googleSnapshotPath)) {
        const snapshot = JSON.parse(fs.readFileSync(googleSnapshotPath, 'utf8'));

        // Filter and map interesting families
        const relevantFamilies = ['standard', 'neural2', 'chirp3_hd', 'studio'];
        const googleVoices = snapshot.voices
            .filter(v => relevantFamilies.includes(v.family))
            .map(v => ({
                ...v,
                tier: v.family // tier maps 1:1 with family for Google
            }));

        voices.push(...googleVoices);
        console.log(`[ShowcaseVoiceLoader] Loaded ${googleVoices.length} Google voices from inventory`);
    } else {
        console.warn('[ShowcaseVoiceLoader] Google snapshot not found, falling back to catalogs');
        // Fallback to catalogs if snapshot missing
        const googleCatalogs = [
            'google_chirp3_hd.json',
            'google_neural2.json',
            'google_standard.json',
            'google_studio.json'
        ];

        for (const catalogFile of googleCatalogs) {
            const catalogPath = path.join(catalogDir, catalogFile);
            if (fs.existsSync(catalogPath)) {
                const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
                const catalogTier = catalog.tier;
                voices.push(...catalog.voices.map(v => ({ ...v, tier: v.tier || catalogTier })));
            }
        }
    }

    // 2. Load Gemini voices from inventory snapshot
    const geminiSnapshotPath = path.join(snapshotDir, 'gemini/2026-01-22.json');
    if (fs.existsSync(geminiSnapshotPath)) {
        const snapshot = JSON.parse(fs.readFileSync(geminiSnapshotPath, 'utf8'));

        // Map gemini_tts family to 'gemini' tier
        const geminiVoices = snapshot.voices.map(v => ({
            ...v,
            tier: 'gemini'
        }));

        voices.push(...geminiVoices);
        console.log(`[ShowcaseVoiceLoader] Loaded ${geminiVoices.length} Gemini voices from inventory`);
    } else {
        console.warn('[ShowcaseVoiceLoader] Gemini snapshot not found, falling back to catalog');
        const catalogPath = path.join(catalogDir, 'gemini_tts.json');
        if (fs.existsSync(catalogPath)) {
            const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
            voices.push(...catalog.voices.map(v => ({ ...v, tier: 'gemini' })));
        }
    }

    // 3. Load ElevenLabs voices from inventory snapshot (has ALL voices including custom)
    const elevenLabsSnapshotPath = path.join(snapshotDir, 'elevenlabs/2026-01-22.json');

    if (fs.existsSync(elevenLabsSnapshotPath)) {
        const snapshot = JSON.parse(fs.readFileSync(elevenLabsSnapshotPath, 'utf8'));

        // Add all voices from snapshot, mapping 'family' to 'tier' for consistency
        const voicesWithTier = snapshot.voices.map(voice => ({
            ...voice,
            tier: voice.tier || voice.family // Use tier if exists, else use family
        }));
        voices.push(...voicesWithTier);

        console.log(`[ShowcaseVoiceLoader] Loaded ${voicesWithTier.length} ElevenLabs voices from inventory`);
    } else {
        console.warn('[ShowcaseVoiceLoader] ElevenLabs snapshot not found, falling back to catalogs');

        // Fallback to catalogs if snapshot doesn't exist
        const elevenLabsCatalogs = [
            'elevenlabs_v3.json',
            'elevenlabs_turbo.json',
            'elevenlabs_flash.json',
            'elevenlabs_standard.json'
        ];

        for (const catalogFile of elevenLabsCatalogs) {
            const catalogPath = path.join(catalogDir, catalogFile);
            if (fs.existsSync(catalogPath)) {
                const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
                const catalogTier = catalog.tier;
                const voicesWithTier = catalog.voices.map(voice => ({
                    ...voice,
                    tier: voice.tier || catalogTier
                }));
                voices.push(...voicesWithTier);
            }
        }
    }

    cachedVoices = voices;
    console.log(`[ShowcaseVoiceLoader] Total voices loaded: ${voices.length}`);

    return voices;
}

/**
 * Get voices filtered by language and tier
 * @param {object} params
 * @param {string} params.languageCode - Language code
 * @param {string[]} params.allowedTiers - Allowed tiers
 * @returns {Promise<Array>} Filtered voices
 */
export async function getShowcaseVoicesFor({ languageCode, allowedTiers }) {
    const allVoices = await loadShowcaseVoices();

    // Normalize language code
    const normalized = languageCode.toLowerCase();

    return allVoices.filter(voice => {
        // Check tier
        if (!allowedTiers.includes(voice.tier)) return false;

        // Check language support
        if (voice.multilingual) return true;

        // Exact match
        if (voice.languageCodes.some(lang => lang.toLowerCase() === normalized)) return true;

        // Base language match
        const baseCode = normalized.split('-')[0];

        return voice.languageCodes.some(lang => {
            const langLower = lang.toLowerCase();
            // Voice has "en", request "en-US" -> Match
            if (langLower === baseCode) return true;
            // Voice has "en-US", request "en" -> Match
            if (langLower.startsWith(baseCode + '-')) return true;
            return false;
        });
    });
}

/**
 * Get all supported languages from showcase voices
 * @param {object} [params]
 * @param {string[]} [params.allowedTiers] - Optional tier filter
 * @returns {Promise<string[]>} Language codes
 */
export async function getShowcaseSupportedLanguages({ allowedTiers } = {}) {
    const allVoices = await loadShowcaseVoices();
    const languages = new Set();

    for (const voice of allVoices) {
        if (allowedTiers && !allowedTiers.includes(voice.tier)) continue;

        for (const lang of voice.languageCodes) {
            languages.add(lang);
        }
    }

    return Array.from(languages).sort();
}

/**
 * Clear cache (useful for testing or if snapshots are updated)
 */
export function clearShowcaseCache() {
    cachedVoices = null;
    cachedLanguages = null;
}
