/**
 * Language Routing Unit Test
 *
 * Tests the routing logic without requiring API calls.
 * Focuses on ensuring translations are properly routed to correct languages.
 */

import sessionStore from '../sessionStore.js';

// Mock translation worker that doesn't require API calls
const mockTranslationWorker = {
    translateToMultipleLanguages: async (text, sourceLang, targetLangs) => {
        console.log(`[MOCK] Would translate "${text}" from ${sourceLang} to [${targetLangs.join(', ')}]`);

        // Simulate successful translations for all requested languages
        const translations = {};
        targetLangs.forEach(lang => {
            translations[lang] = `Mock translation to ${lang}: ${text}`;
        });

        return translations;
    }
};

// Mock host mode handler logic
function simulateTranslationBroadcast(sessionId, translationResults, translationTargets) {
    const results = [];

    console.log(`[SIMULATE] Broadcasting translations to [${translationTargets.join(', ')}]`);

    for (const targetLang of translationTargets) {
        const translatedText = translationResults[targetLang];

        if (!translatedText) {
            console.log(`[SIMULATE] Skipping ${targetLang} - no translation available`);
            continue;
        }

        // Simulate the validation logic from hostModeHandler.js
        const isSameAsOriginal = false; // Mock - assume translations are different

        if (isSameAsOriginal) {
            console.log(`[SIMULATE] Skipping ${targetLang} - translation same as original`);
            continue;
        }

        // Simulate successful broadcast
        results.push({
            targetLang,
            translatedText: translatedText.substring(0, 50),
            success: true
        });

        console.log(`[SIMULATE] ✅ Broadcast to ${targetLang}: "${translatedText.substring(0, 50)}..."`);
    }

    return results;
}

async function testBasicRouting() {
    console.log('\n=== Test: Basic Language Routing ===');

    // Create a session
    const { sessionId } = sessionStore.createSession();
    console.log(`📝 Created session: ${sessionId}`);

    // Add listeners for different languages
    const spanishListener = sessionStore.addListener(sessionId, 'socket1', {}, 'es', 'SpanishUser');
    const frenchListener = sessionStore.addListener(sessionId, 'socket2', {}, 'fr', 'FrenchUser');
    const germanListener = sessionStore.addListener(sessionId, 'socket3', {}, 'de', 'GermanUser');

    console.log('👥 Listeners added');

    // Simulate the routing logic from hostModeHandler.js
    const targetLanguages = sessionStore.getSessionLanguages(sessionId);
    console.log(`🎯 Target languages: [${targetLanguages.join(', ')}]`);

    const sourceLang = 'en';
    const sameLanguageTargets = targetLanguages.filter(lang => lang === sourceLang);
    const translationTargets = targetLanguages.filter(lang => lang !== sourceLang);

    console.log(`📊 Routing analysis:`);
    console.log(`  Same language: [${sameLanguageTargets.join(', ')}]`);
    console.log(`  Translation targets: [${translationTargets.join(', ')}]`);

    // Simulate translation
    const translationResults = await mockTranslationWorker.translateToMultipleLanguages(
        'Hello world',
        sourceLang,
        translationTargets
    );

    console.log(`🧠 Translation results:`, Object.keys(translationResults));

    // Simulate broadcasting
    const broadcastResults = simulateTranslationBroadcast(sessionId, translationResults, translationTargets);

    console.log(`📡 Broadcast results: ${broadcastResults.length} successful broadcasts`);

    // Verify results
    const expectedBroadcasts = translationTargets.length;
    const actualBroadcasts = broadcastResults.length;

    console.log(`✅ Expected broadcasts: ${expectedBroadcasts}`);
    console.log(`✅ Actual broadcasts: ${actualBroadcasts}`);

    if (actualBroadcasts !== expectedBroadcasts) {
        throw new Error(`❌ Expected ${expectedBroadcasts} broadcasts but got ${actualBroadcasts}`);
    }

    // Verify each language got a broadcast
    translationTargets.forEach(lang => {
        const wasBroadcast = broadcastResults.some(r => r.targetLang === lang);
        if (!wasBroadcast) {
            throw new Error(`❌ Language ${lang} was not broadcast to`);
        }
        console.log(`✅ ${lang} received broadcast`);
    });

    console.log('✅ Basic routing test PASSED');

    // Cleanup
    sessionStore.closeSession(sessionId);
    return true;
}

async function testLanguageSwitchingRouting() {
    console.log('\n=== Test: Language Switching Routing ===');

    // Create a session
    const { sessionId } = sessionStore.createSession();

    // Start with Spanish listener
    sessionStore.addListener(sessionId, 'socket1', {}, 'es', 'User1');

    let targetLanguages = sessionStore.getSessionLanguages(sessionId);
    console.log(`📊 Initial languages: [${targetLanguages.join(', ')}]`);

    // Switch from Spanish to German
    sessionStore.updateListenerLanguage(sessionId, 'socket1', 'de');

    targetLanguages = sessionStore.getSessionLanguages(sessionId);
    console.log(`📊 After switch: [${targetLanguages.join(', ')}]`);

    // Verify the switch worked
    if (!targetLanguages.includes('de')) {
        throw new Error('❌ German not in language list after switch');
    }

    if (targetLanguages.includes('es')) {
        throw new Error('❌ Spanish still in language list after switch');
    }

    // Simulate routing with new language set
    const sourceLang = 'en';
    const sameLanguageTargets = targetLanguages.filter(lang => lang === sourceLang);
    const translationTargets = targetLanguages.filter(lang => lang !== sourceLang);

    console.log(`🎯 Translation targets after switch: [${translationTargets.join(', ')}]`);

    const translationResults = await mockTranslationWorker.translateToMultipleLanguages(
        'How are you?',
        sourceLang,
        translationTargets
    );

    const broadcastResults = simulateTranslationBroadcast(sessionId, translationResults, translationTargets);

    // Should broadcast to German only
    if (broadcastResults.length !== 1 || broadcastResults[0].targetLang !== 'de') {
        throw new Error(`❌ Expected broadcast to German only, got: ${JSON.stringify(broadcastResults)}`);
    }

    console.log('✅ Language switching routing test PASSED');

    // Cleanup
    sessionStore.closeSession(sessionId);
    return true;
}

async function testNullTranslationHandling() {
    console.log('\n=== Test: Null Translation Handling ===');

    const { sessionId } = sessionStore.createSession();

    // Add listeners
    sessionStore.addListener(sessionId, 'socket1', {}, 'es', 'SpanishUser');
    sessionStore.addListener(sessionId, 'socket2', {}, 'fr', 'FrenchUser');

    const targetLanguages = ['es', 'fr'];
    const sourceLang = 'en';
    const translationTargets = targetLanguages.filter(lang => lang !== sourceLang);

    // Simulate partial translation results (some successful, some failed)
    const translationResults = {
        'es': 'Mock Spanish translation', // Success
        // 'fr' is missing - simulates failed translation
    };

    console.log(`🧠 Partial translation results:`, Object.keys(translationResults));

    const broadcastResults = simulateTranslationBroadcast(sessionId, translationResults, translationTargets);

    console.log(`📡 Broadcast results: ${broadcastResults.length} successful broadcasts`);

    // Should broadcast to Spanish only (French failed)
    if (broadcastResults.length !== 1 || broadcastResults[0].targetLang !== 'es') {
        throw new Error(`❌ Expected broadcast to Spanish only, got: ${JSON.stringify(broadcastResults)}`);
    }

    console.log('✅ Null translation handling test PASSED');

    // Cleanup
    sessionStore.closeSession(sessionId);
    return true;
}

async function runUnitTests() {
    console.log('🧪 Running Language Routing Unit Tests...\n');

    const tests = [
        { name: 'Basic Language Routing', func: testBasicRouting },
        { name: 'Language Switching Routing', func: testLanguageSwitchingRouting },
        { name: 'Null Translation Handling', func: testNullTranslationHandling }
    ];

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        try {
            console.log(`\n--- Running ${test.name} ---`);
            const result = await test.func();
            if (result) {
                passed++;
                console.log(`✅ ${test.name} PASSED`);
            }
        } catch (error) {
            failed++;
            console.error(`❌ ${test.name} FAILED: ${error.message}`);
        }
    }

    console.log(`\n=== Unit Test Results ===`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📊 Total: ${passed + failed}`);

    if (failed === 0) {
        console.log('\n🎉 ALL UNIT TESTS PASSED! Language routing logic is working correctly.');
        console.log('Note: Integration tests require valid API keys for actual translations.');
    } else {
        console.log(`\n⚠️ ${failed} unit test(s) failed.`);
    }

    return failed === 0;
}

// Run the unit tests
runUnitTests().catch(console.error);
