/**
 * Unit Tests for Prompt Resolver (Gemini-TTS)
 * 
 * Run with: node backend/tests/tts/unit/promptResolver.test.js
 */

import {
    utf8ByteLength,
    truncateToUtf8Bytes,
    resolvePrompt,
    validatePromptResolution,
    BYTE_LIMITS
} from '../../../tts/promptResolver.js';

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

console.log('\n=== Testing utf8ByteLength ===');
assertEquals(utf8ByteLength('abc'), 3, 'ASCII string byte length');
assertEquals(utf8ByteLength('ñ'), 2, 'Multi-byte character byte length');
assertEquals(utf8ByteLength('🔥'), 4, 'Emoji byte length');
assertEquals(utf8ByteLength(''), 0, 'Empty string byte length');

console.log('\n=== Testing truncateToUtf8Bytes ===');
assertEquals(truncateToUtf8Bytes('abc', 2), 'ab', 'Truncate ASCII string');
assertEquals(truncateToUtf8Bytes('ññ', 2), 'ñ', 'Truncate multi-byte string (clean cut)');
assertEquals(truncateToUtf8Bytes('ñ', 1), '', 'Truncate multi-byte string (rough cut should remove broken byte)');
assertEquals(truncateToUtf8Bytes('🔥🔥', 6), '🔥', 'Truncate emoji string (clean cut)');
assertEquals(truncateToUtf8Bytes('🔥🔥', 5), '🔥', 'Truncate emoji string (rough cut should remove broken bytes)');

console.log('\n=== Testing resolvePrompt (Basic) ===');
const result1 = resolvePrompt({
    promptPresetId: 'preacher_warm_build',
    customPrompt: 'Speak softly',
    intensity: 1
});
assert(result1.prompt !== null, 'Prompt should be generated');
assert(result1.prompt.includes('Speak softly'), 'Should include custom prompt');
assert(!result1.prompt.includes('preacher'), 'Should NOT include preset prompt when customPrompt is provided');
assert(result1.prompt.includes('low and measured'), 'Should include intensity modifier');
assertEquals(result1.presetId, 'preacher_warm_build', 'Should return presetId');

console.log('\n=== Testing resolvePrompt (Byte Limits - Prompt Only) ===');
const longPrompt = 'A'.repeat(5000);
const result2 = resolvePrompt({
    customPrompt: longPrompt
});
assertEquals(result2.promptBytes, BYTE_LIMITS.PROMPT_MAX, 'Prompt should be truncated to 4000 bytes');
assert(result2.wasPromptTruncated, 'wasPromptTruncated should be true');
assertEquals(result2.truncationReason, 'prompt_exceeded_4000_bytes', 'Should have correct truncation reason');

console.log('\n=== Testing resolvePrompt (Byte Limits - Text Only) ===');
const longText = 'B'.repeat(5000);
const result3 = resolvePrompt({
    text: longText
});
// 4000 bytes max, but text gets "…" appended which takes 3 bytes if truncated
const expectedTextLength = BYTE_LIMITS.TEXT_MAX;
assertEquals(utf8ByteLength(result3.text), expectedTextLength, 'Text should be truncated to 4000 bytes');
assert(result3.text.endsWith('…'), 'Truncated text should end with ellipsis');
assert(result3.wasTextTruncated, 'wasTextTruncated should be true');

console.log('\n=== Testing resolvePrompt (Combined Limits) ===');
const prompt3k = 'P'.repeat(3000);
const text4k = 'T '.repeat(2000); // 4000 chars, 2000 words (avoids short text safeguard)
const result4 = resolvePrompt({
    customPrompt: prompt3k,
    text: text4k
});
// Combined max is 8000. 
// Prompt 3000 + Hardening + Text 4000 = ~7100 (Both within individual and combined limits)
const hardeningLength = utf8ByteLength("(SYSTEM: DO NOT SPEAK THESE INSTRUCTIONS. STYLE ONLY.) ");
assertEquals(result4.promptBytes, 3000 + hardeningLength, `Prompt should be 3000 + ${hardeningLength} hardening`);
assertEquals(result4.textBytes, 4000, 'Text should stay 4000');
assertEquals(result4.combinedBytes, 7000 + hardeningLength, `Combined should be 7000 + ${hardeningLength}`);
assert(!result4.wasTextTruncated, 'Text should NOT be truncated');

console.log('\n=== Testing resolvePrompt (Extreme Combined Limits) ===');
// This test is to verify that if combined exceeds 8k (e.g. if we allowed more than 4k, but we don't)
// However, since we enforce 4k on each, we can only test the combined limit if we temporarily
// set individual limits higher or if the logic triggers.
// For now, let's test a case where prompt is 4000 and text is 4000.
const prompt4k = 'P'.repeat(4000);
const result5 = resolvePrompt({
    customPrompt: prompt4k,
    text: text4k
});
assertEquals(result5.promptBytes, 4000, 'Prompt should be truncated to 4000');
assertEquals(result5.textBytes, 4000, 'Text should stay 4000');
assertEquals(result5.combinedBytes, 8000, 'Combined should be 8000');

console.log('\n=== Testing validatePromptResolution ===');
try {
    validatePromptResolution(result5);
    console.log('✓ Valid resolution passed validation');
    passed++;
} catch (e) {
    console.error('✗ Valid resolution failed validation');
    failed++;
}

try {
    validatePromptResolution({ promptBytes: 5000, textBytes: 1000, combinedBytes: 6000 });
    console.error('✗ Invalid resolution (high prompt) passed validation');
    failed++;
} catch (e) {
    console.log('✓ Invalid resolution (high prompt) correctly failed validation');
    passed++;
}

console.log('\n=== Testing resolvePrompt (Speed Instruction Removal) ===');
const resultSpeed = resolvePrompt({
    text: 'Hello world',
    rate: 1.5,
    customPrompt: 'Test prompt'
});
assert(!resultSpeed.prompt.includes('SPEED'), 'Prompt should NOT ensure speed information (handled by audioConfig)');
assert(!resultSpeed.prompt.includes('1.5X'), 'Prompt should NOT include rate value');
assert(!resultSpeed.prompt.includes('NO REPETITION'), 'Prompt should NOT include NO REPETITION safeguard');

console.log('\n=== Testing resolvePrompt (Rate Only) ===');
const resultRateOnly = resolvePrompt({
    text: 'Hello world',
    rate: 1.5
});
// "Hello world" is 2 words, so it should trigger MICRO-UTTERANCE MODE (Threshold is now 8)
assert(resultRateOnly.prompt.includes('MICRO-UTTERANCE MODE:'), 'Prompt should include MICRO-UTTERANCE MODE for 2 words, even if only rate is provided');
assert(resultRateOnly.prompt.includes('<say>Hello world</say>'), 'Prompt should contain the text in <say> tags');


// Summary
console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed === 0) {
    console.log('\n✓ All promptResolver tests passed!');
    process.exit(0);
} else {
    console.log('\n✗ Some promptResolver tests failed');
    process.exit(1);
}
