/**
 * SSML Configuration for Frontend
 * 
 * Defines delivery styles, power words, and UI configuration
 * for SSML-based preaching delivery (Chirp 3 HD voices only)
 */

/**
 * Delivery style presets
 */
export const DELIVERY_STYLES = {
    standard_preaching: {
        value: 'standard_preaching',
        label: 'Standard Preaching',
        description: 'Warm, confident sermon cadence with intentional pauses',
        icon: '🎤',
        defaultRate: 1.1,
        defaultPitch: '+1st',
        pauseIntensity: 'medium'
    },
    pentecostal: {
        value: 'pentecostal',
        label: 'UPC/Pentecostal',
        description: 'Joyful urgency with rhythmic cadence',
        icon: '🔥',
        defaultRate: 0.94,
        defaultPitch: '+2st',
        pauseIntensity: 'light'
    },
    teaching: {
        value: 'teaching',
        label: 'Teaching',
        description: 'Measured, clear explanation for Bible study',
        icon: '📖',
        defaultRate: 0.90,
        defaultPitch: '0st',
        pauseIntensity: 'heavy'
    },
    altar_call: {
        value: 'altar_call',
        label: 'Altar Call',
        description: 'Softer, inviting tone for invitation',
        icon: '🙏',
        defaultRate: 0.88,
        defaultPitch: '+1st',
        pauseIntensity: 'heavy'
    }
};

/**
 * Power words for emphasis (spiritual/preaching context)
 */
export const POWER_WORDS = [
    // Spiritual
    'Jesus', 'Lord', 'Spirit', 'God', 'Christ', 'Holy', 'Father', 'Savior',
    // Action
    'faith', 'grace', 'mercy', 'deliverance', 'healing', 'salvation', 'redemption', 'forgiveness',
    // Time
    'today', 'now', 'tonight', 'moment',
    // Affirmation
    'amen', 'hallelujah', 'glory', 'praise',
    // Emphasis
    'believe', 'trust', 'hope', 'love', 'truth', 'word', 'promise'
];

/**
 * Pause intensity options
 */
export const PAUSE_INTENSITY_OPTIONS = [
    { value: 'light', label: 'Light (200-300ms)', description: 'Quick, energetic pacing' },
    { value: 'medium', label: 'Medium (300-450ms)', description: 'Balanced sermon cadence' },
    { value: 'heavy', label: 'Heavy (400-500ms)', description: 'Reflective, teaching style' }
];

/**
 * Speaking rate presets
 */
export const RATE_PRESETS = [
    { value: 0.75, label: 'Very Slow (0.75x)' },
    { value: 0.85, label: 'Slow (0.85x)' },
    { value: 0.92, label: 'Sermon Pace (0.92x)' },
    { value: 1.0, label: 'Normal (1.0x)' },
    { value: 1.1, label: 'Slightly Fast (1.1x)' },
    { value: 1.25, label: 'Fast (1.25x)' }
];

/**
 * Pitch adjustment options
 */
export const PITCH_OPTIONS = [
    { value: '-2st', label: '-2 semitones (Lower)' },
    { value: '-1st', label: '-1 semitone' },
    { value: '0st', label: 'Normal (0)' },
    { value: '+1st', label: '+1 semitone (Warm)' },
    { value: '+2st', label: '+2 semitones (Higher)' }
];

/**
 * Check if voice supports SSML
 */
export function voiceSupportsSSML(voiceName, tier) {
    if (!voiceName && !tier) return false;

    // ONLY Chirp 3 HD uses the complex dynamic prosody engine.
    if (tier === 'chirp3_hd') return true;

    // Check voice name patterns
    if (voiceName) {
        return voiceName.includes('Chirp3') ||
            voiceName.includes('Chirp_3') ||
            voiceName.includes('Chirp-3');
    }

    return false;
}

/**
 * Get delivery style by value
 */
export function getDeliveryStyle(value) {
    return DELIVERY_STYLES[value] || DELIVERY_STYLES.standard_preaching;
}

/**
 * Get all delivery styles as array
 */
export function getAllDeliveryStyles() {
    return Object.values(DELIVERY_STYLES);
}
