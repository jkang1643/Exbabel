/**
 * Supabase Admin Client
 * 
 * Server-side Supabase client using service role key.
 * This client bypasses Row Level Security (RLS) and should only be used
 * for server-side operations after proper authentication/authorization.
 * 
 * SECURITY: Never expose this client or the service role key to the frontend.
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
        "Missing required Supabase configuration: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env"
    );
}

/**
 * Admin client with service role privileges
 * - Bypasses RLS for server-side operations
 * - Used for fetching user profiles after JWT verification
 * - Stateless (no session persistence)
 */
export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
    },
});
