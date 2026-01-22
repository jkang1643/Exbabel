/**
 * TTS Voice Resolver
 * 
 * Resolves which voice to use based on precedence:
 * 1. User preference (if provided and allowed)
 * 2. Org default for language (if set and allowed)
 * 3. Catalog default for language
 * 4. Fallback: gemini tier + first available voice
 */

import { getDefaultVoice, isVoiceValid, getVoicesFor } from './voiceCatalog.js';
import { getOrgVoiceDefaults } from './defaults/defaultsStore.js';

/**
 * Resolve voice selection based on preferences and permissions
 * @param {object} params
 * @param {string} params.orgId - Organization ID
 * @param {object} params.userPref - User preference { tier, voiceName } (optional)
 * @param {string} params.languageCode - BCP-47 language code
 * @param {Array<string>} params.allowedTiers - Array of allowed tier names
 * @returns {Promise<object>} Resolved voice { tier, voiceName, reason }
 */
export async function resolveVoice({ orgId, userPref, languageCode, allowedTiers }) {
    // 1. User preference (if provided and allowed)
    if (userPref?.tier && (userPref?.voiceId || userPref?.voiceName)) {
        // Check if tier is allowed
        if (allowedTiers.includes(userPref.tier)) {
            // Validate voice is valid for language/tier (accepts voiceId or voiceName)
            if (await isVoiceValid({
                voiceId: userPref.voiceId,
                voiceName: userPref.voiceName,
                languageCode,
                tier: userPref.tier
            })) {
                return {
                    tier: userPref.tier,
                    voiceId: userPref.voiceId,
                    voiceName: userPref.voiceName,
                    reason: 'user_preference'
                };
            } else {
                const identifier = userPref.voiceId || userPref.voiceName;
                console.warn(`[VoiceResolver] User preference invalid: ${identifier} for ${languageCode}:${userPref.tier}`);
            }
        } else {
            console.warn(`[VoiceResolver] User preference tier not allowed: ${userPref.tier} (allowed: ${allowedTiers.join(', ')})`);
        }
    }

    // 2. Org default for language (if set and allowed)
    try {
        const orgDefaults = await getOrgVoiceDefaults(orgId);
        const orgDefault = orgDefaults[languageCode];

        if (orgDefault?.tier && (orgDefault?.voiceId || orgDefault?.voiceName)) {
            // Check if tier is allowed
            if (allowedTiers.includes(orgDefault.tier)) {
                // Validate voice is valid
                if (await isVoiceValid({
                    voiceId: orgDefault.voiceId,
                    voiceName: orgDefault.voiceName,
                    languageCode,
                    tier: orgDefault.tier
                })) {
                    return {
                        tier: orgDefault.tier,
                        voiceId: orgDefault.voiceId,
                        voiceName: orgDefault.voiceName,
                        reason: 'org_default'
                    };
                } else {
                    const identifier = orgDefault.voiceId || orgDefault.voiceName;
                    console.warn(`[VoiceResolver] Org default invalid: ${identifier} for ${languageCode}:${orgDefault.tier}`);
                }
            } else {
                console.warn(`[VoiceResolver] Org default tier not allowed: ${orgDefault.tier} (allowed: ${allowedTiers.join(', ')})`);
            }
        }
    } catch (error) {
        console.warn(`[VoiceResolver] Failed to get org defaults for ${orgId}:`, error.message);
    }

    // 3. Catalog default for language
    const catalogDefault = await getDefaultVoice({ languageCode, allowedTiers });
    if (catalogDefault) {
        return {
            tier: catalogDefault.tier,
            voiceId: catalogDefault.voiceId,
            voiceName: catalogDefault.voiceName,
            reason: 'catalog_default'
        };
    }

    // 4. Fallback: gemini tier + first available voice for language
    // This handles edge cases where language has no voices in allowed tiers
    console.warn(`[VoiceResolver] No catalog default found for ${languageCode} with tiers ${allowedTiers.join(', ')}`);

    // Try to find any voice for this language in allowed tiers
    for (const tier of ['gemini', 'chirp3_hd', 'neural2', 'standard']) {
        if (!allowedTiers.includes(tier)) continue;

        const voices = await getVoicesFor({ languageCode, allowedTiers: [tier] });
        if (voices.length > 0) {
            return {
                tier: tier,
                voiceId: voices[0].voiceId,
                voiceName: voices[0].voiceName,
                reason: 'fallback_first_available'
            };
        }
    }

    // Ultimate fallback: Use english with gemini
    console.error(`[VoiceResolver] No voices found for ${languageCode}. Falling back to en-US with Gemini.`);
    return {
        tier: 'gemini',
        voiceId: 'gemini:gemini_tts:-:Kore',
        voiceName: 'Kore',
        reason: 'fallback_english'
    };
}
