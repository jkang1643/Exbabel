/**
 * Church Routes - Search and join churches
 */

import express from 'express';
import { supabaseAdmin } from '../supabaseAdmin.js';
import { requireAuth } from '../middleware/requireAuthContext.js';

export const churchRouter = express.Router();

/**
 * GET /api/churches/search
 * Search for churches by name (public endpoint)
 * 
 * Query params:
 * - q: search query (optional, returns all if empty)
 * - limit: max results (default 20)
 */
churchRouter.get('/churches/search', async (req, res) => {
    try {
        const { q = '', limit = 20 } = req.query;
        const searchLimit = Math.min(parseInt(limit) || 20, 50);

        let query = supabaseAdmin
            .from('churches')
            .select('id, name, created_at')
            .order('name', { ascending: true })
            .limit(searchLimit);

        // If search query provided, filter by name
        if (q.trim()) {
            query = query.ilike('name', `%${q.trim()}%`);
        }

        const { data: churches, error } = await query;

        if (error) {
            console.error('[Churches] Search error:', error.message);
            return res.status(500).json({ error: 'Failed to search churches' });
        }

        res.json({
            success: true,
            churches: churches || [],
            count: churches?.length || 0
        });
    } catch (err) {
        console.error('[Churches] Unexpected error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/churches/join
 * Join a church (requires authentication)
 * 
 * Body:
 * - churchId: UUID of the church to join
 */
churchRouter.post('/churches/join', requireAuth, async (req, res) => {
    try {
        const { churchId } = req.body;
        const userId = req.auth.user_id;

        if (!churchId) {
            return res.status(400).json({ error: 'churchId is required' });
        }

        // Verify church exists
        const { data: church, error: churchErr } = await supabaseAdmin
            .from('churches')
            .select('id, name')
            .eq('id', churchId)
            .single();

        if (churchErr || !church) {
            return res.status(404).json({ error: 'Church not found' });
        }

        // Check if user already has a profile
        const { data: existingProfile } = await supabaseAdmin
            .from('profiles')
            .select('user_id, church_id')
            .eq('user_id', userId)
            .single();

        if (existingProfile) {
            if (existingProfile.church_id === churchId) {
                return res.json({
                    success: true,
                    message: 'Already a member of this church',
                    church: church,
                    alreadyMember: true
                });
            } else {
                // User belongs to a different church
                return res.status(400).json({
                    error: 'You are already a member of another church',
                    currentChurchId: existingProfile.church_id
                });
            }
        }

        // Create profile linked to this church
        const { data: newProfile, error: profileErr } = await supabaseAdmin
            .from('profiles')
            .insert({
                user_id: userId,
                church_id: churchId,
                role: 'member'
            })
            .select('user_id, church_id, role')
            .single();

        if (profileErr) {
            console.error('[Churches] Join error:', profileErr.message);
            return res.status(500).json({ error: 'Failed to join church' });
        }

        console.log(`[Churches] ✅ User ${userId} joined church ${church.name} (${churchId})`);

        res.json({
            success: true,
            message: `Welcome to ${church.name}!`,
            church: church,
            profile: newProfile
        });
    } catch (err) {
        console.error('[Churches] Unexpected error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/churches/:id
 * Get church details by ID
 */
churchRouter.get('/churches/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const { data: church, error } = await supabaseAdmin
            .from('churches')
            .select('id, name, created_at')
            .eq('id', id)
            .single();

        if (error || !church) {
            return res.status(404).json({ error: 'Church not found' });
        }

        res.json({
            success: true,
            church
        });
    } catch (err) {
        console.error('[Churches] Unexpected error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});
