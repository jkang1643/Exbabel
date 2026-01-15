/**
 * Language Routing Test Suite
 *
 * Tests that translation partials are correctly routed to all target languages,
 * not just Spanish (es). This test identifies the routing issue mentioned by the user.
 */

import fetch from 'node-fetch';
import WebSocket from 'ws';

const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;

class RoutingTestRunner {
    constructor() {
        this.hostWs = null;
        this.listeners = new Map(); // targetLang -> { ws, messages: [] }
        this.sessionId = null;
        this.testTimeout = 15000; // 15 seconds
    }

    async createSession() {
        console.log('📝 Creating session...');
        const response = await fetch(`${BASE_URL}/session/start`, { method: 'POST' });
        const session = await response.json();
        if (!session.success) throw new Error(`Failed to create session: ${session.error}`);
        this.sessionId = session.sessionId;
        console.log(`✅ Created session: ${this.sessionId}`);
        return this.sessionId;
    }

    async connectHost(sourceLang = 'en') {
        console.log(`🏠 Connecting host with source language: ${sourceLang}...`);
        this.hostWs = new WebSocket(`ws://localhost:${PORT}/translate?role=host&sessionId=${this.sessionId}`);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Host connection timeout')), 5000);

            this.hostWs.on('open', () => {
                console.log('✅ Host connected');
                this.hostWs.send(JSON.stringify({ type: 'init', sourceLang }));
                clearTimeout(timeout);
                resolve();
            });

            this.hostWs.on('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }

    async connectListener(targetLang, userName = `Listener-${targetLang}`) {
        console.log(`👂 Connecting listener for ${targetLang}...`);
        const ws = new WebSocket(`ws://localhost:${PORT}/translate?role=listener&sessionId=${this.sessionId}&targetLang=${targetLang}&userName=${userName}`);

        const listenerData = {
            ws,
            messages: [],
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
                const msg = JSON.parse(data.toString());
                listenerData.messages.push(msg);
                console.log(`📨 ${targetLang} received: ${msg.type} ${msg.hasTranslation ? '(translated)' : '(raw)'}`);
            });

            ws.on('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });
    }

    async sendTranscription(text) {
        console.log(`🎤 Sending transcription: "${text}"`);
        this.hostWs.send(JSON.stringify({
            type: 'transcription',
            text: text,
            isPartial: true,
            timestamp: Date.now()
        }));
    }

    async waitForTranslations(timeoutMs = 5000) {
        console.log(`⏳ Waiting ${timeoutMs}ms for translations...`);
        return new Promise(resolve => {
            setTimeout(() => {
                resolve(this.getResults());
            }, timeoutMs);
        });
    }

    getResults() {
        const results = {};
        for (const [targetLang, listener] of this.listeners.entries()) {
            const translationMessages = listener.messages.filter(msg =>
                msg.type === 'translation' && msg.hasTranslation === true
            );
            const transcriptionMessages = listener.messages.filter(msg =>
                msg.type === 'translation' && msg.hasTranslation === false
            );

            results[targetLang] = {
                connected: listener.connected,
                translationMessages: translationMessages.length,
                transcriptionMessages: transcriptionMessages.length,
                totalMessages: listener.messages.length,
                lastTranslation: translationMessages[translationMessages.length - 1]
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

async function runRoutingTest(testName, sourceLang, targetLangs, testText) {
    console.log(`\n--- Running Test: ${testName} ---`);
    console.log(`Source: ${sourceLang}, Targets: ${targetLangs.join(', ')}, Text: "${testText}"`);

    const runner = new RoutingTestRunner();

    try {
        // Setup
        await runner.createSession();
        await runner.connectHost(sourceLang);

        // Connect listeners for all target languages
        await Promise.all(targetLangs.map(lang => runner.connectListener(lang)));

        // Wait a moment for connections to stabilize
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Send transcription
        await runner.sendTranscription(testText);

        // Wait for translations
        const results = await runner.waitForTranslations();

        // Analyze results
        console.log('\n📊 Results:');
        const spanishReceived = results['es']?.translationMessages > 0;
        const otherLangsReceived = targetLangs
            .filter(lang => lang !== 'es')
            .some(lang => results[lang]?.translationMessages > 0);

        console.log(`Spanish (es) received translations: ${spanishReceived ? '✅' : '❌'}`);
        console.log(`Other languages received translations: ${otherLangsReceived ? '✅' : '❌'}`);

        for (const [lang, result] of Object.entries(results)) {
            const status = result.translationMessages > 0 ? '✅ TRANSLATED' : '❌ NO TRANSLATION';
            console.log(`  ${lang}: ${status} (${result.translationMessages} translations, ${result.transcriptionMessages} transcriptions)`);
        }

        // Check for the specific issue: only Spanish working
        if (spanishReceived && !otherLangsReceived) {
            console.log('\n🚨 BUG CONFIRMED: Only Spanish (es) is receiving translations!');
            console.log('This confirms the routing issue where other languages are not getting translation partials.');
        } else if (!spanishReceived && otherLangsReceived) {
            console.log('\n🚨 UNEXPECTED: Spanish not working, but others are!');
        } else if (spanishReceived && otherLangsReceived) {
            console.log('\n✅ All languages working correctly');
        } else {
            console.log('\n❌ No translations received at all');
        }

        return { success: true, results };

    } catch (error) {
        console.error(`❌ Test failed: ${error.message}`);
        return { success: false, error: error.message };
    } finally {
        runner.cleanup();
    }
}

async function runSuite() {
    console.log('🚀 Starting Language Routing Test Suite...');
    console.log('This suite tests why only Spanish (es) receives translation partials.');

    const testCases = [
        {
            name: 'English → Multiple Languages (Spanish + Others)',
            sourceLang: 'en',
            targetLangs: ['es', 'fr', 'de', 'it', 'pt'],
            testText: 'Hello world. This is a test message for translation routing.'
        },
        {
            name: 'Spanish → Multiple Languages (Spanish + Others)',
            sourceLang: 'es',
            targetLangs: ['es', 'fr', 'de', 'it', 'pt'],
            testText: 'Hola mundo. Este es un mensaje de prueba para el enrutamiento de traducciones.'
        },
        {
            name: 'French → Multiple Languages (Spanish + Others)',
            sourceLang: 'fr',
            targetLangs: ['es', 'fr', 'de', 'it', 'pt'],
            testText: 'Bonjour le monde. Ceci est un message de test pour le routage des traductions.'
        }
    ];

    const results = [];

    for (const testCase of testCases) {
        const result = await runRoutingTest(
            testCase.name,
            testCase.sourceLang,
            testCase.targetLangs,
            testCase.testText
        );
        results.push({ testCase, result });
    }

    console.log('\n--- Suite Summary ---');
    let spanishOnlyIssues = 0;

    for (const { testCase, result } of results) {
        if (result.success) {
            const spanishReceived = result.results['es']?.translationMessages > 0;
            const otherLangsReceived = testCase.targetLangs
                .filter(lang => lang !== 'es')
                .some(lang => result.results[lang]?.translationMessages > 0);

            if (spanishReceived && !otherLangsReceived) {
                spanishOnlyIssues++;
                console.log(`❌ ${testCase.name}: CONFIRMED BUG - Only Spanish working`);
            } else {
                console.log(`✅ ${testCase.name}: Working correctly`);
            }
        } else {
            console.log(`❌ ${testCase.name}: Test failed - ${result.error}`);
        }
    }

    if (spanishOnlyIssues > 0) {
        console.log(`\n🚨 CRITICAL: Found ${spanishOnlyIssues} test cases where only Spanish (es) receives translations!`);
        console.log('The routing logic has a bug where other languages are not getting translation partials.');
        console.log('\n🔍 Investigation needed in:');
        console.log('1. hostModeHandler.js - translationTargets filtering logic');
        console.log('2. Check if translationTargets array is being populated correctly');
        console.log('3. Verify that translation promises are resolving for non-Spanish languages');
    } else {
        console.log('\n✅ No routing issues detected - all languages working correctly');
    }

    console.log('\n--- Test Suite Complete ---');
}

// Run the suite
runSuite().catch(console.error);
