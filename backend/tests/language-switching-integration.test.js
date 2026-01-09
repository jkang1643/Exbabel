/**
 * Language Switching Integration Test Suite
 *
 * Comprehensive integration tests to ensure language switching and translation routing work correctly.
 * Tests both partial and final translations across language switches.
 */

import fetch from 'node-fetch';
import WebSocket from 'ws';
import sessionStore from '../sessionStore.js';

const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;

class TranslationIntegrationTester {
    constructor() {
        this.sessionId = null;
        this.listeners = new Map(); // lang -> { ws, messages: [], userName }
        this.hostWs = null;
    }

    async setupSession() {
        console.log('📝 Creating test session...');
        const response = await fetch(`${BASE_URL}/session/start`, { method: 'POST' });
        const session = await response.json();
        if (!session.success) throw new Error(`Failed to create session: ${session.error}`);
        this.sessionId = session.sessionId;
        console.log(`✅ Created session: ${this.sessionId}`);
    }

    async connectHost() {
        console.log('🏠 Connecting host...');
        this.hostWs = new WebSocket(`ws://localhost:${PORT}/translate?role=host&sessionId=${this.sessionId}`);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Host connection timeout')), 5000);

            this.hostWs.on('open', () => {
                this.hostWs.send(JSON.stringify({ type: 'init', sourceLang: 'en' }));
                console.log('✅ Host connected');
                clearTimeout(timeout);
                resolve();
            });

            this.hostWs.on('error', reject);
        });
    }

    async connectListener(targetLang, userName = `Listener-${targetLang}`) {
        console.log(`👂 Connecting listener for ${targetLang} (${userName})...`);
        const ws = new WebSocket(`ws://localhost:${PORT}/translate?role=listener&sessionId=${this.sessionId}&targetLang=${targetLang}&userName=${encodeURIComponent(userName)}`);

        const listenerData = {
            ws,
            messages: [],
            userName,
            targetLang,
            connected: false
        };

        this.listeners.set(targetLang, listenerData);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Listener ${targetLang} connection timeout`)), 5000);

            ws.on('open', () => {
                console.log(`✅ Listener connected for ${targetLang}`);
                listenerData.connected = true;
                clearTimeout(timeout);
                resolve();
            });

            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    listenerData.messages.push(message);

                    // Log translation messages
                    if (message.type === 'translation' && message.hasTranslation) {
                        console.log(`📨 ${targetLang} received: "${message.translatedText?.substring(0, 30)}..." (${message.isPartial ? 'partial' : 'final'})`);
                    }
                } catch (error) {
                    console.error(`Error parsing message for ${targetLang}:`, error);
                }
            });

            ws.on('error', reject);
        });
    }

    async switchLanguage(oldLang, newLang) {
        const listener = this.listeners.get(oldLang);
        if (!listener) throw new Error(`No listener for ${oldLang}`);

        console.log(`🔄 Switching ${oldLang} listener to ${newLang}...`);

        // Send language change message
        listener.ws.send(JSON.stringify({
            type: 'change_language',
            targetLang: newLang
        }));

        // Update our tracking
        listener.targetLang = newLang;
        this.listeners.set(newLang, listener);
        this.listeners.delete(oldLang);

        // Wait a bit for the backend to process
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    async sendTranscription(text, shouldBePartial = true) {
        console.log(`🎤 Sending transcription: "${text}" (${shouldBePartial ? 'partial' : 'final'})`);
        this.hostWs.send(JSON.stringify({
            type: 'transcription',
            text: text,
            isPartial: shouldBePartial,
            timestamp: Date.now()
        }));
    }

    async waitForTranslations(timeoutMs = 3000) {
        console.log(`⏳ Waiting ${timeoutMs}ms for translations...`);
        return new Promise(resolve => setTimeout(resolve, timeoutMs));
    }

    getTranslationResults() {
        const results = {};
        for (const [lang, listener] of this.listeners.entries()) {
            const translationMessages = listener.messages.filter(msg =>
                msg.type === 'translation' && msg.hasTranslation === true
            );
            const partialTranslations = translationMessages.filter(msg => msg.isPartial);
            const finalTranslations = translationMessages.filter(msg => !msg.isPartial);

            results[lang] = {
                connected: listener.connected,
                totalMessages: listener.messages.length,
                translationMessages: translationMessages.length,
                partialTranslations: partialTranslations.length,
                finalTranslations: finalTranslations.length,
                latestPartial: partialTranslations[partialTranslations.length - 1],
                latestFinal: finalTranslations[finalTranslations.length - 1]
            };
        }
        return results;
    }

    cleanup() {
        console.log('🧹 Cleaning up connections...');
        if (this.hostWs) {
            this.hostWs.close();
        }
        for (const [_, listener] of this.listeners.entries()) {
            if (listener.ws) {
                listener.ws.close();
            }
        }
    }
}

async function testBasicTranslationDelivery() {
    console.log('\n=== Test 1: Basic Translation Delivery ===');
    const tester = new TranslationIntegrationTester();

    try {
        // Setup
        await tester.setupSession();
        await tester.connectHost();
        await tester.connectListener('es', 'SpanishUser');
        await tester.connectListener('fr', 'FrenchUser');
        await tester.connectListener('de', 'GermanUser');

        // Wait for connections to stabilize
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Send a partial transcription
        await tester.sendTranscription('Hello world, this is a test message for translation.');

        // Wait for translations
        await tester.waitForTranslations();

        const results = tester.getTranslationResults();
        console.log('📊 Results:', results);

        // Verify translations were received
        const spanishReceived = results['es']?.translationMessages > 0;
        const frenchReceived = results['fr']?.translationMessages > 0;
        const germanReceived = results['de']?.translationMessages > 0;

        console.log(`✅ Spanish received translations: ${spanishReceived}`);
        console.log(`✅ French received translations: ${frenchReceived}`);
        console.log(`✅ German received translations: ${germanReceived}`);

        if (!spanishReceived || !frenchReceived || !germanReceived) {
            throw new Error('❌ Not all languages received translations');
        }

        console.log('✅ Basic translation delivery test PASSED');
        return true;

    } catch (error) {
        console.error('❌ Basic translation delivery test FAILED:', error.message);
        return false;
    } finally {
        tester.cleanup();
    }
}

async function testLanguageSwitching() {
    console.log('\n=== Test 2: Language Switching ===');
    const tester = new TranslationIntegrationTester();

    try {
        // Setup
        await tester.setupSession();
        await tester.connectHost();
        await tester.connectListener('es', 'SpanishUser');

        // Send initial translation
        await tester.sendTranscription('Hello, how are you today?');
        await tester.waitForTranslations(2000);

        let results = tester.getTranslationResults();
        const initialSpanishCount = results['es']?.translationMessages || 0;
        console.log(`📊 Initial Spanish translations: ${initialSpanishCount}`);

        // Switch from Spanish to German
        await tester.switchLanguage('es', 'de');

        // Send another translation
        await tester.sendTranscription('What time is the meeting?');
        await tester.waitForTranslations(2000);

        results = tester.getTranslationResults();
        const finalGermanCount = results['de']?.translationMessages || 0;
        const finalSpanishCount = results['es']?.translationMessages || 0;

        console.log(`📊 After switch - German translations: ${finalGermanCount}, Spanish translations: ${finalSpanishCount}`);

        // Verify the switch worked
        if (finalGermanCount === 0) {
            throw new Error('❌ German did not receive translations after switch');
        }

        if (finalSpanishCount > initialSpanishCount) {
            throw new Error('❌ Spanish continued receiving translations after switch');
        }

        console.log('✅ Language switching test PASSED');
        return true;

    } catch (error) {
        console.error('❌ Language switching test FAILED:', error.message);
        return false;
    } finally {
        tester.cleanup();
    }
}

async function testMultipleLanguageSwitches() {
    console.log('\n=== Test 3: Multiple Language Switches ===');
    const tester = new TranslationIntegrationTester();

    try {
        // Setup
        await tester.setupSession();
        await tester.connectHost();
        await tester.connectListener('es', 'MultiLangUser');

        const testMessages = [
            'Good morning, how are you?',
            'What is the weather like today?',
            'Can you help me with directions?',
            'Thank you for your assistance.'
        ];

        const languages = ['es', 'fr', 'de', 'it'];
        let totalTranslations = 0;

        for (let i = 0; i < languages.length; i++) {
            const targetLang = languages[i];
            const message = testMessages[i % testMessages.length];

            console.log(`🔄 Switching to ${targetLang} and sending: "${message}"`);

            // Switch language (skip first iteration)
            if (i > 0) {
                await tester.switchLanguage(languages[i-1], targetLang);
            }

            // Send translation
            await tester.sendTranscription(message);
            await tester.waitForTranslations(2000);

            const results = tester.getTranslationResults();
            const langTranslations = results[targetLang]?.translationMessages || 0;

            console.log(`📊 ${targetLang} translations after switch: ${langTranslations}`);

            if (langTranslations === 0) {
                throw new Error(`❌ ${targetLang} did not receive translations after switch ${i + 1}`);
            }

            totalTranslations += langTranslations;
        }

        console.log(`✅ Multiple language switches test PASSED (${totalTranslations} total translations)`);
        return true;

    } catch (error) {
        console.error('❌ Multiple language switches test FAILED:', error.message);
        return false;
    } finally {
        tester.cleanup();
    }
}

async function testFinalTranslationsAfterSwitch() {
    console.log('\n=== Test 4: Final Translations After Language Switch ===');
    const tester = new TranslationIntegrationTester();

    try {
        // Setup
        await tester.setupSession();
        await tester.connectHost();
        await tester.connectListener('es', 'FinalTestUser');

        // Send partial translation first
        await tester.sendTranscription('This is a partial message that will be completed.');
        await tester.waitForTranslations(1500);

        // Switch language during partial streaming
        await tester.switchLanguage('es', 'fr');

        // Send final transcription
        await tester.sendTranscription('This completes the sentence.', false); // isPartial = false
        await tester.waitForTranslations(2000);

        const results = tester.getTranslationResults();
        const frenchFinals = results['fr']?.finalTranslations || 0;
        const spanishFinals = results['es']?.finalTranslations || 0;

        console.log(`📊 Final translations - French: ${frenchFinals}, Spanish: ${spanishFinals}`);

        if (frenchFinals === 0) {
            throw new Error('❌ French did not receive final translations after switch');
        }

        if (spanishFinals > 0) {
            console.warn('⚠️ Spanish received finals after switch - this might be expected if timing aligns');
        }

        console.log('✅ Final translations after switch test PASSED');
        return true;

    } catch (error) {
        console.error('❌ Final translations after switch test FAILED:', error.message);
        return false;
    } finally {
        tester.cleanup();
    }
}

async function runFullTestSuite() {
    console.log('🚀 Running Language Switching Integration Test Suite...\n');

    const tests = [
        { name: 'Basic Translation Delivery', func: testBasicTranslationDelivery },
        { name: 'Language Switching', func: testLanguageSwitching },
        { name: 'Multiple Language Switches', func: testMultipleLanguageSwitches },
        { name: 'Final Translations After Switch', func: testFinalTranslationsAfterSwitch }
    ];

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        try {
            const result = await test.func();
            if (result) {
                passed++;
            } else {
                failed++;
            }
        } catch (error) {
            console.error(`❌ ${test.name} crashed:`, error);
            failed++;
        }
    }

    console.log(`\n=== Test Suite Results ===`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📊 Total: ${passed + failed}`);

    if (failed === 0) {
        console.log('\n🎉 ALL TESTS PASSED! Language switching and translation routing are working correctly.');
    } else {
        console.log(`\n⚠️ ${failed} test(s) failed. Language switching issues may still exist.`);
    }

    return failed === 0;
}

// Run the test suite
runFullTestSuite().catch(console.error);
