/**
 * Test WebSocket TTS Commands
 * 
 * Simple test script to verify TTS WebSocket command handlers work correctly.
 * 
 * Usage:
 *   1. Start backend with TTS_ENABLED_DEFAULT=true
 *   2. Create a session and get the sessionId
 *   3. Run: node backend/test-websocket-tts.js <sessionId>
 */

import WebSocket from 'ws';

const SESSION_ID = process.argv[2] || 'test-session';
const WS_URL = `ws://localhost:3001/translate?role=listener&sessionId=${SESSION_ID}&targetLang=es&userName=TestUser`;

console.log('[Test] Connecting to:', WS_URL);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('[Test] ✅ WebSocket connected');

    // Test 1: Send tts/synthesize command with default Gemini (should fallback to Neural2 for ES)
    console.log('\n[Test] Sending tts/synthesize command (Gemini Fallback)...');
    ws.send(JSON.stringify({
        type: 'tts/synthesize',
        segmentId: 'test-gemini',
        text: 'Hola, esta es una prueba de Gemini.',
        languageCode: 'es-ES'
    }));

    // Test 2: Send tts/synthesize command with explicit Neural2 (should auto-route to chirp3_hd)
    setTimeout(() => {
        console.log('\n[Test] Sending tts/synthesize command (Neural2 Routing)...');
        ws.send(JSON.stringify({
            type: 'tts/synthesize',
            segmentId: 'test-neural2',
            text: 'Hola, esta es una prueba de Neural 2.',
            languageCode: 'es-ES',
            voiceName: 'es-ES-Neural2-A'
        }));
    }, 1500);

    // Test 3: Send tts/stop command
    setTimeout(() => {
        console.log('\n[Test] Sending tts/stop command...');
        ws.send(JSON.stringify({
            type: 'tts/stop'
        }));
    }, 2000);

    // Close connection after tests
    setTimeout(() => {
        console.log('\n[Test] Closing connection...');
        ws.close();
    }, 3000);
});

ws.on('message', (data) => {
    try {
        const message = JSON.parse(data.toString());

        // Log TTS-related messages
        if (message.type?.startsWith('tts/')) {
            console.log('[Test] ✅ Received:', JSON.stringify(message, null, 2));
        } else {
            console.log('[Test] Received (non-TTS):', message.type);
        }
    } catch (error) {
        console.error('[Test] ❌ Error parsing message:', error);
    }
});

ws.on('error', (error) => {
    console.error('[Test] ❌ WebSocket error:', error.message);
});

ws.on('close', () => {
    console.log('[Test] WebSocket closed');
    process.exit(0);
});
