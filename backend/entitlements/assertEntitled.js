/**
 * Entitlement Enforcement Helpers
 * 
 * Functions to assert entitlement conditions and throw on violations.
 * 
 * @module entitlements/assertEntitled
 */

/**
 * @typedef {import('./getEntitlements.js').Entitlements} Entitlements
 */

// ========================================
// Custom Error Classes
// ========================================

/**
 * Error thrown when subscription status blocks access.
 */
export class SubscriptionInactiveError extends Error {
    constructor(status, planCode) {
        super(`Subscription is ${status} (plan=${planCode}). Access denied.`);
        this.name = "SubscriptionInactiveError";
        this.status = status;
        this.planCode = planCode;
        this.httpStatus = status === "past_due" ? 402 : 403;
    }
}

/**
 * Error thrown when language limit is exceeded.
 */
export class LanguageLimitExceededError extends Error {
    constructor(requested, allowed, planCode) {
        super(
            `Requested ${requested} languages but plan=${planCode} allows max=${allowed}`
        );
        this.name = "LanguageLimitExceededError";
        this.requested = requested;
        this.allowed = allowed;
        this.planCode = planCode;
        this.httpStatus = 403;
    }
}

/**
 * Error thrown when a feature is not enabled.
 */
export class FeatureNotEnabledError extends Error {
    constructor(featureName, planCode) {
        super(`Feature '${featureName}' is not enabled for plan=${planCode}`);
        this.name = "FeatureNotEnabledError";
        this.featureName = featureName;
        this.planCode = planCode;
        this.httpStatus = 403;
    }
}

/**
 * Error thrown when user role is insufficient.
 */
export class InsufficientRoleError extends Error {
    constructor(requiredRole, actualRole) {
        super(`Required role '${requiredRole}' but user has '${actualRole}'`);
        this.name = "InsufficientRoleError";
        this.requiredRole = requiredRole;
        this.actualRole = actualRole;
        this.httpStatus = 403;
    }
}

// ========================================
// Assertion Functions
// ========================================

/**
 * Allowed subscription statuses for active access.
 */
const ACTIVE_STATUSES = ["active", "trialing"];

/**
 * Asserts that the subscription is active (allows access).
 * 
 * Allowed statuses: 'active', 'trialing'
 * Blocked statuses: 'past_due', 'canceled', 'paused', 'none'
 * 
 * @param {Entitlements} entitlements - The entitlements object
 * @throws {SubscriptionInactiveError} If subscription is not active
 */
export function assertSubscriptionActive(entitlements) {
    const { status, planCode } = entitlements.subscription;

    if (!ACTIVE_STATUSES.includes(status)) {
        console.warn(
            `[AssertEntitled] ✗ Subscription blocked: status=${status} plan=${planCode} church=${entitlements.churchId}`
        );
        throw new SubscriptionInactiveError(status, planCode);
    }

    console.log(`[AssertEntitled] ✓ Subscription active: status=${status} plan=${planCode}`);
}

/**
 * Asserts that the requested language count is within limits.
 * 
 * @param {Entitlements} entitlements - The entitlements object
 * @param {number} requestedCount - Number of languages requested
 * @throws {LanguageLimitExceededError} If limit is exceeded
 */
export function assertLanguageLimit(entitlements, requestedCount) {
    const maxAllowed = entitlements.limits.maxSimultaneousLanguages;
    const planCode = entitlements.subscription.planCode;

    if (requestedCount > maxAllowed) {
        console.warn(
            `[AssertEntitled] ✗ Language limit exceeded: requested=${requestedCount} max=${maxAllowed} plan=${planCode} church=${entitlements.churchId}`
        );
        throw new LanguageLimitExceededError(requestedCount, maxAllowed, planCode);
    }

    console.log(
        `[AssertEntitled] ✓ Language limit OK: requested=${requestedCount} max=${maxAllowed}`
    );
}

/**
 * Asserts that a feature flag is enabled.
 * 
 * @param {Entitlements} entitlements - The entitlements object
 * @param {string} featureName - The feature to check
 * @throws {FeatureNotEnabledError} If feature is not enabled
 */
export function assertFeatureEnabled(entitlements, featureName) {
    const featureFlags = entitlements.limits.featureFlags || {};
    const planCode = entitlements.subscription.planCode;

    if (!featureFlags[featureName]) {
        console.warn(
            `[AssertEntitled] ✗ Feature not enabled: feature=${featureName} plan=${planCode} church=${entitlements.churchId}`
        );
        throw new FeatureNotEnabledError(featureName, planCode);
    }

    console.log(`[AssertEntitled] ✓ Feature enabled: feature=${featureName}`);
}

/**
 * Asserts that the user has the required role.
 * 
 * @param {Object} auth - The auth context (from req.auth)
 * @param {string} requiredRole - The required role ('admin' or 'member')
 * @throws {InsufficientRoleError} If role is insufficient
 */
export function assertRole(auth, requiredRole) {
    if (requiredRole === "admin" && auth.role !== "admin") {
        console.warn(
            `[AssertEntitled] ✗ Insufficient role: required=${requiredRole} actual=${auth.role} user=${auth.user_id}`
        );
        throw new InsufficientRoleError(requiredRole, auth.role);
    }

    console.log(`[AssertEntitled] ✓ Role OK: required=${requiredRole} actual=${auth.role}`);
}
