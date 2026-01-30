/**
 * Apply usage RPC migration to DEV database
 */

import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const supabaseUrl = "https://pmxfuofokccifbiqxhpp.supabase.co";
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '.env') });

const supabaseUrl = "https://pmxfuofokccifbiqxhpp.supabase.co";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, serviceRoleKey, {
    db: { schema: 'public' }
});

// Read the migration SQL
const migrationPath = path.join(__dirname, "../supabase/migrations/20260128_record_usage_event.sql");
const sql = fs.readFileSync(migrationPath, "utf8");

console.log("Applying migration to DEV database...");
console.log("SQL length:", sql.length, "characters");

// Use the REST API directly to execute raw SQL
const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec`, {
    method: "POST",
    headers: {
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    },
    body: JSON.stringify({ query: sql })
});

const result = await response.text();

if (!response.ok) {
    console.error("❌ Migration failed!");
    console.error("Status:", response.status);
    console.error("Response:", result);

    // Try alternative: execute via pg_stat_statements or direct query
    console.log("\nTrying alternative method...");
    const { data, error } = await supabase.rpc('record_usage_event', {
        p_church_id: '00000000-0000-0000-0000-000000000000',
        p_metric: 'test',
        p_quantity: 1,
        p_idempotency_key: 'test'
    });

    if (error && error.message.includes('not find the function')) {
        console.log("Function doesn't exist yet. Please run the SQL manually in Supabase SQL Editor.");
        console.log("\nSQL to run:");
        console.log(sql);
    }

    process.exit(1);
}

console.log("✅ Migration applied successfully!");
console.log("Result:", result);
