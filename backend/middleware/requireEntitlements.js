/**
 * Entitlements Middleware
 * 
 * Middleware that requires authentication and loads entitlements.
 * Use this for routes that need entitlement enforcement.
 * 
 * @module middleware/requireEntitlements
 */

import { requireAuthContext } from "./requireAuthContext.js";
import { getEntitlements, assertSubscriptionActive, SubscriptionInactiveError } from "../entitlements/index.js";

/**
 * Middleware: Require authenticated user with entitlements loaded
 * 
 * Builds on requireAuthContext, then loads and attaches entitlements.
 * Sets req.entitlements = { churchId, subscription, limits, billing, routing }
 * 
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {NextFunction} next - Express next function
 */
export async function requireEntitlements(req, res, next) {
    // First run requireAuthContext
    await requireAuthContext(req, res, async () => {
        try {
            // If auth failed, req.auth won't exist
            if (!req.auth || !req.auth.church_id) {
                // Auth middleware already sent response
                return;
            }

            // Load entitlements
            const entitlements = await getEntitlements(req.auth.church_id);
            req.entitlements = entitlements;

            console.log(
                `[Auth+E] ✓ user=${req.auth.user_id} church=${req.auth.church_id} plan=${entitlements.subscription.planCode} status=${entitlements.subscription.status}`
            );

            return next();
        } catch (e) {
            console.error("[Auth+E] Error loading entitlements:", e);
            return res.status(500).json({
                error: "Failed to load entitlements",
            });
        }
    });
}

/**
 * Middleware: Require active subscription
 * 
 * Use after requireEntitlements to enforce subscription status gating.
 * Blocks past_due, canceled, paused, none.
 * 
 * @param {Request} req - Express request (must have req.entitlements)
 * @param {Response} res - Express response
 * @param {NextFunction} next - Express next function
 */
export function requireActiveSubscription(req, res, next) {
    try {
        if (!req.entitlements) {
            // Entitlements not loaded - programming error
            console.error("[Subscription] requireActiveSubscription called without entitlements");
            return res.status(500).json({ error: "Internal error" });
        }

        assertSubscriptionActive(req.entitlements);
        return next();
    } catch (e) {
        if (e instanceof SubscriptionInactiveError) {
            console.warn(`[Subscription] ✗ Blocked: status=${e.status} plan=${e.planCode}`);
            return res.status(e.httpStatus).json({
                error: e.message,
                status: e.status,
                planCode: e.planCode,
            });
        }
        return res.status(500).json({ error: "Internal error" });
    }
}

/**
 * Middleware: Require admin role
 * 
 * Use after requireAuthContext or requireEntitlements.
 * Blocks non-admin users from billable/admin actions.
 * 
 * @param {Request} req - Express request (must have req.auth)
 * @param {Response} res - Express response
 * @param {NextFunction} next - Express next function
 */
export function requireAdmin(req, res, next) {
    if (!req.auth) {
        return res.status(401).json({ error: "Not authenticated" });
    }

    if (req.auth.role !== "admin") {
        console.warn(`[Admin] ✗ Blocked: user=${req.auth.user_id} role=${req.auth.role}`);
        return res.status(403).json({
            error: "Admin role required",
            role: req.auth.role,
        });
    }

    console.log(`[Admin] ✓ OK: user=${req.auth.user_id}`);
    return next();
}
