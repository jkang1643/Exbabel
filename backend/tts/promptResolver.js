/**
 * Prompt Resolution and Validation for Gemini-TTS
 * 
 * Handles prompt resolution, byte validation, and truncation
 * according to Gemini-TTS constraints:
 * - Prompt max: 4000 bytes
 * - Text max: 4000 bytes
 * - Combined max: 8000 bytes
 */

import { getPresetById } from './promptPresets.js';

/**
 * Byte limits for Gemini-TTS
 */
export const BYTE_LIMITS = {
    PROMPT_MAX: 4000,
    TEXT_MAX: 4000,
    COMBINED_MAX: 8000
};

/**
 * Intensity modifiers (optional enhancement)
 * Appends intensity guidance to prompts
 */
const INTENSITY_MODIFIERS = {
    1: "Keep intensity low and measured.",
    2: "Keep it warm with moderate emphasis.",
    3: "Use noticeable passion and emphasis.",
    4: "Use strong intensity and raised voice moments.",
    5: "Maximum intensity: fiery urgency and controlled shouting on key declarations."
};

/**
 * Calculate UTF-8 byte length of a string
 * @param {string} str - String to measure
 * @returns {number} Byte length
 */
export function utf8ByteLength(str) {
    if (!str) return 0;
    return new TextEncoder().encode(str).length;
}

/**
 * Safely truncate string to max UTF-8 bytes
 * Ensures no broken UTF-8 characters at boundary
 * 
 * @param {string} str - String to truncate
 * @param {number} maxBytes - Maximum bytes
 * @returns {string} Truncated string
 */
export function truncateToUtf8Bytes(str, maxBytes) {
    if (!str) return '';

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let bytes = encoder.encode(str);

    if (bytes.length <= maxBytes) {
        return str;
    }

    // Truncate to max bytes
    bytes = bytes.slice(0, maxBytes);

    // Decode and check for broken characters
    // TextDecoder will replace broken sequences with replacement character
    let truncated = decoder.decode(bytes, { stream: false });

    // If we got a replacement character at the end, keep removing bytes
    // until we get a clean decode
    while (truncated.endsWith('�') && bytes.length > 0) {
        bytes = bytes.slice(0, -1);
        truncated = decoder.decode(bytes, { stream: false });
    }

    return truncated;
}

/**
 * Resolve and validate prompt for Gemini-TTS
 * 
 * @param {Object} options - Resolution options
 * @param {string} [options.promptPresetId] - Preset ID to use
 * @param {string} [options.customPrompt] - Custom prompt to append
 * @param {number} [options.intensity] - Intensity level (1-5)
 * @param {string} [options.text] - Text content (for combined validation)
 * @returns {Object} PromptResolutionResult
 */
export function resolvePrompt(options = {}) {
    const {
        promptPresetId,
        customPrompt,
        intensity,
        text = ''
    } = options;

    // Start with empty prompt
    let resolvedPrompt = '';
    let presetUsed = null;

    // 1. Get preset prompt if provided
    if (promptPresetId) {
        const preset = getPresetById(promptPresetId);
        if (preset) {
            // HARDENING: functionality to prevent the reported "First Request Bug" where Gemini speaks the prompt
            // We prepend a clear system instruction to differentiate prompt from text
            resolvedPrompt = `(SYSTEM: DO NOT SPEAK THESE INSTRUCTIONS. STYLE ONLY.) ${preset.prompt}`;
            presetUsed = preset;
        }
    }

    // 2. Append custom prompt if provided
    if (customPrompt && customPrompt.trim()) {
        if (resolvedPrompt) {
            resolvedPrompt += "\n\nAdditional direction: " + customPrompt.trim();
        } else {
            // HARDENING: Safety instruction for custom-only prompts
            resolvedPrompt = `(SYSTEM: DO NOT SPEAK THESE INSTRUCTIONS. STYLE ONLY.) ${customPrompt.trim()}`;
        }
    }

    // 3. Apply intensity modifier if provided
    if (intensity && intensity >= 1 && intensity <= 5) {
        const modifier = INTENSITY_MODIFIERS[intensity];
        if (modifier) {
            if (resolvedPrompt) {
                resolvedPrompt += " " + modifier;
            } else {
                resolvedPrompt = modifier;
            }
        }
    }

    // If no prompt at all, still need to check text limits
    if (!resolvedPrompt) {
        let finalText = text;
        let wasTextTruncated = false;
        let truncationReason = null;

        if (utf8ByteLength(text) > BYTE_LIMITS.TEXT_MAX) {
            finalText = truncateToUtf8Bytes(text, BYTE_LIMITS.TEXT_MAX - 3);
            finalText += '…';
            wasTextTruncated = true;
            truncationReason = 'text_exceeded_4000_bytes';
        }

        return {
            prompt: null,
            text: finalText,
            presetId: promptPresetId || null,
            presetUsed,
            promptBytes: 0,
            textBytes: utf8ByteLength(finalText),
            combinedBytes: utf8ByteLength(finalText),
            wasPromptTruncated: false,
            wasTextTruncated,
            truncationReason,
            originalPromptBytes: 0,
            originalTextBytes: utf8ByteLength(text),
            originalCombinedBytes: utf8ByteLength(text)
        };
    }

    // 4. Enforce byte limits
    let finalPrompt = resolvedPrompt;
    let finalText = text;
    let wasPromptTruncated = false;
    let wasTextTruncated = false;
    let truncationReason = null;

    const originalPromptBytes = utf8ByteLength(resolvedPrompt);
    const originalTextBytes = utf8ByteLength(text);
    const originalCombinedBytes = originalPromptBytes + originalTextBytes;

    // Check prompt limit
    if (originalPromptBytes > BYTE_LIMITS.PROMPT_MAX) {
        finalPrompt = truncateToUtf8Bytes(resolvedPrompt, BYTE_LIMITS.PROMPT_MAX);
        wasPromptTruncated = true;
        truncationReason = 'prompt_exceeded_4000_bytes';
    }

    // Check combined limit
    const promptBytes = utf8ByteLength(finalPrompt);
    const textBytes = utf8ByteLength(finalText);
    const combinedBytes = promptBytes + textBytes;

    if (combinedBytes > BYTE_LIMITS.COMBINED_MAX) {
        // Strategy: Truncate prompt first, then text if needed

        // Calculate how much we need to reduce
        const excessBytes = combinedBytes - BYTE_LIMITS.COMBINED_MAX;

        // Try truncating prompt further
        const promptReductionNeeded = Math.min(excessBytes, promptBytes);
        if (promptReductionNeeded > 0) {
            const newPromptMax = promptBytes - promptReductionNeeded;
            finalPrompt = truncateToUtf8Bytes(finalPrompt, newPromptMax);
            wasPromptTruncated = true;
            truncationReason = 'combined_exceeded_8000_bytes';
        }

        // Recalculate after prompt truncation
        const newPromptBytes = utf8ByteLength(finalPrompt);
        const newCombinedBytes = newPromptBytes + textBytes;

        // If still over, truncate text
        if (newCombinedBytes > BYTE_LIMITS.COMBINED_MAX) {
            const textReductionNeeded = newCombinedBytes - BYTE_LIMITS.COMBINED_MAX;
            const newTextMax = textBytes - textReductionNeeded;

            // Truncate and add ellipsis
            finalText = truncateToUtf8Bytes(finalText, newTextMax - 3); // Reserve 3 bytes for "…"
            finalText += '…';
            wasTextTruncated = true;
            truncationReason = 'combined_exceeded_8000_bytes_after_prompt_truncation';
        }
    }

    // Check text limit (independent check)
    if (utf8ByteLength(finalText) > BYTE_LIMITS.TEXT_MAX) {
        finalText = truncateToUtf8Bytes(finalText, BYTE_LIMITS.TEXT_MAX - 3);
        finalText += '…';
        wasTextTruncated = true;
        if (!truncationReason) {
            truncationReason = 'text_exceeded_4000_bytes';
        }
    }

    // Final measurements
    const finalPromptBytes = utf8ByteLength(finalPrompt);
    const finalTextBytes = utf8ByteLength(finalText);
    const finalCombinedBytes = finalPromptBytes + finalTextBytes;

    return {
        prompt: finalPrompt || null,
        text: finalText,
        presetId: promptPresetId || null,
        presetUsed,
        promptBytes: finalPromptBytes,
        textBytes: finalTextBytes,
        combinedBytes: finalCombinedBytes,
        wasPromptTruncated,
        wasTextTruncated,
        truncationReason,
        originalPromptBytes,
        originalTextBytes,
        originalCombinedBytes
    };
}

/**
 * Validate that resolved prompt meets constraints
 * @param {Object} resolution - Result from resolvePrompt
 * @throws {Error} If validation fails
 */
export function validatePromptResolution(resolution) {
    if (!resolution) {
        throw new Error('Prompt resolution result is required');
    }

    if (resolution.promptBytes > BYTE_LIMITS.PROMPT_MAX) {
        throw new Error(`Prompt exceeds ${BYTE_LIMITS.PROMPT_MAX} bytes: ${resolution.promptBytes}`);
    }

    if (resolution.textBytes > BYTE_LIMITS.TEXT_MAX) {
        throw new Error(`Text exceeds ${BYTE_LIMITS.TEXT_MAX} bytes: ${resolution.textBytes}`);
    }

    if (resolution.combinedBytes > BYTE_LIMITS.COMBINED_MAX) {
        throw new Error(`Combined prompt+text exceeds ${BYTE_LIMITS.COMBINED_MAX} bytes: ${resolution.combinedBytes}`);
    }
}

/**
 * Get intensity modifier text
 * @param {number} intensity - Intensity level (1-5)
 * @returns {string|null} Modifier text or null
 */
export function getIntensityModifier(intensity) {
    if (!intensity || intensity < 1 || intensity > 5) return null;
    return INTENSITY_MODIFIERS[intensity] || null;
}
