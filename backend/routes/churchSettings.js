/**
 * Church Settings Routes
 * GET  /api/church/settings          — fetch permanent_code + conference_mode
 * PATCH /api/church/settings         — update conference_mode
 * POST /api/church/settings/regenerate-code — generate a new permanent_code
 */

import express from 'express';
import { supabaseAdmin } from '../supabaseAdmin.js';
import { requireAuth } from '../middleware/requireAuthContext.js';

export const churchSettingsRouter = express.Router();

// All routes require authentication
churchSettingsRouter.use(requireAuth);

/**
 * Helper: generate a random 6-char code (same charset as sessionStore)
 */
function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

/**
 * GET /api/church/settings
 * Returns the church's permanent_code and conference_mode.
 * If permanent_code is null, generates one and saves it.
 */
churchSettingsRouter.get('/church/settings', async (req, res) => {
    try {
        const churchId = req.auth?.profile?.church_id;
        if (!churchId) {
            return res.status(400).json({ error: 'No church associated with your account' });
        }

        const { data: church, error } = await supabaseAdmin
            .from('churches')
            .select('id, name, permanent_code, conference_mode')
            .eq('id', churchId)
            .single();

        if (error || !church) {
            return res.status(404).json({ error: 'Church not found' });
        }

        // Lazily generate permanent_code if missing
        let permanentCode = church.permanent_code;
        if (!permanentCode) {
            permanentCode = await generateUniquePermanentCode();
            await supabaseAdmin
                .from('churches')
                .update({ permanent_code: permanentCode })
                .eq('id', churchId);
        }

        res.json({
            success: true,
            settings: {
                permanentCode,
                conferenceMode: church.conference_mode ?? false,
                churchName: church.name,
            }
        });
    } catch (err) {
        console.error('[ChurchSettings] GET error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * PATCH /api/church/settings
 * Update conference_mode for the church.
 * Body: { conferenceMode: boolean }
 */
churchSettingsRouter.patch('/church/settings', async (req, res) => {
    try {
        const churchId = req.auth?.profile?.church_id;
        const role = req.auth?.profile?.role;

        if (!churchId) {
            return res.status(400).json({ error: 'No church associated with your account' });
        }
        if (role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can update church settings' });
        }

        const { conferenceMode } = req.body;
        if (typeof conferenceMode !== 'boolean') {
            return res.status(400).json({ error: 'conferenceMode must be a boolean' });
        }

        const { error } = await supabaseAdmin
            .from('churches')
            .update({ conference_mode: conferenceMode })
            .eq('id', churchId);

        if (error) {
            console.error('[ChurchSettings] PATCH error:', error.message);
            return res.status(500).json({ error: 'Failed to update settings' });
        }

        console.log(`[ChurchSettings] ✓ conference_mode=${conferenceMode} for church ${churchId}`);
        res.json({ success: true, conferenceMode });
    } catch (err) {
        console.error('[ChurchSettings] PATCH error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/church/settings/regenerate-code
 * Generates a new permanent_code for the church.
 */
churchSettingsRouter.post('/church/settings/regenerate-code', async (req, res) => {
    try {
        const churchId = req.auth?.profile?.church_id;
        const role = req.auth?.profile?.role;

        if (!churchId) {
            return res.status(400).json({ error: 'No church associated with your account' });
        }
        if (role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can regenerate the church code' });
        }

        const newCode = await generateUniquePermanentCode();

        const { error } = await supabaseAdmin
            .from('churches')
            .update({ permanent_code: newCode })
            .eq('id', churchId);

        if (error) {
            console.error('[ChurchSettings] Regenerate error:', error.message);
            return res.status(500).json({ error: 'Failed to regenerate code' });
        }

        console.log(`[ChurchSettings] ✓ Regenerated permanent_code=${newCode} for church ${churchId}`);
        res.json({ success: true, permanentCode: newCode });
    } catch (err) {
        console.error('[ChurchSettings] Regenerate error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Generate a unique permanent code (retries up to 5 times on collision)
 */
async function generateUniquePermanentCode() {
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        const { data } = await supabaseAdmin
            .from('churches')
            .select('id')
            .eq('permanent_code', code)
            .maybeSingle();
        if (!data) return code; // No collision
    }
    // Fallback: use timestamp suffix to guarantee uniqueness
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    return chars.charAt(Math.floor(Math.random() * chars.length)) +
        Date.now().toString(36).toUpperCase().slice(-5);
}
