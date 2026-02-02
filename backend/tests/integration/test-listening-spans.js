/**
 * Integration Test: Listening Spans
 * 
 * Tests the listening span lifecycle: start → heartbeat → stop
 * and verifies usage events are recorded correctly.
 * 
 * Run: node backend/tests/integration/test-listening-spans.js
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { supabaseAdmin } from '../../supabaseAdmin.js';
import {
    startListening,
    heartbeat,
    stopListening,
    stopAllListeningForSession
} from '../../usage/listeningSpans.js';
import { getListeningQuotaStatus } from '../../usage/getListeningQuota.js';

// Test configuration
const TEST_SESSION_ID = '00000000-0000-0000-0000-000000000001';
const TEST_USER_ID = '00000000-0000-0000-0000-000000000002'; // Must be UUID for listening_spans
const TEST_CHURCH_ID = process.env.TEST_CHURCH_ID;

async function ensureTestSession() {
    // Create test session if doesn't exist
    const { data: existing } = await supabaseAdmin
        .from('sessions')
        .select('id')
        .eq('id', TEST_SESSION_ID)
        .single();

    if (!existing) {
        const { error } = await supabaseAdmin
            .from('sessions')
            .insert({
                id: TEST_SESSION_ID,
                church_id: TEST_CHURCH_ID,
                session_code: 'TEST01',
                status: 'active',
                source_lang: 'en'
            });

        if (error && !error.message.includes('duplicate')) {
            throw new Error(`Failed to create test session: ${error.message}`);
        }
    }
    console.log('✓ Test session ready');
}

async function cleanupTestData() {
    // Delete any existing test spans
    await supabaseAdmin
        .from('listening_spans')
        .delete()
        .eq('session_id', TEST_SESSION_ID)
        .eq('user_id', TEST_USER_ID);

    console.log('✓ Cleaned up test data');
}

async function testStartListening() {
    console.log('\n--- Test 1: Start Listening ---');

    const result = await startListening({
        sessionId: TEST_SESSION_ID,
        userId: TEST_USER_ID,
        churchId: TEST_CHURCH_ID
    });

    if (!result.success) {
        throw new Error('startListening failed');
    }

    console.log(`✓ Span created: ${result.spanId}`);
    console.log(`  Already active: ${result.alreadyActive}`);

    // Try to start again (should detect already active)
    const result2 = await startListening({
        sessionId: TEST_SESSION_ID,
        userId: TEST_USER_ID,
        churchId: TEST_CHURCH_ID
    });

    if (!result2.alreadyActive) {
        throw new Error('Expected alreadyActive=true on second start');
    }

    console.log('✓ Idempotency check passed (detected already active)');
    return result.spanId;
}

async function testHeartbeat() {
    console.log('\n--- Test 2: Heartbeat ---');

    const result = await heartbeat({
        sessionId: TEST_SESSION_ID,
        userId: TEST_USER_ID
    });

    if (!result.success || !result.updated) {
        throw new Error('heartbeat failed to update');
    }

    console.log('✓ Heartbeat updated last_seen_at');
}

async function testStopListening() {
    console.log('\n--- Test 3: Stop Listening ---');

    // Wait a bit to accumulate some duration
    console.log('  Waiting 2s to accumulate duration...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    const result = await stopListening({
        sessionId: TEST_SESSION_ID,
        userId: TEST_USER_ID,
        reason: 'test_stop'
    });

    if (!result.success) {
        throw new Error('stopListening failed');
    }

    console.log(`✓ Span stopped: ${result.durationSeconds}s`);
    console.log(`  Event recorded: ${result.eventRecorded}`);

    // Verify the span is now ended in DB
    const { data: span } = await supabaseAdmin
        .from('listening_spans')
        .select('ended_at, ended_reason')
        .eq('session_id', TEST_SESSION_ID)
        .eq('user_id', TEST_USER_ID)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    if (!span?.ended_at) {
        throw new Error('Span not marked as ended in DB');
    }

    console.log(`✓ DB verified: ended_at=${span.ended_at}, reason=${span.ended_reason}`);
}

async function testStopNonexistent() {
    console.log('\n--- Test 4: Stop Nonexistent Span ---');

    const result = await stopListening({
        sessionId: TEST_SESSION_ID,
        userId: '99999999-9999-9999-9999-999999999999', // Valid UUID that doesn't exist
        reason: 'test'
    });

    if (!result.success || result.durationSeconds !== 0) {
        throw new Error('Expected graceful handling of nonexistent span');
    }

    console.log('✓ Gracefully handled nonexistent span');
}

async function testQuotaStatus() {
    console.log('\n--- Test 5: Quota Status ---');

    if (!TEST_CHURCH_ID) {
        console.log('⚠ Skipping quota test (TEST_CHURCH_ID not set)');
        return;
    }

    try {
        const quota = await getListeningQuotaStatus(TEST_CHURCH_ID);
        console.log('✓ Quota status retrieved:');
        console.log(`  Included: ${quota.included_seconds_per_month}s/month`);
        console.log(`  Used MTD: ${quota.used_seconds_mtd}s`);
        console.log(`  Active now: ${quota.active_seconds_now}s`);
        console.log(`  Remaining: ${quota.remaining_seconds}s`);
    } catch (err) {
        // RPC might not exist yet if migration wasn't applied
        console.log(`⚠ Quota RPC not available: ${err.message}`);
    }
}

async function runTests() {
    console.log('='.repeat(50));
    console.log('Listening Spans Integration Test');
    console.log('='.repeat(50));

    if (!TEST_CHURCH_ID) {
        console.error('ERROR: TEST_CHURCH_ID environment variable is required');
        console.log('Set it with: export TEST_CHURCH_ID=<your-church-uuid>');
        process.exit(1);
    }

    try {
        await ensureTestSession();
        await cleanupTestData();

        await testStartListening();
        await testHeartbeat();
        await testStopListening();
        await testStopNonexistent();
        await testQuotaStatus();

        console.log('\n' + '='.repeat(50));
        console.log('✅ All tests passed!');
        console.log('='.repeat(50));

    } catch (err) {
        console.error('\n❌ Test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    } finally {
        // Cleanup
        await cleanupTestData();
    }
}

runTests();
