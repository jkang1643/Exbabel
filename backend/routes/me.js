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

    // DEV OVERRIDE: Inject ENV CHURCH_ID if set, to match server.js logic (DEV ONLY)
    const isDev = process.env.NODE_ENV !== 'production';
    let effectiveProfile = profile;
    if (isDev && (process.env.CHURCH_ID || process.env.TEST_CHURCH_ID) && profile) {
        effectiveProfile = { ...profile, church_id: process.env.CHURCH_ID || process.env.TEST_CHURCH_ID };
    }

    res.json({
        user_id,
        email,
        profile: effectiveProfile,
        isVisitor: !effectiveProfile,
        // Legacy fields for backwards compatibility
        church_id: effectiveProfile?.church_id || null,
        church_name: effectiveProfile?.church_name || null,
        role: effectiveProfile?.role || null,
    });
});
