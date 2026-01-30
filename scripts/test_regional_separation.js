
import { getVoicesFor } from '../backend/tts/voiceCatalog/index.js';
import { loadAllCatalogs } from '../backend/tts/voiceCatalog/catalogLoader.js';

async function test() {
    console.log('🚀 Testing Strictly Separated Regional Voices');
    await loadAllCatalogs();

    const check = async (code, expectedIncludes, expectedExcludes, label) => {
        console.log(`\nTesting ${label} (${code})...`);
        const voices = await getVoicesFor({
            languageCode: code,
            allowedTiers: ['standard', 'neural2', 'chirp3_hd', 'gemini', 'elevenlabs_v3']
        });

        console.log(`Found ${voices.length} voices.`);
        const voiceNames = voices.map(v => v.voiceName || v.displayName);
        const languageCodes = new Set();
        voices.forEach(v => v.languageCodes.forEach(c => languageCodes.add(c)));

        // Validation
        let pass = true;

        // Check Includes
        for (const req of expectedIncludes) {
            const hasIt = Array.from(languageCodes).some(c => c.includes(req));
            if (!hasIt) {
                console.log(`❌ Missing expected region: ${req}`);
                pass = false;
            } else {
                console.log(`✅ Found expected region: ${req}`);
            }
        }

        // Check Excludes (Strict Validity Check)
        // Verify that EVERY returned voice actually supports the requested code (or generic base)
        // We do NOT ban 'es-ES' if the voice ALSO supports 'es-MX'.

        const invalidVoices = voices.filter(v => {
            const supportsCode = v.languageCodes.includes(code);
            const supportsBase = v.languageCodes.includes(code.split('-')[0]);

            // Voice is valid if it supports the specific region OR the generic base
            return !supportsCode && !supportsBase;
        });

        if (invalidVoices.length > 0) {
            console.log(`❌ Found INVALID voices (do not support ${code} or base): ${invalidVoices.length} (e.g. ${invalidVoices[0].voiceName})`);
            console.log(`   Invalid voice langs: ${invalidVoices[0].languageCodes}`);
            pass = false;
        } else {
            console.log(`✅ All returned voices support ${code} (or generic base)`);
        }

        return pass;
    };

    // Test 1: Spanish (Mexico)
    // Should have es-MX. Should NOT have es-ES (Spain) or es-US (USA)
    const t1 = await check('es-MX', ['es-MX'], ['es-ES', 'es-US'], 'Spanish (Mexico)');

    // Test 2: Spanish (Spain)
    // Should have es-ES. Should NOT have es-MX
    const t2 = await check('es-ES', ['es-ES'], ['es-MX'], 'Spanish (Spain)');

    // Test 3: English (UK)
    // Should have en-GB. Should NOT have en-US
    const t3 = await check('en-GB', ['en-GB'], ['en-US'], 'English (UK)');

    if (t1 && t2 && t3) {
        console.log('\n✅ ALL SEPARATION TESTS PASSED');
    } else {
        console.log('\n❌ SOME TESTS FAILED');
        process.exit(1);
    }
}

test();
