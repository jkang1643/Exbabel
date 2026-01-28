/**
 * Debug Entitlements Endpoint
 * 
 * DEV-only endpoint to inspect entitlements for the authenticated user's church.
 * Protected by admin role in production.
 */

import express from "express";
import { requireAuthContext } from "../middleware/requireAuthContext.js";
import { getEntitlements } from "../entitlements/index.js";

export const entitlementsRouter = express.Router();

/**
 * GET /api/debug/entitlements
 * 
 * Returns entitlement data for the authenticated user's church.
 * 
 * Protection:
 * - Requires valid JWT token
 * - In production: requires admin role
 * - In development: any authenticated user
 * 
 * Response:
 * {
 *   planCode: string,
 *   status: string,
 *   limits: { ... },
 *   routing: { capability: { provider, model } }
 * }
 */
entitlementsRouter.get("/debug/entitlements", requireAuthContext, async (req, res) => {
    try {
        const isDev = process.env.NODE_ENV !== "production";

        // In production, require admin role
        if (!isDev && req.auth.role !== "admin") {
            return res.status(403).json({
                error: "Admin role required in production",
            });
        }

        const entitlements = await getEntitlements(req.auth.church_id);

        // Format response for easy debugging
        const response = {
            churchId: entitlements.churchId,
            planCode: entitlements.subscription.planCode,
            status: entitlements.subscription.status,
            currentPeriod: {
                start: entitlements.subscription.currentPeriodStart,
                end: entitlements.subscription.currentPeriodEnd,
            },
            limits: entitlements.limits,
            billing: entitlements.billing,
            routing: Object.entries(entitlements.routing).reduce((acc, [cap, route]) => {
                acc[cap] = {
                    provider: route.provider,
                    model: route.model,
                    hasParams: Object.keys(route.params || {}).length > 0,
                };
                return acc;
            }, {}),
            routingCapabilities: Object.keys(entitlements.routing),
        };

        console.log(`[Debug] Entitlements fetched for church=${req.auth.church_id} by user=${req.auth.user_id}`);

        res.json(response);
    } catch (error) {
        console.error("[Debug] Error fetching entitlements:", error);
        res.status(500).json({
            error: error.message,
        });
    }
});
