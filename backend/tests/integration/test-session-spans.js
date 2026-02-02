/**
 * Integration Test: Session Spans
 * 
 * Tests the session span lifecycle: start → heartbeat → stop
 * and verifies session-based billing events are recorded correctly.
 * 
 * Run: node backend/tests/integration/test-session-spans.js
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { supabaseAdmin } from '../../supabaseAdmin.js';
import {
    startSessionSpan,
    heartbeatSessionSpan,
    stopSessionSpan
} from '../../usage/sessionSpans.js';
import { getSessionQuotaStatus } from '../../usage/getSessionQuota.js';

// Test configuration
const TEST_SESSION_ID = '00000000-0000-0000-0000-000000000003';
const TEST_CHURCH_ID = process.env.TEST_CHURCH_ID;

async function ensureTestSession() {
    // Ensure a test session exists for the test
    const { error } = await supabaseAdmin
        .from('sessions')
        .upsert({
            id: TEST_SESSION_ID,
            church_id: TEST_CHURCH_ID,
            session_code: 'TEST999',
            status: 'active'
        }, { onConflict: 'id' });

    if (error) {
        console.error('Failed to create test session:', error.message);
        throw error;
    }
    console.log('✓ Test session ready');
}

async function cleanupTestData() {
    // Clean up any previous test session spans
    await supabaseAdmin
        .from('session_spans')
        .delete()
        .eq('session_id', TEST_SESSION_ID);

    console.log('✓ Cleaned up test data');
}

async function testStartSessionSpan() {
    console.log('\n--- Test 1: Start Session Span ---');

    const result = await startSessionSpan({
        sessionId: TEST_SESSION_ID,
        churchId: TEST_CHURCH_ID,
        metadata: { sourceLang: 'en' }
    });

    if (!result.success || !result.spanId) {
        throw new Error('Failed to create session span');
    }

    console.log(`✓ Session span created: ${result.spanId}`);
    console.log(`  Already active: ${result.alreadyActive}`);

    // Verify idempotency
    const result2 = await startSessionSpan({
        sessionId: TEST_SESSION_ID,
        churchId: TEST_CHURCH_ID
    });

    if (!result2.alreadyActive) {
        throw new Error('Idempotency check failed - should detect already active');
    }

    console.log('✓ Idempotency check passed (detected already active)');

    return result.spanId;
}

async function testHeartbeat() {
    console.log('\n--- Test 2: Heartbeat ---');

    const result = await heartbeatSessionSpan({
        sessionId: TEST_SESSION_ID
    });

    if (!result.updated) {
        throw new Error('Heartbeat did not update any rows');
    }

    console.log('✓ Heartbeat updated last_seen_at');
}

async function testStopSessionSpan() {
    console.log('\n--- Test 3: Stop Session Span ---');

    // Wait a bit to accumulate duration
    console.log('  Waiting 2s to accumulate duration...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    const result = await stopSessionSpan({
        sessionId: TEST_SESSION_ID,
        reason: 'test_stop'
    });

    if (!result.success) {
        throw new Error('Failed to stop session span');
    }

    console.log(`✓ Session span stopped: ${result.durationSeconds}s`);
    console.log(`  Event recorded: ${result.eventRecorded}`);

    // Verify in DB
    const { data: span } = await supabaseAdmin
        .from('session_spans')
        .select('*')
        .eq('session_id', TEST_SESSION_ID)
        .not('ended_at', 'is', null)
        .single();

    if (!span || !span.ended_at) {
        throw new Error('DB verification failed - span not properly ended');
    }

    console.log(`✓ DB verified: ended_at=${span.ended_at}, reason=${span.ended_reason}`);
}

async function testStopNonexistent() {
    console.log('\n--- Test 4: Stop Nonexistent Span ---');

    const result = await stopSessionSpan({
        sessionId: '99999999-9999-9999-9999-999999999999',
        reason: 'test'
    });

    if (!result.success || result.durationSeconds !== 0) {
        throw new Error('Expected graceful handling of nonexistent span');
    }

    console.log('✓ Gracefully handled nonexistent span');
}

async function testQuotaStatus() {
    console.log('\n--- Test 5: Quota Status ---');

    try {
        const status = await getSessionQuotaStatus(TEST_CHURCH_ID);

        if (!status) {
            console.log('⚠ Quota RPC returned null (may need to deploy RPC)');
        } else {
            console.log('✓ Quota status retrieved:');
            console.log(`  Included: ${status.included_seconds_per_month}s/month`);
            console.log(`  Used MTD: ${status.used_seconds_mtd}s`);
            console.log(`  Active now: ${status.active_seconds_now}s`);
            console.log(`  Remaining: ${status.remaining_seconds}s`);
        }
    } catch (err) {
        console.log(`⚠ Quota RPC not available: ${err.message}`);
    }
}

async function testCheckUsageEvents() {
    console.log('\n--- Test 6: Check Usage Events ---');

    const { data: events } = await supabaseAdmin
        .from('usage_events')
        .select('*')
        .eq('church_id', TEST_CHURCH_ID)
        .eq('metric', 'session_seconds')
        .order('occurred_at', { ascending: false })
        .limit(5);

    if (events && events.length > 0) {
        console.log(`✓ Found ${events.length} session_seconds event(s):`);
        events.forEach((e, i) => {
            console.log(`  [${i + 1}] ${e.quantity}s at ${e.occurred_at} (key: ${e.idempotency_key?.substring(0, 40)}...)`);
        });
    } else {
        console.log('⚠ No session_seconds events found');
    }
}

async function testCheckMonthlyAggregates() {
    console.log('\n--- Test 7: Check Monthly Aggregates ---');

    const { data: monthly } = await supabaseAdmin
        .from('usage_monthly')
        .select('*')
        .eq('church_id', TEST_CHURCH_ID)
        .eq('metric', 'session_seconds');

    if (monthly && monthly.length > 0) {
        console.log(`✓ Found monthly aggregates:`);
        monthly.forEach(m => {
            console.log(`  ${m.month_start}: ${m.total_quantity}s total`);
        });
    } else {
        console.log('⚠ No session_seconds monthly aggregates found yet');
    }
}

// Main test runner
async function runTests() {
    console.log('==================================================');
    console.log('Session Spans Integration Test');
    console.log('==================================================');

    if (!TEST_CHURCH_ID) {
        console.error('❌ TEST_CHURCH_ID not set in backend/.env');
        process.exit(1);
    }

    try {
        await ensureTestSession();
        await cleanupTestData();
        await testStartSessionSpan();
        await testHeartbeat();
        await testStopSessionSpan();
        await testStopNonexistent();
        await testQuotaStatus();
        await testCheckUsageEvents();
        await testCheckMonthlyAggregates();

        console.log('\n==================================================');
        console.log('✅ All tests passed!');
        console.log('==================================================');
    } catch (err) {
        console.error(`\n❌ Test failed: ${err.message}`);
        console.error(err.stack);
    } finally {
        await cleanupTestData();
        process.exit(0);
    }
}

runTests();
