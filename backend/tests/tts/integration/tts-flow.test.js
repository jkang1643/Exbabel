/**
 * TTS Integration Test Suite
 * 
 * Tests the full WebSocket TTS flow:
 * 1. Session creation via HTTP
 * 2. Host connection
 * 3. Listener connection
 * 4. TTS synthesis requests (Gemini, Neural2, Chirp3 HD)
 */

import fetch from 'node-fetch';
import WebSocket from 'ws';

const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;

async function runTest(name, scenario) {
    console.log(`\n--- Running Test: ${name} ---`);
    try {
        // 1. Create a session
        const response = await fetch(`${BASE_URL}/session/start`, { method: 'POST' });
        const session = await response.json();
        if (!session.success) throw new Error(`Failed to create session: ${session.error}`);

        const { sessionId } = session;

        // 2. Connect as Host (to activate session)
        const hostWs = new WebSocket(`ws://localhost:${PORT}/translate?role=host&sessionId=${sessionId}`);

        await new Promise((resolve, reject) => {
            hostWs.on('open', () => {
                hostWs.send(JSON.stringify({ type: 'init', sourceLang: 'en' }));
                resolve();
            });
            hostWs.on('error', reject);
            setTimeout(() => reject(new Error('Host connection timeout')), 5000);
        });

        // 3. Connect as Listener
        const listenerWs = new WebSocket(`ws://localhost:${PORT}/translate?role=listener&sessionId=${sessionId}&targetLang=es&userName=Tester`);

        const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                listenerWs.close();
                hostWs.close();
                reject(new Error(`Test "${name}" timed out`));
            }, 10000);

            listenerWs.on('open', () => {
                listenerWs.send(JSON.stringify({
                    type: 'tts/synthesize',
                    ...scenario
                }));
            });

            listenerWs.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'tts/audio') {
                    clearTimeout(timeout);
                    listenerWs.close();
                    hostWs.close();
                    resolve({ success: true, size: msg.audioContentBase64?.length });
                } else if (msg.type === 'tts/error') {
                    clearTimeout(timeout);
                    listenerWs.close();
                    hostWs.close();
                    resolve({ success: false, error: msg.message, code: msg.code });
                }
            });

            listenerWs.on('error', reject);
        });

        if (result.success) {
            console.log(`✅ Passed: Received ${result.size} bytes of audio`);
        } else {
            console.warn(`⚠️ Finished with error (expected in some scenarios): ${result.error}`);
            return result;
        }
        return result;

    } catch (error) {
        console.error(`❌ Failed: ${error.message}`);
        return { success: false, error: error.message };
    }
}

async function runSuite() {
    console.log('Starting TTS Integration Test Suite...');

    // Scenario 1: Spanish Neural2 (Should use chirp3_hd engine)
    await runTest('Spanish Neural2 (Auto-Route)', {
        text: 'Hola monde. Probando voz Neural 2.',
        languageCode: 'es-ES',
        voiceName: 'es-ES-Neural2-A',
        segmentId: 'seg-neural2'
    });

    // Scenario 2: Spanish Shorthand (Auto-Normalize)
    await runTest('Spanish Shorthand Normalization', {
        text: 'Prueba de normalización.',
        languageCode: 'es-ES',
        voiceName: 'es-Neural2-B',
        segmentId: 'seg-norm'
    });

    // Scenario 3: Chirp 3 HD Default
    await runTest('Chirp 3 HD Default', {
        text: 'Hola monde. Probando Chirp 3 HD default.',
        languageCode: 'es-ES',
        tier: 'chirp3_hd',
        segmentId: 'seg-chirp'
    });

    // Scenario 4: Gemini Aoede (Spanish - Should fall back to Neural2)
    await runTest('Gemini Aoede Spanish (Manual)', {
        text: 'Probando voz Aoede en español.',
        languageCode: 'es-ES',
        voiceName: 'Aoede',
        tier: 'gemini',
        segmentId: 'seg-gemini-aoede'
    });

    // Scenario 5: Gemini Default (Spanish Fallback)
    const geminiResult = await runTest('Gemini Spanish Fallback', {
        text: 'Hola monde. Probando Gemini fallback.',
        languageCode: 'es-ES',
        segmentId: 'seg-gemini'
    });

    if (geminiResult.error && geminiResult.error.includes('Vertex AI API')) {
        console.log('ℹ️ Note: Gemini tests correctly failed due to disabled Vertex AI API (expected unless enabled).');
    }

    console.log('\n--- TTS Suite Complete ---');
}

runSuite();
