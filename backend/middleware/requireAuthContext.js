/**
 * Authentication Context Middleware
 * 
 * Verifies JWT token and loads user profile to establish auth context.
 * Attaches { user_id, church_id, role } to req.auth for downstream handlers.
 * 
 * Error responses:
 * - 401: Missing or invalid token
 * - 403: Valid token but no profile created
 * - 500: Internal server error
 */

import { supabaseAdmin } from "../supabaseAdmin.js";

/**
 * Extract Bearer token from Authorization header
 * @param {Request} req - Express request object
 * @returns {string|null} - Token string or null if not found
 */
function getBearerToken(req) {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
        return null;
    }
    return authHeader.slice("Bearer ".length).trim();
}

/**
 * Middleware: Require authenticated user with profile context
 * 
 * Verifies JWT and loads profile from database.
 * Sets req.auth = { user_id, church_id, role }
 * 
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {NextFunction} next - Express next function
 */
export async function requireAuthContext(req, res, next) {
    try {
        // Step 1: Extract token
        const token = getBearerToken(req);
        if (!token) {
            return res.status(401).json({
                error: "Missing bearer token",
            });
        }

        // Step 2: Verify JWT with Supabase
        const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);

        if (userErr || !userData?.user) {
            console.warn("[Auth] Invalid token:", userErr?.message || "No user data");
            return res.status(401).json({
                error: "Invalid token",
            });
        }

        const user_id = userData.user.id;

        // Step 3: Load profile (tenant context)
        const { data: profile, error: profErr } = await supabaseAdmin
            .from("profiles")
            .select("user_id, church_id, role")
            .eq("user_id", user_id)
            .single();

        if (profErr || !profile) {
            console.warn("[Auth] Profile not found for user:", user_id, profErr?.message);
            // User is authenticated but hasn't completed onboarding
            return res.status(403).json({
                error: "Profile not created",
            });
        }

        // Step 4: Attach auth context to request
        req.auth = profile; // { user_id, church_id, role }

        console.log(`[Auth] ✓ user=${profile.user_id} church=${profile.church_id} role=${profile.role}`);

        return next();
    } catch (e) {
        console.error("[Auth] Unexpected error in requireAuthContext:", e);
        return res.status(500).json({
            error: "Internal error",
        });
    }
}
