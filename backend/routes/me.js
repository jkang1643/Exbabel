/**
 * User Context Endpoint
 * 
 * Provides authenticated user's context (user_id, church_id, role).
 * Serves as a health check for the authentication flow.
 */

import express from "express";
import { requireAuthContext } from "../middleware/requireAuthContext.js";

export const meRouter = express.Router();

/**
 * GET /api/me
 * 
 * Returns the authenticated user's context.
 * Requires valid JWT token in Authorization header.
 * 
 * Response: { user_id, church_id, role }
 */
meRouter.get("/me", requireAuthContext, (req, res) => {
    // req.auth is guaranteed to exist here (set by requireAuthContext middleware)
    res.json(req.auth);
});
