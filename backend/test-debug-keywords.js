// Debug keyword matching
import { normalizeTranscript } from '../core/services/bibleReferenceNormalizer.js';
import { getFingerprintsInstance } from '../core/services/bibleVerseFingerprints.js';
import { BibleReferenceDetector } from '../core/services/bibleReferenceDetector.js';

console.log('🔍 Debugging Keyword Matching\n');

const text = 'We need to repent and be baptized for the forgiveness of sins';
console.log('Text:', text);

const normalized = normalizeTranscript(text);
console.log('Tokens:', normalized.tokens);

const fp = getFingerprintsInstance();
const matches = fp.matchKeywords(normalized.tokens);
console.log('\nKeyword matches:', Array.from(matches.entries()));

const detector = new BibleReferenceDetector({
  confidenceThreshold: 0.5, // Low threshold for debugging
  enableLLMConfirmation: false
});

detector.detectReferences(text).then(refs => {
  console.log('\nDetected references:', refs);
  if (refs.length > 0) {
    refs.forEach(r => {
      console.log(`  - ${r.displayText}: confidence=${r.confidence.toFixed(2)}, method=${r.method}, hits=${r.hits}, weightedScore=${r.weightedScore?.toFixed(2)}`);
    });
  }
}).catch(console.error);
