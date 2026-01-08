/**
 * Unit Tests for TTS Policy Enforcement
 * 
 * Run with: node ttsPolicy.test.js
 */

import { validateTtsRequest, checkOrgEnabled, resolveTierForUser, isVoiceAllowed } from '../ttsPolicy.js';

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

// Test 1: TTS disabled for org
console.log('\n=== Test 1: TTS disabled for organization ===');
process.env.TTS_ENABLED_DEFAULT = 'false';
const result1 = await validateTtsRequest({
    orgId: 'org1',
    userId: 'user1',
    tier: 'gemini',
    languageCode: 'en-US',
    voiceName: 'Kore'
});
assert(result1 !== null, 'Should return error when TTS disabled');
assertEquals(result1?.code, 'TTS_DISABLED', 'Should return TTS_DISABLED error code');

// Test 2: TTS enabled - valid request
console.log('\n=== Test 2: TTS enabled - valid request ===');
process.env.TTS_ENABLED_DEFAULT = 'true';
const result2 = await validateTtsRequest({
    orgId: 'org1',
    userId: 'user1',
    tier: 'gemini',
    languageCode: 'en-US',
    voiceName: 'Kore'
});
assert(result2 === null, 'Should return null for valid request');

// Test 3: Check org enabled
console.log('\n=== Test 3: Check org enabled ===');
process.env.TTS_ENABLED_DEFAULT = 'true';
const enabled = await checkOrgEnabled('org1');
assert(enabled === true, 'Should return true when TTS_ENABLED_DEFAULT is true');

process.env.TTS_ENABLED_DEFAULT = 'false';
const disabled = await checkOrgEnabled('org1');
assert(disabled === false, 'Should return false when TTS_ENABLED_DEFAULT is false');

// Test 4: Resolve tier for user
console.log('\n=== Test 4: Resolve tier for user ===');
const tiers = resolveTierForUser({}, {});
assert(Array.isArray(tiers), 'Should return array of tiers');
assert(tiers.includes('gemini'), 'Should include gemini tier');

// Test 5: Voice allowed validation
console.log('\n=== Test 5: Voice allowed validation ===');
const voiceAllowed1 = isVoiceAllowed('gemini', 'en-US', 'Kore');
assert(voiceAllowed1 === true, 'Should allow valid voice');

const voiceAllowed2 = isVoiceAllowed('', '', '');
assert(voiceAllowed2 === false, 'Should reject empty parameters');

const voiceAllowed3 = isVoiceAllowed('gemini', 'en-US', null);
assert(voiceAllowed3 === false, 'Should reject null voice name');

// Test 6: Tier not allowed (future test when tier validation is implemented)
console.log('\n=== Test 6: Tier validation (placeholder) ===');
// This will be tested in PR4 when tier validation is fully implemented
console.log('  (Skipped - tier validation not fully implemented in PR2)');

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
