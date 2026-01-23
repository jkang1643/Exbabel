import { OpenAIGrammarProvider } from './OpenAIGrammarProvider.js';
import { DeepSeekGrammarProvider } from './DeepSeekGrammarProvider.js';
import { DummyGrammarProvider } from './DummyGrammarProvider.js';

export class GrammarProviderFactory {
    static createProvider(type, config = {}) {
        switch (type.toLowerCase()) {
            case 'openai':
                return new OpenAIGrammarProvider(config);
            case 'deepseek':
                return new DeepSeekGrammarProvider(config);
            case 'dummy':
                return new DummyGrammarProvider(config);
            default:
                console.warn(`[GrammarProviderFactory] Unknown provider type: ${type}, defaulting to OpenAI`);
                return new OpenAIGrammarProvider(config);
        }
    }
}
