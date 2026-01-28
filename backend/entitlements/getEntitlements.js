/**
 * Entitlements Fetcher
 * 
 * Fetches plan limits, billing settings, and model routing for a church.
 * Uses service role client to bypass RLS.
 * 
 * IMPORTANT: This module uses supabaseAdmin (service role) because
 * plans/subscriptions/billing tables have RLS revoked for anon+authenticated.
 * 
 * @module entitlements/getEntitlements
 */

import { supabaseAdmin } from "../supabaseAdmin.js";

/**
 * @typedef {Object} Subscription
 * @property {'trialing'|'active'|'past_due'|'canceled'|'paused'|'none'} status
 * @property {string|null} currentPeriodStart
 * @property {string|null} currentPeriodEnd
 * @property {string} planCode
 * @property {string|null} planId
 */

/**
 * @typedef {Object} Limits
 * @property {number} includedSecondsPerMonth
 * @property {number|null} maxSessionSeconds
 * @property {number} maxSimultaneousLanguages
 * @property {string} sttTier
 * @property {string} ttsTier
 * @property {Record<string, any>} featureFlags
 */

/**
 * @typedef {Object} Billing
 * @property {boolean} paygEnabled
 * @property {number} paygRateCentsPerHour
 * @property {number|null} paygHardCapSeconds
 * @property {boolean} allowOverageWhileLive
 */

/**
 * @typedef {Object} RoutingEntry
 * @property {string} provider
 * @property {string} model
 * @property {Record<string, any>} params
 */

/**
 * @typedef {Object} Entitlements
 * @property {string} churchId
 * @property {Subscription} subscription
 * @property {Limits} limits
 * @property {Billing} billing
 * @property {Record<string, RoutingEntry>} routing
 */

/**
 * Simple in-memory TTL cache for entitlements
 * Avoids hitting DB multiple times per request cycle
 * TTL: 60 seconds
 */
const CACHE_TTL_MS = 60 * 1000;
const entitlementsCache = new Map();

function getCached(churchId) {
    const cached = entitlementsCache.get(churchId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        console.log(`[Entitlements] ✓ Cache hit for church=${churchId}`);
        return cached.data;
    }
    return null;
}

function setCache(churchId, data) {
    entitlementsCache.set(churchId, { data, timestamp: Date.now() });
}

/**
 * Clears the entitlements cache (useful when subscription changes)
 * @param {string} [churchId] - Optional specific church to clear, or all if omitted
 */
export function clearEntitlementsCache(churchId) {
    if (churchId) {
        entitlementsCache.delete(churchId);
    } else {
        entitlementsCache.clear();
    }
}

/**
 * Fetches complete entitlements for a church.
 * 
 * Performs three DB reads (cached for 60s):
 * 1. Subscription + plan join (limits)
 * 2. Billing settings
 * 3. Routing map
 * 
 * @param {string} churchId - The church ID to fetch entitlements for
 * @returns {Promise<Entitlements>} Normalized entitlements object
 * @throws {Error} If subscription exists but plan is missing (500)
 * @throws {Error} If billing settings are missing (500)
 */
export async function getEntitlements(churchId) {
    // Check cache first
    const cached = getCached(churchId);
    if (cached) return cached;

    // ========================================
    // 1. Fetch subscription + plan join
    // ========================================
    // 1. Fetch subscription + plan join
    // ========================================
    const { data: subscriptionData, error: subError } = await supabaseAdmin
        .from("subscriptions")
        .select(`
            status,
            current_period_start,
            current_period_end,
            plan_id,
            plans (
                code,
                included_seconds_per_month,
                max_session_seconds,
                max_simultaneous_languages,
                stt_tier,
                tts_tier,
                feature_flags
            )
        `)
        .eq("church_id", churchId)
        .single();

    // Handle no subscription: return "not entitled" (status: 'none')
    // NOTE: We use 'none' not 'canceled' to distinguish missing from Stripe-canceled
    if (subError || !subscriptionData) {
        console.warn(`[Entitlements] No subscription found for church=${churchId}`);
        const notEntitled = {
            churchId,
            subscription: {
                status: "none",
                currentPeriodStart: null,
                currentPeriodEnd: null,
                planCode: "none",
                planId: null,
            },
            limits: {
                includedSecondsPerMonth: 0,
                maxSessionSeconds: 0,
                maxSimultaneousLanguages: 0,
                sttTier: "none",
                ttsTier: "none",
                featureFlags: {},
            },
            billing: {
                paygEnabled: false,
                paygRateCentsPerHour: 0,
                paygHardCapSeconds: null,
                allowOverageWhileLive: false,
            },
            routing: {},
        };
        setCache(churchId, notEntitled);
        return notEntitled;
    }

    // Subscription exists but plan is missing - misconfigured DB
    if (!subscriptionData.plans) {
        throw new Error(
            `[Entitlements] Subscription exists but plan is missing for church=${churchId} plan_id=${subscriptionData.plan_id}`
        );
    }

    const plan = subscriptionData.plans;

    // ========================================
    // 2. Fetch billing settings
    // ========================================
    const { data: billingData, error: billingError } = await supabaseAdmin
        .from("church_billing_settings")
        .select("*")
        .eq("church_id", churchId)
        .single();

    // Billing settings must exist (invariant)
    if (billingError || !billingData) {
        throw new Error(
            `[Entitlements] Billing settings missing for church=${churchId}. Run backfill.`
        );
    }

    // ========================================
    // 3. Fetch routing map by plan_id
    // ========================================
    const { data: routingData, error: routingError } = await supabaseAdmin
        .from("plan_model_routing")
        .select("capability, provider, model, params")
        .eq("plan_id", subscriptionData.plan_id);

    if (routingError) {
        console.warn(`[Entitlements] Error fetching routing for plan_id=${subscriptionData.plan_id}:`, routingError);
    }

    // Build routing map (capability -> { provider, model, params })
    const routing = {};
    if (routingData) {
        for (const row of routingData) {
            routing[row.capability] = {
                provider: row.provider,
                model: row.model,
                params: row.params || {},
            };
        }
    }

    // ========================================
    // Build normalized entitlements object
    // ========================================
    const entitlements = {
        churchId,
        subscription: {
            status: subscriptionData.status,
            currentPeriodStart: subscriptionData.current_period_start,
            currentPeriodEnd: subscriptionData.current_period_end,
            planCode: plan.code,
            planId: subscriptionData.plan_id,
        },
        limits: {
            includedSecondsPerMonth: plan.included_seconds_per_month,
            maxSessionSeconds: plan.max_session_seconds,
            maxSimultaneousLanguages: plan.max_simultaneous_languages,
            sttTier: plan.stt_tier,
            ttsTier: plan.tts_tier,
            featureFlags: plan.feature_flags || {},
        },
        billing: {
            paygEnabled: billingData.payg_enabled,
            paygRateCentsPerHour: billingData.payg_rate_cents_per_hour,
            paygHardCapSeconds: billingData.payg_hard_cap_seconds,
            allowOverageWhileLive: billingData.allow_overage_while_live,
        },
        routing,
    };

    console.log(`[Entitlements] ✓ church=${churchId} plan=${plan.code} status=${subscriptionData.status}`);

    // Cache the result
    setCache(churchId, entitlements);

    return entitlements;
}
