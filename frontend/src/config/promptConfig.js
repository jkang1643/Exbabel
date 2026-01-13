/**
 * Prompt Configuration for Frontend
 * 
 * Mirrors backend prompt presets for UI display.
 * Used by TtsPanel to show available prompt options.
 */

/**
 * Prompt Categories
 */
export const PROMPT_CATEGORIES = [
    { id: 'general', label: 'General' },
    { id: 'upci_pentecostal', label: 'UPCI / Pentecostal' }
];

/**
 * Prompt Presets
 * 
 * Each preset includes:
 * - id: Unique identifier (matches backend)
 * - category: Category ID
 * - label: Human-readable name for UI
 * - description: Short description for tooltips
 */
export const PROMPT_PRESETS = [
    // General Presets
    {
        id: 'preacher_warm_build',
        category: 'general',
        label: 'Preacher: Warm Build',
        description: 'Warm, confident sermon cadence with gradual intensity'
    },
    {
        id: 'preacher_call_response',
        category: 'general',
        label: 'Preacher: Call & Response',
        description: 'Rhythmic preaching inviting congregation response'
    },
    {
        id: 'pastoral_comfort',
        category: 'general',
        label: 'Pastoral Comfort',
        description: 'Caring pastor offering comfort and empathy'
    },
    {
        id: 'interpreter_neutral',
        category: 'general',
        label: 'Interpreter: Neutral',
        description: 'Professional interpreter with high clarity'
    },
    {
        id: 'interpreter_slightly_warm',
        category: 'general',
        label: 'Interpreter: Slightly Warm',
        description: 'Trained interpreter with slight warmth'
    },
    {
        id: 'stage_announcer',
        category: 'general',
        label: 'Stage Announcer',
        description: 'Confident, energetic stage announcer'
    },
    {
        id: 'church_announcements',
        category: 'general',
        label: 'Church Announcements',
        description: 'Friendly church announcements host'
    },
    {
        id: 'audiobook_intimate',
        category: 'general',
        label: 'Audiobook: Intimate',
        description: 'Natural audiobook narrator'
    },
    {
        id: 'news_anchor',
        category: 'general',
        label: 'News Anchor',
        description: 'Professional news anchor delivery'
    },
    {
        id: 'support_agent_calm',
        category: 'general',
        label: 'Support Agent: Calm',
        description: 'Helpful customer support agent'
    },

    // UPCI / Pentecostal Presets
    {
        id: 'upci_apostolic_fire',
        category: 'upci_pentecostal',
        label: 'UPCI: Apostolic Fire',
        description: 'Holy Ghost authority with fiery delivery'
    },
    {
        id: 'upci_altar_call_fire',
        category: 'upci_pentecostal',
        label: 'UPCI: Altar Call Fire',
        description: 'Urgent, emotional altar call climax'
    },
    {
        id: 'upci_teaching_authority',
        category: 'upci_pentecostal',
        label: 'UPCI: Teaching Authority',
        description: 'Doctrinally strong teaching with fire'
    },
    {
        id: 'upci_revival_meeting',
        category: 'upci_pentecostal',
        label: 'UPCI: Revival Meeting',
        description: 'Explosive camp meeting preaching'
    },
    {
        id: 'upci_pastoral_authority',
        category: 'upci_pentecostal',
        label: 'UPCI: Pastoral Authority',
        description: 'Loving pastor with firm authority'
    },
    {
        id: 'upci_interpreter_neutral_fire',
        category: 'upci_pentecostal',
        label: 'UPCI: Interpreter (Fire)',
        description: 'Pentecostal preaching optimized for interpretation'
    }
];

/**
 * Get preset by ID
 * @param {string} presetId - Preset ID
 * @returns {Object|null} Preset object or null
 */
export function getPresetById(presetId) {
    return PROMPT_PRESETS.find(p => p.id === presetId) || null;
}

/**
 * Get presets by category
 * @param {string} categoryId - Category ID
 * @returns {Array} Array of presets
 */
export function getPresetsByCategory(categoryId) {
    return PROMPT_PRESETS.filter(p => p.category === categoryId);
}

/**
 * Get presets grouped by category
 * @returns {Object} Object with category IDs as keys
 */
export function getPresetsGroupedByCategory() {
    const grouped = {};
    PROMPT_CATEGORIES.forEach(cat => {
        grouped[cat.id] = getPresetsByCategory(cat.id);
    });
    return grouped;
}

/**
 * Calculate UTF-8 byte length (client-side)
 * @param {string} str - String to measure
 * @returns {number} Byte length
 */
export function utf8ByteLength(str) {
    if (!str) return 0;
    return new TextEncoder().encode(str).length;
}

/**
 * Byte limits (must match backend)
 */
export const BYTE_LIMITS = {
    PROMPT_MAX: 4000,
    TEXT_MAX: 4000,
    COMBINED_MAX: 8000
};

/**
 * Get byte usage status
 * @param {number} bytes - Current bytes
 * @param {number} max - Maximum bytes
 * @returns {string} Status: 'ok' | 'warning' | 'error'
 */
export function getByteStatus(bytes, max) {
    const percentage = (bytes / max) * 100;
    if (percentage >= 100) return 'error';
    if (percentage >= 90) return 'warning';
    return 'ok';
}
