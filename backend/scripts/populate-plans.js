/**
 * Script to populate plans and model routing data
 * 
 * Usage: node backend/scripts/populate-plans.js
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

async function populate() {
    console.log('--- Populating Plans and Routing ---\n');

    // 1. Defined Plans
    const plans = [
        {
            code: 'starter',
            name: 'Starter',
            included_seconds_per_month: 36000,
            max_session_seconds: 7200,
            max_simultaneous_languages: 2,
            stt_tier: 'basic',
            tts_tier: 'basic',
            feature_flags: {}
        },
        {
            code: 'pro',
            name: 'Pro',
            included_seconds_per_month: 180000,
            max_session_seconds: 14400,
            max_simultaneous_languages: 5,
            stt_tier: 'pro',
            tts_tier: 'pro',
            feature_flags: {}
        },
        {
            code: 'unlimited',
            name: 'Unlimited',
            included_seconds_per_month: 1800000,
            max_session_seconds: null,
            max_simultaneous_languages: 99,
            stt_tier: 'unlimited',
            tts_tier: 'unlimited',
            feature_flags: {}
        }
    ];

    for (const plan of plans) {
        console.log(`Checking plan: ${plan.code}...`);
        const { data: upsertedPlan, error: pErr } = await supabase
            .from('plans')
            .upsert(plan, { onConflict: 'code' })
            .select()
            .single();

        if (pErr) {
            console.error(`  ✗ Error upserting plan ${plan.code}:`, pErr.message);
            continue;
        }

        console.log(`  ✓ Plan ${plan.code} ready (ID: ${upsertedPlan.id})`);

        // 2. Clear existing routing for this plan (since we don't have a unique constraint yet)
        await supabase.from('plan_model_routing').delete().eq('plan_id', upsertedPlan.id);

        // 3. Define Routing for this plan
        const routing = [];

        if (plan.code === 'starter') {
            routing.push(
                { plan_id: upsertedPlan.id, capability: 'translate', provider: 'openai', model: 'gpt-4o-mini', params: {} },
                { plan_id: upsertedPlan.id, capability: 'stt', provider: 'google', model: 'v1p1beta1', params: { model: 'latest_long', useEnhanced: true } },
                { plan_id: upsertedPlan.id, capability: 'tts', provider: 'google', model: 'neural2', params: {} },
                { plan_id: upsertedPlan.id, capability: 'grammar', provider: 'openai', model: 'gpt-4o-mini', params: { temperature: 0 } }
            );
        } else if (plan.code === 'pro') {
            routing.push(
                { plan_id: upsertedPlan.id, capability: 'translate', provider: 'openai', model: 'gpt-4o', params: {} },
                { plan_id: upsertedPlan.id, capability: 'stt', provider: 'google', model: 'v1p1beta1', params: { model: 'latest_long', useEnhanced: true, enableAutomaticPunctuation: true } },
                { plan_id: upsertedPlan.id, capability: 'tts', provider: 'google', model: 'studio', params: {} },
                { plan_id: upsertedPlan.id, capability: 'grammar', provider: 'deepseek', model: 'deepseek-chat', params: { temperature: 0 } }
            );
        } else if (plan.code === 'unlimited') {
            routing.push(
                { plan_id: upsertedPlan.id, capability: 'translate', provider: 'openai', model: 'gpt-realtime-mini', params: {} },
                { plan_id: upsertedPlan.id, capability: 'stt', provider: 'google', model: 'v1p1beta1', params: { model: 'latest_long', useEnhanced: true, enableAutomaticPunctuation: true, profanityFilter: false } },
                { plan_id: upsertedPlan.id, capability: 'tts', provider: 'elevenlabs', model: 'elevenlabs_flash', params: {} },
                { plan_id: upsertedPlan.id, capability: 'grammar', provider: 'deepseek', model: 'deepseek-chat', params: { temperature: 0 } }
            );
        }

        for (const route of routing) {
            const { error: rErr } = await supabase
                .from('plan_model_routing')
                .upsert(route, { onConflict: 'plan_id,capability' });

            if (rErr) {
                console.error(`    ✗ Error upserting route ${route.capability}:`, rErr.message);
            } else {
                console.log(`    ✓ Route ${route.capability.padEnd(10)} : ${route.provider}/${route.model}`);
            }
        }
        console.log('');
    }

    console.log('--- Population Complete ---');
}

populate().catch(console.error);
