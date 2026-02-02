/**
 * Manual Test Script: Session Quota Testing
 * 
 * Run this script to manually test the session quota flow end-to-end.
 * You can see real-time quota decrementing, start/stop tracking, and aggregations.
 * 
 * Usage:
 *   node backend/tests/manual-test-session-quota.js [command]
 * 
 * Commands:
 *   start    - Start a session span
 *   status   - Check current quota status
 *   stop     - Stop the session span
 *   events   - Show recent usage events
 *   monthly  - Show monthly aggregates
 *   all      - Run complete flow (start → wait → status → stop → verify)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

import { supabaseAdmin } from '../supabaseAdmin.js';
import { startSessionSpan, heartbeatSessionSpan, stopSessionSpan } from '../usage/sessionSpans.js';
import { getSessionQuotaStatus, formatQuotaStatus } from '../usage/getSessionQuota.js';

const TEST_CHURCH_ID = process.env.TEST_CHURCH_ID;
const TEST_SESSION_ID = '00000000-0000-0000-0000-000000000099'; // Dedicated test session

async function ensureTestSession() {
    await supabaseAdmin
        .from('sessions')
        .upsert({
            id: TEST_SESSION_ID,
            church_id: TEST_CHURCH_ID,
            session_code: 'MANUAL',
            status: 'active'
        }, { onConflict: 'id' });
    console.log(`📍 Using session: ${TEST_SESSION_ID}`);
}

async function startSpan() {
    console.log('\n🟢 Starting session span...');
    const result = await startSessionSpan({
        sessionId: TEST_SESSION_ID,
        churchId: TEST_CHURCH_ID,
        metadata: { mode: 'manual_test' }
    });

    if (result.alreadyActive) {
        console.log('⚠️  Session span already active');
    } else {
        console.log(`✓ Started span: ${result.spanId}`);
    }

    // Start heartbeat
    console.log('💓 Starting heartbeat (30s interval)...');
    console.log('   Press Ctrl+C to stop, or run: node script.js stop');

    const interval = setInterval(async () => {
        await heartbeatSessionSpan({ sessionId: TEST_SESSION_ID });
        console.log(`   ♥ Heartbeat sent at ${new Date().toISOString()}`);
    }, 30000);

    // Keep running
    process.on('SIGINT', async () => {
        clearInterval(interval);
        console.log('\n🛑 Stopping due to Ctrl+C...');
        await stopSpan();
        process.exit(0);
    });
}

async function checkStatus() {
    console.log('\n📊 Checking quota status...');

    let status = null;
    try {
        status = await getSessionQuotaStatus(TEST_CHURCH_ID);
    } catch (err) {
        // RPC missing, proceed to simulation
    }

    // SIMULATION: If RPC is missing, simulate the live count for the test
    if (!status) {
        console.log('⚠ Quota RPC not detected in DB. Simulating live count from local state...');

        // Get MTD from usage_monthly
        const { data: monthly } = await supabaseAdmin
            .from('usage_monthly')
            .select('total_quantity')
            .eq('church_id', TEST_CHURCH_ID)
            .eq('month_start', '2026-02-01') // Current month in test
            .eq('metric', 'session_seconds')
            .maybeSingle(); // maybeSingle handles 0 rows better

        const usedMtd = monthly?.total_quantity || 0;

        // Get active span duration
        const { data: span } = await supabaseAdmin
            .from('session_spans')
            .select('started_at, last_seen_at')
            .eq('session_id', TEST_SESSION_ID)
            .is('ended_at', null)
            .maybeSingle();

        let activeNow = 0;
        if (span) {
            const start = new Date(span.started_at);
            const last = new Date(span.last_seen_at);
            activeNow = Math.floor((last.getTime() - start.getTime()) / 1000);
        }

        status = {
            included_seconds_per_month: 3600, // 1 hour starter plan
            used_seconds_mtd: usedMtd,
            active_seconds_now: activeNow,
            remaining_seconds: 3600 - usedMtd - activeNow
        };
    }

    if (status) {
        // Add minutesRemaining for display
        const minutesRemaining = (status.remaining_seconds / 60).toFixed(1);
        const percentUsed = status.included_seconds_per_month > 0
            ? Math.round(((status.used_seconds_mtd + status.active_seconds_now) / status.included_seconds_per_month) * 100)
            : 0;

        console.log('┌──────────────────────────────────────┐');
        console.log(`│ PLAN:      ${Math.floor(status.included_seconds_per_month / 60)} minutes / month`);
        console.log(`│ USED MTD:  ${status.used_seconds_mtd}s (historical)`);
        console.log(`│ LIVE NOW:  ${status.active_seconds_now}s (current stream)`);
        console.log(`│ ───────────`);
        console.log(`│ TOTAL:     ${status.used_seconds_mtd + status.active_seconds_now}s`);
        console.log(`│ REMAINING: ${status.remaining_seconds}s (${minutesRemaining}m left)`);
        console.log(`│ % USED:    ${percentUsed}%`);
        console.log('└──────────────────────────────────────┘');

        if (status.remaining_seconds <= 0) {
            console.log('⚠️  QUOTA EXHAUSTED! Streaming would be blocked.');
        }
    }
}

async function stopSpan() {
    console.log('\n🔴 Stopping session span...');
    const result = await stopSessionSpan({
        sessionId: TEST_SESSION_ID,
        reason: 'manual_stop'
    });

    console.log(`✓ Stopped: ${result.durationSeconds}s recorded`);
    console.log(`  Event recorded: ${result.eventRecorded}`);
}

async function showEvents() {
    console.log('\n📋 Recent session_seconds events:');

    const { data: events } = await supabaseAdmin
        .from('usage_events')
        .select('*')
        .eq('church_id', TEST_CHURCH_ID)
        .eq('metric', 'session_seconds')
        .order('occurred_at', { ascending: false })
        .limit(10);

    if (events?.length > 0) {
        events.forEach((e, i) => {
            console.log(`  [${i + 1}] ${e.quantity}s @ ${new Date(e.occurred_at).toLocaleString()}`);
            console.log(`      key: ${e.idempotency_key}`);
        });
    } else {
        console.log('  (no events found)');
    }
}

async function showMonthly() {
    console.log('\n📅 Monthly aggregates:');

    const { data: monthly } = await supabaseAdmin
        .from('usage_monthly')
        .select('*')
        .eq('church_id', TEST_CHURCH_ID)
        .eq('metric', 'session_seconds');

    if (monthly?.length > 0) {
        monthly.forEach(m => {
            console.log(`  ${m.month_start}: ${m.total_quantity}s total`);
        });
    } else {
        console.log('  (no monthly data)');
    }
}

async function runAll() {
    console.log('='.repeat(50));
    console.log('FULL SESSION QUOTA TEST');
    console.log('='.repeat(50));

    await ensureTestSession();
    await showMonthly();

    console.log('\n⏱️  Starting 10-second session...');
    await startSessionSpan({
        sessionId: TEST_SESSION_ID,
        churchId: TEST_CHURCH_ID,
        metadata: { mode: 'full_test' }
    });

    for (let i = 1; i <= 3; i++) {
        await new Promise(r => setTimeout(r, 4000));
        console.log(`\n   ♥ Heartbeat ${i}/3`);
        await heartbeatSessionSpan({ sessionId: TEST_SESSION_ID });

        // CHECK STATUS DURING THE STREAM TO SHOW THE LIVE COUNTER
        await checkStatus();
    }

    await stopSessionSpan({ sessionId: TEST_SESSION_ID, reason: 'test_complete' });

    await showEvents();
    await showMonthly();

    console.log('\n✅ Test complete!');
}

// Main
async function main() {
    if (!TEST_CHURCH_ID) {
        console.error('❌ Set TEST_CHURCH_ID in backend/.env');
        process.exit(1);
    }

    const command = process.argv[2] || 'all';

    await ensureTestSession();

    switch (command) {
        case 'start':
            await startSpan();
            break;
        case 'status':
            await checkStatus();
            break;
        case 'stop':
            await stopSpan();
            break;
        case 'events':
            await showEvents();
            break;
        case 'monthly':
            await showMonthly();
            break;
        case 'all':
            await runAll();
            break;
        default:
            console.log('Unknown command. Use: start, status, stop, events, monthly, all');
    }
}

main().catch(console.error);
