/**
 * Unit Tests for TTS Policy Enforcement
 * 
 * Run with: node ttsPolicy.test.js
 */

import { validateTtsRequest, checkOrgEnabled, resolveEnginesForUser, isVoiceAllowed } from '../../../tts/../../tts/ttsPolicy.js';
import { TtsEngine } from '../../../tts/../../tts/tts.types.js';

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
    profile: {
        engine: TtsEngine.GEMINI_TTS,
        languageCode: 'en-US',
        voiceName: 'Kore',
        modelName: 'gemini-2.5-flash-tts',
        encoding: 'MP3',
        streaming: false
    }
});
assert(result1 !== null, 'Should return error when TTS disabled');
assertEquals(result1?.code, 'TTS_DISABLED', 'Should return TTS_DISABLED error code');

// Test 2: TTS enabled - valid request
console.log('\n=== Test 2: TTS enabled - valid request ===');
process.env.TTS_ENABLED_DEFAULT = 'true';
const result2 = await validateTtsRequest({
    orgId: 'org1',
    userId: 'user1',
    profile: {
        engine: TtsEngine.GEMINI_TTS,
        languageCode: 'en-US',
        voiceName: 'Kore',
        modelName: 'gemini-2.5-flash-tts',
        encoding: 'MP3',
        streaming: false
    }
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

// Test 4: Resolve engines for user
console.log('\n=== Test 4: Resolve engines for user ===');
const engines = resolveEnginesForUser({}, {});
assert(Array.isArray(engines), 'Should return array of engines');
assert(engines.includes(TtsEngine.GEMINI_TTS), 'Should include gemini_tts engine');

// Test 5: Voice allowed validation
console.log('\n=== Test 5: Voice allowed validation ===');
const voiceAllowed1 = isVoiceAllowed(TtsEngine.GEMINI_TTS, 'en-US', 'Kore');
assert(voiceAllowed1 === true, 'Should allow valid voice');

const voiceAllowed2 = isVoiceAllowed('', '', '');
assert(voiceAllowed2 === false, 'Should reject empty parameters');

const voiceAllowed3 = isVoiceAllowed(TtsEngine.GEMINI_TTS, 'en-US', null);
assert(voiceAllowed3 === false, 'Should reject null voice name');

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
