/**
 * Verification Script for WebSocket STT Parameters
 * 
 * This script simulates a WebSocket client connecting to the API and 
 * sending an 'init' message with the new STT enhancement parameters.
 * 
 * Usage:
 *   node backend/tests/scripts/verifyWebSocketParams.js
 */

import WebSocket from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

const PORT = process.env.PORT || 3001;
const API_KEY = (process.env.WS_API_KEYS || '').split(',')[0];
const WS_URL = `ws://localhost:${PORT}/api/translate?apiKey=${API_KEY}`;

if (!API_KEY) {
    console.error('❌ Error: WS_API_KEYS not set in .env');
    process.exit(1);
}

console.log('='.repeat(70));
console.log('WEBSOCKET STT PARAMETERS VERIFICATION');
console.log('='.repeat(70));
console.log(`Connecting to: ${WS_URL}`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('✅ Connected to WebSocket');

    // Test 1: Enable both features via init
    const initMessage = {
        type: 'init',
        sourceLang: 'en',
        targetLang: 'es',
        enableMultiLanguage: true,
        alternativeLanguageCodes: ['es', 'fr'],
        enableSpeakerDiarization: true,
        minSpeakers: 2,
        maxSpeakers: 3
    };

    console.log('\n1. SENDING INIT WITH STT ENHANCEMENTS:');
    console.log(JSON.stringify(initMessage, null, 2));

    ws.send(JSON.stringify(initMessage));

    console.log('\nCHECK BACKEND LOGS FOR:');
    console.log('  - [GoogleSpeech] 🌍 MULTI-LANG ENABLED: Primary=en-US, Alternatives=es-ES, fr-FR');
    console.log('  - [GoogleSpeech] 👥 DIARIZATION ENABLED: minSpeakers=2, maxSpeakers=3');

    // Wait a bit and then close
    setTimeout(() => {
        console.log('\n2. Closing connection...');
        ws.close();
        console.log('Verification finished. Check server console for logs.');
        process.exit(0);
    }, 3000);
});

ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'error') {
        console.error('❌ WebSocket Error:', msg.message);
        process.exit(1);
    } else {
        console.log(`📩 Received: ${msg.type}${msg.message ? ` - ${msg.message}` : ''}`);
    }
});

ws.on('error', (err) => {
    console.error('❌ Connection failed. Is the server running?');
    console.error(err.message);
    process.exit(1);
});
