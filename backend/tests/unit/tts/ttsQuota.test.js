/**
 * Unit Tests for TTS Quota Enforcement
 * 
 * Run with: node ttsQuota.test.js
 */

import { canSynthesize, resetSessionQuota, getSessionQuota } from '../../../tts/ttsQuota.js';

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

// Test 1: No limit configured - should allow all
console.log('\n=== Test 1: No quota limit configured ===');
delete process.env.TTS_MAX_CHARS_PER_SESSION;
const result1 = canSynthesize({
    orgId: 'org1',
    userId: 'user1',
    sessionId: 'session1',
    characters: 1000000
});
assert(result1.allowed, 'Should allow synthesis when no limit configured');

// Test 2: Under limit - should allow
console.log('\n=== Test 2: Under quota limit ===');
process.env.TTS_MAX_CHARS_PER_SESSION = '1000';
resetSessionQuota('session2');
const result2 = canSynthesize({
    orgId: 'org1',
    userId: 'user1',
    sessionId: 'session2',
    characters: 500
});
assert(result2.allowed, 'Should allow synthesis when under limit');

// Test 3: Exactly at limit - should allow
console.log('\n=== Test 3: Exactly at quota limit ===');
const result3 = canSynthesize({
    orgId: 'org1',
    userId: 'user1',
    sessionId: 'session2',
    characters: 500
});
assert(result3.allowed, 'Should allow synthesis when exactly at limit');

// Test 4: Over limit - should block
console.log('\n=== Test 4: Over quota limit ===');
const result4 = canSynthesize({
    orgId: 'org1',
    userId: 'user1',
    sessionId: 'session2',
    characters: 100
});
assert(!result4.allowed, 'Should block synthesis when over limit');
assert(result4.error !== undefined, 'Should return error object when blocked');
assertEquals(result4.error.code, 'TTS_QUOTA_EXCEEDED', 'Should return TTS_QUOTA_EXCEEDED error code');

// Test 5: Per-session tracking
console.log('\n=== Test 5: Per-session tracking ===');
resetSessionQuota('session3');
resetSessionQuota('session4');
canSynthesize({
    orgId: 'org1',
    userId: 'user1',
    sessionId: 'session3',
    characters: 800
});
const result5 = canSynthesize({
    orgId: 'org1',
    userId: 'user1',
    sessionId: 'session4',
    characters: 800
});
assert(result5.allowed, 'Different sessions should have independent quotas');

// Test 6: Get session quota
console.log('\n=== Test 6: Get session quota ===');
const quota = getSessionQuota('session3');
assertEquals(quota.characters, 800, 'Should track character usage correctly');
assertEquals(quota.limit, 1000, 'Should return configured limit');

// Test 7: Reset session quota
console.log('\n=== Test 7: Reset session quota ===');
resetSessionQuota('session3');
const quotaAfterReset = getSessionQuota('session3');
assertEquals(quotaAfterReset.characters, 0, 'Should reset character count to 0');

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
