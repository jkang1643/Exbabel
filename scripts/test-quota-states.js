#!/usr/bin/env node
/**
 * Test Script: Simulate Quota Warning and Exceeded States
 * 
 * This script inserts usage records directly into the database to simulate
 * different quota states for testing the warning and exceeded UI.
 * 
 * Usage:
 *   node scripts/test-quota-states.js [command] [church-id]
 * 
 * Commands:
 *   reset     - Clear all test usage for this month
 *   warning   - Set usage to 85% (trigger warning)
 *   exceeded  - Set usage to 105% (trigger exceeded)
 *   status    - Show current quota status
 * 
 * Environment:
 *   Requires .env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 * 
 * Example:
 *   node scripts/test-quota-states.js status
 *   node scripts/test-quota-states.js warning
 *   node scripts/test-quota-states.js exceeded
 *   node scripts/test-quota-states.js reset
 */

import dotenv from 'dotenv';
dotenv.config({ path: './backend/.env' });

import { supabaseAdmin } from '../backend/supabaseAdmin.js';
import { getQuotaStatus, checkQuotaLimit } from '../backend/usage/quotaEnforcement.js';

const TEST_CHURCH_ID = process.env.TEST_CHURCH_ID || 'f9c09a47-c599-431d-a20c-9e8e9e50e52a';

async function main() {
    const command = process.argv[2] || 'status';
    const churchId = process.argv[3] || TEST_CHURCH_ID;

    console.log(`\n🧪 Quota Test Script`);
    console.log(`Church ID: ${churchId}`);
    console.log(`Command: ${command}\n`);

    switch (command) {
        case 'status':
            await showStatus(churchId);
            break;
        case 'warning':
            await setUsagePercent(churchId, 0.85);
            break;
        case 'exceeded':
            await setUsagePercent(churchId, 1.05);
            break;
        case 'reset':
            await resetUsage(churchId);
            break;
        default:
            console.log('Unknown command. Use: status, warning, exceeded, reset');
    }
}

async function showStatus(churchId) {
    console.log('📊 Current Quota Status:\n');

    try {
        const status = await getQuotaStatus(churchId);

        if (!status.hasQuota) {
            console.log('❌ No subscription found for this church');
            return;
        }

        console.log('Combined:');
        console.log(`  Included: ${formatTime(status.combined.included)}`);
        console.log(`  Used:     ${formatTime(status.combined.used)}`);
        console.log(`  Remaining: ${formatTime(status.combined.remaining)}`);
        console.log(`  Percent:  ${(status.combined.percentUsed * 100).toFixed(1)}%`);

        console.log('\nSolo Mode:');
        console.log(`  Included: ${formatTime(status.solo.included)}`);
        console.log(`  Used:     ${formatTime(status.solo.used)}`);
        console.log(`  Remaining: ${formatTime(status.solo.remaining)}`);
        console.log(`  Percent:  ${(status.solo.percentUsed * 100).toFixed(1)}%`);

        console.log('\nHost Mode:');
        console.log(`  Included: ${formatTime(status.host.included)}`);
        console.log(`  Used:     ${formatTime(status.host.used)}`);
        console.log(`  Remaining: ${formatTime(status.host.remaining)}`);
        console.log(`  Percent:  ${(status.host.percentUsed * 100).toFixed(1)}%`);

        console.log('\nStatus:');
        console.log(`  Warning:  ${status.isWarning ? '⚠️ YES' : '✅ No'}`);
        console.log(`  Exceeded: ${status.isExceeded ? '🚫 YES' : '✅ No'}`);

        // Check what action would be taken
        const soloCheck = await checkQuotaLimit(churchId, 'solo');
        const hostCheck = await checkQuotaLimit(churchId, 'host');

        console.log('\nActions:');
        console.log(`  Solo mode: ${soloCheck.action.toUpperCase()}${soloCheck.message ? ` - ${soloCheck.message}` : ''}`);
        console.log(`  Host mode: ${hostCheck.action.toUpperCase()}${hostCheck.message ? ` - ${hostCheck.message}` : ''}`);

    } catch (err) {
        console.error('Error getting status:', err.message);
    }
}

async function setUsagePercent(churchId, percent) {
    console.log(`📝 Setting usage to ${(percent * 100).toFixed(0)}%...\n`);

    try {
        // First get the plan limits
        const { data: sub, error: subErr } = await supabaseAdmin
            .from('subscriptions')
            .select(`
                plan_id,
                plans (
                    included_seconds_per_month,
                    included_solo_seconds_per_month,
                    included_host_seconds_per_month
                )
            `)
            .eq('church_id', churchId)
            .in('status', ['active', 'trialing'])
            .single();

        if (subErr || !sub) {
            console.error('❌ No active subscription found:', subErr?.message);
            return;
        }

        const plan = sub.plans;
        const soloIncluded = plan.included_solo_seconds_per_month || Math.floor(plan.included_seconds_per_month / 2);
        const hostIncluded = plan.included_host_seconds_per_month || Math.floor(plan.included_seconds_per_month / 2);

        const targetSolo = Math.floor(soloIncluded * percent);
        const targetHost = Math.floor(hostIncluded * percent);

        console.log(`Plan limits:`);
        console.log(`  Solo: ${formatTime(soloIncluded)}`);
        console.log(`  Host: ${formatTime(hostIncluded)}`);
        console.log(`\nTarget usage (${(percent * 100).toFixed(0)}%):`);
        console.log(`  Solo: ${formatTime(targetSolo)}`);
        console.log(`  Host: ${formatTime(targetHost)}`);

        // Get current month start
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const monthStartStr = monthStart.toISOString().split('T')[0];

        // Upsert solo_seconds
        await supabaseAdmin
            .from('usage_monthly')
            .upsert({
                church_id: churchId,
                month_start: monthStartStr,
                metric: 'solo_seconds',
                total_quantity: targetSolo
            }, { onConflict: 'church_id,month_start,metric' });

        // Upsert host_seconds
        await supabaseAdmin
            .from('usage_monthly')
            .upsert({
                church_id: churchId,
                month_start: monthStartStr,
                metric: 'host_seconds',
                total_quantity: targetHost
            }, { onConflict: 'church_id,month_start,metric' });

        console.log('\n✅ Usage updated successfully!');
        console.log('\nNew status:');
        await showStatus(churchId);

    } catch (err) {
        console.error('Error setting usage:', err.message);
    }
}

async function resetUsage(churchId) {
    console.log('🗑️ Resetting usage for current month...\n');

    try {
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const monthStartStr = monthStart.toISOString().split('T')[0];

        // Delete solo and host metrics for this month
        const { error } = await supabaseAdmin
            .from('usage_monthly')
            .delete()
            .eq('church_id', churchId)
            .eq('month_start', monthStartStr)
            .in('metric', ['solo_seconds', 'host_seconds', 'session_seconds']);

        if (error) {
            console.error('❌ Error resetting:', error.message);
            return;
        }

        console.log('✅ Usage reset successfully!');
        console.log('\nNew status:');
        await showStatus(churchId);

    } catch (err) {
        console.error('Error resetting usage:', err.message);
    }
}

function formatTime(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
}

main().catch(console.error);
