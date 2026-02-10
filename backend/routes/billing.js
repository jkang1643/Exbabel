/**
 * Billing API Routes
 * 
 * All endpoints require admin role (invariant #4).
 * 
 * Endpoints:
 *   POST /api/billing/subscription-checkout  — Create Stripe Checkout for plan upgrade
 *   POST /api/billing/top-up-checkout        — Create Stripe Checkout for hour pack
 *   GET  /api/billing/portal                 — Create Stripe Billing Portal session
 *   GET  /api/billing/status                 — Get current subscription + usage info
 * 
 * @module routes/billing
 */

import express from 'express';
import { stripe } from '../services/stripe.js';
import { supabaseAdmin } from '../supabaseAdmin.js';
import { requireAuth, requireAdmin } from '../middleware/requireAuthContext.js';

const router = express.Router();

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:5173';

// Top-up packs configuration (server-side truth)
const TOP_UP_PACKS = {
    '1_hour': { seconds: 3600, amountCents: 999, label: '1 Hour' },
    '5_hours': { seconds: 18000, amountCents: 3999, label: '5 Hours' },
    '10_hours': { seconds: 36000, amountCents: 6999, label: '10 Hours' },
};

// ============================================================================
// MIDDLEWARE: All billing routes require admin
// ============================================================================

router.use(requireAuth, requireAdmin);

// ============================================================================
// POST /billing/subscription-checkout
// ============================================================================

/**
 * Create a Stripe Checkout Session for a subscription plan upgrade.
 * 
 * Body: { planCode: 'pro' | 'unlimited' }
 * Returns: { url: string } — Stripe-hosted checkout page URL
 */
router.post('/billing/subscription-checkout', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(503).json({ error: 'Billing not configured' });
        }

        const { planCode } = req.body;
        if (!planCode) {
            return res.status(400).json({ error: 'planCode is required' });
        }

        const churchId = req.auth.profile.church_id;

        // 1. Look up the plan and its Stripe price
        const { data: plan, error: planErr } = await supabaseAdmin
            .from('plans')
            .select('id, code, name, stripe_price_id')
            .eq('code', planCode)
            .single();

        if (planErr || !plan) {
            return res.status(400).json({ error: `Invalid plan: ${planCode}` });
        }

        if (!plan.stripe_price_id) {
            return res.status(400).json({ error: `Plan ${planCode} has no Stripe price configured` });
        }

        // 2. Get or create Stripe customer for this church
        const customerId = await ensureStripeCustomer(churchId);

        // 3. Create Checkout Session
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            client_reference_id: churchId,
            metadata: {
                church_id: churchId,
                plan_code: planCode,
            },
            line_items: [{
                price: plan.stripe_price_id,
                quantity: 1,
            }],
            success_url: `${APP_BASE_URL}/billing?success=true&plan=${planCode}`,
            cancel_url: `${APP_BASE_URL}/billing?canceled=true`,
            // If already has a subscription, allow switching
            subscription_data: {
                metadata: {
                    church_id: churchId,
                    plan_code: planCode,
                },
            },
        });

        console.log(`[Billing] ✓ Checkout session created: church=${churchId} plan=${planCode} session=${session.id}`);
        res.json({ url: session.url });

    } catch (err) {
        console.error('[Billing] ✗ subscription-checkout error:', err.message);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// ============================================================================
// POST /billing/top-up-checkout
// ============================================================================

/**
 * Create a Stripe Checkout Session for a one-time top-up purchase.
 * 
 * Body: { packId: '1_hour' | '5_hours' | '10_hours' }
 * Returns: { url: string } — Stripe-hosted checkout page URL
 */
router.post('/billing/top-up-checkout', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(503).json({ error: 'Billing not configured' });
        }

        const { packId } = req.body;
        const pack = TOP_UP_PACKS[packId];

        if (!pack) {
            return res.status(400).json({
                error: `Invalid packId. Choose from: ${Object.keys(TOP_UP_PACKS).join(', ')}`,
            });
        }

        const churchId = req.auth.profile.church_id;
        const customerId = await ensureStripeCustomer(churchId);

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            customer: customerId,
            client_reference_id: churchId,
            metadata: {
                church_id: churchId,
                type: 'top_up',
                pack_id: packId,
                seconds: String(pack.seconds),
            },
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${pack.label} — Additional Translation Time`,
                        description: `${pack.label} of additional translation time for Exbabel. Expires at end of current billing month.`,
                    },
                    unit_amount: pack.amountCents,
                },
                quantity: 1,
            }],
            success_url: `${APP_BASE_URL}/billing?success=true&topup=${packId}`,
            cancel_url: `${APP_BASE_URL}/billing?canceled=true`,
        });

        console.log(`[Billing] ✓ Top-up checkout created: church=${churchId} pack=${packId} session=${session.id}`);
        res.json({ url: session.url });

    } catch (err) {
        console.error('[Billing] ✗ top-up-checkout error:', err.message);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// ============================================================================
// GET /billing/portal
// ============================================================================

/**
 * Create a Stripe Billing Portal session for managing payment methods / invoices.
 * 
 * Returns: { url: string } — Stripe-hosted portal URL
 */
router.get('/billing/portal', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(503).json({ error: 'Billing not configured' });
        }

        const churchId = req.auth.profile.church_id;
        const customerId = await ensureStripeCustomer(churchId);

        const portalSession = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${APP_BASE_URL}/billing`,
        });

        console.log(`[Billing] ✓ Portal session created: church=${churchId}`);
        res.json({ url: portalSession.url });

    } catch (err) {
        console.error('[Billing] ✗ portal error:', err.message);
        res.status(500).json({ error: 'Failed to create portal session' });
    }
});

// ============================================================================
// GET /billing/status
// ============================================================================

/**
 * Get current subscription and usage status for the admin's church.
 * 
 * Returns: { subscription, plan, usage, packs }
 */
router.get('/billing/status', async (req, res) => {
    try {
        const churchId = req.auth.profile.church_id;

        // Get subscription + plan
        const { data: sub, error: subErr } = await supabaseAdmin
            .from('subscriptions')
            .select('*, plans(*)')
            .eq('church_id', churchId)
            .single();

        if (subErr) {
            return res.status(500).json({ error: 'Failed to load subscription' });
        }

        // Get quota status via RPC
        const { data: quota, error: quotaErr } = await supabaseAdmin
            .rpc('get_session_quota_status', { p_church_id: churchId });

        const quotaData = quota?.[0] || null;

        // Get purchased credits this month
        const { data: credits } = await supabaseAdmin
            .from('purchased_credits')
            .select('amount_seconds, created_at')
            .eq('church_id', churchId)
            .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString())
            .order('created_at', { ascending: false });

        res.json({
            subscription: {
                status: sub.status,
                currentPeriodEnd: sub.current_period_end,
                stripeSubscriptionId: sub.stripe_subscription_id,
            },
            plan: sub.plans ? {
                code: sub.plans.code,
                name: sub.plans.name,
                includedSecondsPerMonth: sub.plans.included_seconds_per_month,
            } : null,
            usage: quotaData ? {
                usedSecondsMtd: Number(quotaData.used_seconds_mtd),
                includedSecondsPerMonth: quotaData.included_seconds_per_month,
                purchasedSecondsMtd: Number(quotaData.purchased_seconds_mtd || 0),
                totalAvailableSeconds: Number(quotaData.total_available_seconds || quotaData.included_seconds_per_month),
                remainingSeconds: Number(quotaData.remaining_seconds),
                percentUsed: quotaData.included_seconds_per_month > 0
                    ? Math.round((Number(quotaData.used_seconds_mtd) / Number(quotaData.total_available_seconds || quotaData.included_seconds_per_month)) * 100)
                    : 0,
            } : null,
            purchasedCredits: credits || [],
            availablePacks: TOP_UP_PACKS,
        });

    } catch (err) {
        console.error('[Billing] ✗ status error:', err.message);
        res.status(500).json({ error: 'Failed to load billing status' });
    }
});

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Ensure the church has a Stripe customer. Creates one if missing.
 * 
 * @param {string} churchId - Church UUID
 * @returns {Promise<string>} Stripe customer ID (cus_xxx)
 */
async function ensureStripeCustomer(churchId) {
    // Check if church already has a Stripe customer
    const { data: church } = await supabaseAdmin
        .from('churches')
        .select('id, name, stripe_customer_id')
        .eq('id', churchId)
        .single();

    if (church?.stripe_customer_id) {
        return church.stripe_customer_id;
    }

    // Create new Stripe customer
    const customer = await stripe.customers.create({
        name: church?.name || 'Unknown Church',
        metadata: {
            church_id: churchId,
        },
    });

    // Store on churches table
    await supabaseAdmin
        .from('churches')
        .update({ stripe_customer_id: customer.id })
        .eq('id', churchId);

    // Also store on subscriptions (denormalized convenience)
    await supabaseAdmin
        .from('subscriptions')
        .update({ stripe_customer_id: customer.id })
        .eq('church_id', churchId);

    console.log(`[Billing] ✓ Created Stripe customer: church=${churchId} customer=${customer.id}`);
    return customer.id;
}

export { router as billingRouter };
export default router;
