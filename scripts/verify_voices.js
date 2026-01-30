
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import configurations directly (since we are in ESM mode)
import { TRANSCRIPTION_LANGUAGES } from '../frontend/src/config/languages.js';

// Read JSON files manually
const snapshotPath = path.join(__dirname, '../frontend/src/data/google-tts-voices.snapshot.json');
const ttsVoicesJsonPath = path.join(__dirname, '../frontend/src/config/ttsVoices.json');

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const ttsVoicesJson = JSON.parse(fs.readFileSync(ttsVoicesJsonPath, 'utf8'));

// Map for short codes to full codes (from frontend/src/config/ttsVoices.js logic)
const LOCALE_MAP = {
    'es': 'es-ES', 'en': 'en-US', 'fr': 'fr-FR', 'de': 'de-DE', 'it': 'it-IT',
    'pt': 'pt-BR', 'ja': 'ja-JP', 'ko': 'ko-KR', 'zh': 'cmn-CN', 'ar': 'ar-XA',
    'hi': 'hi-IN', 'ru': 'ru-RU', 'he': 'he-IL', 'nl': 'nl-NL', 'pl': 'pl-PL',
    'tr': 'tr-TR', 'cs': 'cs-CZ', 'da': 'da-DK', 'fi': 'fi-FI', 'el': 'el-GR',
    'hu': 'hu-HU', 'id': 'id-ID', 'ms': 'ms-MY', 'nb': 'nb-NO', 'ro': 'ro-RO',
    'sk': 'sk-SK', 'sv': 'sv-SE', 'th': 'th-TH', 'uk': 'uk-UA', 'vi': 'vi-VN',
    'bg': 'bg-BG', 'hr': 'hr-HR', 'lt': 'lt-LT', 'lv': 'lv-LV', 'sl': 'sl-SI',
    'sr': 'sr-RS', 'af': 'af-ZA', 'bn': 'bn-IN', 'ca': 'ca-ES', 'eu': 'eu-ES',
    'fil': 'fil-PH', 'gl': 'gl-ES', 'gu': 'gu-IN', 'is': 'is-IS', 'kn': 'kn-IN',
    'ml': 'ml-IN', 'mr': 'mr-IN', 'pa': 'pa-IN', 'ta': 'ta-IN', 'te': 'te-IN',
    'ur': 'ur-IN', 'cy': 'cy-GB', 'et': 'et-EE'
};

const normalizeCode = (code) => {
    if (code.includes('-')) return code;
    return LOCALE_MAP[code] || `${code}-${code.toUpperCase()}`;
};

console.log('--- Voice Availability Verification ---');
console.log(`Total Snapshot Languages: ${snapshot.languages.length}`);
console.log(`Total Snapshot Voices: ${snapshot.voices.length}`);
console.log(`Total Frontend Languages (Transcription): ${TRANSCRIPTION_LANGUAGES.length}`);

const report = {
    missingVoices: [],
    lowVoiceCount: [],
    tierGaps: []
};

TRANSCRIPTION_LANGUAGES.forEach(lang => {
    const normalized = normalizeCode(lang.code);

    // Check in ttsVoices.json (Frontend Config)
    const frontendVoices = ttsVoicesJson[normalized] || [];

    // Check in Snapshot (Official Google Data)
    const officialVoices = snapshot.voices.filter(v => v.languageCodes.includes(normalized));

    const status = {
        code: lang.code,
        normalized,
        name: lang.name,
        frontendCount: frontendVoices.length,
        officialCount: officialVoices.length,
        frontendTiers: [...new Set(frontendVoices.map(v => v.tier))],
        officialTiers: [...new Set(officialVoices.map(v => v.tier))]
    };

    if (frontendVoices.length === 0) {
        report.missingVoices.push(status);
    } else if (frontendVoices.length < 2) {
        report.lowVoiceCount.push(status);
    }

    // Check specifically for Neural2/Chirp availability mismatch
    const hasNeural2 = officialVoices.some(v => v.name.includes('Neural2'));
    const hasChirp = officialVoices.some(v => v.name.includes('Chirp'));

    if (hasNeural2 && !status.frontendTiers.includes('neural2')) {
        report.tierGaps.push({ ...status, missingTier: 'neural2' });
    }
    if (hasChirp && !status.frontendTiers.includes('chirp3_hd')) {
        report.tierGaps.push({ ...status, missingTier: 'chirp3_hd' });
    }

    // Japanese and Korean specific check
    if (lang.code === 'ja' || lang.code === 'ko') {
        console.log(`\nDetailed Check for ${lang.name} (${lang.code} -> ${normalized}):`);
        console.log(`- Frontend Voices: ${frontendVoices.length}`);
        console.log(`- Official Voices: ${officialVoices.length}`);
        console.log(`- Frontend Tiers: ${status.frontendTiers.join(', ')}`);
        console.log(`- Official Tiers: ${status.officialTiers.join(', ')}`);

        if (frontendVoices.length === 0) {
            console.error(`  [CRITICAL] No voices found in frontend config for ${lang.name}!`);
        }
    }
});

console.log('\n--- Summary Report ---');
console.log(`Languages with NO voices in frontend: ${report.missingVoices.length}`);
if (report.missingVoices.length > 0) {
    report.missingVoices.forEach(m => console.log(`  - ${m.name} (${m.code} -> ${m.normalized}): Official has ${m.officialCount} voices`));
}

console.log(`\nLanguages with Tier Gaps (Available in API but missing in Frontend): ${report.tierGaps.length}`);
if (report.tierGaps.length > 0) {
    report.tierGaps.forEach(g => console.log(`  - ${g.name} (${g.normalized}) missing ${g.missingTier}`));
}

// Verification Conclusion
if (report.missingVoices.some(v => v.code === 'ja' || v.code === 'ko')) {
    console.log('\n[FAILURE] Japanese or Korean voices are missing from frontend config.');
    process.exit(1);
} else {
    console.log('\n[SUCCESS] Japanese and Korean voices are present in frontend config.');
}
