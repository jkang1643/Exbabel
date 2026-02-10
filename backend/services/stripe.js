/**
 * Stripe SDK — Singleton initialization
 * 
 * Exports a configured Stripe client for use across the backend.
 * 
 * Required env vars:
 *   STRIPE_SECRET_KEY - Stripe secret API key (sk_test_... or sk_live_...)
 * 
 * @module services/stripe
 */

import Stripe from 'stripe';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!STRIPE_SECRET_KEY) {
    console.warn('[Stripe] ⚠️ STRIPE_SECRET_KEY not set — billing features disabled');
}

const stripe = STRIPE_SECRET_KEY
    ? new Stripe(STRIPE_SECRET_KEY, {
        apiVersion: '2024-12-18.acacia',
        appInfo: {
            name: 'Exbabel',
            version: '1.0.0',
        },
    })
    : null;

if (stripe) {
    console.log('[Stripe] ✓ SDK initialized');
}

export { stripe };
export default stripe;
