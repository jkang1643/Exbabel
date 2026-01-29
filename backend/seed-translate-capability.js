/**
 * Seed translate capability in plan_model_routing
 * 
 * Run: node seed-translate-capability.js
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

async function seedTranslateCapability() {
    console.log("\\n=== Seed translate capability ===");
    console.log(`Target: ${supabaseUrl}`);

    // Step 1: Get all plans
    const { data: plans, error: planErr } = await supabase
        .from("plans")
        .select("id, code");

    if (planErr || !plans) {
        console.error("❌ Error fetching plans:", planErr?.message);
        process.exit(1);
    }

    console.log(`Found ${plans.length} plans`);

    // Step 2: Check existing translate routing
    const { data: existingRouting } = await supabase
        .from("plan_model_routing")
        .select("plan_id, capability")
        .eq("capability", "translate");

    const existingPlanIds = new Set((existingRouting || []).map(r => r.plan_id));

    // Step 3: Insert missing translate routing
    for (const plan of plans) {
        if (existingPlanIds.has(plan.id)) {
            console.log(`   ✓ ${plan.code}: translate already exists`);
            continue;
        }

        // Default to gpt-4o-mini for translate
        const { error: insertErr } = await supabase
            .from("plan_model_routing")
            .insert({
                plan_id: plan.id,
                capability: "translate",
                provider: "openai",
                model: "gpt-4o-mini",
                params: null
            });

        if (insertErr) {
            console.error(`   ❌ ${plan.code}: ${insertErr.message}`);
        } else {
            console.log(`   ✓ ${plan.code}: added translate → openai/gpt-4o-mini`);
        }
    }

    console.log("\\n=== Seed complete ===\\n");
}

seedTranslateCapability().catch(console.error);
