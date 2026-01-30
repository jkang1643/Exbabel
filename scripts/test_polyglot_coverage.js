
import { getVoicesFor } from '../backend/tts/voiceCatalog/index.js';
import { loadAllCatalogs } from '../backend/tts/voiceCatalog/catalogLoader.js';

async function test() {
    console.log('🚀 Testing Polyglot Voice Coverage (ElevenLabs & Gemini)');
    await loadAllCatalogs();

    const check = async (regionCode, expectedProviders) => {
        console.log(`\nTesting request for: ${regionCode}...`);
        const voices = await getVoicesFor({
            languageCode: regionCode,
            allowedTiers: ['standard', 'neural2', 'chirp3_hd', 'gemini', 'elevenlabs_v3']
        });

        console.log(`Found ${voices.length} total voices.`);

        let pass = true;

        for (const provider of expectedProviders) {
            const providerVoices = voices.filter(v => v.provider === provider);
            if (providerVoices.length > 0) {
                console.log(`✅ Found ${providerVoices.length} voices for provider: ${provider}`);
                // Optional: print one name to be sure
                // console.log(`   Sample: ${providerVoices[0].voiceName}`);
            } else {
                console.log(`❌ MISSING voices for provider: ${provider}`);
                pass = false;
            }
        }

        return pass;
    };

    // Test 1: Spanish (Mexico) -> Should satisfy both Gemini (explicit es-MX) and ElevenLabs (generic es)
    const t1 = await check('es-MX', ['gemini', 'elevenlabs']);

    // Test 2: English (UK) -> Should satisfy both
    const t2 = await check('en-GB', ['gemini', 'elevenlabs']);

    // Test 3: Chinese (Simplified) -> Should satisfy both (ElevenLabs uses 'zh', Gemini uses 'cmn-CN' or 'zh-CN')
    // Note: Gemini uses 'cmn-CN' usually, let's see if our normalizer handles it or if the voice has the code.
    // Based on file view, Gemini has 'cmn-CN'. 
    // If request is 'zh-CN', normalize might convert.
    // Let's test what frontend sends. Frontend sends 'zh-CN' (LanguageSelector.jsx / languages.js).
    // VoiceCatalog normalize likely handles this.
    const t3 = await check('zh-CN', ['gemini', 'elevenlabs']);

    if (t1 && t2 && t3) {
        console.log('\n✅ ALL POLYGLOT TESTS PASSED');
    } else {
        console.log('\n❌ SOME TESTS FAILED');
        process.exit(1);
    }
}

test();
