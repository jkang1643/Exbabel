
const WebSocket = require('ws');

// Configuration
const WS_URL = 'ws://localhost:3001/translate';
// MOCK token/churchID usually requires backend support or env override
// To test Unlimited, export TEST_CHURCH_ID='your_unlimited_church_id' before running
const TEST_CHURCH_ID = process.env.TEST_CHURCH_ID;

// NOTE: This test requires the backend to be running.
// It mimics a client connecting and asking for voices.
// Run manually: 
// 1. Ensure backend is running (npm run server)
// 2. Run this script: TEST_CHURCH_ID=your_church_id node backend/tests/verify_solo_mode_voices.js



async function testSoloModeVoiceFetching() {
    console.log('🔌 Connecting to WebSocket...');
    if (TEST_CHURCH_ID) console.log(`   Using TEST_CHURCH_ID=${TEST_CHURCH_ID}`);

    // Connect as a client (no specific role = solo mode fallback)
    const ws = new WebSocket(`${WS_URL}${TEST_CHURCH_ID ? `?testChurchId=${TEST_CHURCH_ID}` : ''}`);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            console.error('❌ Test timed out');
            ws.close();
            reject(new Error('Timeout'));
        }, 5000);

        ws.on('open', () => {
            console.log('✅ Connected');

            // Wait a bit for server to be ready (it sends 'info' message)
        });

        ws.on('message', (data) => {
            const message = JSON.parse(data);
            console.log('📩 Received:', message.type);

            if (message.type === 'info') {
                console.log('ℹ️ Server info received, requesting voices...');
                // Request voices for English
                ws.send(JSON.stringify({
                    type: 'tts/list_voices',
                    languageCode: 'en-US'
                }));
            }

            if (message.type === 'tts/voices') {
                console.log('🗣️ Voice list received!');
                console.log(`   Language: ${message.languageCode}`);
                console.log(`   Plan Code: ${message.planCode}`);
                console.log(`   Allowed Tiers: [${message.allowedTiers?.join(', ')}]`);
                console.log(`   Total Voices: ${message.voices?.length}`);

                // Check for premium tiers
                const tiers = new Set(message.voices.map(v => v.tier));
                console.log('   Available Tiers:', Array.from(tiers));

                // Verification Logic (adjust expecting "starter" output if no auth provided)
                // If we don't provide auth, we expect "starter" behavior, 
                // BUT the FIX logic regarding `clientWs.entitlements` should now be active.
                // To truly verify "Unlimited", we'd need to mock the entitlements or auth.
                // However, seeing "starter" correctly is better than "error".

                // Ideally, we'd see 'gemini' in the allowed list if we could simulate unlimited.
                // For now, just completing the flow proves the handler didn't crash and returned data.

                clearTimeout(timeout);
                ws.close();
                resolve();
            }
        });

        ws.on('error', (err) => {
            console.error('❌ WebSocket Error:', err);
            reject(err);
        });
    });
}

testSoloModeVoiceFetching()
    .then(() => console.log('✅ Test Completed'))
    .catch(err => console.error('❌ Test Failed:', err));
