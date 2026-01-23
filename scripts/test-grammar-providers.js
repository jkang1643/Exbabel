import { GrammarProviderFactory } from '../backend/providers/grammar/GrammarProviderFactory.js';
import { OpenAIGrammarProvider } from '../backend/providers/grammar/OpenAIGrammarProvider.js';
import { DummyGrammarProvider } from '../backend/providers/grammar/DummyGrammarProvider.js';

async function testProviders() {
    console.log('--- Testing Grammar Provider Factory ---');

    // Test 1: Create OpenAI Provider (Default)
    console.log('\nTest 1: Create OpenAI Provider');
    const openaiProvider = GrammarProviderFactory.createProvider('openai', { apiKey: 'test-key', model: 'gpt-4o-mini' });
    if (openaiProvider instanceof OpenAIGrammarProvider) {
        console.log('✅ PASS: Created OpenAIGrammarProvider');
        if (openaiProvider.model === 'gpt-4o-mini') {
            console.log('✅ PASS: Correct model configured');
        } else {
            console.error('❌ FAIL: Incorrect model:', openaiProvider.model);
        }
    } else {
        console.error('❌ FAIL: Did not create OpenAIGrammarProvider');
    }

    // Test 2: Create Dummy Provider
    console.log('\nTest 2: Create Dummy Provider');
    const dummyProvider = GrammarProviderFactory.createProvider('dummy');
    if (dummyProvider instanceof DummyGrammarProvider) {
        console.log('✅ PASS: Created DummyGrammarProvider');

        // Test functionality
        const result = await dummyProvider.correctFinal('Hello world');
        if (result === 'Hello world.') {
            console.log('✅ PASS: Dummy provider logic executed');
        } else {
            console.error('❌ FAIL: Dummy provider logic failed:', result);
        }
    } else {
        console.error('❌ FAIL: Did not create DummyGrammarProvider');
    }

    // Test 3: Unknown Provider (Fallback)
    console.log('\nTest 3: Unknown Provider Fallback');
    const unknownProvider = GrammarProviderFactory.createProvider('unknown_type');
    if (unknownProvider instanceof OpenAIGrammarProvider) {
        console.log('✅ PASS: Fallback to OpenAIGrammarProvider');
    } else {
        console.error('❌ FAIL: Did not fallback correctly');
    }

    console.log('\n--- Verification Complete ---');
}

testProviders().catch(console.error);
