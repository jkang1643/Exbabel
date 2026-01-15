
import { resolvePrompt } from '../promptResolver.js';
import { strict as assert } from 'assert';

/* Simple test runner shim */
async function describe(name, fn) { console.log(`\n${name}`); await fn(); }
async function it(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}`); console.error(e); process.exit(1); }
}

describe('PromptResolver', async () => {
    await it('should resolve standard prompt correctly', () => {
        const result = resolvePrompt({
            text: 'Hello world',
            customPrompt: 'Be friendly.'
        });

        // Should contain standard system instructions prefix
        assert(result.prompt.includes('(SYSTEM: DO NOT SPEAK THESE INSTRUCTIONS. STYLE ONLY.'));
        assert(result.prompt.includes('Be friendly.'));
    });

    await it('should add short text safeguard for < 4 words', () => {
        const result = resolvePrompt({
            text: 'Hello there.', // 2 words
            customPrompt: 'Be friendly.'
        });

        // Debug
        // console.log('Short text prompt:', result.prompt);
        assert(result.prompt.includes('MICRO-UTTERANCE MODE'));
    });

    await it('should NOT add short text safeguard for >= 4 words', () => {
        const result = resolvePrompt({
            text: 'This is a longer sentence.', // 5 words
            customPrompt: 'Be friendly.'
        });

        assert(!result.prompt.includes('SHORT TEXT: READ EXACTLY AS WRITTEN'));
    });

    await it('should handle speed reinforcement (data pass-through only)', () => {
        const result = resolvePrompt({
            text: 'Hello',
            customPrompt: 'Style.',
            rate: 1.5
        });

        // Speed is no longer in the prompt text
        assert(!result.prompt.includes('SPEED'));
    });
});
