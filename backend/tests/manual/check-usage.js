/**
 * Manual Verification Utility: Check Usage Daily
 * 
 * This script allows you to quickly check the current usage totals
 * for a specific church or for all churches for today.
 * 
 * Usage:
 * node backend/tests/manual/check-usage.js [church_id]
 */

import { supabaseAdmin } from '../../supabaseAdmin.js';
import dotenv from 'dotenv';
dotenv.config();

async function checkUsage() {
    const churchId = process.argv[2];
    const today = new Date().toISOString().split('T')[0];

    console.log(`\n--- Usage Daily Report (${today}) ---\n`);

    let query = supabaseAdmin
        .from('usage_daily')
        .select('church_id, metric, quantity, updated_at')
        .eq('date', today);

    if (churchId) {
        query = query.eq('church_id', churchId);
        console.log(`Filtering for Church ID: ${churchId}\n`);
    }

    const { data, error } = await query;

    if (error) {
        console.error('❌ Error fetching usage:', error.message);
        process.exit(1);
    }

    if (!data || data.length === 0) {
        console.log('No usage records found for today.');
    } else {
        // Group by church
        const byChurch = data.reduce((acc, row) => {
            if (!acc[row.church_id]) acc[row.church_id] = [];
            acc[row.church_id].push(row);
            return acc;
        }, {});

        for (const [id, records] of Object.entries(byChurch)) {
            console.log(`Church: ${id}`);
            records.forEach(r => {
                console.log(`  - ${r.metric.padEnd(25)} : ${r.quantity.toString().padStart(8)} (updated ${new Date(r.updated_at).toLocaleTimeString()})`);
            });
            console.log('');
        }
    }
}

checkUsage().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
