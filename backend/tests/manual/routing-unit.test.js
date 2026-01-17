/**
 * Language Routing Unit Test
 *
 * This test isolates the routing logic to identify why only Spanish (es) receives translations.
 * It mocks the translation workers and focuses on the routing/broadcasting logic.
 */

import sessionStore from '../../sessionStore.js';

// Mock translation workers to avoid actual API calls
const mockTranslationWorker = {
    translateToMultipleLanguages: async (text, sourceLang, targetLangs, apiKey, sessionId) => {
        console.log(`[MOCK] Translating "${text}" from ${sourceLang} to [${targetLangs.join(', ')}]`);

        const translations = {};

        // Simulate the actual logic: only translate languages different from source
        const langsToTranslate = targetLangs.filter(lang => lang !== sourceLang);

        // Mock successful translations for all languages
        // But let's test if the issue is here - maybe only Spanish "succeeds"
        for (const lang of langsToTranslate) {
            if (lang === 'es') {
                // Spanish always "succeeds"
                translations[lang] = `Translated to Spanish: ${text}`;
                console.log(`[MOCK] ✅ Translated to ${lang}`);
            } else {
                // Other languages "fail" - this might be the bug!
                console.log(`[MOCK] ❌ Failed to translate to ${lang}`);
                // translations[lang] remains undefined
            }
        }

        console.log(`[MOCK] Returning translations:`, Object.keys(translations));
        return translations;
    }
};

// Test the routing logic directly
async function testRoutingLogic() {
    console.log('🧪 Testing Language Routing Logic...');

    // Create a test session
    const { sessionId } = sessionStore.createSession();
    console.log(`📝 Created test session: ${sessionId}`);

    // Simulate different scenarios
    const scenarios = [
        {
            name: 'English source → Multiple targets including Spanish',
            sourceLang: 'en',
            targetLangs: ['es', 'fr', 'de', 'it'],
            expectedTranslations: ['es', 'fr', 'de', 'it'] // All should get translations
        },
        {
            name: 'Spanish source → Multiple targets including Spanish',
            sourceLang: 'es',
            targetLangs: ['es', 'fr', 'de', 'it'],
            expectedTranslations: ['fr', 'de', 'it'] // Only non-source languages should get translations
        },
        {
            name: 'French source → Multiple targets including Spanish',
            sourceLang: 'fr',
            targetLangs: ['es', 'fr', 'de', 'it'],
            expectedTranslations: ['es', 'de', 'it'] // All except source should get translations
        }
    ];

    for (const scenario of scenarios) {
        console.log(`\n--- ${scenario.name} ---`);
        console.log(`Source: ${scenario.sourceLang}`);
        console.log(`Targets: [${scenario.targetLangs.join(', ')}]`);
        console.log(`Expected translations: [${scenario.expectedTranslations.join(', ')}]`);

        // Simulate the logic from hostModeHandler.js
        const targetLanguages = scenario.targetLangs;
        const currentSourceLang = scenario.sourceLang;

        // This is the key logic from the handler
        const sameLanguageTargets = targetLanguages.filter(lang => lang === currentSourceLang);
        const translationTargets = targetLanguages.filter(lang => lang !== currentSourceLang);

        console.log(`📊 Routing analysis:`);
        console.log(`  sameLanguageTargets (no translation needed): [${sameLanguageTargets.join(', ')}]`);
        console.log(`  translationTargets (need translation): [${translationTargets.join(', ')}]`);

        // Simulate calling translateToMultipleLanguages
        const translations = await mockTranslationWorker.translateToMultipleLanguages(
            'Test message',
            currentSourceLang,
            translationTargets, // This is what gets passed to translation
            'mock-api-key',
            sessionId
        );

        console.log(`📨 Translation results:`, Object.keys(translations));

        // Check what would be broadcast
        const broadcastTargets = [];
        const noTranslationTargets = [];

        // Same language targets get original text (transcription only)
        for (const targetLang of sameLanguageTargets) {
            broadcastTargets.push(`${targetLang} (transcription)`);
        }

        // Translation targets get translated text if available
        for (const targetLang of translationTargets) {
            if (translations[targetLang]) {
                broadcastTargets.push(`${targetLang} (translated)`);
            } else {
                noTranslationTargets.push(targetLang);
                broadcastTargets.push(`${targetLang} (no translation)`);
            }
        }

        console.log(`📡 Broadcast results:`);
        console.log(`  ✅ Translated: [${broadcastTargets.filter(t => t.includes('(translated)')).join(', ')}]`);
        console.log(`  📝 Transcription only: [${broadcastTargets.filter(t => t.includes('(transcription)')).join(', ')}]`);
        console.log(`  ❌ No translation: [${noTranslationTargets.join(', ')}]`);

        // Check if Spanish is the only one getting translations
        const translatedLangs = Object.keys(translations);
        const spanishOnly = translatedLangs.length === 1 && translatedLangs[0] === 'es';

        if (spanishOnly) {
            console.log(`🚨 BUG CONFIRMED: Only Spanish received translations!`);
            console.log(`   This suggests the translation worker is only succeeding for Spanish.`);
        } else if (translatedLangs.length === scenario.expectedTranslations.length) {
            console.log(`✅ All expected languages received translations`);
        } else {
            console.log(`⚠️ Unexpected translation results`);
        }
    }

    // Clean up
    sessionStore.closeSession(sessionId);
    console.log('\n--- Unit Test Complete ---');
}

// Alternative test: check if the issue is in the filtering logic
function testFilteringLogic() {
    console.log('\n🔍 Testing Filtering Logic...');

    const testCases = [
        { source: 'en', targets: ['es', 'fr', 'de'], expectedTranslationTargets: ['es', 'fr', 'de'] },
        { source: 'es', targets: ['es', 'fr', 'de'], expectedTranslationTargets: ['fr', 'de'] },
        { source: 'fr', targets: ['es', 'fr', 'de'], expectedTranslationTargets: ['es', 'de'] },
    ];

    for (const testCase of testCases) {
        const sameLanguageTargets = testCase.targets.filter(lang => lang === testCase.source);
        const translationTargets = testCase.targets.filter(lang => lang !== testCase.source);

        const matches = JSON.stringify(translationTargets) === JSON.stringify(testCase.expectedTranslationTargets);

        console.log(`${testCase.source} → [${testCase.targets.join(',')}]`);
        console.log(`  Same language: [${sameLanguageTargets.join(',')}]`);
        console.log(`  Translation targets: [${translationTargets.join(',')}]`);
        console.log(`  Expected: [${testCase.expectedTranslationTargets.join(',')}]`);
        console.log(`  ${matches ? '✅' : '❌'} Match\n`);
    }
}

// Run tests
testFilteringLogic();
testRoutingLogic().catch(console.error);
