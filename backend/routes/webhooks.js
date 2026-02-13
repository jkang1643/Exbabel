/**
 * Stripe Webhook Handler
 * 
 * Receives Stripe events and updates the database accordingly.
 * Uses signature verification (STRIPE_WEBHOOK_SECRET) instead of JWT auth.
 * 
 * Handled events:
 *   - checkout.session.completed  (subscription upgrade + top-up purchase)
 *   - customer.subscription.updated (status changes, plan changes → deterministic admin promotion/demotion)
 *   - customer.subscription.deleted (cancellation → demote to member)
 *   - invoice.payment_succeeded    (confirm subscription stays active)
 *   - invoice.payment_failed       (demote to member on payment failure)
 * 
 * CRITICAL: This route MUST be mounted BEFORE express.json() in server.js,
 * because Stripe signature verification requires the raw request body.
 * 
 * @module routes/webhooks
 */

import express from 'express';
import { stripe } from '../services/stripe.js';
import { supabaseAdmin } from '../supabaseAdmin.js';
import { clearEntitlementsCache } from '../entitlements/index.js';

const router = express.Router();

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Statuses that grant admin access
const ADMIN_STATUSES = ['active', 'trialing'];
// Statuses that revoke admin access
const MEMBER_STATUSES = ['past_due', 'canceled', 'paused'];

/**
 * POST /api/webhooks/stripe
 * 
 * Must use express.raw() to get the raw body for signature verification.
 * The route-level middleware is applied here so the global express.json()
 * does not consume the body first.
 */
router.post(
    '/stripe',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        if (!stripe || !WEBHOOK_SECRET) {
            console.error('[Webhook] Stripe not configured');
            return res.status(500).json({ error: 'Stripe not configured' });
        }

        // Step 1: Verify signature
        let event;
        try {
            const sig = req.headers['stripe-signature'];
            event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
        } catch (err) {
            console.error(`[Webhook] ✗ Signature verification failed: ${err.message}`);
            return res.status(400).json({ error: `Webhook signature verification failed` });
        }

        console.log(`[Webhook] ✓ Received event: ${event.type} (${event.id})`);

        // Step 2: Route event to handler
        try {
            switch (event.type) {
                case 'checkout.session.completed':
                    await handleCheckoutCompleted(event.data.object);
                    break;

                case 'customer.subscription.updated':
                    await handleSubscriptionUpdated(event.data.object);
                    break;

                case 'customer.subscription.deleted':
                    await handleSubscriptionDeleted(event.data.object);
                    break;

                case 'invoice.payment_succeeded':
                case 'invoice.paid':
                case 'invoice_payment.paid': // Legacy/alternative event seen in logs
                    await handleInvoicePaymentSucceeded(event.data.object);
                    break;

                case 'invoice.payment_failed':
                case 'invoice_payment.failed':
                    await handleInvoicePaymentFailed(event.data.object);
                    break;

                default:
                    console.log(`[Webhook] Unhandled event type: ${event.type}`);
            }
        } catch (err) {
            console.error(`[Webhook] ✗ Handler error for ${event.type}:`, err.message);
            // Return 200 anyway to prevent Stripe from retrying
            // (we log the error for debugging, but don't want infinite retries)
        }

        // Always return 200 to acknowledge receipt
        res.status(200).json({ received: true });
    }
);

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Handle checkout.session.completed
 * 
 * Two modes:
 *   - subscription: User upgraded their plan
 *   - payment: User purchased top-up hours
 */
async function handleCheckoutCompleted(session) {
    const mode = session.mode; // 'subscription' or 'payment'
    const churchId = session.client_reference_id || session.metadata?.church_id;

    if (!churchId) {
        console.error('[Webhook] ✗ checkout.session.completed missing church_id');
        return;
    }

    console.log(`[Webhook] Checkout completed: mode=${mode} church=${churchId}`);

    if (mode === 'subscription') {
        await handleSubscriptionCheckout(session, churchId);
    } else if (mode === 'payment') {
        const metaType = session.metadata?.type;
        if (metaType === 'top_up') {
            await handleTopUpCheckout(session, churchId);
        } else {
            console.log(`[Webhook] Payment checkout with unknown type: ${metaType}`);
        }
    }
}

/**
 * Handle subscription checkout — upgrade plan
 */
async function handleSubscriptionCheckout(session, churchId) {
    const stripeSubscriptionId = session.subscription;
    const stripeCustomerId = session.customer;

    // Fetch the full subscription object from Stripe to get price/plan details
    const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const stripePriceId = subscription.items.data[0]?.price?.id;

    if (!stripePriceId) {
        console.error('[Webhook] ✗ Could not extract price ID from subscription');
        return;
    }

    // Look up the plan by stripe_price_id
    const { data: plan, error: planErr } = await supabaseAdmin
        .from('plans')
        .select('id, code')
        .eq('stripe_price_id', stripePriceId)
        .single();

    if (planErr || !plan) {
        console.error(`[Webhook] ✗ No plan found for stripe_price_id=${stripePriceId}:`, planErr?.message);
        return;
    }

    // Update the subscription row
    const { error: subErr } = await supabaseAdmin
        .from('subscriptions')
        .update({
            plan_id: plan.id,
            status: mapStripeStatus(subscription.status),
            stripe_subscription_id: stripeSubscriptionId,
            stripe_customer_id: stripeCustomerId,
            stripe_price_id: stripePriceId,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        })
        .eq('church_id', churchId);

    if (subErr) {
        console.error(`[Webhook] ✗ Failed to update subscription:`, subErr.message);
        return;
    }

    // Also ensure churches.stripe_customer_id is set
    await supabaseAdmin
        .from('churches')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', churchId)
        .is('stripe_customer_id', null);

    const mappedStatus = mapStripeStatus(subscription.status);
    console.log(`[Webhook] ✓ Subscription upgraded: church=${churchId} plan=${plan.code} status=${mappedStatus}`);

    // Deterministic admin promotion based on status
    await syncRoleFromStatus(churchId, mappedStatus);

    clearEntitlementsCache(churchId);
}

/**
 * Handle top-up checkout — one-time credit purchase
 * 
 * IMPORTANT: Purchased hours are SPLIT 50/50 between solo and host modes.
 * E.g., purchasing "5 hours" creates:
 *   - 5 hours for solo mode (18000/2 = 9000 seconds)
 *   - 5 hours for host mode (18000/2 = 9000 seconds)
 * Total: 10 hours available across both modes
 */
async function handleTopUpCheckout(session, churchId) {
    const seconds = parseInt(session.metadata?.seconds, 10);
    const paymentIntentId = session.payment_intent;

    if (!seconds || !paymentIntentId) {
        console.error('[Webhook] ✗ Top-up missing seconds or payment_intent');
        return;
    }

    // Give full purchased seconds to BOTH solo and host modes
    // This doubles the effective hours (e.g., buying 1 hour gives 1 hour solo + 1 hour host)
    const secondsPerMode = seconds;

    const creditsToInsert = [
        {
            church_id: churchId,
            amount_seconds: secondsPerMode,
            mode: 'solo',
            stripe_payment_intent_id: `${paymentIntentId}_solo`,
        },
        {
            church_id: churchId,
            amount_seconds: secondsPerMode,
            mode: 'host',
            stripe_payment_intent_id: `${paymentIntentId}_host`,
        }
    ];

    const { error } = await supabaseAdmin
        .from('purchased_credits')
        .insert(creditsToInsert);

    if (error) {
        if (error.code === '23505') {
            // Unique violation = duplicate webhook delivery, safe to ignore
            console.log(`[Webhook] ↩ Top-up already recorded (idempotent): pi=${paymentIntentId}`);
        } else {
            console.error(`[Webhook] ✗ Failed to insert purchased_credits:`, error.message);
        }
        return;
    }

    console.log(`[Webhook] ✓ Top-up recorded: church=${churchId} total=${seconds}s (${secondsPerMode}s solo + ${secondsPerMode}s host) pi=${paymentIntentId}`);
    clearEntitlementsCache(churchId);
}

/**
 * Handle customer.subscription.updated
 * 
 * Covers: plan changes, status transitions (active→past_due, trialing→active, etc.)
 * DETERMINISTIC: promotes/demotes admin based on subscription status.
 */
async function handleSubscriptionUpdated(subscription) {
    const stripeSubscriptionId = subscription.id;
    const stripePriceId = subscription.items.data[0]?.price?.id;
    const stripeCustomerId = subscription.customer;

    // Find the church
    let churchId = await findChurchForSubscription(stripeSubscriptionId, stripeCustomerId);
    if (!churchId) {
        console.error(`[Webhook] ✗ subscription.updated: cannot find church for sub=${stripeSubscriptionId}`);
        return;
    }

    await updateSubscriptionRow(churchId, subscription, stripePriceId, stripeSubscriptionId);
}

/**
 * Handle customer.subscription.deleted
 * Sets subscription status to 'canceled' and demotes profiles to member
 */
async function handleSubscriptionDeleted(subscription) {
    const stripeSubscriptionId = subscription.id;

    const { data: sub, error: findErr } = await supabaseAdmin
        .from('subscriptions')
        .select('church_id')
        .eq('stripe_subscription_id', stripeSubscriptionId)
        .single();

    if (findErr || !sub) {
        console.error(`[Webhook] ✗ subscription.deleted: cannot find sub=${stripeSubscriptionId}`);
        return;
    }

    const { error } = await supabaseAdmin
        .from('subscriptions')
        .update({ status: 'canceled' })
        .eq('church_id', sub.church_id);

    if (error) {
        console.error(`[Webhook] ✗ Failed to cancel subscription:`, error.message);
        return;
    }

    console.log(`[Webhook] ✓ Subscription canceled: church=${sub.church_id}`);

    // Demote profiles back to member (admin access revoked)
    await syncRoleFromStatus(sub.church_id, 'canceled');

    clearEntitlementsCache(sub.church_id);
}

/**
 * Handle invoice.payment_succeeded
 * 
 * Confirms the subscription stays active after a successful payment.
 * 
 * CRITICAL: This is where we update plan_id to grant premium features.
 * Only after payment succeeds do we give users access to upgraded plans.
 * 
 * Particularly important for:
 *   - Trial users upgrading (must pay before getting Pro features)
 *   - Recurring payments (renewal)
 *   - Recovery from past_due status
 */
async function handleInvoicePaymentSucceeded(invoice) {
    let stripeSubscriptionId = extractSubscriptionId(invoice.subscription);

    // If top-level subscription is missing, check line items (common for proration invoices)
    if (!stripeSubscriptionId && invoice.lines?.data) {
        for (const line of invoice.lines.data) {
            if (line.subscription) {
                stripeSubscriptionId = extractSubscriptionId(line.subscription);
                if (stripeSubscriptionId) break;
            }
        }
    }

    if (!stripeSubscriptionId) {
        // One-time payment (e.g., top-up) — no action needed
        console.log(`[Webhook] invoice.payment_succeeded: no subscription found (one-time payment?), skipping. Invoice=${invoice.id}`);
        return;
    }

    const stripeCustomerId = invoice.customer;
    const churchId = await findChurchForSubscription(stripeSubscriptionId, stripeCustomerId);

    if (!churchId) {
        console.error(`[Webhook] ✗ invoice.payment_succeeded: cannot find church for sub=${stripeSubscriptionId}`);
        return;
    }

    // Fetch subscription to get current price
    const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const stripePriceId = subscription.items.data[0]?.price?.id;

    // Look up plan by price
    let planId = null;
    let planCode = null;
    if (stripePriceId) {
        const { data: plan } = await supabaseAdmin
            .from('plans')
            .select('id, code')
            .eq('stripe_price_id', stripePriceId)
            .single();

        if (plan) {
            planId = plan.id;
            planCode = plan.code;
            console.log(`[Webhook] ✓ Plan identified: ${plan.code} (price=${stripePriceId})`);
        }
    }

    // Update status to active AND update plan_id (only after payment succeeds)
    const updateData = { status: 'active' };
    if (planId) {
        updateData.plan_id = planId;
        updateData.stripe_price_id = stripePriceId;
    }

    const { error } = await supabaseAdmin
        .from('subscriptions')
        .update(updateData)
        .eq('church_id', churchId);

    if (!error) {
        console.log(`[Webhook] ✓ invoice.payment_succeeded: church=${churchId} → status=active${planCode ? `, plan=${planCode}` : ''}`);
    }

    // Promote to admin (only after payment succeeds)
    await syncRoleFromStatus(churchId, 'active');

    clearEntitlementsCache(churchId);
}

/**
 * Handle invoice.payment_failed
 * 
 * When a subscription payment fails, demote the church to member.
 * This gates admin features until payment is resolved.
 */
async function handleInvoicePaymentFailed(invoice) {
    let stripeSubscriptionId = extractSubscriptionId(invoice.subscription);

    // If top-level subscription is missing, check line items
    if (!stripeSubscriptionId && invoice.lines?.data) {
        for (const line of invoice.lines.data) {
            if (line.subscription) {
                stripeSubscriptionId = extractSubscriptionId(line.subscription);
                if (stripeSubscriptionId) break;
            }
        }
    }

    if (!stripeSubscriptionId) {
        console.log(`[Webhook] invoice.payment_failed: no subscription found (one-time payment?), skipping. Invoice=${invoice.id}`);
        return;
    }

    const stripeCustomerId = invoice.customer;
    const churchId = await findChurchForSubscription(stripeSubscriptionId, stripeCustomerId);

    if (!churchId) {
        console.error(`[Webhook] ✗ invoice.payment_failed: cannot find church for sub=${stripeSubscriptionId}`);
        return;
    }

    // Update status to past_due
    const { error } = await supabaseAdmin
        .from('subscriptions')
        .update({ status: 'past_due' })
        .eq('church_id', churchId);

    if (error) {
        console.error(`[Webhook] ✗ invoice.payment_failed: failed to update status:`, error.message);
        return;
    }

    console.log(`[Webhook] ⚠️ invoice.payment_failed: church=${churchId} → status=past_due`);

    // Demote to member (admin features gated until payment resolves)
    await syncRoleFromStatus(churchId, 'past_due');

    clearEntitlementsCache(churchId);
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Deterministic role sync: promote or demote ALL profiles in a church
 * based on the subscription status.
 * 
 * This is the SINGLE source of truth for admin/member transitions:
 *   - active, trialing → admin
 *   - past_due, canceled, paused → member
 * 
 * @param {string} churchId
 * @param {string} status - Mapped subscription status
 */
async function syncRoleFromStatus(churchId, status) {
    const shouldBeAdmin = ADMIN_STATUSES.includes(status);
    const newRole = shouldBeAdmin ? 'admin' : 'member';

    const { error } = await supabaseAdmin
        .from('profiles')
        .update({ role: newRole })
        .eq('church_id', churchId);

    if (error) {
        console.error(`[Webhook] ✗ Failed to set role=${newRole} for church=${churchId}:`, error.message);
    } else {
        console.log(`[Webhook] ✓ Role sync: church=${churchId} → role=${newRole} (status=${status})`);
    }
}

/**
 * Find the church_id for a given Stripe subscription.
 * Tries subscription table first, then falls back to churches table.
 * 
 * @param {string} stripeSubscriptionId
 * @param {string} stripeCustomerId
 * @returns {Promise<string|null>} churchId or null
 */
async function findChurchForSubscription(stripeSubscriptionId, stripeCustomerId) {
    // Try by subscription ID
    const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('church_id')
        .eq('stripe_subscription_id', stripeSubscriptionId)
        .single();

    if (sub?.church_id) return sub.church_id;

    // Fallback: try by customer ID on churches table
    if (stripeCustomerId) {
        const { data: church } = await supabaseAdmin
            .from('churches')
            .select('id')
            .eq('stripe_customer_id', stripeCustomerId)
            .single();

        if (church?.id) return church.id;
    }

    return null;
}

/**
 * Update subscription row with latest Stripe data.
 * 
 * IMPORTANT: Does NOT update plan_id here - that only happens on invoice.paid
 * to prevent trial users from getting premium features without payment.
 */
async function updateSubscriptionRow(churchId, subscription, stripePriceId, stripeSubscriptionId) {
    const mappedStatus = mapStripeStatus(subscription.status);

    const updateData = {
        status: mappedStatus,
        stripe_subscription_id: stripeSubscriptionId,
    };

    // Safely parse period timestamps (may be null in some Stripe events)
    if (subscription.current_period_start) {
        updateData.current_period_start = new Date(subscription.current_period_start * 1000).toISOString();
    }
    if (subscription.current_period_end) {
        updateData.current_period_end = new Date(subscription.current_period_end * 1000).toISOString();
    }

    // ✅ RESTORED (CONDITIONAL): Update plan_id on subscription.updated ONLY if active.
    // This allows legitimate upgrades via Portal (which sets status=active) to work immediately,
    // while still preventing trial users (status=trialing) from accessing premium features unpaid.
    if (mappedStatus === 'active' && stripePriceId) {
        const { data: plan } = await supabaseAdmin
            .from('plans')
            .select('id, code')
            .eq('stripe_price_id', stripePriceId)
            .single();

        if (plan) {
            updateData.plan_id = plan.id;
            updateData.stripe_price_id = stripePriceId;
            console.log(`[Webhook] ✓ Updating plan to ${plan.code} (status=active)`);
        }
    }

    const { error } = await supabaseAdmin
        .from('subscriptions')
        .update(updateData)
        .eq('church_id', churchId);

    if (error) {
        console.error(`[Webhook] ✗ Failed to update subscription for church=${churchId}:`, error.message);
        return;
    }

    console.log(`[Webhook] ✓ Subscription updated: church=${churchId} status=${mappedStatus}`);

    // ❌ REMOVED: Don't sync role on subscription.updated
    // Role sync now only happens on invoice.paid (after payment succeeds)
    // await syncRoleFromStatus(churchId, mappedStatus);

    clearEntitlementsCache(churchId);
}

/**
 * Map Stripe subscription status to our constrained enum.
 * DB constraint: trialing, active, past_due, canceled, paused
 */
function mapStripeStatus(stripeStatus) {
    const statusMap = {
        'active': 'active',
        'trialing': 'trialing',
        'past_due': 'past_due',
        'unpaid': 'past_due',       // treat unpaid as past_due
        'canceled': 'canceled',
        'incomplete': 'past_due',   // incomplete payment → past_due
        'incomplete_expired': 'canceled',
        'paused': 'paused',
    };
    return statusMap[stripeStatus] || 'active';
}

/**
 * Extract subscription ID from Stripe's subscription field.
 * Stripe may return either a string ID or an expanded subscription object.
 */
function extractSubscriptionId(subscriptionField) {
    if (!subscriptionField) return null;
    if (typeof subscriptionField === 'string') return subscriptionField;
    if (typeof subscriptionField === 'object' && subscriptionField.id) return subscriptionField.id;
    return null;
}

export { router as webhookRouter };
export default router;
