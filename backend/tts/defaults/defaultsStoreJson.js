/**
 * TTS Defaults Store - JSON File Implementation
 * 
 * Stores org voice defaults in a JSON file with atomic read/write operations.
 * File: backend/config/ttsDefaults.json
 * 
 * Structure:
 * {
 *   "org123": {
 *     "en-US": { "tier": "gemini", "voiceName": "Kore" },
 *     "es-ES": { "tier": "chirp3_hd", "voiceName": "es-ES-Chirp3-HD-Leda" }
 *   }
 * }
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { isVoiceValid } from '../voiceCatalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULTS_FILE = path.join(__dirname, '../../config/ttsDefaults.json');

/**
 * Read defaults file with error handling
 * @private
 * @returns {Promise<object>} Defaults object
 */
async function readDefaults() {
    try {
        const data = await fs.readFile(DEFAULTS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        // File doesn't exist or is invalid - return empty object
        if (error.code === 'ENOENT') {
            return {};
        }
        console.error('[DefaultsStoreJson] Failed to read defaults file:', error);
        return {};
    }
}

/**
 * Write defaults file atomically
 * @private
 * @param {object} defaults - Defaults object to write
 */
async function writeDefaults(defaults) {
    try {
        // Ensure directory exists
        const dir = path.dirname(DEFAULTS_FILE);
        await fs.mkdir(dir, { recursive: true });

        // Write atomically using temp file + rename
        const tempFile = `${DEFAULTS_FILE}.tmp`;
        await fs.writeFile(tempFile, JSON.stringify(defaults, null, 2), 'utf-8');
        await fs.rename(tempFile, DEFAULTS_FILE);
    } catch (error) {
        console.error('[DefaultsStoreJson] Failed to write defaults file:', error);
        throw new Error(`Failed to write defaults: ${error.message}`);
    }
}

/**
 * Get org voice defaults for all languages
 * @param {string} orgId - Organization ID
 * @returns {Promise<object>} Defaults by language { [languageCode]: { tier, voiceName } }
 */
export async function getOrgVoiceDefaults(orgId) {
    const defaults = await readDefaults();
    return defaults[orgId] || {};
}

/**
 * Set org voice default for a specific language
 * @param {string} orgId - Organization ID
 * @param {string} languageCode - BCP-47 language code
 * @param {string} tier - Tier name
 * @param {string} voiceName - Voice name
 * @throws {Error} If voice is invalid
 */
export async function setOrgVoiceDefault(orgId, languageCode, tier, voiceName) {
    // Validate voice before saving
    if (!isVoiceValid({ voiceName, languageCode, tier })) {
        throw new Error(`Invalid voice: ${voiceName} for ${languageCode}:${tier}`);
    }

    // Read current defaults
    const defaults = await readDefaults();

    // Initialize org defaults if needed
    if (!defaults[orgId]) {
        defaults[orgId] = {};
    }

    // Set the default
    defaults[orgId][languageCode] = { tier, voiceName };

    // Write back atomically
    await writeDefaults(defaults);

    console.log(`[DefaultsStoreJson] Set default for ${orgId}/${languageCode}: ${tier}/${voiceName}`);
}
