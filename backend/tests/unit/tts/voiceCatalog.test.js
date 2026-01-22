/**
 * Unit Tests for Voice Catalog
 * 
 * Run with: node backend/tests/unit/tts/voiceCatalog.test.js
 */

import {
    getAllVoices,
    getVoicesFor,
    isVoiceValid,
    getDefaultVoice,
    toGoogleVoiceSelection
} from '../../../tts/voiceCatalog.js';

// Test counter
let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`✓ ${message}`);
        passed++;
    } else {
        console.error(`✗ ${message}`);
        failed++;
    }
}

function assertEquals(actual, expected, message) {
    if (actual === expected) {
        console.log(`✓ ${message}`);
        passed++;
    } else {
        console.error(`✗ ${message} (expected: ${expected}, got: ${actual})`);
        failed++;
    }
}

console.log('=== Voice Catalog Tests ===\n');

// Test 1: getAllVoices returns voices
console.log('Test 1: getAllVoices');
const allVoices = getAllVoices();
assert(allVoices.length > 0, 'Should return voices');
assert(allVoices.some(v => v.tier === 'gemini'), 'Should include Gemini voices');
assert(allVoices.some(v => v.tier === 'chirp3_hd'), 'Should include Chirp3-HD voices');

// Test 2: getVoicesFor filters by language
console.log('\nTest 2: Filter by language');
const enUSVoices = getVoicesFor({ languageCode: 'en-US', allowedTiers: ['gemini', 'chirp3_hd'] });
assert(enUSVoices.length > 0, 'Should return en-US voices');
assert(enUSVoices.every(v => v.languageCodes.includes('en-US')), 'All voices should support en-US');

const esESVoices = getVoicesFor({ languageCode: 'es-ES', allowedTiers: ['gemini', 'chirp3_hd'] });
assert(esESVoices.length > 0, 'Should return es-ES voices');
assert(esESVoices.every(v => v.languageCodes.includes('es-ES')), 'All voices should support es-ES');

// Test 3: getVoicesFor filters by tier
console.log('\nTest 3: Filter by tier');
const geminiOnly = getVoicesFor({ languageCode: 'en-US', allowedTiers: ['gemini'] });
assert(geminiOnly.length > 0, 'Should return Gemini voices');
assert(geminiOnly.every(v => v.tier === 'gemini'), 'All voices should be Gemini tier');

const chirpOnly = getVoicesFor({ languageCode: 'en-US', allowedTiers: ['chirp3_hd'] });
assert(chirpOnly.length > 0, 'Should return Chirp3-HD voices');
assert(chirpOnly.every(v => v.tier === 'chirp3_hd'), 'All voices should be Chirp3-HD tier');

const both = getVoicesFor({ languageCode: 'en-US', allowedTiers: ['gemini', 'chirp3_hd'] });
assert(both.length > geminiOnly.length, 'Combined should have more voices than single tier');

// Test 4: isVoiceValid
console.log('\nTest 4: Voice validation');
assert(isVoiceValid({ voiceName: 'Kore', languageCode: 'en-US', tier: 'gemini' }),
    'Kore should be valid for en-US Gemini');
assert(isVoiceValid({ voiceName: 'en-US-Chirp3-HD-Kore', languageCode: 'en-US', tier: 'chirp3_hd' }),
    'en-US-Chirp3-HD-Kore should be valid for en-US Chirp3-HD');
assert(!isVoiceValid({ voiceName: 'InvalidVoice', languageCode: 'en-US', tier: 'gemini' }),
    'Invalid voice should return false');
assert(!isVoiceValid({ voiceName: 'Kore', languageCode: 'en-US', tier: 'chirp3_hd' }),
    'Gemini voice name should be invalid for Chirp3-HD tier');

// Test 5: getDefaultVoice
console.log('\nTest 5: Default voice selection');
const enDefault = getDefaultVoice({ languageCode: 'en-US', allowedTiers: ['gemini', 'chirp3_hd'] });
assertEquals(enDefault.tier, 'gemini', 'Should prefer Gemini tier for en-US');
assertEquals(enDefault.voiceName, 'Kore', 'Should default to Kore voice');

const chirpDefault = getDefaultVoice({ languageCode: 'en-US', allowedTiers: ['chirp3_hd'] });
assertEquals(chirpDefault.tier, 'chirp3_hd', 'Should use Chirp3-HD when Gemini not allowed');
assert(chirpDefault.voiceName.startsWith('en-US-Chirp3-HD-'), 'Should return Chirp3-HD voice name');

// Test 6: toGoogleVoiceSelection
console.log('\nTest 6: Google TTS API request builder');
const geminiRequest = toGoogleVoiceSelection({ tier: 'gemini', languageCode: 'en-US', voiceName: 'Kore' });
assertEquals(geminiRequest.voice.name, 'Kore', 'Should set voice name');
assertEquals(geminiRequest.voice.languageCode, 'en-US', 'Should set language code');
assertEquals(geminiRequest.voice.modelName, 'gemini-2.5-flash-tts', 'Should set Gemini model');

const chirpRequest = toGoogleVoiceSelection({ tier: 'chirp3_hd', languageCode: 'en-US', voiceName: 'en-US-Chirp3-HD-Kore' });
assertEquals(chirpRequest.voice.name, 'en-US-Chirp3-HD-Kore', 'Should set Chirp voice name');
assertEquals(chirpRequest.voice.modelName, 'chirp-3-hd', 'Should set Chirp3-HD model');

// Test 7: Multi-language support
console.log('\nTest 7: Multi-language support');
const languages = ['en-US', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP', 'cmn-CN'];
languages.forEach(lang => {
    const voices = getVoicesFor({ languageCode: lang, allowedTiers: ['gemini', 'chirp3_hd'] });
    assert(voices.length > 0, `Should have voices for ${lang}`);
});

// Summary
console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed === 0) {
    console.log('\n✓ All tests passed!');
    process.exit(0);
} else {
    console.log('\n✗ Some tests failed');
    process.exit(1);
}
