import { BaseGrammarProvider } from './BaseGrammarProvider.js';

export class DummyGrammarProvider extends BaseGrammarProvider {
    constructor(config = {}) {
        super(config);
        this.name = 'dummy';
    }

    async correctPartial(text, options = {}) {
        console.log(`[DummyGrammarProvider] correctPartial: ${text}`);
        return text; // Pass through
    }

    async correctFinal(text, options = {}) {
        console.log(`[DummyGrammarProvider] correctFinal: ${text}`);
        // Simulate some simple correction for testing
        if (text.endsWith('.')) return text;
        return text + '.';
    }
}
