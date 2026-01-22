/**
 * Gemini Docs-Based Inventory Collector
 * 
 * Since Gemini doesn't have a stable voice list endpoint,
 * we maintain a static source file based on documentation
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_VOICES_PATH = path.join(__dirname, '../sources/gemini_voices.json');

/**
 * Generate stable voiceId for Gemini
 * @private
 */
function _generateVoiceId(voiceName) {
    return `gemini:gemini_tts:-:${voiceName}`;
}

/**
 * Fetch Gemini inventory from static source file
 * @returns {Promise<object>} Inventory snapshot
 */
export async function fetchGeminiInventory() {
    console.log('[GeminiDocs] Loading voice inventory from static source...');

    const content = await fs.readFile(GEMINI_VOICES_PATH, 'utf8');
    const sourceData = JSON.parse(content);

    const voices = sourceData.voices.map(voice => {
        return {
            voiceId: _generateVoiceId(voice.voiceName),
            provider: 'gemini',
            family: 'gemini_tts',
            voiceName: voice.voiceName,
            displayName: voice.displayName,
            languageCodes: voice.languageCodes,
            model: voice.model
        };
    });

    const snapshot = {
        fetchedAt: new Date().toISOString(),
        providerKey: 'gemini',
        voices,
        source: 'static_docs'
    };

    console.log(`[GeminiDocs] Loaded ${voices.length} voices from static source`);

    return snapshot;
}
