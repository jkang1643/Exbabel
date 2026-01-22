/**
 * Unit Tests for Voice Resolver
 * 
 * Run with: node backend/tests/unit/tts/voiceResolver.test.js
 */

import { resolveVoice } from '../../../tts/voiceResolver.js';
import { setOrgVoiceDefault } from '../../../tts/defaults/defaultsStore.js';

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

console.log('=== Voice Resolver Tests ===\n');

// Test 1: Catalog default (no user pref, no org default)
console.log('Test 1: Catalog default');
const result1 = await resolveVoice({
    orgId: 'test-org-1',
    userPref: null,
    languageCode: 'en-US',
    allowedTiers: ['gemini', 'chirp3_hd']
});
assertEquals(result1.tier, 'gemini', 'Should use Gemini tier (catalog default)');
assertEquals(result1.voiceName, 'Kore', 'Should use Kore voice (catalog default)');
assertEquals(result1.reason, 'catalog_default', 'Reason should be catalog_default');

// Test 2: User preference overrides catalog default
console.log('\nTest 2: User preference');
const result2 = await resolveVoice({
    orgId: 'test-org-2',
    userPref: { tier: 'gemini', voiceName: 'Puck' },
    languageCode: 'en-US',
    allowedTiers: ['gemini', 'chirp3_hd']
});
assertEquals(result2.tier, 'gemini', 'Should use user preference tier');
assertEquals(result2.voiceName, 'Puck', 'Should use user preference voice');
assertEquals(result2.reason, 'user_preference', 'Reason should be user_preference');

// Test 3: Org default overrides catalog default
console.log('\nTest 3: Org default');
const testOrgId = 'test-org-3';
await setOrgVoiceDefault(testOrgId, 'en-US', 'chirp3_hd', 'en-US-Chirp3-HD-Puck');

const result3 = await resolveVoice({
    orgId: testOrgId,
    userPref: null,
    languageCode: 'en-US',
    allowedTiers: ['gemini', 'chirp3_hd']
});
assertEquals(result3.tier, 'chirp3_hd', 'Should use org default tier');
assertEquals(result3.voiceName, 'en-US-Chirp3-HD-Puck', 'Should use org default voice');
assertEquals(result3.reason, 'org_default', 'Reason should be org_default');

// Test 4: User preference overrides org default
console.log('\nTest 4: User preference overrides org default');
const result4 = await resolveVoice({
    orgId: testOrgId, // Has org default set
    userPref: { tier: 'gemini', voiceName: 'Charon' },
    languageCode: 'en-US',
    allowedTiers: ['gemini', 'chirp3_hd']
});
assertEquals(result4.tier, 'gemini', 'User pref should override org default (tier)');
assertEquals(result4.voiceName, 'Charon', 'User pref should override org default (voice)');
assertEquals(result4.reason, 'user_preference', 'Reason should be user_preference');

// Test 5: Invalid user preference falls back to org default
console.log('\nTest 5: Invalid user preference fallback');
const result5 = await resolveVoice({
    orgId: testOrgId,
    userPref: { tier: 'gemini', voiceName: 'InvalidVoice' },
    languageCode: 'en-US',
    allowedTiers: ['gemini', 'chirp3_hd']
});
assertEquals(result5.tier, 'chirp3_hd', 'Should fall back to org default tier');
assertEquals(result5.voiceName, 'en-US-Chirp3-HD-Puck', 'Should fall back to org default voice');
assertEquals(result5.reason, 'org_default', 'Reason should be org_default');

// Test 6: Disallowed tier falls back
console.log('\nTest 6: Disallowed tier fallback');
const result6 = await resolveVoice({
    orgId: 'test-org-6',
    userPref: { tier: 'gemini', voiceName: 'Kore' },
    languageCode: 'en-US',
    allowedTiers: ['chirp3_hd'] // Gemini not allowed
});
assertEquals(result6.tier, 'chirp3_hd', 'Should fall back to allowed tier');
assert(result6.voiceName.startsWith('en-US-Chirp3-HD-'), 'Should use Chirp3-HD voice');
assertEquals(result6.reason, 'catalog_default', 'Reason should be catalog_default');

// Test 7: Chirp3-HD only tier selection
console.log('\nTest 7: Chirp3-HD only');
const result7 = await resolveVoice({
    orgId: 'test-org-7',
    userPref: null,
    languageCode: 'es-ES',
    allowedTiers: ['chirp3_hd']
});
assertEquals(result7.tier, 'chirp3_hd', 'Should use Chirp3-HD when Gemini not allowed');
assert(result7.voiceName.startsWith('es-ES-Chirp3-HD-'), 'Should use Spanish Chirp3-HD voice');

// Test 8: Fallback for language with no voices in allowed tiers
console.log('\nTest 8: Fallback to English');
const result8 = await resolveVoice({
    orgId: 'test-org-8',
    userPref: null,
    languageCode: 'xx-XX', // Non-existent language
    allowedTiers: ['gemini', 'chirp3_hd']
});
assertEquals(result8.tier, 'gemini', 'Should fall back to Gemini');
assertEquals(result8.voiceName, 'Kore', 'Should fall back to Kore');
assertEquals(result8.reason, 'fallback_english', 'Reason should be fallback_english');

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
