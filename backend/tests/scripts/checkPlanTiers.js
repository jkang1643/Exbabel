/**
 * Quick diagnostic script to check what tts_tier values are set for each plan
 * Run: node backend/tests/scripts/checkPlanTiers.js
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkPlanTiers() {
    console.log('=== Plan TTS Tier Check ===\n');

    // 1. Check all plans and their tts_tier values
    const { data: plans, error: plansError } = await supabase
        .from('plans')
        .select('id, code, name, tts_tier, stt_tier')
        .order('code');

    if (plansError) {
        console.error('Failed to fetch plans:', plansError.message);
        return;
    }

    console.log('Plans in database:');
    console.log('─'.repeat(60));
    for (const plan of plans) {
        console.log(`  ${plan.code.padEnd(12)} | tts_tier: ${(plan.tts_tier || 'NULL').padEnd(10)} | stt_tier: ${plan.stt_tier || 'NULL'}`);
    }

    // 2. Check what the pro plan should map to
    console.log('\n\nExpected tier mappings:');
    console.log('─'.repeat(60));
    console.log('  starter  -> tts_tier should be "starter" or "basic" -> [standard, neural2, studio]');
    console.log('  pro      -> tts_tier should be "pro"                 -> [chirp3_hd, standard, neural2, studio]');
    console.log('  unlimited-> tts_tier should be "unlimited"           -> [gemini, elevenlabs, chirp3_hd, ...]');

    // 3. Check church 71afaace-d9e6-4c94-84ed-b504efe7fa1c subscription
    const testChurchId = '71afaace-d9e6-4c94-84ed-b504efe7fa1c';

    const { data: sub, error: subError } = await supabase
        .from('subscriptions')
        .select(`
      status,
      plan_id,
      plans (
        code,
        tts_tier
      )
    `)
        .eq('church_id', testChurchId)
        .single();

    console.log('\n\nYour church subscription:');
    console.log('─'.repeat(60));
    if (subError) {
        console.log(`  ❌ Error fetching subscription: ${subError.message}`);
    } else if (sub) {
        console.log(`  Church ID: ${testChurchId}`);
        console.log(`  Status: ${sub.status}`);
        console.log(`  Plan: ${sub.plans?.code || 'unknown'}`);
        console.log(`  tts_tier in DB: ${sub.plans?.tts_tier || 'NULL'}`);

        if (sub.plans?.code === 'pro' && sub.plans?.tts_tier !== 'pro') {
            console.log('\n  ⚠️  BUG FOUND: Pro plan has tts_tier="${sub.plans?.tts_tier}" instead of "pro"!');
            console.log('  FIX: Run this SQL in Supabase:');
            console.log(`    UPDATE plans SET tts_tier = 'pro' WHERE code = 'pro';`);
        }
    }

    console.log('\n');
}

checkPlanTiers().catch(console.error);
