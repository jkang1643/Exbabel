/**
 * Model Resolver
 * 
 * Resolves AI model configuration from entitlements by capability.
 * 
 * @module entitlements/resolveModel
 */

/**
 * @typedef {import('./getEntitlements.js').Entitlements} Entitlements
 * @typedef {import('./getEntitlements.js').RoutingEntry} RoutingEntry
 */

/**
 * Custom error for missing capability routing.
 */
export class CapabilityNotConfiguredError extends Error {
    constructor(capability, planCode) {
        super(`No routing configured for capability=${capability} plan=${planCode}`);
        this.name = "CapabilityNotConfiguredError";
        this.capability = capability;
        this.planCode = planCode;
    }
}

/**
 * Resolves the model configuration for a given capability.
 * 
 * Does NOT default silently - throws if capability is missing.
 * This prevents billing surprises from accidental defaults.
 * 
 * @param {Entitlements} entitlements - The entitlements object
 * @param {string} capability - The capability to resolve (e.g., 'stt', 'tts', 'chat', 'grammar')
 * @returns {RoutingEntry} The resolved model configuration { provider, model, params }
 * @throws {CapabilityNotConfiguredError} If capability is not configured for the plan
 */
export function resolveModel(entitlements, capability) {
    const routing = entitlements.routing[capability];

    if (!routing) {
        console.error(
            `[ResolveModel] ✗ Missing routing: capability=${capability} plan=${entitlements.subscription.planCode}`
        );
        throw new CapabilityNotConfiguredError(
            capability,
            entitlements.subscription.planCode
        );
    }

    console.log(
        `[ResolveModel] ✓ capability=${capability} → provider=${routing.provider} model=${routing.model}`
    );

    return routing;
}

