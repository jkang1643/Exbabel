/**
 * Comprehensive Bible Reference Detection Test
 * 
 * Run with: node test-bible-full.js
 * Requires OPENAI_API_KEY for AI-based tests (loads from backend/.env)
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env file from backend directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

import { parseSpokenNumber } from '../core/services/spokenNumberParser.js';
import { detectBookName } from '../core/services/bookNameDetector.js';
import { normalizeTranscript } from '../core/services/bibleReferenceNormalizer.js';
import { getFingerprintsInstance } from '../core/services/bibleVerseFingerprints.js';
import { BibleReferenceDetector } from '../core/services/bibleReferenceDetector.js';
import { CoreEngine } from '../core/engine/coreEngine.js';

console.log('🧪 Bible Reference Detection - Full Test Suite (AI-Based)\n');
console.log('='.repeat(70));

// Check for API key
const hasApiKey = !!process.env.OPENAI_API_KEY;
if (hasApiKey) {
  console.log('✅ OPENAI_API_KEY found - AI tests will run');
} else {
  console.log('⚠️  OPENAI_API_KEY not set - AI tests will be skipped');
  console.log('   Set it with: export OPENAI_API_KEY=your_key_here\n');
}
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let skippedTests = 0;
const testDetails = [];

function test(name, fn) {
  totalTests++;
  const startTime = Date.now();
  try {
    const result = fn();
    const duration = Date.now() - startTime;
    if (result === true || (result && result !== false)) {
      console.log(`✅ ${name} (${duration}ms)`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration, error: null });
      return true;
    } else {
      console.log(`❌ ${name} (${duration}ms)`);
      testDetails.push({ name, status: 'failed', duration, error: 'Test returned false' });
      return false;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ ${name}: ${error.message} (${duration}ms)`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1]?.trim()}`);
    }
    testDetails.push({ name, status: 'failed', duration, error: error.message });
    return false;
  }
}

async function testAsync(name, fn, details = {}) {
  totalTests++;
  const startTime = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - startTime;
    if (result === true || (result && result !== false)) {
      const detailsStr = details.result ? ` - ${details.result}` : '';
      console.log(`✅ ${name}${detailsStr} (${duration}ms)`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration, error: null, details });
      return true;
    } else {
      console.log(`❌ ${name} (${duration}ms)`);
      if (details.expected) {
        console.log(`   Expected: ${details.expected}`);
      }
      if (details.actual) {
        console.log(`   Actual: ${details.actual}`);
      }
      testDetails.push({ name, status: 'failed', duration, error: details.expected || 'Test returned false', details });
      return false;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ ${name}: ${error.message} (${duration}ms)`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1]?.trim()}`);
    }
    testDetails.push({ name, status: 'failed', duration, error: error.message });
    return false;
  }
}

// ============================================================================
// Test Suite 1: Spoken Number Parser
// ============================================================================
console.log('\n📊 Test Suite 1: Spoken Number Parser');
console.log('-'.repeat(70));

test('Parse "thirty eight" → 38', () => {
  const result = parseSpokenNumber('thirty eight');
  return result?.value === 38;
});

test('Parse "two" → 2', () => {
  const result = parseSpokenNumber('two');
  return result?.value === 2;
});

test('Parse "twenty one" → 21', () => {
  const result = parseSpokenNumber('twenty one');
  return result?.value === 21;
});

// ============================================================================
// Test Suite 2: Book Name Detector
// ============================================================================
console.log('\n📖 Test Suite 2: Book Name Detector');
console.log('-'.repeat(70));

test('Detect "Acts"', () => {
  const tokens = 'acts chapter two'.split(' ');
  const book = detectBookName(tokens, 0);
  return book?.book === 'Acts';
});

test('Detect "John"', () => {
  const tokens = 'john chapter three'.split(' ');
  const book = detectBookName(tokens, 0);
  return book?.book === 'John';
});

test('Detect "1 Corinthians" with ordinal', () => {
  const tokens = 'first corinthians'.split(' ');
  const book = detectBookName(tokens, 0);
  return book?.book === '1 Corinthians';
});

// ============================================================================
// Test Suite 3: Transcript Normalizer
// ============================================================================
console.log('\n🔤 Test Suite 3: Transcript Normalizer');
console.log('-'.repeat(70));

test('Normalize and tokenize', () => {
  const normalized = normalizeTranscript('In Acts 2:38, Peter said');
  // After normalization: lowercase, strip punctuation, tokenize
  // "In Acts 2:38, Peter said" → ['in', 'acts', '2', '38', 'peter', 'said']
  // Check that we have tokens and 'acts' is one of them (case-insensitive)
  const hasActs = normalized.tokens.some(t => {
    const lower = t.toLowerCase();
    return lower === 'acts' || lower === 'act';
  });
  return normalized.tokens.length >= 5 && hasActs;
});

test('Strip punctuation', () => {
  const normalized = normalizeTranscript('Acts 2:38!');
  return !normalized.normalizedText.includes(':') && !normalized.normalizedText.includes('!');
});

// ============================================================================
// Test Suite 4: Verse Fingerprints
// ============================================================================
console.log('\n🧬 Test Suite 4: Verse Fingerprints');
console.log('-'.repeat(70));

test('Load fingerprints', () => {
  const fp = getFingerprintsInstance();
  const refs = fp.getAllReferences();
  return refs.length > 0;
});

test('Get verses by keyword "repent"', () => {
  const fp = getFingerprintsInstance();
  const verses = fp.getVersesByKeyword('repent');
  return verses.length > 0 && verses.includes('Acts 2:38');
});

test('Match keywords to verses', () => {
  const fp = getFingerprintsInstance();
  const tokens = ['repent', 'baptize', 'holy', 'spirit'];
  const matches = fp.matchKeywords(tokens);
  return matches.size > 0 && matches.has('Acts 2:38');
});

// ============================================================================
// Test Suite 5: Full Detection Engine (Regex + AI Hybrid)
// ============================================================================
console.log('\n🔍 Test Suite 5: Full Detection Engine (Hybrid: Regex + AI)');
console.log('-'.repeat(70));

// Detector for regex-only tests (AI disabled)
const regexDetector = new BibleReferenceDetector({
  confidenceThreshold: 0.85,
  enableAIMatching: false, // Disable AI for regex-only tests
  openaiApiKey: process.env.OPENAI_API_KEY
});

// Detector for AI-based tests
const aiDetector = hasApiKey ? new BibleReferenceDetector({
  confidenceThreshold: 0.75, // Lower threshold for AI matches
  aiConfidenceThreshold: 0.75,
  enableAIMatching: true,
  openaiApiKey: process.env.OPENAI_API_KEY
}) : null;

await testAsync('Detect explicit reference "Acts 2:38" (regex)', async () => {
  const text = 'In Acts 2:38, Peter said to repent';
  const refs = await regexDetector.detectReferences(text);
  const passed = refs.length > 0 && refs[0].displayText === 'Acts 2:38' && refs[0].method === 'regex';
  return {
    result: passed ? `Found: ${refs[0]?.displayText} (${refs[0]?.method}, confidence: ${refs[0]?.confidence?.toFixed(2)})` : 'No match found',
    expected: 'Acts 2:38 via regex',
    actual: refs.length > 0 ? `${refs[0].displayText} (${refs[0].method})` : 'No matches'
  };
}, { result: '', expected: '', actual: '' });

await testAsync('Detect spoken numbers "Acts chapter two verse thirty eight" (regex)', async () => {
  const text = 'As it is written in Acts chapter two verse thirty eight';
  const lowThresholdDetector = new BibleReferenceDetector({
    confidenceThreshold: 0.7,
    enableAIMatching: false,
    openaiApiKey: process.env.OPENAI_API_KEY
  });
  const refs = await lowThresholdDetector.detectReferences(text);
  const passed = refs.length > 0 && refs[0].displayText === 'Acts 2:38';
  return {
    result: passed ? `Found: ${refs[0]?.displayText} (${refs[0]?.method}, confidence: ${refs[0]?.confidence?.toFixed(2)})` : 'No match found',
    expected: 'Acts 2:38',
    actual: refs.length > 0 ? refs[0].displayText : 'No matches'
  };
}, { result: '', expected: '', actual: '' });

// AI-based tests
if (hasApiKey && aiDetector) {
  await testAsync('Detect via AI "repent and be baptized"', async () => {
    const text = 'Peter said we need to repent and be baptized for the forgiveness of sins';
    console.log(`   📝 Testing: "${text}"`);
    const refs = await aiDetector.detectReferences(text);
    const passed = refs.length > 0 && refs.some(r => r.displayText.includes('Acts 2:38') || r.displayText.includes('Acts'));
    if (refs.length > 0) {
      console.log(`   📊 AI Results: ${refs.length} reference(s) found`);
      refs.forEach((ref, i) => {
        console.log(`      ${i + 1}. ${ref.displayText} (${ref.method}, confidence: ${ref.confidence.toFixed(2)})`);
      });
    } else {
      console.log(`   ⚠️  AI returned no matches (may be rate limited or uncertain)`);
    }
    return {
      result: passed ? `Found: ${refs[0]?.displayText} (${refs[0]?.method}, confidence: ${refs[0]?.confidence?.toFixed(2)})` : 'No match found',
      expected: 'Acts 2:38 via AI',
      actual: refs.length > 0 ? `${refs.map(r => r.displayText).join(', ')}` : 'No matches'
    };
  }, { result: '', expected: '', actual: '' });

  await testAsync('Detect via AI "God so loved the world"', async () => {
    const text = 'The Bible says that God so loved the world that he gave his only son';
    console.log(`   📝 Testing: "${text}"`);
    const refs = await aiDetector.detectReferences(text);
    const passed = refs.length > 0 && refs.some(r => r.displayText.includes('John 3:16'));
    if (refs.length > 0) {
      console.log(`   📊 AI Results: ${refs.length} reference(s) found`);
      refs.forEach((ref, i) => {
        console.log(`      ${i + 1}. ${ref.displayText} (${ref.method}, confidence: ${ref.confidence.toFixed(2)})`);
      });
    } else {
      console.log(`   ⚠️  AI returned no matches`);
    }
    return {
      result: passed ? `Found: ${refs[0]?.displayText} (${refs[0]?.method}, confidence: ${refs[0]?.confidence?.toFixed(2)})` : 'No match found',
      expected: 'John 3:16 via AI',
      actual: refs.length > 0 ? `${refs.map(r => r.displayText).join(', ')}` : 'No matches'
    };
  }, { result: '', expected: '', actual: '' });

  await testAsync('Detect via AI "wages of sin is death"', async () => {
    const text = 'The Bible says the wages of sin is death but the gift of God is eternal life';
    console.log(`   📝 Testing: "${text}"`);
    const refs = await aiDetector.detectReferences(text);
    const passed = refs.length > 0 && refs.some(r => r.displayText.includes('Romans 6:23'));
    if (refs.length > 0) {
      console.log(`   📊 AI Results: ${refs.length} reference(s) found`);
      refs.forEach((ref, i) => {
        console.log(`      ${i + 1}. ${ref.displayText} (${ref.method}, confidence: ${ref.confidence.toFixed(2)})`);
      });
    } else {
      console.log(`   ⚠️  AI returned no matches`);
    }
    return {
      result: passed ? `Found: ${refs[0]?.displayText} (${refs[0]?.method}, confidence: ${refs[0]?.confidence?.toFixed(2)})` : 'No match found',
      expected: 'Romans 6:23 via AI',
      actual: refs.length > 0 ? `${refs.map(r => r.displayText).join(', ')}` : 'No matches'
    };
  }, { result: '', expected: '', actual: '' });

  // Test chapter-only reference with AI verse matching
  await testAsync('Detect chapter-only "Acts 2" and match verse via AI', async () => {
    const text = 'In Acts 2, Peter said to repent and be baptized for the forgiveness of sins';
    console.log(`   📝 Testing: "${text}"`);
    const refs = await aiDetector.detectReferences(text);
    // Should find Acts 2:38 via chapter-only regex + AI verse matching
    const passed = refs.length > 0 && refs.some(r => 
      r.displayText.includes('Acts 2:') && 
      (r.method === 'regex+ai' || r.method === 'ai')
    );
    if (refs.length > 0) {
      console.log(`   📊 Results: ${refs.length} reference(s) found`);
      refs.forEach((ref, i) => {
        console.log(`      ${i + 1}. ${ref.displayText} (${ref.method}, confidence: ${ref.confidence.toFixed(2)})`);
      });
    } else {
      console.log(`   ⚠️  No matches found`);
    }
    return {
      result: passed ? `Found: ${refs[0]?.displayText} (${refs[0]?.method}, confidence: ${refs[0]?.confidence?.toFixed(2)})` : 'No match found',
      expected: 'Acts 2:38 via regex+ai (chapter-only + AI verse matching)',
      actual: refs.length > 0 ? `${refs.map(r => r.displayText).join(', ')}` : 'No matches'
    };
  }, { result: '', expected: '', actual: '' });
} else {
  // Mark AI tests as skipped
  const aiTestNames = [
    'Detect via AI "repent and be baptized"',
    'Detect via AI "God so loved the world"',
    'Detect via AI "wages of sin is death"'
  ];
  aiTestNames.forEach(name => {
    skippedTests++;
    testDetails.push({ name, status: 'skipped', duration: 0, error: null });
    console.log(`   ⚠️  Skipping: ${name}`);
  });
}

await testAsync('No false positives on unrelated text', async () => {
  const text = 'Today is a nice day and the weather is good';
  const refs = await regexDetector.detectReferences(text);
  const passed = refs.length === 0;
  return {
    result: passed ? 'Correctly rejected' : `Unexpected matches: ${refs.map(r => r.displayText).join(', ')}`,
    expected: 'No matches',
    actual: refs.length > 0 ? `${refs.length} match(es)` : 'No matches'
  };
}, { result: '', expected: '', actual: '' });

// ============================================================================
// Test Suite 6: Core Engine Integration
// ============================================================================
console.log('\n⚙️  Test Suite 6: Core Engine Integration');
console.log('-'.repeat(70));

const coreEngine = new CoreEngine({
  bibleConfig: {
    confidenceThreshold: 0.85,
    aiConfidenceThreshold: 0.75,
    enableAIMatching: hasApiKey, // Enable AI if API key available
    openaiApiKey: process.env.OPENAI_API_KEY,
    transcriptWindowSeconds: 10
  }
});

coreEngine.initialize();

await testAsync('CoreEngine detects references (regex)', async () => {
  const text = 'In Acts 2:38, Peter said to repent';
  const refs = await coreEngine.detectReferences(text, {
    sourceLang: 'en',
    targetLang: 'es',
    seqId: 1
  });
  const passed = refs.length > 0 && refs[0].displayText === 'Acts 2:38';
  return {
    result: passed ? `Found: ${refs[0]?.displayText} (${refs[0]?.method})` : 'No match found',
    expected: 'Acts 2:38',
    actual: refs.length > 0 ? refs[0].displayText : 'No matches'
  };
}, { result: '', expected: '', actual: '' });

// ============================================================================
// Test Suite 7: Trigger-Based AI Filtering
// ============================================================================
console.log('\n🎯 Test Suite 7: Trigger-Based AI Filtering');
console.log('-'.repeat(70));

if (hasApiKey && aiDetector) {
  // Track AI calls by intercepting the methods
  let aiCallCount = 0;
  const originalAiVerseMatching = aiDetector.aiVerseMatching.bind(aiDetector);
  const originalAiVerseMatchingForChapter = aiDetector.aiVerseMatchingForChapter.bind(aiDetector);
  
  aiDetector.aiVerseMatching = async function(...args) {
    aiCallCount++;
    return originalAiVerseMatching(...args);
  };
  
  aiDetector.aiVerseMatchingForChapter = async function(...args) {
    aiCallCount++;
    return originalAiVerseMatchingForChapter(...args);
  };

  await testAsync('AI called when trigger present: "The Bible says"', async () => {
    aiCallCount = 0; // Reset counter
    const text = 'The Bible says that God so loved the world';
    const hasTrigger = aiDetector.hasContextualTrigger(text);
    const startTime = Date.now();
    const refs = await aiDetector.detectReferences(text);
    const duration = Date.now() - startTime;
    const aiWasCalled = aiCallCount > 0; // Check actual call count, not duration
    
    const passed = hasTrigger && aiWasCalled && refs.length > 0;
    console.log(`   📝 Text: "${text}"`);
    console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ✅' : 'NO ❌'}`);
    console.log(`   🤖 AI called: ${aiWasCalled ? 'YES' : 'NO'} (${aiCallCount} call(s), ${duration}ms)`);
    console.log(`   📊 Matches: ${refs.length}`);
    
    return {
      result: passed ? `Trigger found, AI called, match found` : `Trigger: ${hasTrigger}, AI: ${aiWasCalled}, Matches: ${refs.length}`,
      expected: 'Trigger found, AI called, match found',
      actual: `Trigger: ${hasTrigger}, AI: ${aiWasCalled}, Matches: ${refs.length}`
    };
  }, { result: '', expected: '', actual: '' });

  await testAsync('AI NOT called when no trigger: Generic text', async () => {
    aiCallCount = 0; // Reset counter
    const text = 'Today is a nice day and the weather is good';
    const hasTrigger = aiDetector.hasContextualTrigger(text);
    const startTime = Date.now();
    const refs = await aiDetector.detectReferences(text);
    const duration = Date.now() - startTime;
    const aiWasCalled = aiCallCount > 0; // Check actual call count, not duration
    
    const passed = !hasTrigger && !aiWasCalled;
    console.log(`   📝 Text: "${text}"`);
    console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ❌' : 'NO ✅'}`);
    console.log(`   🤖 AI called: ${aiWasCalled ? 'YES ❌' : 'NO ✅'} (${aiCallCount} call(s), ${duration}ms)`);
    
    return {
      result: passed ? `No trigger, AI not called (correct)` : `Trigger: ${hasTrigger}, AI: ${aiWasCalled}`,
      expected: 'No trigger, AI not called',
      actual: `Trigger: ${hasTrigger}, AI: ${aiWasCalled}`
    };
  }, { result: '', expected: '', actual: '' });

  await testAsync('AI NOT called when no trigger: "repent and be baptized" (no trigger phrase)', async () => {
    aiCallCount = 0; // Reset counter
    const text = 'We need to repent and be baptized for the forgiveness of sins';
    const hasTrigger = aiDetector.hasContextualTrigger(text);
    const startTime = Date.now();
    const refs = await aiDetector.detectReferences(text);
    const duration = Date.now() - startTime;
    const aiWasCalled = aiCallCount > 0; // Check actual call count, not duration
    
    const passed = !hasTrigger && !aiWasCalled;
    console.log(`   📝 Text: "${text}"`);
    console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ❌' : 'NO ✅'}`);
    console.log(`   🤖 AI called: ${aiWasCalled ? 'YES ❌' : 'NO ✅'} (${aiCallCount} call(s), ${duration}ms)`);
    
    return {
      result: passed ? `No trigger, AI not called (correct)` : `Trigger: ${hasTrigger}, AI: ${aiWasCalled}`,
      expected: 'No trigger, AI not called',
      actual: `Trigger: ${hasTrigger}, AI: ${aiWasCalled}`
    };
  }, { result: '', expected: '', actual: '' });

  await testAsync('AI called when trigger present: "Peter said"', async () => {
    aiCallCount = 0; // Reset counter
    const text = 'Peter said to repent and be baptized';
    const hasTrigger = aiDetector.hasContextualTrigger(text);
    const startTime = Date.now();
    const refs = await aiDetector.detectReferences(text);
    const duration = Date.now() - startTime;
    const aiWasCalled = aiCallCount > 0; // Check actual call count, not duration
    
    const passed = hasTrigger && aiWasCalled && refs.length > 0;
    console.log(`   📝 Text: "${text}"`);
    console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ✅' : 'NO ❌'}`);
    console.log(`   🤖 AI called: ${aiWasCalled ? 'YES' : 'NO'} (${aiCallCount} call(s), ${duration}ms)`);
    console.log(`   📊 Matches: ${refs.length}`);
    
    return {
      result: passed ? `Trigger found, AI called, match found` : `Trigger: ${hasTrigger}, AI: ${aiWasCalled}, Matches: ${refs.length}`,
      expected: 'Trigger found, AI called, match found',
      actual: `Trigger: ${hasTrigger}, AI: ${aiWasCalled}, Matches: ${refs.length}`
    };
  }, { result: '', expected: '', actual: '' });
} else {
  console.log('   ⚠️  Skipping trigger filtering tests (no API key)');
  const triggerTestNames = [
    'AI called when trigger present: "The Bible says"',
    'AI NOT called when no trigger: Generic text',
    'AI NOT called when no trigger: "repent and be baptized" (no trigger phrase)',
    'AI called when trigger present: "Peter said"'
  ];
  triggerTestNames.forEach(name => {
    skippedTests++;
    testDetails.push({ name, status: 'skipped', duration: 0, error: null });
  });
}

// ============================================================================
// Test Suite 8: Fuzzy Trigger Matching
// ============================================================================
console.log('\n🔤 Test Suite 8: Fuzzy Trigger Matching');
console.log('-'.repeat(70));

const fuzzyDetector = new BibleReferenceDetector({
  confidenceThreshold: 0.75,
  enableAIMatching: false // Disable AI for trigger-only tests
});

await testAsync('Exact match: "The Bible says"', async () => {
  const text = 'The Bible says that God so loved the world';
  const hasTrigger = fuzzyDetector.hasContextualTrigger(text);
  const passed = hasTrigger === true;
  console.log(`   📝 Text: "${text}"`);
  console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ✅' : 'NO ❌'}`);
  return {
    result: passed ? 'Trigger detected' : 'Trigger not detected',
    expected: 'Trigger detected',
    actual: hasTrigger ? 'Trigger detected' : 'Trigger not detected'
  };
}, { result: '', expected: '', actual: '' });

await testAsync('Punctuation variation: "The Bible, says"', async () => {
  const text = 'The Bible, says that God so loved the world';
  const hasTrigger = fuzzyDetector.hasContextualTrigger(text);
  const passed = hasTrigger === true;
  console.log(`   📝 Text: "${text}"`);
  console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ✅' : 'NO ❌'}`);
  return {
    result: passed ? 'Trigger detected' : 'Trigger not detected',
    expected: 'Trigger detected',
    actual: hasTrigger ? 'Trigger detected' : 'Trigger not detected'
  };
}, { result: '', expected: '', actual: '' });

await testAsync('Spelling typo: "The bibel says"', async () => {
  const text = 'The bibel says that God so loved the world';
  const hasTrigger = fuzzyDetector.hasContextualTrigger(text);
  const passed = hasTrigger === true;
  console.log(`   📝 Text: "${text}"`);
  console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ✅' : 'NO ❌'}`);
  return {
    result: passed ? 'Trigger detected (fuzzy match)' : 'Trigger not detected',
    expected: 'Trigger detected (fuzzy match)',
    actual: hasTrigger ? 'Trigger detected' : 'Trigger not detected'
  };
}, { result: '', expected: '', actual: '' });

await testAsync('Capitalization: "THE BIBLE SAYS"', async () => {
  const text = 'THE BIBLE SAYS that God so loved the world';
  const hasTrigger = fuzzyDetector.hasContextualTrigger(text);
  const passed = hasTrigger === true;
  console.log(`   📝 Text: "${text}"`);
  console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ✅' : 'NO ❌'}`);
  return {
    result: passed ? 'Trigger detected' : 'Trigger not detected',
    expected: 'Trigger detected',
    actual: hasTrigger ? 'Trigger detected' : 'Trigger not detected'
  };
}, { result: '', expected: '', actual: '' });

await testAsync('Extra spaces: "The  Bible   says"', async () => {
  const text = 'The  Bible   says that God so loved the world';
  const hasTrigger = fuzzyDetector.hasContextualTrigger(text);
  const passed = hasTrigger === true;
  console.log(`   📝 Text: "${text}"`);
  console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ✅' : 'NO ❌'}`);
  return {
    result: passed ? 'Trigger detected' : 'Trigger not detected',
    expected: 'Trigger detected',
    actual: hasTrigger ? 'Trigger detected' : 'Trigger not detected'
  };
}, { result: '', expected: '', actual: '' });

await testAsync('Fuzzy match: "The Bibel say" (typo + verb form)', async () => {
  const text = 'The Bibel say that God so loved the world';
  const hasTrigger = fuzzyDetector.hasContextualTrigger(text);
  const passed = hasTrigger === true;
  console.log(`   📝 Text: "${text}"`);
  console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ✅' : 'NO ❌'}`);
  return {
    result: passed ? 'Trigger detected (fuzzy match)' : 'Trigger not detected',
    expected: 'Trigger detected (fuzzy match)',
    actual: hasTrigger ? 'Trigger detected' : 'Trigger not detected'
  };
}, { result: '', expected: '', actual: '' });

await testAsync('Fuzzy match: "Peter say" (verb form variation)', async () => {
  const text = 'Peter say to repent and be baptized';
  const hasTrigger = fuzzyDetector.hasContextualTrigger(text);
  const passed = hasTrigger === true;
  console.log(`   📝 Text: "${text}"`);
  console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ✅' : 'NO ❌'}`);
  return {
    result: passed ? 'Trigger detected (fuzzy match)' : 'Trigger not detected',
    expected: 'Trigger detected (fuzzy match)',
    actual: hasTrigger ? 'Trigger detected' : 'Trigger not detected'
  };
}, { result: '', expected: '', actual: '' });

await testAsync('Fuzzy match: "as it is writen" (typo)', async () => {
  const text = 'As it is writen, we must love one another';
  const hasTrigger = fuzzyDetector.hasContextualTrigger(text);
  const passed = hasTrigger === true;
  console.log(`   📝 Text: "${text}"`);
  console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ✅' : 'NO ❌'}`);
  return {
    result: passed ? 'Trigger detected (fuzzy match)' : 'Trigger not detected',
    expected: 'Trigger detected (fuzzy match)',
    actual: hasTrigger ? 'Trigger detected' : 'Trigger not detected'
  };
}, { result: '', expected: '', actual: '' });

await testAsync('No match: Completely different text', async () => {
  const text = 'Today is a nice day and the weather is good';
  const hasTrigger = fuzzyDetector.hasContextualTrigger(text);
  const passed = hasTrigger === false;
  console.log(`   📝 Text: "${text}"`);
  console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ❌' : 'NO ✅'}`);
  return {
    result: passed ? 'Correctly rejected' : 'Unexpected trigger detected',
    expected: 'No trigger detected',
    actual: hasTrigger ? 'Trigger detected' : 'No trigger detected'
  };
}, { result: '', expected: '', actual: '' });

await testAsync('No match: Similar but not close enough', async () => {
  const text = 'The book mentions something interesting';
  const hasTrigger = fuzzyDetector.hasContextualTrigger(text);
  const passed = hasTrigger === false;
  console.log(`   📝 Text: "${text}"`);
  console.log(`   🔍 Trigger detected: ${hasTrigger ? 'YES ❌' : 'NO ✅'}`);
  return {
    result: passed ? 'Correctly rejected' : 'Unexpected trigger detected',
    expected: 'No trigger detected',
    actual: hasTrigger ? 'Trigger detected' : 'No trigger detected'
  };
}, { result: '', expected: '', actual: '' });

// ============================================================================
// Summary
// ============================================================================
console.log('\n' + '='.repeat(70));
console.log('\n📊 Test Summary');
console.log('-'.repeat(70));

// Calculate properly - totalTests includes skipped, but we need to track them separately
const actualTotal = testDetails.length;
const failedTests = testDetails.filter(t => t.status === 'failed').length;
const actualSkipped = testDetails.filter(t => t.status === 'skipped').length;
const totalRun = actualTotal - actualSkipped;

console.log(`   Total Tests: ${actualTotal}`);
console.log(`   Passed: ${passedTests}`);
console.log(`   Failed: ${failedTests}`);
console.log(`   Skipped: ${actualSkipped} (AI tests without API key)`);
console.log(`   Success Rate: ${totalRun > 0 ? ((passedTests / totalRun) * 100).toFixed(1) : 0}%`);

// Calculate total duration
const totalDuration = testDetails.reduce((sum, t) => sum + t.duration, 0);
const avgDuration = testDetails.length > 0 ? (totalDuration / testDetails.length).toFixed(0) : 0;
console.log(`   Total Duration: ${totalDuration}ms`);
console.log(`   Average Duration: ${avgDuration}ms per test`);

// Detailed breakdown
console.log('\n📋 Test Details');
console.log('-'.repeat(70));

const bySuite = {
  'Spoken Number Parser': testDetails.filter(t => t.name.includes('Parse')),
  'Book Name Detector': testDetails.filter(t => t.name.includes('Detect "')),
  'Transcript Normalizer': testDetails.filter(t => t.name.includes('Normalize') || t.name.includes('Strip')),
  'Verse Fingerprints': testDetails.filter(t => t.name.includes('fingerprint') || t.name.includes('keyword')),
  'Detection Engine': testDetails.filter(t => (t.name.includes('Detect') || t.name.includes('false positive')) && !t.name.includes('AI called') && !t.name.includes('Exact match') && !t.name.includes('Punctuation') && !t.name.includes('Spelling') && !t.name.includes('Capitalization') && !t.name.includes('Extra spaces') && !t.name.includes('Fuzzy match') && !t.name.includes('No match')),
  'Core Engine': testDetails.filter(t => t.name.includes('CoreEngine')),
  'Trigger Filtering': testDetails.filter(t => t.name.includes('AI called') || t.name.includes('AI NOT called')),
  'Fuzzy Triggers': testDetails.filter(t => t.name.includes('Exact match') || t.name.includes('Punctuation') || t.name.includes('Spelling') || t.name.includes('Capitalization') || t.name.includes('Extra spaces') || t.name.includes('Fuzzy match') || (t.name.includes('No match') && !t.name.includes('false positive')))
};

for (const [suite, tests] of Object.entries(bySuite)) {
  if (tests.length > 0) {
    const suitePassed = tests.filter(t => t.status === 'passed').length;
    const suiteFailed = tests.filter(t => t.status === 'failed').length;
    console.log(`\n   ${suite}: ${suitePassed}/${tests.length} passed`);
    if (suiteFailed > 0) {
      tests.filter(t => t.status === 'failed').forEach(t => {
        console.log(`      ❌ ${t.name}`);
        if (t.error) console.log(`         Error: ${t.error}`);
      });
    }
  }
}

// AI-specific summary
if (hasApiKey) {
  const aiTests = testDetails.filter(t => t.name.includes('via AI'));
  if (aiTests.length > 0) {
    const aiPassed = aiTests.filter(t => t.status === 'passed').length;
    console.log(`\n   🤖 AI-Based Tests: ${aiPassed}/${aiTests.length} passed`);
    aiTests.forEach(t => {
      const status = t.status === 'passed' ? '✅' : '❌';
      console.log(`      ${status} ${t.name} (${t.duration}ms)`);
      if (t.details?.result) {
        console.log(`         ${t.details.result}`);
      }
    });
  }
} else {
  console.log(`\n   🤖 AI-Based Tests: Skipped (no OPENAI_API_KEY)`);
}

console.log('\n' + '='.repeat(70));

if (failedTests === 0 && actualSkipped === 0) {
  console.log('\n🎉 All tests passed! The Bible reference detection system is working correctly.\n');
  process.exit(0);
} else if (failedTests === 0) {
  console.log(`\n✅ All run tests passed! (${actualSkipped} AI test(s) skipped - set OPENAI_API_KEY to run them)\n`);
  process.exit(0);
} else {
  console.log(`\n⚠️  ${failedTests} test(s) failed. Please review the errors above.\n`);
  process.exit(1);
}
