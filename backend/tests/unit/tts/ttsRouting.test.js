/**
 * Unit Tests for TTS Routing - Gemini Voice Resolution
 * 
 * Run with: node tests/unit/tts/ttsRouting.test.js
 */

import { resolveTtsRoute } from '../../../tts/ttsRouting.js';

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

// Test 1: Gemini voices with gemini- prefix
console.log('\n=== Test 1: Gemini voices with gemini- prefix ===');

const route1 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'gemini-Kore',
    languageCode: 'en-US'
});
assertEquals(route1.voiceName, 'Kore', 'gemini-Kore should route to Kore');
assertEquals(route1.tier, 'gemini', 'Tier should be gemini');

const route2 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'gemini-Charon',
    languageCode: 'en-US'
});
assertEquals(route2.voiceName, 'Charon', 'gemini-Charon should route to Charon');

const route3 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'gemini-Leda',
    languageCode: 'es-ES'
});
assertEquals(route3.voiceName, 'Leda', 'gemini-Leda should route to Leda');

const route4 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'gemini-Puck',
    languageCode: 'fr-FR'
});
assertEquals(route4.voiceName, 'Puck', 'gemini-Puck should route to Puck');

const route5 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'gemini-Aoede',
    languageCode: 'de-DE'
});
assertEquals(route5.voiceName, 'Aoede', 'gemini-Aoede should route to Aoede');

const route6 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'gemini-Fenrir',
    languageCode: 'ja-JP'
});
assertEquals(route6.voiceName, 'Fenrir', 'gemini-Fenrir should route to Fenrir');

// Test 2: Gemini voices without prefix (backwards compatibility)
console.log('\n=== Test 2: Gemini voices without prefix (backwards compatibility) ===');

const route7 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'Kore',
    languageCode: 'en-US'
});
assertEquals(route7.voiceName, 'Kore', 'Bare Kore should route to Kore');

const route8 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'Charon',
    languageCode: 'en-US'
});
assertEquals(route8.voiceName, 'Charon', 'Bare Charon should route to Charon');

// Test 3: Invalid Gemini voice names (fallback to Kore)
console.log('\n=== Test 3: Invalid Gemini voice names (fallback to Kore) ===');

const route9 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'gemini-InvalidVoice',
    languageCode: 'en-US'
});
assertEquals(route9.voiceName, 'Kore', 'Invalid gemini- prefixed voice should fallback to Kore');

const route10 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'InvalidVoice',
    languageCode: 'en-US'
});
assertEquals(route10.voiceName, 'Kore', 'Invalid bare voice should fallback to Kore');

const route11 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: null,
    languageCode: 'en-US'
});
assertEquals(route11.voiceName, 'Kore', 'Null voice should fallback to Kore');

// Test 4: Non-Gemini tiers (regression prevention)
console.log('\n=== Test 4: Non-Gemini tiers (regression prevention) ===');

const route12 = await resolveTtsRoute({
    requestedTier: 'chirp3_hd',
    requestedVoice: 'en-US-Chirp3-HD-Kore',
    languageCode: 'en-US'
});
assertEquals(route12.voiceName, 'en-US-Chirp3-HD-Kore', 'Chirp3 HD voice should route correctly');
assertEquals(route12.tier, 'chirp3_hd', 'Tier should be chirp3_hd');

const route13 = await resolveTtsRoute({
    requestedTier: 'neural2',
    requestedVoice: 'es-ES-Neural2-A',
    languageCode: 'es-ES'
});
assertEquals(route13.voiceName, 'es-ES-Neural2-A', 'Neural2 voice should route correctly');
assertEquals(route13.tier, 'neural2', 'Tier should be neural2');

const route14 = await resolveTtsRoute({
    requestedTier: 'standard',
    requestedVoice: 'fr-FR-Standard-A',
    languageCode: 'fr-FR'
});
assertEquals(route14.voiceName, 'fr-FR-Standard-A', 'Standard voice should route correctly');
assertEquals(route14.tier, 'standard', 'Tier should be standard');

// Test 5: Language-specific Gemini routing
console.log('\n=== Test 5: Language-specific Gemini routing ===');

const route15 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'gemini-Leda',
    languageCode: 'es'
});
assertEquals(route15.voiceName, 'Leda', 'Spanish Gemini voice should route correctly');
assertEquals(route15.languageCode, 'es-ES', 'Language code should be normalized to es-ES');

const route16 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'gemini-Puck',
    languageCode: 'ja'
});
assertEquals(route16.voiceName, 'Puck', 'Japanese Gemini voice should route correctly');
assertEquals(route16.languageCode, 'ja-JP', 'Language code should be normalized to ja-JP');

const route17 = await resolveTtsRoute({
    requestedTier: 'gemini',
    requestedVoice: 'gemini-Aoede',
    languageCode: 'zh'
});
assertEquals(route17.voiceName, 'Aoede', 'Chinese Gemini voice should route correctly');
assertEquals(route17.languageCode, 'cmn-CN', 'Language code should be normalized to cmn-CN');

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
