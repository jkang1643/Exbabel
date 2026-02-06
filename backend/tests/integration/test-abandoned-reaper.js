/**
 * Integration Test: Abandoned Session Reaper
 * 
 * Tests the periodic abandoned session cleanup functionality.
 * 
 * Run: node backend/tests/integration/test-abandoned-reaper.js
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { supabaseAdmin } from '../../supabaseAdmin.js';
import { startSessionSpan } from '../../usage/sessionSpans.js';
import {
    reapAbandonedSessionSpans,
    reapAbandonedSessions,
    runReaperCycle,
    CONFIG
} from '../../usage/abandonedSessionReaper.js';

// Test configuration
const TEST_SESSION_ID = '00000000-0000-0000-0000-000000000099';
const TEST_CHURCH_ID = process.env.TEST_CHURCH_ID;

async function ensureTestSession() {
    // Ensure a test session exists for the test
    const { error } = await supabaseAdmin
        .from('sessions')
        .upsert({
            id: TEST_SESSION_ID,
            church_id: TEST_CHURCH_ID,
            session_code: 'REAP99',
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

    // Reset test session status
    await supabaseAdmin
        .from('sessions')
        .update({ status: 'ended', ended_at: new Date().toISOString() })
        .eq('id', TEST_SESSION_ID);

    console.log('✓ Cleaned up test data');
}

async function testReapStaleSpan() {
    console.log('\n--- Test 1: Reap Stale Session Span ---');

    // Create a session span
    await startSessionSpan({
        sessionId: TEST_SESSION_ID,
        churchId: TEST_CHURCH_ID,
        metadata: { test: true }
    });

    // Artificially age the span by setting last_seen_at to past threshold
    const staleTime = new Date(Date.now() - (CONFIG.ABANDONED_THRESHOLD_SECONDS + 60) * 1000).toISOString();
    await supabaseAdmin
        .from('session_spans')
        .update({ last_seen_at: staleTime })
        .eq('session_id', TEST_SESSION_ID)
        .is('ended_at', null);

    console.log(`  Set last_seen_at to ${staleTime} (beyond threshold)`);

    // Run the reaper
    const result = await reapAbandonedSessionSpans();

    if (result.reapedCount !== 1) {
        throw new Error(`Expected 1 reaped span, got ${result.reapedCount}`);
    }

    console.log('✓ Stale span was reaped');

    // Verify span is ended
    const { data: span } = await supabaseAdmin
        .from('session_spans')
        .select('*')
        .eq('session_id', TEST_SESSION_ID)
        .single();

    if (!span || !span.ended_at || span.ended_reason !== 'abandoned_reaper') {
        throw new Error('DB verification failed - span not properly ended by reaper');
    }

    console.log(`✓ DB verified: ended_at=${span.ended_at}, reason=${span.ended_reason}`);
}

async function testNoReapRecentSpan() {
    console.log('\n--- Test 2: Do NOT Reap Recent Session Span ---');

    // Clean up first
    await supabaseAdmin
        .from('session_spans')
        .delete()
        .eq('session_id', TEST_SESSION_ID);

    // Create a session span (fresh, not stale)
    await startSessionSpan({
        sessionId: TEST_SESSION_ID,
        churchId: TEST_CHURCH_ID,
        metadata: { test: true }
    });

    // Run the reaper - should NOT reap this one
    const result = await reapAbandonedSessionSpans();

    if (result.reapedCount !== 0) {
        throw new Error(`Expected 0 reaped spans, got ${result.reapedCount} (recent span was incorrectly reaped!)`);
    }

    console.log('✓ Recent span was NOT reaped (correct behavior)');

    // Clean up the span manually
    await supabaseAdmin
        .from('session_spans')
        .update({ ended_at: new Date().toISOString(), ended_reason: 'test_cleanup' })
        .eq('session_id', TEST_SESSION_ID)
        .is('ended_at', null);
}

async function testReapAbandonedSession() {
    console.log('\n--- Test 3: Reap Abandoned Session ---');

    // Create an "abandoned" session (active in DB, no memory presence, old enough)
    const oldTime = new Date(Date.now() - (CONFIG.ABANDONED_THRESHOLD_SECONDS + 120) * 1000).toISOString();
    await supabaseAdmin
        .from('sessions')
        .update({
            status: 'active',
            ended_at: null,
            created_at: oldTime
        })
        .eq('id', TEST_SESSION_ID);

    // Make sure no active spans exist
    await supabaseAdmin
        .from('session_spans')
        .update({ ended_at: new Date().toISOString() })
        .eq('session_id', TEST_SESSION_ID)
        .is('ended_at', null);

    // Run session reaper
    const result = await reapAbandonedSessions();

    if (result.reapedCount !== 1) {
        throw new Error(`Expected 1 reaped session, got ${result.reapedCount}`);
    }

    console.log('✓ Abandoned session was reaped');

    // Verify session is ended
    const { data: session } = await supabaseAdmin
        .from('sessions')
        .select('*')
        .eq('id', TEST_SESSION_ID)
        .single();

    if (!session || session.status !== 'ended') {
        throw new Error('DB verification failed - session not properly ended by reaper');
    }

    console.log(`✓ DB verified: status=${session.status}`);
}

async function testFullReaperCycle() {
    console.log('\n--- Test 4: Full Reaper Cycle ---');

    const result = await runReaperCycle();

    console.log(`✓ Full cycle completed:`);
    console.log(`  Spans reaped: ${result.spans.reapedCount}`);
    console.log(`  Sessions reaped: ${result.sessions.reapedCount}`);
    console.log(`  Errors: ${result.spans.errors.length + result.sessions.errors.length}`);
}

// Main test runner
async function runTests() {
    console.log('==================================================');
    console.log('Abandoned Session Reaper Integration Test');
    console.log('==================================================');
    console.log(`Configuration:`);
    console.log(`  ABANDONED_THRESHOLD_SECONDS: ${CONFIG.ABANDONED_THRESHOLD_SECONDS}`);
    console.log(`  DEFAULT_REAPER_INTERVAL_MS: ${CONFIG.DEFAULT_REAPER_INTERVAL_MS}`);

    if (!TEST_CHURCH_ID) {
        console.error('❌ TEST_CHURCH_ID not set in backend/.env');
        process.exit(1);
    }

    try {
        await ensureTestSession();
        await cleanupTestData();

        // Re-activate test session for tests
        await supabaseAdmin
            .from('sessions')
            .update({ status: 'active', ended_at: null })
            .eq('id', TEST_SESSION_ID);

        await testReapStaleSpan();
        await testNoReapRecentSpan();
        await testReapAbandonedSession();
        await testFullReaperCycle();

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
