/**
 * Script to simulate hitting the usage limit for testing.
 * 
 * Usage: 
 *   node backend/scripts/set_test_usage.js --percent=85           # Sets BOTH Solo and Host to 85% of Starter limits
 *   node backend/scripts/set_test_usage.js --percent=100 --plan=pro # Sets BOTH to 100% of Pro limits
 *   node backend/scripts/set_test_usage.js --reset                # Resets BOTH to 0%
 * 
 * Arguments:
 *   --percent=N  (0-100, default 99.7)
 *   --plan=CODE  (starter, pro, unlimited - default: starter)
 *   --reset      (Equivalent to --percent=0)
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Target Church ID from user request
const CHURCH_ID = 'a3ceec33-2448-4a65-a944-ec1158df2e73'; // boyge

async function setTestPlanAndUsage() {
    console.log('--- Setting Test Plan and Usage ---\n');

    // Parse CLI arguments
    const args = process.argv.slice(2);
    const isReset = args.includes('--reset');
    const isLastMinute = args.includes('--last-minute');

    // Percent arg
    const percentArg = args.find(arg => arg.startsWith('--percent='));
    let percent = 99.7;
    if (isReset) percent = 0;
    else if (percentArg) percent = parseFloat(percentArg.split('=')[1]);

    // Plan arg
    const planArg = args.find(arg => arg.startsWith('--plan='));
    let planCode = 'starter';
    if (planArg) planCode = planArg.split('=')[1];

    console.log(`Configuration: Plan=${planCode}, Target Usage=${percent}%`);

    // 1. Get plan details
    const { data: plan, error: planError } = await supabase
        .from('plans')
        .select('id, code, included_solo_seconds_per_month, included_host_seconds_per_month')
        .eq('code', planCode)
        .single();

    if (planError || !plan) {
        throw new Error(`Could not find plan '${planCode}': ${planError?.message}`);
    }

    const soloLimit = plan.included_solo_seconds_per_month;
    const hostLimit = plan.included_host_seconds_per_month;

    console.log(`Plan Limits: Solo=${soloLimit}s, Host=${hostLimit}s`);

    // 2. Update subscription
    const { error: subError } = await supabase
        .from('subscriptions')
        .update({
            plan_id: plan.id,
            status: 'active'
        })
        .eq('church_id', CHURCH_ID);

    if (subError) throw new Error(`Subscription update error: ${subError.message}`);
    console.log(`✓ Subscription updated to '${planCode}'`);

    // 3. Calculate target usage for both metrics
    let targetSolo, targetHost;

    if (isLastMinute) {
        console.log('Calculating target usage for LAST MINUTE (limit - 60s)...');
        targetSolo = Math.max(0, soloLimit - 60);
        targetHost = Math.max(0, hostLimit - 60);

        // Recalculate percent for display
        percent = ((targetSolo / soloLimit) * 100).toFixed(4);
    } else {
        targetSolo = Math.floor(soloLimit * (percent / 100));
        targetHost = Math.floor(hostLimit * (percent / 100));
    }

    console.log(`Setting Usage:`);
    console.log(`  Solo: ${targetSolo}s / ${soloLimit}s (${percent}%)`);
    console.log(`  Host: ${targetHost}s / ${hostLimit}s (${percent}%)`);

    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const today = now.toISOString().split('T')[0];

    // 4. Update usage_monthly (CRITICAL for quota enforcement)
    const updates = [
        {
            church_id: CHURCH_ID,
            month_start: startDate,
            metric: 'solo_seconds',
            total_quantity: targetSolo
        },
        {
            church_id: CHURCH_ID,
            month_start: startDate,
            metric: 'host_seconds',
            total_quantity: targetHost
        }
    ];

    const { error: monthlyError } = await supabase
        .from('usage_monthly')
        .upsert(updates, { onConflict: 'church_id, month_start, metric' });

    if (monthlyError) throw new Error(`Monthly Usage update error: ${monthlyError.message}`);

    // 5. Update usage_daily (for charts/graphs) - update both metrics
    const dailyUpdates = [
        {
            church_id: CHURCH_ID,
            date: today,
            metric: 'solo_active_seconds',
            quantity: targetSolo
        },
        {
            church_id: CHURCH_ID,
            date: today,
            metric: 'host_active_seconds',
            quantity: targetHost
        }
    ];

    const { error: dailyError } = await supabase
        .from('usage_daily')
        .upsert(dailyUpdates, { onConflict: 'church_id, date, metric' });

    if (dailyError) throw new Error(`Daily Usage update error: ${dailyError.message}`);

    console.log(`✓ Successfully updated usage for BOTH Solo and Host modes to ${percent}% of '${planCode}' limits.`);
    console.log('  Refresh your dashboard to see the change.');
}

setTestPlanAndUsage().catch(console.error);
