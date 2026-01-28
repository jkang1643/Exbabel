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

/**
 * Resolves allowed TTS catalog tiers based on business plan tier.
 * 
 * Maps business logic (basic/pro/enterprise) to technical catalog tiers.
 * 
 * @param {Entitlements} entitlements 
 * @returns {Array<string>} Array of allowed tier strings (e.g. ['standard', 'neural2'])
 */
export function resolveAllowedTiers(entitlements) {
    const ttsTier = entitlements.limits.ttsTier || 'none';

    // TIERS MAPPING
    // 'basic' -> standard, neural2 (No custom/premium voices)
    // 'pro'   -> all Google (including Studio/Journey) + ElevenLabs standard + Flash
    // 'enterprise' -> everything including ElevenLabs Turbo/V3

    // Default / fallback
    const tiers = ['standard'];

    switch (ttsTier) {
        case 'basic':
            // High quality Google, no premium external
            return ['standard', 'neural2', 'chirp3_hd', 'gemini'];

        case 'pro':
            // Adds Studio voices + ElevenLabs efficient models
            return ['standard', 'neural2', 'chirp3_hd', 'gemini', 'google_studio', 'elevenlabs_flash', 'elevenlabs_standard'];

        case 'enterprise':
        case 'unlimited':
            // Everything
            return ['standard', 'neural2', 'chirp3_hd', 'gemini', 'google_studio', 'elevenlabs_flash', 'elevenlabs_standard', 'elevenlabs_turbo', 'elevenlabs_v3'];

        case 'none':
        default:
            return [];
    }
}
