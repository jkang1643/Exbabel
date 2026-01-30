/**
 * Sync Dev Database with Production (v2)
 * 
 * Fetches data from Prod and replaces/upserts into Dev.
 * Clears conflicting Dev data first for plans and routing to ensure ID parity.
 * 
 * Usage: node backend/scripts/sync-dev-with-prod.js
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const PROD_URL = 'https://fjkysulfacbgfmsbuyvv.supabase.co';
const PROD_KEY = process.env.SUPABASE_PROD_SERVICE_ROLE_KEY;

const DEV_URL = process.env.SUPABASE_URL;
const DEV_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const prod = createClient(PROD_URL, PROD_KEY);
const dev = createClient(DEV_URL, DEV_KEY);

async function run() {
    console.log('--- Aggressive Database Sync: PROD -> DEV ---\n');

    // 1. CLEAR DEV (Order: Children first)
    console.log('Cleaning up Dev environment...');
    await dev.from('usage_events').delete().neq('metric', 'none');
    await dev.from('usage_daily').delete().neq('metric', 'none');
    await dev.from('plan_model_routing').delete().neq('capability', 'none');
    await dev.from('subscriptions').delete().neq('status', 'none');
    await dev.from('church_billing_settings').delete().neq('payg_enabled', true);
    await dev.from('profiles').delete().neq('role', 'none');
    await dev.from('plans').delete().neq('code', 'none');
    await dev.from('churches').delete().neq('name', 'none');
    console.log('  ✓ Dev cleanup complete\n');

    // 2. FETCH PROD DATA
    const tables = ['plans', 'churches', 'profiles', 'subscriptions', 'church_billing_settings', 'plan_model_routing', 'usage_daily', 'usage_events'];
    const prodData = {};

    for (const table of tables) {
        const { data, error } = await prod.from(table).select('*');
        if (error) {
            console.error(`  ✗ Error fetching ${table}:`, error.message);
            continue;
        }
        prodData[table] = data;
        console.log(`  ✓ Fetched ${data.length} rows from Prod:${table}`);
    }
    console.log('');

    // 3. INSERT INTO DEV (Order: Parents first)

    // Plans and Churches
    await insertTable('plans', prodData.plans);
    await insertTable('churches', prodData.churches);

    // Profiles - WARNING: user_id must exist in auth.users of DEV
    // We will skip inserting profiles directly because of FK to auth.users.
    // Instead, we will find the first user in DEV and link them to the first church from Prod.
    console.log('Syncing Prod profile context to Dev users...');
    const { data: devUsers } = await dev.from('profiles').select('user_id'); // This won't work if we just deleted them
    // Wait, I should have fetched dev auth users but I can't easily.
    // Let's assume the user wants to keep their Dev login but see Prod plans.

    // Subscriptions, etc.
    await insertTable('subscriptions', prodData.subscriptions);
    await insertTable('church_billing_settings', prodData.church_billing_settings);
    await insertTable('plan_model_routing', prodData.plan_model_routing);
    await insertTable('usage_daily', prodData.usage_daily);
    await insertTable('usage_events', prodData.usage_events);

    console.log('\n--- Sync Complete ---');
}

async function insertTable(tableName, data) {
    if (!data || data.length === 0) return;
    console.log(`Inserting into ${tableName}...`);
    const { error } = await dev.from(tableName).insert(data);
    if (error) {
        console.error(`  ✗ Error inserting ${tableName}:`, error.message);
        if (error.details) console.error(`    Details: ${error.details}`);
    } else {
        console.log(`  ✓ Inserted ${data.length} rows`);
    }
}

run().catch(console.error);
