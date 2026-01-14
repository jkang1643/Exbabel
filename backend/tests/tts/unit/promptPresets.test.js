/**
 * Unit Tests for Prompt Presets
 * 
 * Run with: node backend/tests/tts/unit/promptPresets.test.js
 */

import {
    PROMPT_PRESETS,
    PromptCategory,
    getPresetById,
    getPresetsByCategory,
    getPresetsGroupedByCategory
} from '../../../tts/promptPresets.js';

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

console.log('\n=== Testing PROMPT_PRESETS structure ===');
assert(Array.isArray(PROMPT_PRESETS), 'PROMPT_PRESETS should be an array');
assert(PROMPT_PRESETS.length >= 16, 'Should have at least 16 presets');

const firstPreset = PROMPT_PRESETS[0];
assert(!!firstPreset.id, 'Preset should have id');
assert(!!firstPreset.label, 'Preset should have label');
assert(!!firstPreset.prompt, 'Preset should have prompt');
assert(!!firstPreset.category, 'Preset should have category');

console.log('\n=== Testing getPresetById ===');
const preacher = getPresetById('preacher_warm_build');
assert(!!preacher, 'Should find preacher_warm_build');
assertEquals(preacher.id, 'preacher_warm_build', 'ID should match');

const nullPreset = getPresetById('non_existent');
assertEquals(nullPreset, null, 'Should return null for non-existent ID');

console.log('\n=== Testing getPresetsByCategory ===');
const generalPresets = getPresetsByCategory(PromptCategory.GENERAL);
assert(generalPresets.length > 0, 'Should have general presets');
assert(generalPresets.every(p => p.category === PromptCategory.GENERAL), 'All should be general');

const upciPresets = getPresetsByCategory(PromptCategory.UPCI_PENTECOSTAL);
assert(upciPresets.length > 0, 'Should have UPCI presets');
assert(upciPresets.every(p => p.category === PromptCategory.UPCI_PENTECOSTAL), 'All should be UPCI');

console.log('\n=== Testing getPresetsGroupedByCategory ===');
const grouped = getPresetsGroupedByCategory();
assert(!!grouped[PromptCategory.GENERAL], 'Should have general group');
assert(!!grouped[PromptCategory.UPCI_PENTECOSTAL], 'Should have UPCI group');
assertEquals(grouped[PromptCategory.GENERAL].length + grouped[PromptCategory.UPCI_PENTECOSTAL].length, PROMPT_PRESETS.length, 'Sum of groups should equal total presets');

// Summary
console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed === 0) {
    console.log('\n✓ All promptPresets tests passed!');
    process.exit(0);
} else {
    console.log('\n✗ Some promptPresets tests failed');
    process.exit(1);
}
