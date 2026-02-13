
import { resolveTtsRoute } from '../tts/ttsRouting.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Gemini Catalog to get all supported languages
const geminiCatalogPath = path.join(__dirname, '../tts/voiceCatalog/catalogs/gemini_tts.json');
const geminiVoices = JSON.parse(fs.readFileSync(geminiCatalogPath, 'utf8'));

// Extract all unique language codes supported by Gemini
const supportedLanguages = new Set();

// Access the 'voices' property of the parsed JSON object
if (geminiVoices.voices && Array.isArray(geminiVoices.voices)) {
    geminiVoices.voices.forEach(voice => {
        if (voice.languageCodes) {
            voice.languageCodes.forEach(code => supportedLanguages.add(code));
        }
    });
} else {
    console.error('ERROR: Invalid gemini_tts.json structure. Expected "voices" array.');
    process.exit(1);
}

// Add known problematic codes that should be normalized
const testLanguages = Array.from(supportedLanguages);

// Automatically generate incorrect 'xx-XX' codes for every language to catch issues like 'mai-MAI', 'am-AM'
// This simulates the frontend sending 'lang-LANG' instead of 'lang-REGION'
const potentialBadCodes = new Set();
supportedLanguages.forEach(code => {
    if (code.includes('-')) {
        const [lang, region] = code.split('-');
        const badCode = `${lang}-${lang.toUpperCase()}`;
        if (badCode !== code && !supportedLanguages.has(badCode)) {
            potentialBadCodes.add(badCode);
        }
    }
});

potentialBadCodes.forEach(code => testLanguages.push(code));

// Add specific known bad codes if not already covered
if (!testLanguages.includes('es-MX')) testLanguages.push('es-MX');

console.log(`🔍 Starting Comprehensive Routing Test for ${testLanguages.length} languages (including ${potentialBadCodes.size} potential invalid codes)...`);

let passed = 0;
let failed = 0;
const failures = [];

async function runTests() {
    for (const lang of testLanguages) {
        try {
            // Test Solo Mode (Generic 'gemini' tier request)
            const result = await resolveTtsRoute({
                languageCode: lang,
                requestedTier: 'gemini',
                mode: 'unary' // Solo mode uses unary/streaming but logic is similar
            });

            const isSuccess = result.tier === 'gemini' &&
                result.provider === 'google' &&
                (result.voiceName === 'Kore' || result.voiceName.includes('Gemini'));

            if (isSuccess) {
                // console.log(`✅ ${lang.padEnd(10)} -> ${result.voiceName} (${result.languageCode})`);
                passed++;
            } else {
                console.error(`❌ ${lang.padEnd(10)} -> FAILED. Got: ${result.tier} / ${result.voiceName}`);
                failures.push({ lang, result });
                failed++;
            }

        } catch (error) {
            console.error(`❌ ${lang.padEnd(10)} -> ERROR: ${error.message}`);
            failures.push({ lang, error: error.message });
            failed++;
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log(`Test Complete.`);
    console.log(`Total Languages: ${testLanguages.length}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log('='.repeat(50));

    if (failures.length > 0) {
        console.log('\nFailure Details:');
        failures.forEach(f => {
            console.log(`Language: ${f.lang}`);
            console.log(JSON.stringify(f.result || f.error, null, 2));
            console.log('-'.repeat(30));
        });
        process.exit(1);
    } else {
        console.log('\n🎉 All languages routed correctly to Gemini!');
        process.exit(0);
    }
}

runTests();
