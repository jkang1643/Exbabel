/**
 * Verification Script for Host Mode STT Parameters
 * 
 * This script simulates a Host client connecting to the frontend WebSocket 
 * and sending an 'init' message with the new STT enhancement parameters.
 * 
 * Usage:
 *   node backend/tests/scripts/verifyHostParams.js
 */

import WebSocket from 'ws';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

const PORT = process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}`;

console.log('='.repeat(70));
console.log('HOST MODE STT PARAMETERS VERIFICATION');
console.log('='.repeat(70));

async function verifyHost() {
    try {
        // 1. Create a session
        console.log('1. Creating session...');
        const sessionRes = await fetch(`${BASE_URL}/session/start`, { method: 'POST' });
        const sessionData = await sessionRes.json();

        if (!sessionData.success) {
            throw new Error(`Failed to create session: ${JSON.stringify(sessionData)}`);
        }

        const { sessionId, wsUrl } = sessionData;
        const fullWsUrl = `ws://localhost:${PORT}${wsUrl}`;
        console.log(`✅ Session created: ${sessionId}`);
        console.log(`Connecting to: ${fullWsUrl}`);

        // 2. Connect as host
        const ws = new WebSocket(fullWsUrl);

        ws.on('open', () => {
            console.log('✅ Connected to WebSocket as Host');

            // 3. Send init with STT enhancements
            const initMessage = {
                type: 'init',
                sourceLang: 'en',
                targetLang: 'es',
                enableMultiLanguage: true,
                alternativeLanguageCodes: ['es', 'fr'],
                enableSpeakerDiarization: true,
                minSpeakers: 1,
                maxSpeakers: 4
            };

            console.log('\n2. SENDING INIT WITH STT ENHANCEMENTS:');
            console.log(JSON.stringify(initMessage, null, 2));

            ws.send(JSON.stringify(initMessage));

            console.log('\nCHECK BACKEND LOGS FOR:');
            console.log('  - [GoogleSpeech] 🌍 MULTI-LANG ENABLED: Primary=en-US, Alternatives=es, fr');
            console.log('  - [GoogleSpeech] 👥 DIARIZATION ENABLED: minSpeakers=1, maxSpeakers=4');

            // Wait a bit and then close
            setTimeout(() => {
                console.log('\n3. Closing connection...');
                ws.close();
                console.log('Verification finished. Check server console for logs.');
                process.exit(0);
            }, 3000);
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            console.log(`📩 Received: ${msg.type}${msg.message ? ` - ${msg.message}` : ''}`);
            if (msg.type === 'error') {
                console.error('❌ WebSocket Error:', msg.message);
                process.exit(1);
            }
        });

        ws.on('error', (err) => {
            console.error('❌ Connection failed.');
            console.error(err.message);
            process.exit(1);
        });

    } catch (error) {
        console.error('❌ Error during verification:', error.message);
        process.exit(1);
    }
}

verifyHost();
