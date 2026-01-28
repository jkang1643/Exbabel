/**
 * Usage Debug Routes
 * 
 * Debug endpoints for testing usage recording pipeline.
 * Admin/Dev only access.
 */

import express from 'express';
import { requireAuthContext } from '../middleware/requireAuthContext.js';
import { requireEntitlements } from '../middleware/requireEntitlements.js';
import { recordUsageEvent, generateIdempotencyKey, getMonthToDateUsage, getTodayUsage } from '../usage/index.js';

const router = express.Router();

/**
 * POST /api/debug/usage
 * 
 * Records a test usage event. Admin/Dev only.
 * Body: { metric: 'transcription_seconds', quantity: 30 }
 */
router.post('/debug/usage', requireAuthContext, requireEntitlements, async (req, res) => {
    try {
        // Require admin role in production
        if (process.env.NODE_ENV === 'production') {
            const role = req.auth?.role;
            if (role !== 'admin') {
                return res.status(403).json({ error: 'Admin access required' });
            }
        }

        const { metric, quantity, idempotency_key } = req.body;

        if (!metric || quantity === undefined) {
            return res.status(400).json({ error: 'metric and quantity are required' });
        }

        const churchId = req.profile?.church_id || req.entitlements?.churchId;
        if (!churchId) {
            return res.status(400).json({ error: 'No church_id found for user' });
        }

        // Use provided idempotency key or generate one for this test
        const idempotencyKey = idempotency_key || generateIdempotencyKey(`debug_${Date.now()}`, metric, 30);

        const result = await recordUsageEvent({
            church_id: churchId,
            metric,
            quantity: Number(quantity),
            idempotency_key: idempotencyKey,
            occurred_at: new Date(),
            metadata: { source: 'debug_endpoint', user_id: req.user?.id }
        });

        res.json({
            success: true,
            ...result,
            idempotency_key: idempotencyKey,
            church_id: churchId
        });
    } catch (error) {
        console.error('[Usage Debug] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/debug/usage
 * 
 * Gets current month usage for the authenticated user's church.
 */
router.get('/debug/usage', requireAuthContext, requireEntitlements, async (req, res) => {
    try {
        const churchId = req.profile?.church_id || req.entitlements?.churchId;
        if (!churchId) {
            return res.status(400).json({ error: 'No church_id found for user' });
        }

        const [monthToDate, today] = await Promise.all([
            getMonthToDateUsage(churchId),
            getTodayUsage(churchId)
        ]);

        res.json({
            church_id: churchId,
            month_to_date: monthToDate,
            today: today
        });
    } catch (error) {
        console.error('[Usage Debug] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

export default router;
