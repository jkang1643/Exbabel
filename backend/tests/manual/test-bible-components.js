// Quick component tests
import { parseSpokenNumber, findAllSpokenNumbers } from '../core/services/spokenNumberParser.js';
import { detectBookName, findAllBookNames } from '../core/services/bookNameDetector.js';
import { normalizeTranscript } from '../core/services/bibleReferenceNormalizer.js';
import { getFingerprintsInstance } from '../core/services/bibleVerseFingerprints.js';

console.log('🧪 Testing Bible Reference Components\n');
console.log('='.repeat(60));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result) {
      console.log(`✅ ${name}`);
      passed++;
    } else {
      console.log(`❌ ${name}`);
      failed++;
    }
  } catch (error) {
    console.log(`❌ ${name}: ${error.message}`);
    failed++;
  }
}

// Test 1: Spoken Numbers
console.log('\n1. Testing Spoken Number Parser...');
test('Parse "thirty eight" → 38', () => {
  const result = parseSpokenNumber('thirty eight');
  return result?.value === 38;
});

test('Parse "two" → 2', () => {
  const result = parseSpokenNumber('two');
  return result?.value === 2;
});

test('Find numbers in text', () => {
  const numbers = findAllSpokenNumbers('Acts chapter two verse thirty eight');
  return numbers.length >= 2 && numbers.some(n => n.value === 2) && numbers.some(n => n.value === 38);
});

// Test 2: Book Detection
console.log('\n2. Testing Book Name Detector...');
test('Detect "Acts"', () => {
  const tokens = 'acts chapter two'.split(' ');
  const book = detectBookName(tokens, 0);
  return book?.book === 'Acts';
});

test('Detect "1 Corinthians"', () => {
  const tokens = 'first corinthians chapter one'.split(' ');
  const book = detectBookName(tokens, 0);
  return book?.book === '1 Corinthians';
});

test('Find all books in text', () => {
  const tokens = 'in acts chapter two verse thirty eight'.split(' ');
  const books = findAllBookNames(tokens);
  return books.length > 0 && books[0].book === 'Acts';
});

// Test 3: Normalization
console.log('\n3. Testing Normalizer...');
test('Normalize transcript', () => {
  const normalized = normalizeTranscript('In Acts 2:38, Peter said');
  return normalized.tokens.length > 0 && normalized.tokens.includes('acts');
});

test('Tokenize correctly', () => {
  const normalized = normalizeTranscript('The Bible says in John 3:16');
  return normalized.tokens.length >= 5;
});

// Test 4: Fingerprints
console.log('\n4. Testing Fingerprints...');
test('Load fingerprints', () => {
  const fp = getFingerprintsInstance();
  const refs = fp.getAllReferences();
  return refs.length > 0;
});

test('Get verses by keyword', () => {
  const fp = getFingerprintsInstance();
  const verses = fp.getVersesByKeyword('repent');
  return verses.length > 0 && verses.includes('Acts 2:38');
});

test('Match keywords', () => {
  const fp = getFingerprintsInstance();
  const tokens = ['repent', 'baptize', 'holy', 'spirit'];
  const matches = fp.matchKeywords(tokens);
  return matches.size > 0 && matches.has('Acts 2:38');
});

// Summary
console.log('\n' + '='.repeat(60));
console.log(`\n✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`\n${failed === 0 ? '🎉 All tests passed!' : '⚠️  Some tests failed'}\n`);

process.exit(failed === 0 ? 0 : 1);
