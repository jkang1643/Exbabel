npm run/**
 * Verification Test for MICRO-UTTERANCE MODE
 * 
 * Run with: node backend/tests/tts/unit/microUtterance.test.js
 */

import { resolvePrompt } from '../../../tts/../../tts/promptResolver.js';

// Test counter
let passed = 0;
let failed = 0;

function assertEquals(actual, expected, message) {
    if (actual === expected) {
        console.log(`✓ ${message}`);
        passed++;
    } else {
        console.error(`✗ ${message}`);
        console.error(`  Expected: ${expected}`);
        console.error(`  Actual:   ${actual}`);
        failed++;
    }
}

function assertContains(str, substring, message) {
    if (str && str.includes(substring)) {
        console.log(`✓ ${message}`);
        passed++;
    } else {
        console.error(`✗ ${message}`);
        console.error(`  String does not contain: ${substring}`);
        failed++;
    }
}

console.log('\n=== Testing Micro-Utterance Mode ===');

// 1. One word
const res1 = resolvePrompt({ text: 'Hello' });
assertContains(res1.prompt, 'MICRO-UTTERANCE MODE:', '1 word should trigger Micro-Utterance Mode');
assertContains(res1.prompt, '<say>Hello</say>', '1 word prompt should contain the text');

// 2. Two words
const res2 = resolvePrompt({ text: 'Good morning' });
assertContains(res2.prompt, 'MICRO-UTTERANCE MODE:', '2 words should trigger Micro-Utterance Mode');
assertContains(res2.prompt, '<say>Good morning</say>', '2 words prompt should contain the text');

// 3. Three words
const res3 = resolvePrompt({ text: 'How are you?' });
assertContains(res3.prompt, 'MICRO-UTTERANCE MODE:', '3 words should trigger Micro-Utterance Mode');
assertContains(res3.prompt, '<say>How are you?</say>', '3 words prompt should contain the text');

// 4. Eight words
const text8 = 'This is a test of the eight words';
const resThreshold = resolvePrompt({ text: text8 });
assertContains(resThreshold.prompt, 'MICRO-UTTERANCE MODE:', '8 words should trigger Micro-Utterance Mode');
assertContains(resThreshold.prompt, `<say>${text8}</say>`, '8 words prompt should contain the text');

// 5. Nine words (Should NOT trigger Micro-Utterance Mode)
const text9 = 'This is a test of the nine word limit now.';
const resSkiped = resolvePrompt({
    text: text9,
    customPrompt: 'Test core'
});
if (resSkiped.prompt && resSkiped.prompt.includes('MICRO-UTTERANCE MODE:')) {
    console.error('✗ 9 words should NOT trigger Micro-Utterance Mode');
    failed++;
} else {
    console.log('✓ 9 words correctly skipped Micro-Utterance Mode');
    passed++;
}
assertContains(resSkiped.prompt, 'Test core', 'Should use core prompt for 9+ words');

// 6. Combined Check (Micro-Utterance should INCLUDE preset/intensity)
const res5 = resolvePrompt({
    text: 'Hello',
    promptPresetId: 'preacher_warm_build',
    intensity: 5
});
assertContains(res5.prompt, 'MICRO-UTTERANCE MODE:', 'Includes Micro-Utterance Mode for short text');
assertContains(res5.prompt, 'STYLE ONLY.', 'Includes system instruction');
assertContains(res5.prompt, 'fiery urgency', 'Includes intensity modifier/preset style');
console.log('✓ Micro-Utterance correctly combined with style instructions');
passed++;

// Summary
console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed === 0) {
    process.exit(0);
} else {
    process.exit(1);
}
