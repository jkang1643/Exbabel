/**
 * PROD DB Backfill Script
 * 
 * Ensures every church has:
 * 1. A subscription row (defaults to starter/trialing)
 * 2. A church_billing_settings row
 * 
 * Run: node prod-backfill.js
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
});

async function backfill() {
    console.log("\\n=== PROD Backfill Script ===");
    console.log(`Target: ${supabaseUrl}`);

    // Step 1: Get starter plan ID
    console.log("\\n1. Looking up starter plan...");
    const { data: starterPlan, error: planErr } = await supabase
        .from("plans")
        .select("id, code")
        .eq("code", "starter")
        .single();

    if (planErr || !starterPlan) {
        console.error("❌ Starter plan not found:", planErr?.message);
        console.log("   → You need to insert the starter plan first.");
        process.exit(1);
    }
    console.log(`   ✓ Found plan: ${starterPlan.code} (${starterPlan.id})`);

    // Step 2: Find churches without subscriptions
    console.log("\\n2. Finding churches without subscriptions...");
    const { data: churches, error: churchErr } = await supabase
        .from("churches")
        .select("id, name");

    if (churchErr) {
        console.error("❌ Error fetching churches:", churchErr.message);
        process.exit(1);
    }
    console.log(`   Found ${churches.length} total churches`);

    // Step 3: Check existing subscriptions
    const { data: existingSubs } = await supabase
        .from("subscriptions")
        .select("church_id");

    const existingSubChurchIds = new Set((existingSubs || []).map(s => s.church_id));
    const churchesNeedingSubs = churches.filter(c => !existingSubChurchIds.has(c.id));

    console.log(`   ${churchesNeedingSubs.length} churches need subscriptions`);

    // Step 4: Insert missing subscriptions
    if (churchesNeedingSubs.length > 0) {
        console.log("\\n3. Inserting missing subscriptions...");
        for (const church of churchesNeedingSubs) {
            const { error: insertErr } = await supabase
                .from("subscriptions")
                .insert({
                    church_id: church.id,
                    plan_id: starterPlan.id,
                    status: "trialing"
                });

            if (insertErr) {
                console.error(`   ❌ Failed for ${church.name}: ${insertErr.message}`);
            } else {
                console.log(`   ✓ Created subscription for: ${church.name}`);
            }
        }
    }

    // Step 5: Check existing billing settings
    console.log("\\n4. Finding churches without billing settings...");
    const { data: existingBilling } = await supabase
        .from("church_billing_settings")
        .select("church_id");

    const existingBillingChurchIds = new Set((existingBilling || []).map(b => b.church_id));
    const churchesNeedingBilling = churches.filter(c => !existingBillingChurchIds.has(c.id));

    console.log(`   ${churchesNeedingBilling.length} churches need billing settings`);

    // Step 6: Insert missing billing settings
    if (churchesNeedingBilling.length > 0) {
        console.log("\\n5. Inserting missing billing settings...");
        for (const church of churchesNeedingBilling) {
            const { error: insertErr } = await supabase
                .from("church_billing_settings")
                .insert({
                    church_id: church.id,
                    payg_enabled: false,
                    payg_rate_cents_per_hour: 0,
                    allow_overage_while_live: false
                });

            if (insertErr) {
                console.error(`   ❌ Failed for ${church.name}: ${insertErr.message}`);
            } else {
                console.log(`   ✓ Created billing settings for: ${church.name}`);
            }
        }
    }

    console.log("\\n=== Backfill Complete ===\\n");
}

backfill().catch(console.error);
