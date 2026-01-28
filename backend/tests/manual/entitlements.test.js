/**
 * Entitlements Unit Tests
 * 
 * Tests for the entitlements module functions.
 * Run with: node --experimental-vm-modules tests/manual/entitlements.test.js
 */

import assert from 'assert';

// Mock entitlements for testing (without DB connection)
const mockEntitlements = {
    churchId: 'test-church-123',
    subscription: {
        status: 'active',
        currentPeriodStart: '2026-01-01T00:00:00Z',
        currentPeriodEnd: '2026-02-01T00:00:00Z',
        planCode: 'starter',
        planId: 'plan-uuid-123',
    },
    limits: {
        includedSecondsPerMonth: 3600,
        maxSessionSeconds: 7200,
        maxSimultaneousLanguages: 3,
        sttTier: 'standard',
        ttsTier: 'standard',
        featureFlags: { exports: true },
    },
    billing: {
        paygEnabled: false,
        paygRateCentsPerHour: 0,
        paygHardCapSeconds: null,
        allowOverageWhileLive: false,
    },
    routing: {
        chat: { provider: 'openai', model: 'gpt-4o-mini', params: {} },
        tts: { provider: 'google', model: 'neural2', params: {} },
    },
};

// Test resolveModel
console.log('\n=== Testing resolveModel ===');

import { resolveModel, CapabilityNotConfiguredError } from '../../entitlements/resolveModel.js';

// Test 1: resolveModel returns correct routing
console.log('Test 1: resolveModel returns correct routing for existing capability');
const chatRouting = resolveModel(mockEntitlements, 'chat');
assert.strictEqual(chatRouting.provider, 'openai');
assert.strictEqual(chatRouting.model, 'gpt-4o-mini');
console.log('  ✓ PASSED');

// Test 2: resolveModel throws on missing capability
console.log('Test 2: resolveModel throws on missing capability');
try {
    resolveModel(mockEntitlements, 'nonexistent');
    assert.fail('Expected CapabilityNotConfiguredError');
} catch (e) {
    assert(e instanceof CapabilityNotConfiguredError);
    assert.strictEqual(e.capability, 'nonexistent');
    assert.strictEqual(e.planCode, 'starter');
    console.log('  ✓ PASSED');
}

// Test assertEntitled functions
console.log('\n=== Testing assertEntitled ===');

import {
    assertSubscriptionActive,
    assertLanguageLimit,
    assertFeatureEnabled,
    assertRole,
    SubscriptionInactiveError,
    LanguageLimitExceededError,
    FeatureNotEnabledError,
    InsufficientRoleError,
} from '../../entitlements/assertEntitled.js';

// Test 3: assertSubscriptionActive allows active
console.log('Test 3: assertSubscriptionActive allows active status');
assertSubscriptionActive(mockEntitlements);
console.log('  ✓ PASSED');

// Test 4: assertSubscriptionActive blocks canceled
console.log('Test 4: assertSubscriptionActive blocks canceled status');
const canceledEntitlements = { ...mockEntitlements, subscription: { ...mockEntitlements.subscription, status: 'canceled' } };
try {
    assertSubscriptionActive(canceledEntitlements);
    assert.fail('Expected SubscriptionInactiveError');
} catch (e) {
    assert(e instanceof SubscriptionInactiveError);
    assert.strictEqual(e.status, 'canceled');
    console.log('  ✓ PASSED');
}

// Test 4b: assertSubscriptionActive blocks 'none' (missing subscription)
console.log('Test 4b: assertSubscriptionActive blocks none status (missing subscription)');
const noneEntitlements = { ...mockEntitlements, subscription: { ...mockEntitlements.subscription, status: 'none' } };
try {
    assertSubscriptionActive(noneEntitlements);
    assert.fail('Expected SubscriptionInactiveError');
} catch (e) {
    assert(e instanceof SubscriptionInactiveError);
    assert.strictEqual(e.status, 'none');
    console.log('  ✓ PASSED');
}

// Test 5: assertSubscriptionActive blocks past_due with 402
console.log('Test 5: assertSubscriptionActive blocks past_due with HTTP 402');
const pastDueEntitlements = { ...mockEntitlements, subscription: { ...mockEntitlements.subscription, status: 'past_due' } };
try {
    assertSubscriptionActive(pastDueEntitlements);
    assert.fail('Expected SubscriptionInactiveError');
} catch (e) {
    assert(e instanceof SubscriptionInactiveError);
    assert.strictEqual(e.httpStatus, 402);
    console.log('  ✓ PASSED');
}

// Test 6: assertLanguageLimit allows within limit
console.log('Test 6: assertLanguageLimit allows within limit');
assertLanguageLimit(mockEntitlements, 2);
console.log('  ✓ PASSED');

// Test 7: assertLanguageLimit blocks over limit
console.log('Test 7: assertLanguageLimit blocks over limit');
try {
    assertLanguageLimit(mockEntitlements, 5);
    assert.fail('Expected LanguageLimitExceededError');
} catch (e) {
    assert(e instanceof LanguageLimitExceededError);
    assert.strictEqual(e.requested, 5);
    assert.strictEqual(e.allowed, 3);
    console.log('  ✓ PASSED');
}

// Test 8: assertFeatureEnabled allows enabled feature
console.log('Test 8: assertFeatureEnabled allows enabled feature');
assertFeatureEnabled(mockEntitlements, 'exports');
console.log('  ✓ PASSED');

// Test 9: assertFeatureEnabled blocks disabled feature
console.log('Test 9: assertFeatureEnabled blocks disabled feature');
try {
    assertFeatureEnabled(mockEntitlements, 'premium_feature');
    assert.fail('Expected FeatureNotEnabledError');
} catch (e) {
    assert(e instanceof FeatureNotEnabledError);
    assert.strictEqual(e.featureName, 'premium_feature');
    console.log('  ✓ PASSED');
}

// Test 10: assertRole allows admin
console.log('Test 10: assertRole allows admin for admin requirement');
assertRole({ user_id: 'test', role: 'admin' }, 'admin');
console.log('  ✓ PASSED');

// Test 11: assertRole blocks member when admin required
console.log('Test 11: assertRole blocks member when admin required');
try {
    assertRole({ user_id: 'test', role: 'member' }, 'admin');
    assert.fail('Expected InsufficientRoleError');
} catch (e) {
    assert(e instanceof InsufficientRoleError);
    assert.strictEqual(e.requiredRole, 'admin');
    assert.strictEqual(e.actualRole, 'member');
    console.log('  ✓ PASSED');
}

console.log('\n=== All tests passed! ===\n');
