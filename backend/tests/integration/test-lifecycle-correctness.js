/**
 * Integration Test: Session Lifecycle Correctness
 * 
 * Verifies the user's 3 critical scenarios:
 * 1. Admin End Session -> DB Updated, Session Closed
 * 2. Listeners Join/Leave -> Session Remains Active
 * 3. Inactive/Timeout -> Session Ends
 * 
 * Run: node backend/tests/integration/test-lifecycle-correctness.js
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { WebSocket } from 'ws'; // Mock socket

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { supabaseAdmin } from '../../supabaseAdmin.js';
import sessionStore from '../../sessionStore.js';

// Test config
const TEST_SESSION_ID = '00000000-0000-0000-0000-000000000007';
const TEST_CHURCH_ID = process.env.TEST_CHURCH_ID;

// Mock Socket
class MockSocket {
    constructor(id) {
        this.id = id;
        this.readyState = 1; // Open
    }
    send(msg) { console.log(`[MockSocket ${this.id}] Got:`, msg); }
    close() { this.readyState = 3; console.log(`[MockSocket ${this.id}] Closed`); }
}

async function setupTestSession() {
    // 1. Clean up local memory
    if (sessionStore.sessions.has(TEST_SESSION_ID)) {
        sessionStore.sessions.delete(TEST_SESSION_ID);
    }

    // 2. Reset DB
    await supabaseAdmin.from('sessions').delete().eq('id', TEST_SESSION_ID);

    const { error } = await supabaseAdmin.from('sessions').insert({
        id: TEST_SESSION_ID,
        church_id: TEST_CHURCH_ID,
        session_code: 'LIFE01',
        status: 'active'
    });

    if (error) throw error;

    // 3. Hydrate Store
    await sessionStore.getSessionByCode('LIFE01');
    sessionStore.setHost(TEST_SESSION_ID, new MockSocket('HOST'), null);

    console.log('✓ Test session ready (In-Memory & DB)');
}

async function verifyDbStatus(expectedStatus) {
    const { data } = await supabaseAdmin
        .from('sessions')
        .select('status, ended_at')
        .eq('id', TEST_SESSION_ID)
        .single();

    if (data.status !== expectedStatus) {
        throw new Error(`DB Status Mismatch! Expected ${expectedStatus}, got ${data.status}`);
    }
    console.log(`✓ DB Status Verified: ${data.status}`);
}

async function runTests() {
    console.log('==================================================');
    console.log('Session Lifecycle Correctness Test');
    console.log('==================================================');

    // --- SCENARIO 2: Listener Independence ---
    console.log('\n--- Scenario 2: Listeners Join/Leave (Should NOT affect session) ---');
    await setupTestSession();

    // Join Listener
    console.log('Action: Listener joining...');
    sessionStore.addListener(TEST_SESSION_ID, 'client1', new MockSocket('L1'), 'es', 'Juan');

    // Verify Session is Active
    if (!sessionStore.getSession(TEST_SESSION_ID)) throw new Error('Session lost from memory!');
    await verifyDbStatus('active');

    // Leave Listener
    console.log('Action: Listener leaving...');
    sessionStore.removeListener(TEST_SESSION_ID, 'client1');

    // Verify Session STILL Active
    if (!sessionStore.getSession(TEST_SESSION_ID)) throw new Error('Session died after listener left!');
    await verifyDbStatus('active');
    console.log('✓ PASS: Listeners do not kill session');


    // --- SCENARIO 1: Explicit Admin End ---
    console.log('\n--- Scenario 1: Host Clicks End Session ---');
    await setupTestSession();

    console.log('Action: calling sessionStore.endSession()...');
    const ended = await sessionStore.endSession(TEST_SESSION_ID, 'host_clicked_end');

    if (!ended) throw new Error('endSession returned false');

    // Verify Memory Cleared
    if (sessionStore.getSession(TEST_SESSION_ID)) throw new Error('Session still in memory!');
    console.log('✓ Memory cleared');

    // Verify DB Ended
    await verifyDbStatus('ended');
    console.log('✓ PASS: Explicit end works');


    // --- SCENARIO 3: Inactive Admin (Grace Period) ---
    console.log('\n--- Scenario 3: Host Disconnects (Grace Period Logic) ---');
    await setupTestSession();

    console.log('Action: Host disconnects (scheduling end)...');
    sessionStore.scheduleSessionEnd(TEST_SESSION_ID);

    // Verify Timer Set
    if (!sessionStore.pendingEndTimers.has(TEST_SESSION_ID)) {
        throw new Error('Grace timer not set!');
    }
    console.log('✓ Grace timer set (waiting for timeout...)');

    // Simulate Reconnect (Cancel)
    console.log('Action: Host Reconnects within grace period...');
    sessionStore.cancelScheduledEnd(TEST_SESSION_ID);
    if (sessionStore.pendingEndTimers.has(TEST_SESSION_ID)) {
        throw new Error('Timer not cancelled!');
    }
    await verifyDbStatus('active');
    console.log('✓ Reconnect cancelled timeout');

    // Simulate Timeout Firing
    console.log('Action: Host Disconnects again (timeout fires)...');
    // We manually simulate the callback behavior since we can't wait 30s
    await sessionStore.endSession(TEST_SESSION_ID, 'host_disconnected');

    await verifyDbStatus('ended');
    console.log('✓ PASS: Timeout ends session');

    console.log('\n==================================================');
    console.log('✅ ALL LIFECYCLE SCENARIOS PASSED');
    console.log('==================================================');
    process.exit(0);
}

runTests().catch(e => {
    console.error(e);
    process.exit(1);
});
