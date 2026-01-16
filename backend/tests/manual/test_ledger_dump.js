// Test script to trigger LEDGER_DUMP for "Y grito"
import { CoreEngine } from '../core/engine/coreEngine.js';

// Import the correlation ledger functions (they need to be accessible)
const corrLedger = new Map(); // sourceSeqId -> { en: [...], es: [...] }
function ledgerAdd(sourceSeqId, kind, payload, route) {
  if (sourceSeqId == null || sourceSeqId === 0) return;
  const entry = corrLedger.get(sourceSeqId) || { en: [], es: [], other: [] };
  const rec = {
    t: Date.now(),
    route, // 'host' | 'listeners'
    kind,  // 'EN_ANCHOR' | 'ES_TRANSLATION' | etc
    isPartial: payload?.isPartial,
    hasTranslation: payload?.hasTranslation,
    hasCorrection: payload?.hasCorrection,
    targetLang: payload?.targetLang,
    previewO: String(payload?.originalText ?? '').slice(0, 60),
    previewT: String(payload?.translatedText ?? '').slice(0, 60),
    updateType: payload?.updateType,
  };
  if (payload?.targetLang === 'en') entry.en.push(rec);
  else if (payload?.targetLang === 'es') entry.es.push(rec);
  else entry.other.push(rec);

  // Keep small
  entry.en = entry.en.slice(-5);
  entry.es = entry.es.slice(-5);
  entry.other = entry.other.slice(-5);

  corrLedger.set(sourceSeqId, entry);
}

async function test() {
  console.log('Simulating ledger dump for "Y grito" scenario...');

  try {
    // First, simulate an EN anchor message
    const enAnchorMessage = {
      type: 'translation',
      originalText: 'I scream loudly in the night',
      translatedText: 'I scream loudly in the night',
      targetLang: 'en',
      sourceLang: 'en',
      hasTranslation: false,
      sourceSeqId: 504,
      isPartial: false
    };

    ledgerAdd(504, 'EN_EMIT', enAnchorMessage, 'host');
    console.log('Added EN anchor to ledger');

    // Then simulate the ES translation message that triggers the dump
    const esTranslationMessage = {
      type: 'translation',
      originalText: 'I scream loudly in the night',
      translatedText: 'Y grito fuerte en la noche', // This contains "Y grito"
      targetLang: 'es',
      sourceLang: 'en',
      hasTranslation: true,
      sourceSeqId: 504,
      isPartial: false
    };

    ledgerAdd(504, 'ES_EMIT', esTranslationMessage, 'listeners');
    console.log('Added ES translation to ledger');

    // Now simulate the TRACE_ES logging and ledger dump
    console.log(`[TRACE_ES] Spanish emission VALID`, {
      type: esTranslationMessage.type,
      updateType: esTranslationMessage.updateType,
      hasCorrection: esTranslationMessage.hasCorrection,
      hasTranslation: esTranslationMessage.hasTranslation,
      sourceLang: esTranslationMessage.sourceLang,
      targetLang: esTranslationMessage.targetLang,
      hasOriginalText: !!(esTranslationMessage.originalText && esTranslationMessage.originalText.trim()),
      hasTranslatedText: !!(esTranslationMessage.translatedText && esTranslationMessage.translatedText.trim()),
      sourceSeqId: esTranslationMessage.sourceSeqId,
      originalPreview: String(esTranslationMessage.originalText ?? '').slice(0, 80),
      translatedPreview: String(esTranslationMessage.translatedText ?? '').slice(0, 80),
      isPartial: esTranslationMessage.isPartial,
      isProblematic: false,
    });

    // TEMP DEBUG LEDGER: Dump ledger for "Y grito" detection
    if (esTranslationMessage?.translatedText?.includes('Y grito')) {
      console.log('[LEDGER_DUMP]', esTranslationMessage.sourceSeqId, corrLedger.get(esTranslationMessage.sourceSeqId));
    }

  } catch (error) {
    console.error('Test failed:', error);
  }
}

test().catch(console.error);
