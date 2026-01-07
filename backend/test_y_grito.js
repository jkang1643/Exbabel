// Test script to trigger "Y grito" translation
import translationManager from './translationManager.js';
import { CoreEngine } from '../core/engine/coreEngine.js';

async function test() {
  console.log('Testing translation that should produce "Y grito"...');

  try {
    // Test direct translation
    const result = await translationManager.translateToMultipleLanguages(
      'I scream',
      'en',
      ['es'],
      process.env.OPENAI_API_KEY
    );

    console.log('Translation result:', result);

    // Also test through CoreEngine to simulate the full pipeline
    const coreEngine = new CoreEngine();
    await coreEngine.initialize();

    // Simulate the message structure that would trigger the ledger dump
    const testMessage = {
      type: 'translation',
      originalText: 'I scream',
      translatedText: result.es || 'Y grito', // Use actual translation or fallback
      targetLang: 'es',
      sourceLang: 'en',
      hasTranslation: true,
      sourceSeqId: 504, // Use the sourceSeqId mentioned in the user's request
      isPartial: false
    };

    console.log('Test message:', testMessage);

  } catch (error) {
    console.error('Test failed:', error);
  }
}

test().catch(console.error);
