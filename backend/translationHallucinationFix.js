/**
 * Detect if output is a hallucination (conversational response instead of translation)
 * @param {string} text - Output text to validate
 * @param {string} originalText - Original input text
 * @returns {boolean} - True if hallucination detected
 */
export const isHallucinatedResponse = (text, originalText) => {
    if (!text || !originalText) return false;

    const lowerText = text.toLowerCase().trim();
    const lowerOriginal = originalText.toLowerCase().trim();

    // Pattern 1: Conversational phrases that indicate hallucination
    const hallucinationPatterns = [
        /^(i'm sorry|i am sorry|sorry)/i,
        /^(hello|hi|hey)/i,
        /^(i can't|i cannot|i can not)/i,
        /^(yes|no|sure|okay|ok)\b/i,
        /^(i don't|i do not)/i,
        /^(thank you|thanks)/i,
        /^(how are you|how can i help)/i,
        /^(i understand|i see)/i,
        /^(of course|certainly)/i,
        /^(let me|i will|i'll)/i,
        /^i\s+(am|'m)\s+(sorry|apologize|afraid)/i,
        /^i\s+(cannot|can't|don't|cannot)\s+/i,
        /^i\s+can\s+help/i,
        /^let\s+me\s+help/i,
        /^i\s+would\s+be\s+happy/i,
        /^i\s+can\s+assist/i,
        /^here\s+to\s+(help|assist)/i,
        /^respectful\s+and\s+meaningful/i,
        /^i\s+appreciate/i
    ];

    for (const pattern of hallucinationPatterns) {
        if (pattern.test(lowerText)) {
            return true;
        }
    }

    // Pattern 2: Output is identical to input (no translation occurred)
    if (lowerText === lowerOriginal && text.length > 5) {
        return true;
    }

    // Pattern 3: Output is suspiciously short for a long input (likely refused)
    if (originalText.length > 50 && text.length < 10) {
        return true;
    }

    return false;
};
