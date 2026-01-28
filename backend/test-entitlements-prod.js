/**
 * Test Entitlements Debug Endpoint
 * 
 * Authenticates with test credentials and calls /api/debug/entitlements
 * Run: node test-entitlements-prod.js
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const testEmail = process.env.TEST_EMAIL;
const testPassword = process.env.TEST_PASSWORD;

if (!supabaseUrl || !supabaseKey || !testEmail || !testPassword) {
    console.error("Missing required env vars: SUPABASE_URL, SUPABASE_KEY, TEST_EMAIL, TEST_PASSWORD");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testDebugEndpoint() {
    console.log("\\n=== Test Entitlements Debug Endpoint ===");
    console.log(`Target: ${supabaseUrl}`);
    console.log(`User: ${testEmail}`);

    // Step 1: Sign in
    console.log("\\n1. Signing in...");
    const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
        email: testEmail,
        password: testPassword
    });

    if (authErr || !authData.session) {
        console.error("❌ Sign in failed:", authErr?.message);
        process.exit(1);
    }

    const token = authData.session.access_token;
    console.log("   ✓ Signed in successfully");
    console.log(`   Token preview: ${token.substring(0, 30)}...`);

    // Step 2: Call debug endpoint
    console.log("\\n2. Calling /api/debug/entitlements...");

    try {
        const response = await fetch("http://localhost:3001/api/debug/entitlements", {
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("❌ Request failed:", response.status, data);
            process.exit(1);
        }

        console.log("   ✓ Request successful!\\n");
        console.log("=== Entitlements Response ===");
        console.log(JSON.stringify(data, null, 2));

    } catch (e) {
        console.error("❌ Fetch error:", e.message);
        console.log("   Is the server running on port 3001?");
        process.exit(1);
    }

    console.log("\\n=== Test Complete ===\\n");
}

testDebugEndpoint().catch(console.error);
