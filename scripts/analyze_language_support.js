
import { TRANSLATION_LANGUAGES } from '../frontend/src/config/languages.js';
import {
    isGoogleTierSupported,
    isGeminiSupported,
    isElevenLabsSupported
} from '../frontend/src/config/languageSupportData.js';

console.log(`Total Translation Languages: ${TRANSLATION_LANGUAGES.length}`);

let standardCount = 0;
let premiumOnlyCount = 0;
let noTtsCount = 0;

console.log('\n--- Premium Only Languages (Should be ~30) ---');
for (const lang of TRANSLATION_LANGUAGES) {
    const code = lang.code;
    const isStandard = isGoogleTierSupported(code, 'standard');
    const isPremium = isGeminiSupported(code) || isElevenLabsSupported(code, 'elevenlabs_v3');

    if (isStandard) {
        standardCount++;
    } else if (isPremium) {
        premiumOnlyCount++;
        console.log(`- ${lang.name} (${code})`);
    } else {
        noTtsCount++;
    }
}

console.log('\n--- Summary ---');
console.log(`Standard TTS (🔊): ${standardCount} (Target ~60)`);
console.log(`Premium Only (🔊⭐): ${premiumOnlyCount} (Target ~30)`);
console.log(`No TTS: ${noTtsCount}`);
console.log(`Total with TTS: ${standardCount + premiumOnlyCount}`);
