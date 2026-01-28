/**
 * Supabase Admin Client
 * 
 * Server-side Supabase client using service role key.
 * This client bypasses Row Level Security (RLS) and should only be used
 * for server-side operations after proper authentication/authorization.
 * 
 * SECURITY: Never expose this client or the service role key to the frontend.
 * 
 * NOTE: Uses lazy initialization to ensure environment variables are loaded first.
 */

import { createClient } from "@supabase/supabase-js";

let _supabaseAdmin = null;

/**
 * Get admin client with service role privileges (lazy-initialized)
 * - Bypasses RLS for server-side operations
 * - Used for fetching user profiles after JWT verification
 * - Stateless (no session persistence)
 */
function getSupabaseAdmin() {
    if (!_supabaseAdmin) {
        const supabaseUrl = process.env.SUPABASE_URL;
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !serviceRoleKey) {
            throw new Error(
                "Missing required Supabase configuration: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env"
            );
        }

        _supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
            },
        });
    }
    return _supabaseAdmin;
}

// Export as a Proxy to maintain the same API (supabaseAdmin.from(...))
export const supabaseAdmin = new Proxy({}, {
    get(target, prop) {
        return getSupabaseAdmin()[prop];
    }
});
