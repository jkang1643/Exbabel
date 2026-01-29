/**
 * Entitlements Module
 * 
 * Server-side entitlement enforcement for the Exbabel platform.
 * 
 * Usage:
 *   import { getEntitlements, resolveModel, assertSubscriptionActive } from './entitlements/index.js';
 */

// Core entitlements fetcher
export { getEntitlements, clearEntitlementsCache } from "./getEntitlements.js";

// Model resolver
export { resolveModel, CapabilityNotConfiguredError } from "./resolveModel.js";

// Enforcement assertions
export {
    assertSubscriptionActive,
    assertLanguageLimit,
    assertFeatureEnabled,
    assertRole,
    assertTtsTierAllowed,
    getAllowedTtsTiers,
    SubscriptionInactiveError,
    LanguageLimitExceededError,
    FeatureNotEnabledError,
    InsufficientRoleError,
    TtsTierNotAllowedError,
} from "./assertEntitled.js";

