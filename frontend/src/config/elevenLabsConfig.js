/**
 * ElevenLabs model capabilities (frontend mirror of backend)
 * Used to show/hide/disable UI controls based on selected tier
 */
export const ELEVENLABS_MODEL_CAPABILITIES = {
    elevenlabs_v3: {
        label: 'Eleven v3 alpha (Expressive)',
        supports: {
            stability: true,
            similarity_boost: true,
            style: true,
            use_speaker_boost: true,
            speed: true
        }
    },
    elevenlabs_turbo: {
        label: 'Eleven Turbo v2.5 (Balanced)',
        supports: {
            stability: true,
            similarity_boost: true,
            style: true,
            use_speaker_boost: true,
            speed: true
        }
    },
    elevenlabs_flash: {
        label: 'Eleven Flash 2.5 (Low Latency)',
        supports: {
            stability: true,
            similarity_boost: true,
            style: true,
            use_speaker_boost: true,
            speed: true
        }
    },
    elevenlabs: {
        label: 'Eleven Multilingual (Stable)',
        supports: {
            stability: true,
            similarity_boost: true,
            style: true,
            use_speaker_boost: true,
            speed: true
        }
    }
};

/**
 * Get ElevenLabs capabilities for a given tier
 * @param {string} tier - ElevenLabs tier
 * @returns {object|null} Capability object or null if not an ElevenLabs tier
 */
export function getElevenLabsCapabilities(tier) {
    return ELEVENLABS_MODEL_CAPABILITIES[tier] || null;
}

/**
 * Check if a tier is an ElevenLabs tier
 * @param {string} tier - Tier to check
 * @returns {boolean} True if ElevenLabs tier
 */
export function isElevenLabsTier(tier) {
    return tier && tier.startsWith('elevenlabs');
}
