/**
 * Base Grammar Provider
 * Abstract base class for grammar correction providers
 */
export class BaseGrammarProvider {
    constructor(config = {}) {
        this.name = 'base';
        this.config = config;
    }

    /**
     * Correct grammar for partial text (fast, lower quality is acceptable)
     * @param {string} text - Text to correct
     * @param {object} options - Additional options (apiKey, signal, etc.)
     * @returns {Promise<string>} - Corrected text
     */
    async correctPartial(text, options = {}) {
        throw new Error('Method correctPartial must be implemented by subclass');
    }

    /**
     * Correct grammar for final text (higher quality, more capable model)
     * @param {string} text - Text to correct
     * @param {object} options - Additional options (apiKey, etc.)
     * @returns {Promise<string>} - Corrected text
     */
    async correctFinal(text, options = {}) {
        throw new Error('Method correctFinal must be implemented by subclass');
    }
}
