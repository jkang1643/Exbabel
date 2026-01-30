
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import configurations
import { TRANSCRIPTION_LANGUAGES, TRANSLATION_LANGUAGES } from '../frontend/src/config/languages.js';
import { getVoicesForLanguage, normalizeLanguageCode } from '../frontend/src/config/ttsVoices.js';

console.log('--- Comprehensive 190-Language Voice Availability Audit ---');

// 1. Aggregate all unique languages (Using Proven Logic)
const uniqueCodes = new Set();
const langDetails = new Map();

const registerLang = (l, source) => {
    if (l && l.code) {
        uniqueCodes.add(l.code);
        if (!langDetails.has(l.code)) {
            langDetails.set(l.code, { ...l, sources: [source] });
        } else {
            langDetails.get(l.code).sources.push(source);
        }
    }
};

TRANSCRIPTION_LANGUAGES.forEach(l => registerLang(l, 'transcription'));
TRANSLATION_LANGUAGES.forEach(l => registerLang(l, 'translation'));

const sortedCodes = Array.from(uniqueCodes).sort();

console.log(`Total Unique Languages Found: ${sortedCodes.length}`);
console.log(`(Should be ~190 based on debug audit)`);

// 2. Audit each language
const results = {
    hasVoices: [],
    noVoices: [],
    errors: []
};

sortedCodes.forEach(code => {
    const lang = langDetails.get(code);
    const normalized = normalizeLanguageCode(code);

    try {
        const voices = getVoicesForLanguage(code);

        const result = {
            code,
            normalized,
            name: lang.name,
            voiceCount: voices ? voices.length : 0,
            tiers: voices ? [...new Set(voices.map(v => v.tier))] : []
        };

        if (Array.isArray(voices)) {
            if (voices.length > 0) {
                results.hasVoices.push(result);
            } else {
                results.noVoices.push(result);
            }
        } else {
            throw new Error(`getVoicesForLanguage returned non-array: ${typeof voices}`);
        }

    } catch (err) {
        results.errors.push({
            code,
            name: lang.name,
            error: err.message
        });
    }
});

// 3. Report Generation
console.log('\n--- Audit Results ---');
console.log(`✅ Languages WITH Voices: ${results.hasVoices.length}`);
console.log(`⚠️  Languages WITHOUT Voices (Empty List): ${results.noVoices.length}`);
console.log(`❌ Languages with ERRORS: ${results.errors.length}`);

if (results.errors.length > 0) {
    console.log('\n[ERRORS DETECTED]');
    results.errors.forEach(e => console.error(`  - ${e.name} (${e.code}): ${e.error}`));
}

if (results.noVoices.length > 0) {
    console.log('\n[Languages Correctly Returning Empty List (No TTS Support)]');
    // Listing all for completeness as requested
    results.noVoices.forEach(l => {
        console.log(`  - ${l.name} (${l.code}) -> ${l.normalized}: []`);
    });
}

// console.log('\n[Languages WITH Voices] (Summary)');
// results.hasVoices.forEach(l => {
//    console.log(`  - ${l.name} (${l.code}) -> ${l.normalized}: ${l.voiceCount} voices`);
// });

// 4. Verification Check
if (results.errors.length === 0) {
    console.log('\n[SUCCESS] All languages processed gracefully.');

    // Check specific known requirements
    const japanese = results.hasVoices.find(r => r.code === 'ja');
    const korean = results.hasVoices.find(r => r.code === 'ko');

    if (japanese && korean) {
        console.log('[SUCCESS] Japanese and Korean specifically verified as having voices.');
    } else {
        console.error('[FAILURE] Japanese or Korean missing from "Has Voices" list!');
        process.exit(1);
    }
} else {
    console.error('\n[FAILURE] Errors encountered during language audit.');
    process.exit(1);
}
