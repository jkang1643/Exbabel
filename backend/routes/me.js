/**
 * User Context Endpoint
 * 
 * Provides authenticated user's context.
 * Returns profile info if it exists, or indicates visitor status.
 */

import express from "express";
import { requireAuth } from "../middleware/requireAuthContext.js";

export const meRouter = express.Router();

/**
 * GET /api/me
 * 
 * Returns the authenticated user's context.
 * For visitors (no profile): { user_id, email, profile: null, isVisitor: true }
 * For members: { user_id, email, profile: { church_id, role }, isVisitor: false }
 */
meRouter.get("/me", requireAuth, (req, res) => {
    const { user_id, email, profile } = req.auth;

    res.json({
        user_id,
        email,
        profile,
        isVisitor: !profile,
        // Legacy fields for backwards compatibility
        church_id: profile?.church_id || null,
        role: profile?.role || null,
    });
});
