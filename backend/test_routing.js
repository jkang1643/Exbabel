import { resolveTtsRoute } from './tts/ttsRouting.js';

console.log('Testing routing resolver...');

// Test 1: Spanish neural2
const route1 = resolveTtsRoute({ requestedTier: 'neural2', languageCode: 'es-ES' });
console.log('Spanish neural2:', JSON.stringify(route1, null, 2));

// Test 2: Gemini for English (should work)
const route2 = resolveTtsRoute({ requestedTier: 'gemini', languageCode: 'en-US' });
console.log('English gemini:', JSON.stringify(route2, null, 2));

// Test 3: Gemini for Spanish (should fallback)
const route3 = resolveTtsRoute({ requestedTier: 'gemini', languageCode: 'es-ES' });
console.log('Spanish gemini (fallback):', JSON.stringify(route3, null, 2));

console.log('Routing resolver tests completed successfully!');
