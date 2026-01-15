/**
 * Gemini-TTS Prompt Preset Library
 * 
 * Natural-language prompts for Gemini-TTS speaking style control.
 * These prompts use the Cloud TTS input.prompt field (Gemini-TTS only).
 * 
 * DO NOT confuse with SSML DeliveryStyles (Chirp 3 HD).
 */

/**
 * Prompt Preset Categories
 */
export const PromptCategory = {
    GENERAL: 'general',
    UPCI_PENTECOSTAL: 'upci_pentecostal'
};

/**
 * General "Amazing Prompt Pack"
 * 
 * Versatile presets for various speaking contexts
 */
const GENERAL_PRESETS = [
    {
        id: 'preacher_warm_build',
        category: PromptCategory.GENERAL,
        label: 'Preacher: Warm Build',
        description: 'Warm, confident sermon cadence with gradual intensity',
        prompt: "Deliver this as a seasoned preacher speaking from the pulpit. Warm, confident, and spiritually uplifting. Use a steady sermon cadence with intentional pauses. Gradually build intensity through the message. Emphasize key spiritual words with conviction, not shouting. End phrases with assurance and authority, not abrupt stops."
    },
    {
        id: 'preacher_call_response',
        category: PromptCategory.GENERAL,
        label: 'Preacher: Call & Response',
        description: 'Rhythmic preaching inviting congregation response',
        prompt: "Speak like a preacher leading a congregation. Use rhythmic phrasing and clear emphasis. Add brief pauses after key statements. Sound inviting and encouraging, as if expecting the audience to respond. Keep it passionate but controlled."
    },
    {
        id: 'pastoral_comfort',
        category: PromptCategory.GENERAL,
        label: 'Pastoral Comfort',
        description: 'Caring pastor offering comfort and empathy',
        prompt: "Speak like a caring pastor offering comfort. Slow, calm pacing. Soft warmth and empathy. Let sentences land with gentle pauses. Avoid dramatic performance; keep it sincere and grounded."
    },
    {
        id: 'interpreter_neutral',
        category: PromptCategory.GENERAL,
        label: 'Interpreter: Neutral',
        description: 'Professional interpreter with high clarity',
        prompt: "Speak like a professional interpreter. Neutral tone, high clarity, steady pace. Pronounce names carefully. Avoid extra emotion. Use natural pauses at commas and sentence boundaries."
    },
    {
        id: 'interpreter_slightly_warm',
        category: PromptCategory.GENERAL,
        label: 'Interpreter: Slightly Warm',
        description: 'Trained interpreter with slight warmth',
        prompt: "Speak like a trained interpreter in a live setting. Clear articulation, steady pace, slight warmth. Keep it natural and easy to follow."
    },
    {
        id: 'stage_announcer',
        category: PromptCategory.GENERAL,
        label: 'Stage Announcer',
        description: 'Confident, energetic stage announcer',
        prompt: "Deliver like a confident stage announcer. Bright, energetic tone. Clear articulation. Slightly faster pace. Smile in the voice. End sentences cleanly."
    },
    {
        id: 'church_announcements',
        category: PromptCategory.GENERAL,
        label: 'Church Announcements',
        description: 'Friendly church announcements host',
        prompt: "Speak like a friendly church announcements host. Warm and upbeat, conversational. Light smiles. Clear enunciation. Short pauses between items."
    },
    {
        id: 'audiobook_intimate',
        category: PromptCategory.GENERAL,
        label: 'Audiobook: Intimate',
        description: 'Natural audiobook narrator',
        prompt: "Narrate like an audiobook reader. Natural, intimate tone. Moderate pacing. Subtle expressiveness. Prioritize clarity and consistency."
    },
    {
        id: 'news_anchor',
        category: PromptCategory.GENERAL,
        label: 'News Anchor',
        description: 'Professional news anchor delivery',
        prompt: "Read like a professional news anchor. Crisp, neutral, authoritative. Steady pace. Minimal emotion."
    },
    {
        id: 'support_agent_calm',
        category: PromptCategory.GENERAL,
        label: 'Support Agent: Calm',
        description: 'Helpful customer support agent',
        prompt: "Speak like a helpful customer support agent. Calm, patient tone. Moderate pace. Clear pronunciation. Friendly but professional."
    }
];

/**
 * UPCI / Pentecostal "Fire Edition" Pack
 * 
 * High-intensity presets for Pentecostal/Apostolic preaching
 */
const UPCI_PENTECOSTAL_PRESETS = [
    {
        id: 'upci_apostolic_fire',
        category: PromptCategory.UPCI_PENTECOSTAL,
        label: 'UPCI: Apostolic Fire',
        description: 'Holy Ghost authority with fiery delivery',
        prompt: "Deliver this as a United Pentecostal (Apostolic) preacher preaching with Holy Ghost authority. Strong, fiery, and bold delivery. Raise intensity throughout the message. Use powerful emphasis, dynamic volume changes, and passionate urgency. Allow moments of raised voice and controlled shouting on key declarations. Use rhythmic cadence common to Pentecostal preaching. Let important words land with conviction and fire. Do not sound calm or neutral—this is proclamation, not narration. End statements with authority and confidence, as if preaching directly to a responsive congregation."
    },
    {
        id: 'upci_altar_call_fire',
        category: PromptCategory.UPCI_PENTECOSTAL,
        label: 'UPCI: Altar Call Fire',
        description: 'Urgent, emotional altar call climax',
        prompt: "Speak as a Pentecostal preacher at the climax of an altar call. Urgent, emotional, and intense. Build rapidly in passion and volume. Use strong emphasis, short forceful phrases, and moments of raised voice. Sound desperate for response, full of faith and authority. Allow intensity to peak, then briefly pull back before final declarations. This should feel like a moment where lives are being called to decision."
    },
    {
        id: 'upci_teaching_authority',
        category: PromptCategory.UPCI_PENTECOSTAL,
        label: 'UPCI: Teaching Authority',
        description: 'Doctrinally strong teaching with fire',
        prompt: "Deliver as a seasoned UPCI preacher teaching with authority and fire. Confident, clear, and doctrinally strong. Use a steady Pentecostal cadence with moments of emphasis and brief intensity spikes. Less shouting than full preaching, but never flat or academic. Speak with conviction, clarity, and spiritual authority."
    },
    {
        id: 'upci_revival_meeting',
        category: PromptCategory.UPCI_PENTECOSTAL,
        label: 'UPCI: Revival Meeting',
        description: 'Explosive camp meeting preaching',
        prompt: "Preach like a Pentecostal revival or camp-meeting preacher. Loud, fiery, and passionate. Strong rhythmic delivery with energetic pacing. Allow frequent emphasis, raised voice, and declaration-style phrases. This should feel explosive, celebratory, and faith-filled, like a packed sanctuary responding audibly."
    },
    {
        id: 'upci_pastoral_authority',
        category: PromptCategory.UPCI_PENTECOSTAL,
        label: 'UPCI: Pastoral Authority',
        description: 'Loving pastor with firm authority',
        prompt: "Speak as a Pentecostal pastor addressing the church with warmth and authority. Loving but firm. Passionate without excessive shouting. Use confident pacing, strong emphasis on key truths, and a tone of spiritual leadership and care."
    },
    {
        id: 'upci_interpreter_neutral_fire',
        category: PromptCategory.UPCI_PENTECOSTAL,
        label: 'UPCI: Interpreter (Fire)',
        description: 'Pentecostal preaching optimized for interpretation',
        prompt: "Speak like a Pentecostal preacher, but optimized for live interpretation. Maintain strong conviction and emphasis without excessive shouting. Keep pacing steady and articulation clear. Allow passion, but avoid overlapping phrases or rapid bursts that would overwhelm interpreters."
    }
];

/**
 * All Prompt Presets
 */
export const PROMPT_PRESETS = [
    ...GENERAL_PRESETS,
    ...UPCI_PENTECOSTAL_PRESETS
];

/**
 * Prompt Preset ID type (for validation)
 */
export const PromptPresetId = {
    // General
    PREACHER_WARM_BUILD: 'preacher_warm_build',
    PREACHER_CALL_RESPONSE: 'preacher_call_response',
    PASTORAL_COMFORT: 'pastoral_comfort',
    INTERPRETER_NEUTRAL: 'interpreter_neutral',
    INTERPRETER_SLIGHTLY_WARM: 'interpreter_slightly_warm',
    STAGE_ANNOUNCER: 'stage_announcer',
    CHURCH_ANNOUNCEMENTS: 'church_announcements',
    AUDIOBOOK_INTIMATE: 'audiobook_intimate',
    NEWS_ANCHOR: 'news_anchor',
    SUPPORT_AGENT_CALM: 'support_agent_calm',

    // UPCI / Pentecostal
    UPCI_APOSTOLIC_FIRE: 'upci_apostolic_fire',
    UPCI_ALTAR_CALL_FIRE: 'upci_altar_call_fire',
    UPCI_TEACHING_AUTHORITY: 'upci_teaching_authority',
    UPCI_REVIVAL_MEETING: 'upci_revival_meeting',
    UPCI_PASTORAL_AUTHORITY: 'upci_pastoral_authority',
    UPCI_INTERPRETER_NEUTRAL_FIRE: 'upci_interpreter_neutral_fire'
};

/**
 * Get preset by ID
 * @param {string} presetId - Preset ID
 * @returns {Object|null} Preset object or null if not found
 */
export function getPresetById(presetId) {
    if (!presetId) return null;
    return PROMPT_PRESETS.find(p => p.id === presetId) || null;
}

/**
 * Get all presets for a category
 * @param {string} category - Category name
 * @returns {Array} Array of presets
 */
export function getPresetsByCategory(category) {
    if (!category) return [];
    return PROMPT_PRESETS.filter(p => p.category === category);
}

/**
 * Validate preset ID
 * @param {string} presetId - Preset ID to validate
 * @returns {boolean} True if valid
 */
export function isValidPresetId(presetId) {
    return Object.values(PromptPresetId).includes(presetId);
}

/**
 * Get all preset IDs
 * @returns {string[]} Array of all preset IDs
 */
export function getAllPresetIds() {
    return Object.values(PromptPresetId);
}

/**
 * Get presets grouped by category
 * @returns {Object} Object with categories as keys
 */
export function getPresetsGroupedByCategory() {
    return {
        [PromptCategory.GENERAL]: getPresetsByCategory(PromptCategory.GENERAL),
        [PromptCategory.UPCI_PENTECOSTAL]: getPresetsByCategory(PromptCategory.UPCI_PENTECOSTAL)
    };
}
