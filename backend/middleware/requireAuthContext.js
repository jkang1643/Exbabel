/**
 * Authentication Middleware
 * 
 * Verifies JWT token and optionally loads user profile.
 * 
 * Two middlewares exported:
 * - requireAuth: Just verifies JWT, profile can be null (for visitors)
 * - requireChurchMember: Requires valid profile with church_id
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
 * Middleware: Require authenticated user (profile optional)
 * 
 * Verifies JWT and loads profile if it exists.
 * Sets req.auth = { user_id, email, profile }
 * where profile may be null for visitors
 * 
 * @param {Request} req - Express request
 * @param {Response} res - Express response  
 * @param {NextFunction} next - Express next function
 */
export async function requireAuth(req, res, next) {
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

        const user = userData.user;

        // Step 3: Load profile (may not exist - that's OK for visitors)
        const { data: profile, error: profErr } = await supabaseAdmin
            .from("profiles")
            .select("user_id, church_id, role")
            .eq("user_id", user.id)
            .single();

        // Step 4: Attach auth context to request
        // Profile can be null for visitors who haven't joined a church
        req.auth = {
            user_id: user.id,
            email: user.email,
            profile: profile || null, // null if no profile
        };

        if (profile) {
            console.log(`[Auth] ✓ Member: user=${profile.user_id} church=${profile.church_id} role=${profile.role}`);
        } else {
            console.log(`[Auth] ✓ Visitor: user=${user.id} (no profile)`);
        }

        return next();
    } catch (e) {
        console.error("[Auth] Unexpected error in requireAuth:", e);
        return res.status(500).json({
            error: "Internal error",
        });
    }
}

/**
 * Middleware: Require church membership
 * 
 * Must be used AFTER requireAuth.
 * Blocks requests if user has no profile/church linkage.
 */
export function requireChurchMember(req, res, next) {
    if (!req.auth?.profile?.church_id) {
        return res.status(403).json({
            error: "Church membership required",
            code: "NO_CHURCH",
        });
    }
    return next();
}

/**
 * Middleware: Require admin role
 * 
 * Must be used AFTER requireAuth.
 * Blocks requests if user is not an admin.
 */
export function requireAdmin(req, res, next) {
    if (!req.auth?.profile?.church_id) {
        return res.status(403).json({
            error: "Church membership required",
            code: "NO_CHURCH",
        });
    }
    if (req.auth.profile.role !== "admin") {
        return res.status(403).json({
            error: "Admin role required",
            code: "NOT_ADMIN",
        });
    }
    return next();
}

/**
 * LEGACY: Backwards-compatible alias
 * Requires both auth AND profile (old behavior)
 */
export async function requireAuthContext(req, res, next) {
    try {
        const token = getBearerToken(req);
        if (!token) {
            return res.status(401).json({ error: "Missing bearer token" });
        }

        const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
        if (userErr || !userData?.user) {
            return res.status(401).json({ error: "Invalid token" });
        }

        const user_id = userData.user.id;

        const { data: profile, error: profErr } = await supabaseAdmin
            .from("profiles")
            .select("user_id, church_id, role")
            .eq("user_id", user_id)
            .single();

        if (profErr || !profile) {
            console.warn("[Auth] Profile not found for user:", user_id, profErr?.message);
            return res.status(403).json({ error: "Profile not created" });
        }

        req.auth = profile; // Legacy format: { user_id, church_id, role }
        console.log(`[Auth] ✓ user=${profile.user_id} church=${profile.church_id} role=${profile.role}`);

        return next();
    } catch (e) {
        console.error("[Auth] Unexpected error:", e);
        return res.status(500).json({ error: "Internal error" });
    }
}
