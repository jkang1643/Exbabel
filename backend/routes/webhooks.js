/**
 * Stripe Webhook Handler
 * 
 * Receives Stripe events and updates the database accordingly.
 * Uses signature verification (STRIPE_WEBHOOK_SECRET) instead of JWT auth.
 * 
 * Handled events (MVP):
 *   - checkout.session.completed  (subscription upgrade + top-up purchase)
 *   - customer.subscription.updated (status changes, plan changes)
 *   - customer.subscription.deleted (cancellation)
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

    console.log(`[Webhook] ✓ Subscription upgraded: church=${churchId} plan=${plan.code} status=${subscription.status}`);
    clearEntitlementsCache(churchId);
}

/**
 * Handle top-up checkout — one-time credit purchase
 */
async function handleTopUpCheckout(session, churchId) {
    const seconds = parseInt(session.metadata?.seconds, 10);
    const paymentIntentId = session.payment_intent;

    if (!seconds || !paymentIntentId) {
        console.error('[Webhook] ✗ Top-up missing seconds or payment_intent');
        return;
    }

    // Idempotent insert (unique index on stripe_payment_intent_id will reject duplicates)
    const { error } = await supabaseAdmin
        .from('purchased_credits')
        .insert({
            church_id: churchId,
            amount_seconds: seconds,
            stripe_payment_intent_id: paymentIntentId,
        });

    if (error) {
        if (error.code === '23505') {
            // Unique violation = duplicate webhook delivery, safe to ignore
            console.log(`[Webhook] ↩ Top-up already recorded (idempotent): pi=${paymentIntentId}`);
        } else {
            console.error(`[Webhook] ✗ Failed to insert purchased_credits:`, error.message);
        }
        return;
    }

    console.log(`[Webhook] ✓ Top-up recorded: church=${churchId} seconds=${seconds} pi=${paymentIntentId}`);
    clearEntitlementsCache(churchId);
}

/**
 * Handle customer.subscription.updated
 * Covers: plan changes, status transitions (active→past_due, pause, etc.)
 */
async function handleSubscriptionUpdated(subscription) {
    const stripeSubscriptionId = subscription.id;
    const stripePriceId = subscription.items.data[0]?.price?.id;
    const stripeCustomerId = subscription.customer;

    // Find the church by stripe_subscription_id
    const { data: sub, error: findErr } = await supabaseAdmin
        .from('subscriptions')
        .select('church_id')
        .eq('stripe_subscription_id', stripeSubscriptionId)
        .single();

    if (findErr || !sub) {
        // Try finding by stripe_customer_id as fallback
        const { data: church } = await supabaseAdmin
            .from('churches')
            .select('id')
            .eq('stripe_customer_id', stripeCustomerId)
            .single();

        if (!church) {
            console.error(`[Webhook] ✗ subscription.updated: cannot find church for sub=${stripeSubscriptionId}`);
            return;
        }

        // Update using church_id from churches table
        await updateSubscriptionRow(church.id, subscription, stripePriceId, stripeSubscriptionId);
        return;
    }

    await updateSubscriptionRow(sub.church_id, subscription, stripePriceId, stripeSubscriptionId);
}

/**
 * Handle customer.subscription.deleted
 * Sets subscription status to 'canceled'
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
    clearEntitlementsCache(sub.church_id);
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Update subscription row with latest Stripe data
 */
async function updateSubscriptionRow(churchId, subscription, stripePriceId, stripeSubscriptionId) {
    const updateData = {
        status: mapStripeStatus(subscription.status),
        stripe_subscription_id: stripeSubscriptionId,
        current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    };

    // If price changed, also update plan
    if (stripePriceId) {
        const { data: plan } = await supabaseAdmin
            .from('plans')
            .select('id, code')
            .eq('stripe_price_id', stripePriceId)
            .single();

        if (plan) {
            updateData.plan_id = plan.id;
            updateData.stripe_price_id = stripePriceId;
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

    console.log(`[Webhook] ✓ Subscription updated: church=${churchId} status=${updateData.status}`);
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

export { router as webhookRouter };
export default router;
