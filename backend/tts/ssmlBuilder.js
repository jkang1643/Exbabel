/**
 * SSML Builder for Chirp 3 HD Voices
 * 
 * Provides SSML generation with dynamic prosody control, emphasis, and delivery styles
 * optimized for preaching/sermon delivery.
 * 
 * Based on Google Cloud TTS Chirp 3 HD SSML documentation and
 * best practices for sermon/preaching audio synthesis.
 */

/**
 * Delivery style presets optimized for preaching
 */
export const DeliveryStyles = {
    STANDARD_PREACHING: {
        name: 'standard_preaching',
        label: 'Standard Preaching',
        description: 'Warm, confident, steady sermon cadence with intentional pauses',
        prompt: 'Deliver this as a seasoned preacher speaking from the pulpit. Warm, confident, and spiritually uplifting. Use a steady sermon cadence with intentional pauses. Gradually build intensity through the message. Emphasize key spiritual words with conviction, not shouting. End phrases with assurance and authority, not abrupt stops.',
        prosody: {
            baseRate: 1.1,
            basePitch: 1, // +1st
            dynamic: true
        },
        pauseIntensity: 'medium' // 300-400ms
    },
    PENTECOSTAL: {
        name: 'pentecostal',
        label: 'UPC/Pentecostal',
        description: 'Joyful urgency with rhythmic cadence and Spirit-led energy',
        prompt: 'Preach with joyful urgency and rhythmic cadence. Allow brief pauses for reflection and response. Lift energy slightly on declarations, soften tone on encouragement. Sound confident, Spirit-led, and inviting.',
        prosody: {
            baseRate: 0.94,
            basePitch: 2, // +2st
            dynamic: true
        },
        pauseIntensity: 'light' // 200-300ms
    },
    TEACHING: {
        name: 'teaching',
        label: 'Teaching',
        description: 'Measured, clear explanation style for Bible study',
        prompt: 'Teach with clarity and measured pacing. Emphasize key concepts with gentle authority. Use pauses to allow reflection on important points. Sound knowledgeable, patient, and encouraging.',
        prosody: {
            baseRate: 0.90,
            basePitch: 0, // 0st
            dynamic: false // More steady for teaching
        },
        pauseIntensity: 'heavy' // 400-500ms
    },
    ALTAR_CALL: {
        name: 'altar_call',
        label: 'Altar Call',
        description: 'Softer, inviting, intimate tone for invitation',
        prompt: 'Speak with gentle invitation and compassion. Use a softer, more intimate tone. Allow longer pauses for personal reflection. Sound warm, caring, and hopeful.',
        prosody: {
            baseRate: 0.88,
            basePitch: 1, // +1st
            dynamic: true
        },
        pauseIntensity: 'heavy' // 400-500ms
    }
};

/**
 * Power words that respond extremely well to emphasis in Chirp 3
 * Based on sermon/preaching context
 */
export const POWER_WORDS = {
    spiritual: ['Jesus', 'Lord', 'Spirit', 'God', 'Christ', 'Holy', 'Father', 'Savior', 'Dios', 'Jesucristo', 'Espíritu', 'Santo', 'Señor', 'Cristo'],
    action: ['faith', 'grace', 'mercy', 'deliverance', 'healing', 'salvation', 'redemption', 'forgiveness'],
    time: ['today', 'now', 'tonight', 'moment'],
    affirmation: ['amen', 'hallelujah', 'glory', 'praise'],
    emphasis: ['believe', 'trust', 'hope', 'love', 'truth', 'word', 'promise']
};

/**
 * Pause durations by intensity
 */
const PAUSE_DURATIONS = {
    light: {
        comma: '200ms',
        sentence: '300ms',
        paragraph: '400ms'
    },
    medium: {
        comma: '300ms',
        sentence: '450ms',
        paragraph: '600ms'
    },
    heavy: {
        comma: '400ms',
        sentence: '600ms',
        paragraph: '800ms'
    }
};

/**
 * Languages where pause control is NOT available
 */
const PAUSE_UNSUPPORTED_LANGUAGES = [
    'bg-bg', 'cs-cz', 'el-gr', 'et-ee', 'he-il', 'hr-hr', 'hu-hu',
    'lt-lt', 'lv-lv', 'pa-in', 'ro-ro', 'sk-sk', 'sl-si', 'sr-rs', 'yue-hk'
];

/**
 * Sanitize text for SSML (escape XML special characters)
 */
export function sanitizeForSSML(text) {
    if (!text) return '';

    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Check if language supports pause control
 */
export function supportsPauseControl(languageCode) {
    if (!languageCode) return true;
    const langLower = languageCode.toLowerCase();
    return !PAUSE_UNSUPPORTED_LANGUAGES.some(unsupported => langLower.startsWith(unsupported));
}

/**
 * Emphasize power words in text
 */
export function emphasizePowerWords(text, customWords = [], level = 'moderate') {
    if (!text) return '';

    // Combine all power words
    const allPowerWords = [
        ...POWER_WORDS.spiritual,
        ...POWER_WORDS.action,
        ...POWER_WORDS.time,
        ...POWER_WORDS.affirmation,
        ...POWER_WORDS.emphasis,
        ...customWords
    ];

    let result = text;

    // Replace each power word with emphasized version
    allPowerWords.forEach(word => {
        const regex = new RegExp(`\\b(${word})\\b`, 'gi');
        result = result.replace(regex, `<emphasis level="${level}">$1</emphasis>`);
    });

    return result;
}

/**
 * Tokenize text into phrases based on punctuation
 * Preserves the delimiter to determine pause type
 */
function tokenizePhrases(text) {
    // Split by sentence-level punctuation only, keeping the delimiter
    // Matches: . ? ! ; : — and newlines (COMMAS REMOVED to keep natural flow)
    const regex = /([.?!;:—]|\n+)/;
    const parts = text.split(regex);

    const phrases = [];

    for (let i = 0; i < parts.length; i += 2) {
        const content = parts[i].trim();
        const delimiter = parts[i + 1] || ''; // Delimiter is in the next index

        if (content || delimiter) {
            phrases.push({
                content,
                delimiter
            });
        }
    }

    return phrases;
}

/**
 * Analyze a phrase to determine prosody modifiers
 * @param {string} content - The phrase text
 * @param {string} delimiter - The punctuation ending the phrase
 * @param {Object} baseSettings - Base rate and pitch
 */
function analyzePhrase(content, delimiter, baseSettings) {
    const wordCount = content.split(/\s+/).length;
    const isShort = wordCount > 0 && wordCount <= 4;
    const isMedium = wordCount > 4 && wordCount <= 12;
    const isLong = wordCount > 12;

    const isQuestion = delimiter.includes('?');
    const isExclamation = delimiter.includes('!');
    const isComma = delimiter.includes(',');

    let rate = baseSettings.baseRate;
    let pitch = baseSettings.basePitch;

    // Heuristic Rules for "Dynamic Prosody" (Additive for predictable results)
    if (isShort) {
        // Short phrases often need more punch/emphasis (slower, slightly higher pitch)
        rate = rate - 0.05;
        pitch += 1; // +1st for emphasis
    } else if (isLong) {
        // Long flowing phrases should move slightly faster
        rate = rate + 0.03;
    }

    if (isExclamation) {
        // Excitement
        rate += 0.02;
        pitch += 1;
    }

    if (isQuestion) {
        // Question intonation
        pitch += 1;
    }

    // Ensure we don't exceed API limits (0.25 to 2.0)
    rate = Math.min(2.0, Math.max(0.25, rate));

    return {
        rate: `${Math.round(rate * 100)}%`, // Format as % string
        pitch: `${pitch > 0 ? '+' : ''}${pitch}st` // Format as st string
    };
}

/**
 * Get pause duration tag based on delimiter and intensity
 */
function getPauseTag(delimiter, intensity = 'medium') {
    const durations = PAUSE_DURATIONS[intensity] || PAUSE_DURATIONS.medium;
    let time = null;

    if (delimiter.match(/[.?!]/)) {
        time = durations.sentence;
    } else if (delimiter.match(/[,;:]|—/)) {
        time = durations.comma;
    } else if (delimiter.match(/\n/)) {
        time = durations.paragraph;
    }

    if (time) {
        return `<break time="${time}"/>`;
    }
    return '';
}

/**
 * Build Dynamic SSML with phrase-level prosody
 */
export function buildSSML(text, options = {}) {
    if (!text) return '';

    const {
        rate = '110%', // Global base rate (ignored if dynamic)
        pitch = '+1st', // Global base pitch (ignored if dynamic)
        pauseIntensity = 'medium',
        emphasizePowerWords: shouldEmphasize = true,
        customEmphasisWords = [],
        emphasisLevel = 'moderate',
        // New options for dynamic engine
        useDynamicProsody = true,
        baseRateValue = 1.1, // Numeric base (1.1 = 110%)
        basePitchValue = 1,    // Numeric base (+1)
        suppressProsodyTags = false // New: Skip <prosody> tags (use for Chirp 3 where audioConfig is preferred)
    } = options;

    // 1. Sanitize (MOVED: Now done per-phrase to avoid splitting entities like &apos; on semicolons)
    // const safeText = sanitizeForSSML(text); // REMOVED

    // If dynamic prosody is DISABLED, fallback to simple wrapper
    if (!useDynamicProsody) {
        let processed = sanitizeForSSML(text); // Sanitize here for non-dynamic path
        // Simple pause substitution (legacy)
        processed = processed.replace(/([.?!])\s+/g, `$1 <break time="${PAUSE_DURATIONS[pauseIntensity].sentence}"/> `);
        processed = processed.replace(/([,;])\s+/g, `$1 <break time="${PAUSE_DURATIONS[pauseIntensity].comma}"/> `);

        if (shouldEmphasize) {
            processed = emphasizePowerWords(processed, customEmphasisWords, emphasisLevel);
        }

        if (suppressProsodyTags) {
            return `<speak>${processed}</speak>`;
        }
        return `<speak><prosody rate="${rate}" pitch="${pitch}">${processed}</prosody></speak>`;
    }

    // 2. Tokenize into phrases (Do this on RAW text so we don't split &apos; at the ;)
    const phrases = tokenizePhrases(text);

    // 3. Select base prosody values
    // Attempt to parse global rate/pitch if numeric bases aren't explicit
    let currentBaseRate = baseRateValue;
    let currentBasePitch = basePitchValue;

    if (typeof rate === 'string' && rate.includes('%')) {
        currentBaseRate = parseFloat(rate) / 100;
        if (isNaN(currentBaseRate)) currentBaseRate = 1.1;
    }

    // 4. Build Phrase Blocks
    let ssmlContent = '';

    phrases.forEach(phrase => {
        if (!phrase.content && !phrase.delimiter) return;

        // Apply Sanitization & Emphasis to content BEFORE wrapping in prosody
        let contentWithEmphasis = sanitizeForSSML(phrase.content); // Sanitize content here!

        if (shouldEmphasize && contentWithEmphasis) {
            contentWithEmphasis = emphasizePowerWords(contentWithEmphasis, customEmphasisWords, emphasisLevel);
        }

        // Calculate Dynamic Prosody
        // If content exists, wrap it. Use base settings + analysis.
        if (phrase.content) {
            if (suppressProsodyTags) {
                // Just append content, no prosody wrapper
                ssmlContent += contentWithEmphasis;
            } else {
                const modifiers = analyzePhrase(phrase.content, phrase.delimiter, {
                    baseRate: currentBaseRate,
                    basePitch: currentBasePitch
                });
                ssmlContent += `<prosody rate="${modifiers.rate}" pitch="${modifiers.pitch}">${contentWithEmphasis}</prosody>`;
            }
        }

        // Append Pause based on delimiter
        if (phrase.delimiter) {
            ssmlContent += sanitizeForSSML(phrase.delimiter); // Sanitize delimiter too
            ssmlContent += getPauseTag(phrase.delimiter, pauseIntensity);
        }

        ssmlContent += ' '; // Space for safety
    });

    return `<speak>${ssmlContent}</speak>`;
}

/**
 * Apply a delivery style preset to text
 */
export function applyDeliveryStyle(text, styleName = 'standard_preaching', overrides = {}) {
    // Find style
    const style = Object.values(DeliveryStyles).find(s => s.name === styleName)
        || DeliveryStyles.STANDARD_PREACHING;

    // Determine if we should use dynamic engine
    // Default to true for styles that specify it
    const useDynamic = style.prosody.dynamic !== false;

    // Merge options
    const options = {
        // Legacy options (kept for compatibility/logging)
        rate: overrides.rate || `${style.prosody.baseRate * 100}%`,
        pitch: overrides.pitch || (style.prosody.basePitch > 0 ? `+${style.prosody.basePitch}st` : `${style.prosody.basePitch}st`),

        // New Dynamic Engine options
        useDynamicProsody: useDynamic,
        baseRateValue: (() => {
            if (!overrides.rate) return style.prosody.baseRate;
            if (typeof overrides.rate === 'number') return overrides.rate;
            if (typeof overrides.rate === 'string' && overrides.rate.includes('%')) {
                return parseFloat(overrides.rate) / 100;
            }
            return parseFloat(overrides.rate) || style.prosody.baseRate;
        })(),
        basePitchValue: (() => {
            if (!overrides.pitch) return style.prosody.basePitch;
            if (typeof overrides.pitch === 'number') return overrides.pitch;
            if (typeof overrides.pitch === 'string') {
                const match = overrides.pitch.match(/([+-]?\d+)/);
                return match ? parseInt(match[1]) : style.prosody.basePitch;
            }
            return style.prosody.basePitch;
        })(),

        pauseIntensity: overrides.pauseIntensity !== undefined ? overrides.pauseIntensity : style.pauseIntensity,
        emphasizePowerWords: overrides.emphasizePowerWords !== undefined ? overrides.emphasizePowerWords : true,
        customEmphasisWords: overrides.customEmphasisWords || [],
        emphasisLevel: overrides.emphasisLevel || 'moderate',
        suppressProsodyTags: overrides.suppressProsodyTags || false
    };

    // Build SSML
    const ssml = buildSSML(text, options);

    return {
        ssml,
        prompt: style.prompt,
        style: style,
        options: options
    };
}

// ... Keep existing exports ...
export function buildMarkup(text, options) { return text; } // Simplified placeholder if needed or keep original
export function supportsSSML(voiceName, tier) {
    if (!voiceName && !tier) return false;

    // ONLY Chirp 3 HD uses the complex dynamic prosody engine.
    // Neural2 and Standard respond better to flat audioConfig.speaking_rate.
    if (tier === 'chirp3_hd') return true;

    if (voiceName) {
        return voiceName.includes('Chirp3') || voiceName.includes('Chirp_3') || voiceName.includes('Chirp-3');
    }
    return false;
}

export function getFallbackText(text, pauseIntensity = 'medium') {
    if (!text) return '';
    let result = text;
    if (pauseIntensity === 'heavy') {
        result = result.replace(/\.\s+/g, '… ').replace(/,\s+/g, ' — ');
    } else if (pauseIntensity === 'medium') {
        result = result.replace(/([.!?])\s+/g, '$1 … ').replace(/,\s+([A-Z])/g, ' — $1');
    }
    return result;
}

export function generateTtsInput(text, options = {}) {
    const { voiceName, tier, languageCode, deliveryStyle = 'standard_preaching', ssmlOptions = {} } = options;

    if (!supportsSSML(voiceName, tier)) {
        return {
            inputType: 'text',
            content: getFallbackText(text, ssmlOptions.pauseIntensity || 'medium'),
            prompt: null
        };
    }

    const canUsePauses = supportsPauseControl(languageCode);
    // If pauses unsupported, dynamic builder will still work but we should force pauseIntensity: null inside if we want strictly no breaks
    // For now, let's assume dynamic engine handles basic breaks well enough or we pass a flag.
    // The previous logic for 'canUsePauses' disabled it.

    const result = applyDeliveryStyle(text, deliveryStyle, ssmlOptions);

    // If language doesn't support pauses, we might need to strip <break> tags
    if (!canUsePauses) {
        result.ssml = result.ssml.replace(/<break[^>]*\/>/g, '');
    }

    return {
        inputType: 'ssml',
        content: result.ssml,
        prompt: result.prompt,
        style: result.style
    };
}
