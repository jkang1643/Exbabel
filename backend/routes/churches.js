/**
 * Church Routes - Search and join churches
 */

import express from 'express';
import { supabaseAdmin } from '../supabaseAdmin.js';
import { requireAuth } from '../middleware/requireAuthContext.js';
import { stripe } from '../services/stripe.js';

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
            .select(`
                id, 
                name, 
                created_at,
                member_count:profiles(count)
            `)
            .order('name', { ascending: true })
            .limit(searchLimit);

        // If search query provided, filter by name
        if (q.trim()) {
            query = query.ilike('name', `%${q.trim()}%`);
        }

        const { data: rawChurches, error } = await query;

        if (error) {
            console.error('[Churches] Search error:', error.message);
            return res.status(500).json({ error: 'Failed to search churches' });
        }

        // Flatten member_count from [{count: X}] to X
        const churches = (rawChurches || []).map(church => ({
            ...church,
            member_count: church.member_count?.[0]?.count || 0
        }));

        res.json({
            success: true,
            churches,
            count: churches.length
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
                role: 'member'  // Default to member — admin requires Stripe payment
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

/**
 * POST /api/churches/leave
 * Leave current church (requires authentication)
 * Deletes the user's profile record
 */
churchRouter.post('/churches/leave', requireAuth, async (req, res) => {
    try {
        const userId = req.auth.user_id;
        const profile = req.auth.profile;

        if (!profile || !profile.church_id) {
            return res.status(400).json({ error: 'You are not a member of any church' });
        }

        // Prevent admins from leaving (they should transfer ownership first)
        if (profile.role === 'admin') {
            return res.status(400).json({
                error: 'Admins cannot leave their church. Transfer admin role first.',
                code: 'ADMIN_CANNOT_LEAVE'
            });
        }

        // Delete the profile
        const { error: deleteErr } = await supabaseAdmin
            .from('profiles')
            .delete()
            .eq('user_id', userId);

        if (deleteErr) {
            console.error('[Churches] Leave error:', deleteErr.message);
            return res.status(500).json({ error: 'Failed to leave church' });
        }

        console.log(`[Churches] ✅ User ${userId} left church ${profile.church_id}`);

        res.json({
            success: true,
            message: 'You have left the church'
        });
    } catch (err) {
        console.error('[Churches] Unexpected error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/churches/create
 * Create a new church (requires authentication)
 * 
 * Creates the church and sets up the user as admin with:
 * - Profile with role='admin'
 * - Subscription with 'starter' plan 
 * - Church billing settings with defaults
 * 
 * Body:
 * - name: Church name (required, 2-100 characters)
 * 
 * Enforces DB Invariants:
 * - Every profile has exactly one church (Invariant #2)
 * - One subscription per church, never missing (Invariant #8)
 * - One billing_settings row per church, never missing (Invariant #9)
 */
churchRouter.post('/churches/create', requireAuth, async (req, res) => {
    try {
        const { name } = req.body;
        const userId = req.auth.user_id;

        // Validate church name
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Church name is required' });
        }

        const trimmedName = name.trim();
        if (trimmedName.length < 2 || trimmedName.length > 100) {
            return res.status(400).json({
                error: 'Church name must be between 2 and 100 characters'
            });
        }

        // Check if user already has a profile (Invariant: one church per user)
        const { data: existingProfile } = await supabaseAdmin
            .from('profiles')
            .select('user_id, church_id')
            .eq('user_id', userId)
            .single();

        if (existingProfile) {
            return res.status(400).json({
                error: 'You are already a member of a church. Each user can only belong to one church.',
                code: 'ALREADY_HAS_CHURCH',
                currentChurchId: existingProfile.church_id
            });
        }

        // Get the starter plan ID
        const { data: starterPlan, error: planErr } = await supabaseAdmin
            .from('plans')
            .select('id')
            .eq('code', 'starter')
            .single();

        if (planErr || !starterPlan) {
            console.error('[Churches] Starter plan not found:', planErr?.message);
            return res.status(500).json({ error: 'System configuration error' });
        }

        // Step 1: Create the church
        const { data: newChurch, error: churchErr } = await supabaseAdmin
            .from('churches')
            .insert({ name: trimmedName })
            .select('id, name, created_at')
            .single();

        if (churchErr) {
            console.error('[Churches] Create church error:', churchErr.message);
            return res.status(500).json({ error: 'Failed to create church' });
        }

        const churchId = newChurch.id;
        console.log(`[Churches] Created church: ${trimmedName} (${churchId})`);

        // Step 2: Create admin profile (Invariant #2: profile -> church)
        const { data: newProfile, error: profileErr } = await supabaseAdmin
            .from('profiles')
            .insert({
                user_id: userId,
                church_id: churchId,
                role: 'member'  // Default to member — admin requires Stripe payment
            })
            .select('user_id, church_id, role')
            .single();

        if (profileErr) {
            console.error('[Churches] Create profile error:', profileErr.message);
            // Rollback: delete the church since profile failed
            await supabaseAdmin.from('churches').delete().eq('id', churchId);
            return res.status(500).json({ error: 'Failed to create admin profile' });
        }

        // Step 3: Create subscription with starter plan (Invariant #8: one subscription per church)
        // IMPORTANT: Start with 'inactive' status. The Stripe webhook will set to 'trialing' (free trial)
        // or 'active' (paid), which will trigger the role upgrade to 'admin' via syncRoleFromStatus.
        const { error: subErr } = await supabaseAdmin
            .from('subscriptions')
            .insert({
                church_id: churchId,
                plan_id: starterPlan.id,
                status: 'inactive',  // Webhook will upgrade to 'trialing' or 'active'
                current_period_start: null,  // Will be set by webhook
                current_period_end: null     // Will be set by webhook
            });

        if (subErr) {
            console.error('[Churches] Create subscription error:', subErr.message);
            // Rollback: delete profile and church
            await supabaseAdmin.from('profiles').delete().eq('user_id', userId);
            await supabaseAdmin.from('churches').delete().eq('id', churchId);
            return res.status(500).json({ error: 'Failed to create subscription' });
        }

        // Step 4: Create billing settings with defaults (Invariant #9: one billing_settings per church)
        const { error: billingErr } = await supabaseAdmin
            .from('church_billing_settings')
            .insert({
                church_id: churchId,
                payg_enabled: false,
                payg_rate_cents_per_hour: 0,
                allow_overage_while_live: false
            });

        if (billingErr) {
            console.error('[Churches] Create billing settings error:', billingErr.message);
            // Rollback: delete subscription, profile, and church
            await supabaseAdmin.from('subscriptions').delete().eq('church_id', churchId);
            await supabaseAdmin.from('profiles').delete().eq('user_id', userId);
            await supabaseAdmin.from('churches').delete().eq('id', churchId);
            return res.status(500).json({ error: 'Failed to create billing settings' });
        }

        // Step 5: Create Stripe customer (non-blocking — lazy creation in billing.js as fallback)
        if (stripe) {
            try {
                const customer = await stripe.customers.create({
                    name: trimmedName,
                    metadata: { church_id: churchId },
                });
                await supabaseAdmin
                    .from('churches')
                    .update({ stripe_customer_id: customer.id })
                    .eq('id', churchId);
                console.log(`[Churches] ✓ Stripe customer created: ${customer.id}`);
            } catch (stripeErr) {
                // Non-fatal: customer will be created lazily on first billing action
                console.warn(`[Churches] ⚠️ Stripe customer creation failed (non-fatal):`, stripeErr.message);
            }
        }

        console.log(`[Churches] ✅ User ${userId} created church "${trimmedName}" and is now admin`);

        res.json({
            success: true,
            message: `Welcome to ${trimmedName}! You are now the administrator.`,
            church: newChurch,
            profile: newProfile
        });
    } catch (err) {
        console.error('[Churches] Unexpected error in create:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});
