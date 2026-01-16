/**
 * Language Switching Test
 *
 * Tests that listeners can switch languages dynamically without breaking routing.
 */

import sessionStore from '../../sessionStore.js';

// Test language switching functionality
async function testLanguageSwitching() {
    console.log('🧪 Testing Language Switching...');

    // Create a test session
    const { sessionId } = sessionStore.createSession();
    console.log(`📝 Created test session: ${sessionId}`);

    // Mock WebSocket objects
    const mockWs1 = { readyState: 1, send: () => {}, close: () => {} };
    const mockWs2 = { readyState: 1, send: () => {}, close: () => {} };

    // Add two listeners with different languages
    const listener1 = sessionStore.addListener(sessionId, 'socket1', mockWs1, 'es', 'User1');
    const listener2 = sessionStore.addListener(sessionId, 'socket2', mockWs2, 'fr', 'User2');

    console.log('👥 Initial listeners:');
    console.log(`  User1 (socket1): ${listener1.targetLang}`);
    console.log(`  User2 (socket2): ${listener2.targetLang}`);

    // Check initial language groups
    let languages = sessionStore.getSessionLanguages(sessionId);
    console.log(`📊 Initial languages: [${languages.join(', ')}]`);

    let esListeners = sessionStore.getListenersByLanguage(sessionId, 'es');
    let frListeners = sessionStore.getListenersByLanguage(sessionId, 'fr');
    console.log(`👂 Spanish listeners: ${esListeners.length}`);
    console.log(`👂 French listeners: ${frListeners.length}`);

    // Test 1: Switch User1 from Spanish to German
    console.log('\n🔄 Test 1: Switching User1 from Spanish to German');
    sessionStore.updateListenerLanguage(sessionId, 'socket1', 'de');

    languages = sessionStore.getSessionLanguages(sessionId);
    console.log(`📊 Languages after switch: [${languages.join(', ')}]`);

    esListeners = sessionStore.getListenersByLanguage(sessionId, 'es');
    frListeners = sessionStore.getListenersByLanguage(sessionId, 'fr');
    let deListeners = sessionStore.getListenersByLanguage(sessionId, 'de');
    console.log(`👂 Spanish listeners: ${esListeners.length}`);
    console.log(`👂 French listeners: ${frListeners.length}`);
    console.log(`👂 German listeners: ${deListeners.length}`);

    // Verify the switch worked correctly
    const updatedListener1 = sessionStore.getSession(sessionId).listeners.get('socket1');
    console.log(`✅ User1 language: ${updatedListener1.targetLang} (expected: de)`);

    if (updatedListener1.targetLang !== 'de') {
        console.error('❌ Language switch failed for User1');
        return false;
    }

    if (esListeners.length !== 0) {
        console.error('❌ User1 not removed from Spanish group');
        return false;
    }

    if (deListeners.length !== 1) {
        console.error('❌ User1 not added to German group');
        return false;
    }

    // Test 2: Switch User2 from French to Spanish
    console.log('\n🔄 Test 2: Switching User2 from French to Spanish');
    sessionStore.updateListenerLanguage(sessionId, 'socket2', 'es');

    languages = sessionStore.getSessionLanguages(sessionId);
    console.log(`📊 Languages after second switch: [${languages.join(', ')}]`);

    esListeners = sessionStore.getListenersByLanguage(sessionId, 'es');
    frListeners = sessionStore.getListenersByLanguage(sessionId, 'fr');
    deListeners = sessionStore.getListenersByLanguage(sessionId, 'de');
    console.log(`👂 Spanish listeners: ${esListeners.length} (expected: 1)`);
    console.log(`👂 French listeners: ${frListeners.length} (expected: 0)`);
    console.log(`👂 German listeners: ${deListeners.length} (expected: 1)`);

    // Verify both switches worked
    const updatedListener2 = sessionStore.getSession(sessionId).listeners.get('socket2');
    console.log(`✅ User2 language: ${updatedListener2.targetLang} (expected: es)`);

    if (updatedListener2.targetLang !== 'es') {
        console.error('❌ Language switch failed for User2');
        return false;
    }

    if (esListeners.length !== 1 || frListeners.length !== 0 || deListeners.length !== 1) {
        console.error('❌ Language group counts incorrect after second switch');
        return false;
    }

    // Test 3: Try switching to same language (should do nothing)
    console.log('\n🔄 Test 3: Switching User1 to same language (de)');
    sessionStore.updateListenerLanguage(sessionId, 'socket1', 'de');

    const finalListener1 = sessionStore.getSession(sessionId).listeners.get('socket1');
    console.log(`✅ User1 language unchanged: ${finalListener1.targetLang} (expected: de)`);

    if (finalListener1.targetLang !== 'de') {
        console.error('❌ Same-language switch affected language');
        return false;
    }

    // Test 4: Try switching non-existent listener (should throw)
    console.log('\n🔄 Test 4: Switching non-existent listener');
    try {
        sessionStore.updateListenerLanguage(sessionId, 'nonexistent', 'it');
        console.error('❌ Should have thrown for non-existent listener');
        return false;
    } catch (error) {
        console.log('✅ Correctly threw error for non-existent listener');
    }

    // Clean up
    sessionStore.closeSession(sessionId);
    console.log('\n✅ All language switching tests passed!');
    return true;
}

// Run the test
testLanguageSwitching().catch(console.error);
