/**
 * Translation Worker Test
 *
 * Tests the actual translation worker to see why only Spanish translations succeed.
 */

import { realtimePartialTranslationWorker } from '../translationWorkersRealtime.js';

// Test individual language translations
async function testIndividualTranslations() {
    console.log('🧪 Testing Individual Language Translations...');

    const testText = 'Hello world, this is a test message.';
    const sourceLang = 'en';
    const targetLangs = ['es', 'fr', 'de', 'it', 'pt'];
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        console.error('❌ No OPENAI_API_KEY found in environment');
        return;
    }

    console.log(`📝 Testing translation from ${sourceLang} to multiple languages`);
    console.log(`📝 Text: "${testText}"`);

    for (const targetLang of targetLangs) {
        console.log(`\n--- Testing ${sourceLang} → ${targetLang} ---`);

        try {
            const startTime = Date.now();
            const result = await realtimePartialTranslationWorker.translatePartial(
                testText,
                sourceLang,
                targetLang,
                apiKey
            );
            const duration = Date.now() - startTime;

            console.log(`✅ SUCCESS (${duration}ms): "${result}"`);

            // Validate the result
            if (!result || result.trim().length === 0) {
                console.log(`⚠️ Empty result`);
            } else if (result.toLowerCase().includes('sorry') || result.toLowerCase().includes('apologize')) {
                console.log(`🚫 CONVERSATIONAL RESPONSE (not a translation)`);
            } else {
                console.log(`👍 Looks like a valid translation`);
            }

        } catch (error) {
            console.log(`❌ FAILED: ${error.message}`);
            if (error.code) {
                console.log(`   Error code: ${error.code}`);
            }
            if (error.conversational) {
                console.log(`   Type: Conversational response (not translation)`);
            }
            if (error.englishLeak) {
                console.log(`   Type: English leak detected`);
            }
        }

        // Clean up connections between tests to avoid interference
        realtimePartialTranslationWorker.closeConnectionsForLanguagePair(sourceLang, targetLang);
        await new Promise(resolve => setTimeout(resolve, 100)); // Brief pause
    }

    console.log('\n--- Individual Translation Test Complete ---');
}

// Test concurrent translations (like the real scenario)
async function testConcurrentTranslations() {
    console.log('\n🔄 Testing Concurrent Translations (like real scenario)...');

    const testText = 'This is a test message for concurrent translation.';
    const sourceLang = 'en';
    const targetLangs = ['es', 'fr', 'de'];
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        console.error('❌ No OPENAI_API_KEY found in environment');
        return;
    }

    console.log(`📝 Testing concurrent translation from ${sourceLang} to [${targetLangs.join(', ')}]`);
    console.log(`📝 Text: "${testText}"`);

    try {
        const startTime = Date.now();
        const results = await realtimePartialTranslationWorker.translateToMultipleLanguages(
            testText,
            sourceLang,
            targetLangs,
            apiKey
        );
        const duration = Date.now() - startTime;

        console.log(`🏁 Concurrent translation completed in ${duration}ms`);
        console.log(`📊 Results:`, results);

        const successfulLangs = Object.keys(results);
        const failedLangs = targetLangs.filter(lang => !results[lang]);

        console.log(`✅ Successful: [${successfulLangs.join(', ')}]`);
        console.log(`❌ Failed: [${failedLangs.join(', ')}]`);

        if (successfulLangs.length === 1 && successfulLangs[0] === 'es') {
            console.log(`🚨 CONFIRMED: Only Spanish succeeded in concurrent translation!`);
        }

        // Analyze each result
        for (const [lang, text] of Object.entries(results)) {
            if (!text || text.trim().length === 0) {
                console.log(`⚠️ ${lang}: Empty result`);
            } else if (text.toLowerCase().includes('sorry') || text.toLowerCase().includes('apologize')) {
                console.log(`🚫 ${lang}: Conversational response`);
            } else {
                console.log(`👍 ${lang}: Valid translation`);
            }
        }

    } catch (error) {
        console.log(`❌ Concurrent translation failed: ${error.message}`);
    }

    console.log('\n--- Concurrent Translation Test Complete ---');
}

// Test connection pooling behavior
async function testConnectionPooling() {
    console.log('\n🏊 Testing Connection Pooling Behavior...');

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error('❌ No OPENAI_API_KEY found');
        return;
    }

    // Test getting connections for different language pairs
    const languagePairs = [
        ['en', 'es'],
        ['en', 'fr'],
        ['en', 'de'],
        ['en', 'it']
    ];

    console.log('📝 Testing connection acquisition for different language pairs...');

    for (const [source, target] of languagePairs) {
        try {
            console.log(`--- Getting connection for ${source} → ${target} ---`);
            const startTime = Date.now();
            const session = await realtimePartialTranslationWorker.getConnection(source, target, apiKey);
            const duration = Date.now() - startTime;

            console.log(`✅ Connection acquired in ${duration}ms`);
            console.log(`   Connection key: ${session.connectionKey}`);
            console.log(`   Ready state: ${session.ws.readyState}`);
            console.log(`   Setup complete: ${session.setupComplete}`);

        } catch (error) {
            console.log(`❌ Failed to get connection for ${source} → ${target}: ${error.message}`);
        }
    }

    console.log('\n📊 Connection pool status:');
    console.log(`   Total connections: ${realtimePartialTranslationWorker.connectionPool.size}`);
    for (const [key, session] of realtimePartialTranslationWorker.connectionPool.entries()) {
        console.log(`   ${key}: readyState=${session.ws.readyState}, setup=${session.setupComplete}`);
    }

    // Clean up
    realtimePartialTranslationWorker.destroy();

    console.log('\n--- Connection Pooling Test Complete ---');
}

// Run tests
async function runAllTests() {
    console.log('🚀 Starting Translation Worker Diagnostic Tests...\n');

    await testIndividualTranslations();
    await testConcurrentTranslations();
    await testConnectionPooling();

    console.log('\n🎯 All tests completed. Check results above for the Spanish-only issue.');
}

// Handle script execution
if (process.argv[1] === new URL(import.meta.url).pathname) {
    runAllTests().catch(console.error);
}
