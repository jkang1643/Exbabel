
import { resolveTtsRoute } from '../tts/ttsRouting.js';

async function testRouting() {
    console.log('Testing TTS Routing for Premium Languages...');

    const testCases = [
        { lang: 'sq-AL', tier: 'gemini', expectedVoice: 'Kore' },
        { lang: 'my-MM', tier: 'gemini', expectedVoice: 'Kore' },
        { lang: 'am-ET', tier: 'gemini', expectedVoice: 'Kore' },
        { lang: 'hy-AM', tier: 'gemini', expectedVoice: 'Kore' },
        { lang: 'es-US', tier: 'gemini', expectedVoice: 'Kore' } // Should fallback or pick default Gemini voice
    ];

    for (const test of testCases) {
        try {
            console.log(`\nTesting ${test.lang} with tier ${test.tier}...`);
            const result = await resolveTtsRoute({
                languageCode: test.lang,
                requestedTier: test.tier
            });

            console.log(`Result: Provider=${result.provider}, Tier=${result.tier}, Voice=${result.voiceName}`);

            if (result.tier === 'gemini' && result.provider === 'google') {
                if (test.expectedVoice && result.voiceName !== test.expectedVoice && !result.voiceName.includes('Gemini')) {
                    console.warn(`WARNING: Expected voice ${test.expectedVoice} but got ${result.voiceName}`);
                }
                console.log('✅ PASS');
            } else {
                console.error('❌ FAIL: Did not route to Gemini');
            }

        } catch (error) {
            console.error(`❌ ERROR: ${error.message}`);
        }
    }
}

testRouting();
