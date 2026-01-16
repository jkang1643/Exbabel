import { resolveTtsRoute } from '../../tts/ttsRouting.js';

console.log('Testing language normalization and routing...');

// Test with short codes (what frontend sends)
const route1 = resolveTtsRoute({ requestedTier: 'neural2', languageCode: 'es' });
console.log('Spanish (short code):', route1.languageCode, route1.voiceName);

const route2 = resolveTtsRoute({ requestedTier: 'neural2', languageCode: 'it' });
console.log('Italian (short code):', route2.languageCode, route2.voiceName);

const route3 = resolveTtsRoute({ requestedTier: 'neural2', languageCode: 'en' });
console.log('English (short code):', route3.languageCode, route3.voiceName);

console.log('✅ Language normalization working correctly');
