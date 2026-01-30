/**
 * Compare Dev Database with Production
 * 
 * Reports mismatches in IDs and values for all core tables.
 * 
 * Usage: node backend/scripts/compare-db.js
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

const TABLES = [
    { name: 'plans', key: 'code' },
    { name: 'churches', key: 'name' },
    { name: 'profiles', key: 'user_id' },
    { name: 'subscriptions', key: 'church_id' },
    { name: 'church_billing_settings', key: 'church_id' },
    { name: 'plan_model_routing', key: r => `${r.plan_id}:${r.capability}` },
    { name: 'usage_daily', key: 'metric' }, // Simplified
];

async function compareTable(tableName, configKey) {
    const businessKey = typeof configKey === 'function' ? configKey : (r => r[configKey]);
    console.log(`\n--- Comparing: ${tableName} ---`);
    const { data: prodData } = await prod.from(tableName).select('*');
    const { data: devData } = await dev.from(tableName).select('*');

    if (!prodData || !devData) {
        console.error(`  ✗ Failed to fetch data for ${tableName}`);
        return;
    }

    const prodMap = new Map(prodData.map(r => [businessKey(r), r]));
    const devMap = new Map(devData.map(r => [businessKey(r), r]));

    // 1. Missing in Dev
    const missing = prodData.filter(r => !devMap.has(businessKey(r)));
    if (missing.length > 0) {
        console.log(`  ⚠️  Missing in Dev (${missing.length}):`);
        missing.forEach(r => console.log(`    - Key: ${businessKey(r)}`));
    }

    // 2. ID Mismatches
    const idMismatches = [];
    prodData.forEach(pRow => {
        const dRow = devMap.get(businessKey(pRow));
        if (dRow) {
            const pId = pRow.id || pRow.user_id || pRow.church_id;
            const dId = dRow.id || dRow.user_id || dRow.church_id;
            if (pId !== dId) {
                idMismatches.push({ key: businessKey(pRow), prodId: pId, devId: dId });
            }
        }
    });

    if (idMismatches.length > 0) {
        console.log(`  ❌ ID Mismatches (${idMismatches.length}):`);
        idMismatches.forEach(m => console.log(`    - ${m.key}: Prod=${m.prodId}, Dev=${m.devId}`));
    }

    // 3. Value Mismatches (excluding IDs)
    const valueMismatches = [];
    prodData.forEach(pRow => {
        const dRow = devMap.get(businessKey(pRow));
        if (dRow) {
            const diffs = [];
            Object.keys(pRow).forEach(k => {
                if (['id', 'created_at', 'updated_at', 'user_id', 'church_id', 'plan_id'].includes(k)) return;
                if (JSON.stringify(pRow[k]) !== JSON.stringify(dRow[k])) {
                    diffs.push(`${k} ('${JSON.stringify(pRow[k])}' vs '${JSON.stringify(dRow[k])}')`);
                }
            });
            if (diffs.length > 0) {
                valueMismatches.push({ key: businessKey(pRow), diffs });
            }
        }
    });

    if (valueMismatches.length > 0) {
        console.log(`  🩹 Value Mismatches (${valueMismatches.length}):`);
        valueMismatches.forEach(m => console.log(`    - ${m.key}: ${m.diffs.join(', ')}`));
    }

    if (missing.length === 0 && idMismatches.length === 0 && valueMismatches.length === 0) {
        console.log(`  ✅ Lined up perfect!`);
    }
}

async function run() {
    for (const t of TABLES) {
        await compareTable(t.name, t.key);
    }
}

run().catch(console.error);
