/**
 * Surgical Sync: Dev -> Prod
 * 
 * Aligns IDs and values without deleting data whenever possible.
 * Handles Foreign Key dependencies by updating children first where needed, 
 * or updating parents by natural key.
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const PROD_URL = 'https://fjkysulfacbgfmsbuyvv.supabase.co';
const PROD_KEY = 'sb_secret_xG6Otfiw4SAqCdcgsbMpMw_MxFr8bEK';

const DEV_URL = process.env.SUPABASE_URL;
const DEV_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const prod = createClient(PROD_URL, PROD_KEY);
const dev = createClient(DEV_URL, DEV_KEY);

async function alignPlans() {
    console.log('Aligning Plans...');
    const { data: pPlans } = await prod.from('plans').select('*');
    const { data: dPlans } = await dev.from('plans').select('*');

    for (const pPlan of pPlans) {
        const dPlan = dPlans.find(d => d.code === pPlan.code);
        if (dPlan) {
            if (dPlan.id !== pPlan.id) {
                console.log(`  Updating ID for plan ${pPlan.code}: ${dPlan.id} -> ${pPlan.id}`);

                // 1. Rename old code to avoid unique constraint violation
                await dev.from('plans').update({ code: pPlan.code + '_old' }).eq('id', dPlan.id);

                // 2. Insert new plan with Prod ID
                const { error: insErr } = await dev.from('plans').insert(pPlan);
                if (insErr) {
                    console.error(`    ✗ Failed to insert plan with new ID: ${insErr.message}`);
                    // Rollback rename
                    await dev.from('plans').update({ code: pPlan.code }).eq('id', dPlan.id);
                } else {
                    // 3. Move all references in Dev to the new Prod ID
                    await dev.from('subscriptions').update({ plan_id: pPlan.id }).eq('plan_id', dPlan.id);
                    await dev.from('plan_model_routing').update({ plan_id: pPlan.id }).eq('plan_id', dPlan.id);

                    // 4. Delete the old record (safe because we moved Fks)
                    await dev.from('plans').delete().eq('id', dPlan.id);
                    console.log(`    ✓ Plan ID updated successfully`);
                }
            } else {
                // IDs match, just sync values
                await dev.from('plans').upsert(pPlan);
                console.log(`  ✓ Plan ${pPlan.code} values synced`);
            }
        } else {
            console.log(`  Inserting missing plan: ${pPlan.code}`);
            await dev.from('plans').insert(pPlan);
        }
    }
}

async function alignChurches() {
    console.log('Aligning Churches...');
    const { data: pChurches } = await prod.from('churches').select('*');
    const { data: dChurches } = await dev.from('churches').select('*');

    for (const pChurch of pChurches) {
        const dChurch = dChurches.find(c => c.name === pChurch.name);
        if (dChurch) {
            if (dChurch.id !== pChurch.id) {
                console.log(`  Updating ID for church ${pChurch.name}: ${dChurch.id} -> ${pChurch.id}`);
                // Update all possible references
                await dev.from('profiles').update({ church_id: pChurch.id }).eq('church_id', dChurch.id);
                await dev.from('subscriptions').update({ church_id: pChurch.id }).eq('church_id', dChurch.id);
                await dev.from('church_billing_settings').update({ church_id: pChurch.id }).eq('church_id', dChurch.id);
                await dev.from('usage_daily').update({ church_id: pChurch.id }).eq('church_id', dChurch.id);
                await dev.from('usage_events').update({ church_id: pChurch.id }).eq('church_id', dChurch.id);

                await dev.from('churches').insert(pChurch);
                await dev.from('churches').delete().eq('id', dChurch.id);
            } else {
                await dev.from('churches').upsert(pChurch);
            }
        } else {
            await dev.from('churches').insert(pChurch);
        }
    }
}

async function run() {
    console.log('--- Surgical Alignment: PROD -> DEV ---\n');
    await alignPlans();
    await alignChurches();

    // Plan Model Routing Alignment
    console.log('Aligning Plan Model Routing...');
    const { data: pRoutes } = await prod.from('plan_model_routing').select('*');
    const { data: dRoutes } = await dev.from('plan_model_routing').select('*');

    for (const pRoute of pRoutes) {
        const dRoute = dRoutes.find(d => d.plan_id === pRoute.plan_id && d.capability === pRoute.capability);
        if (dRoute) {
            if (dRoute.id !== pRoute.id) {
                console.log(`  Updating ID for route ${pRoute.capability} (Plan: ${pRoute.plan_id})`);
                await dev.from('plan_model_routing').delete().eq('id', dRoute.id);
                await dev.from('plan_model_routing').insert(pRoute);
            } else {
                await dev.from('plan_model_routing').upsert(pRoute);
            }
        } else {
            console.log(`  Inserting missing route: ${pRoute.capability} (Plan: ${pRoute.plan_id})`);
            await dev.from('plan_model_routing').insert(pRoute);
        }
    }

    // For other tables, we general sync missing/values
    const remaining = ['subscriptions', 'church_billing_settings'];
    for (const table of remaining) {
        console.log(`Syncing ${table}...`);
        const { data } = await prod.from(table).select('*');
        if (data) {
            const pk = (table === 'church_billing_settings' ? 'church_id' : 'id');
            await dev.from(table).upsert(data, { onConflict: pk });
        }
    }

    // Profiles Alignment - Special handling (Only sync if user exists in Dev)
    console.log('Syncing Profiles (limited to existing Dev users)...');
    const { data: dProfiles } = await dev.from('profiles').select('user_id');
    const devUserIds = new Set(dProfiles.map(p => p.user_id));

    const { data: pProfiles } = await prod.from('profiles').select('*');
    if (pProfiles) {
        const syncableProfiles = pProfiles.filter(p => devUserIds.has(p.user_id));
        if (syncableProfiles.length > 0) {
            await dev.from('profiles').upsert(syncableProfiles, { onConflict: 'user_id' });
            console.log(`  ✓ Synced ${syncableProfiles.length} profiles`);
        } else {
            console.log('  ℹ No matching user_ids found in Dev for Prod profiles');
        }
    }

    console.log('\n--- Alignment Complete ---');
}

run().catch(console.error);
