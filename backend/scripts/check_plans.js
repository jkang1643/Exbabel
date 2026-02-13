/**
 * Check Current Plans & Database Connection
 * 
 * Usage: 
 *   node scripts/check_plans.js
 * 
 * This script connects using the CURRENT environment variables in .env
 * and prints the Supabase URL and the Plans table content.
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from backend root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('--- Database Connection Info ---');
console.log(`URL: ${supabaseUrl || 'NOT SET'}`);
// Mask key for safety
console.log(`Key: ${serviceKey ? serviceKey.slice(0, 10) + '...' : 'NOT SET'}`);
console.log('--------------------------------');

if (!supabaseUrl || !serviceKey) {
    console.error('❌ Missing Supabase credentials in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

async function checkPlans() {
    console.log('\nQuerying plans table...');
    const { data: plans, error } = await supabase
        .from('plans')
        .select('code, name, stripe_price_id')
        .order('code');

    if (error) {
        console.error('❌ Error fetching plans:', error.message);
        return;
    }

    if (!plans || plans.length === 0) {
        console.log('⚠️ No plans found in table.');
        return;
    }

    console.log('\n✅ Current Plans in DB:');
    console.table(plans);

    // Basic heuristic check
    const isTest = plans.some(p => p.stripe_price_id && p.stripe_price_id.includes('test'));
    const isLive = plans.some(p => p.stripe_price_id && !p.stripe_price_id.includes('test') && p.stripe_price_id.startsWith('price_'));

    console.log('\n--- Analysis ---');
    if (isTest) {
        console.log('ℹ️  These look like TEST MODE price IDs.');
    } else if (isLive) {
        console.log('ℹ️  These look like LIVE MODE price IDs.');
    } else {
        console.log('❓ Could not determine mode from Price IDs (or they are missing).');
    }
}

checkPlans();
