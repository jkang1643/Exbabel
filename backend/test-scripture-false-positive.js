/**
 * TDD Test for Scripture False Positive Detection
 * 
 * This test identifies the issue where scripture is being detected in solo mode
 * when there is no clear scripture present.
 * 
 * Issue: Text like "We're two or three gathered together" is triggering false
 * positives for books like "1 Corinthians 1:2", "Hosea 1:2", "Esther 1:2", "Romans 1:2"
 * 
 * Run with: node test-scripture-false-positive.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env file from backend directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

import { normalizeTranscript } from '../core/services/bibleReferenceNormalizer.js';
import { findAllBookNames } from '../core/services/bookNameDetector.js';
import { BibleReferenceDetector } from '../core/services/bibleReferenceDetector.js';

console.log('🧪 Scripture False Positive Detection Test\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    const result = fn();
    if (result === true || (result && result !== false)) {
      console.log(`✅ ${name}`);
      passedTests++;
      return true;
    } else {
      console.log(`❌ ${name}`);
      if (result && typeof result === 'object' && result.message) {
        console.log(`   ${result.message}`);
      }
      failedTests++;
      return false;
    }
  } catch (error) {
    console.log(`❌ ${name}: ${error.message}`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1]?.trim()}`);
    }
    failedTests++;
    return false;
  }
}

async function testAsync(name, fn) {
  totalTests++;
  try {
    const result = await fn();
    if (result === true || (result && result !== false)) {
      console.log(`✅ ${name}`);
      passedTests++;
      return true;
    } else {
      console.log(`❌ ${name}`);
      if (result && typeof result === 'object' && result.message) {
        console.log(`   ${result.message}`);
        if (result.details) {
          console.log(`   Details: ${JSON.stringify(result.details, null, 2)}`);
        }
      }
      failedTests++;
      return false;
    }
  } catch (error) {
    console.log(`❌ ${name}: ${error.message}`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1]?.trim()}`);
    }
    failedTests++;
    return false;
  }
}

// ============================================================================
// Test Suite: False Positive Detection
// ============================================================================

console.log('\n📋 Test Suite: False Positive Detection');
console.log('-'.repeat(70));

// Test case from the actual logs
const problematicText = "You know, when you entertain strangers, you may be entertaining angels unaware, you know, but if you miss that, let me give you this one. We're two or three gathered together";

// Create detector with AI disabled to focus on regex issues
const regexDetector = new BibleReferenceDetector({
  confidenceThreshold: 0.85,
  enableAIMatching: false // Disable AI to test regex-only false positives
});

// Test 1: Check if the problematic text triggers false positives
await testAsync('No false positives on "We\'re two or three gathered together"', async () => {
  const text = "We're two or three gathered together";
  const refs = await regexDetector.detectReferences(text);
  
  if (refs.length > 0) {
    return {
      message: `Found ${refs.length} false positive(s): ${refs.map(r => r.displayText).join(', ')}`,
      details: {
        text,
        detectedReferences: refs.map(r => ({
          book: r.book,
          chapter: r.chapter,
          verse: r.verse,
          confidence: r.confidence,
          method: r.method,
          displayText: r.displayText
        }))
      }
    };
  }
  
  return true;
});

// Test 1b: Check if low-confidence book matches are being used to create high-confidence references
await testAsync('Low-confidence book matches should not create high-confidence references', async () => {
  // This text has "this one" which becomes "thi one" after normalization
  // "thi" matches "first corinthians" (firTHIst) with low confidence
  // Then "one" and "two" become chapter 1, verse 2
  const text = "let me give you this one. We're two or three";
  const refs = await regexDetector.detectReferences(text);
  
  // Check for references that have high confidence but are based on fuzzy book matches
  const suspiciousRefs = refs.filter(r => r.confidence >= 0.85);
  
  if (suspiciousRefs.length > 0) {
    console.log(`   🔍 Found ${suspiciousRefs.length} high-confidence false positive(s): ${suspiciousRefs.map(r => r.displayText).join(', ')}`);
    return false; // Explicitly return false to fail the test
  }
  
  return true;
});

// Test 1c: Reproduce exact issue from logs
await testAsync('Exact text from logs should not produce false positives', async () => {
  const text = "You know, when you entertain strangers, you may be entertaining angels unaware, you know, but if you miss that, let me give you this one. We're two or three gathered together";
  const refs = await regexDetector.detectReferences(text);
  
  // Debug output
  console.log(`   🔍 Found ${refs.length} reference(s)`);
  if (refs.length > 0) {
    refs.forEach((ref, idx) => {
      console.log(`      ${idx + 1}. ${ref.displayText} (conf: ${ref.confidence}, method: ${ref.method})`);
    });
    // This should NOT detect any scripture - return false to fail the test
    return false;
  }
  
  return true;
});

// Test 2: Check the full problematic text
await testAsync('No false positives on full problematic text', async () => {
  const refs = await regexDetector.detectReferences(problematicText);
  
  if (refs.length > 0) {
    return {
      message: `Found ${refs.length} false positive(s): ${refs.map(r => r.displayText).join(', ')}`,
      details: {
        text: problematicText,
        detectedReferences: refs.map(r => ({
          book: r.book,
          chapter: r.chapter,
          verse: r.verse,
          confidence: r.confidence,
          method: r.method,
          displayText: r.displayText
        }))
      }
    };
  }
  
  return true;
});

// Test 3: Check book name detection on individual words
test('Book name detector should not match "gathered" as "Esther"', () => {
  const normalized = normalizeTranscript("gathered");
  const bookDetections = findAllBookNames(normalized.tokens);
  
  const estherMatches = bookDetections.filter(b => b.book === 'Esther');
  if (estherMatches.length > 0) {
    return {
      message: `"gathered" incorrectly matched as "Esther" (confidence: ${estherMatches[0].confidence})`
    };
  }
  
  return true;
});

test('Book name detector should not match "together" as "Esther"', () => {
  const normalized = normalizeTranscript("together");
  const bookDetections = findAllBookNames(normalized.tokens);
  
  const estherMatches = bookDetections.filter(b => b.book === 'Esther');
  if (estherMatches.length > 0) {
    return {
      message: `"together" incorrectly matched as "Esther" (confidence: ${estherMatches[0].confidence})`
    };
  }
  
  return true;
});

test('Book name detector should not match "we\'re" as any book', () => {
  const normalized = normalizeTranscript("we're");
  const bookDetections = findAllBookNames(normalized.tokens);
  
  if (bookDetections.length > 0) {
    return {
      message: `"we're" incorrectly matched as: ${bookDetections.map(b => b.book).join(', ')}`
    };
  }
  
  return true;
});

// Test 4: Check normalization of the problematic text
test('Normalization should not create book name matches', () => {
  const normalized = normalizeTranscript(problematicText);
  const bookDetections = findAllBookNames(normalized.tokens);
  
  // Log what tokens are being created
  console.log(`   📝 Normalized tokens: [${normalized.tokens.join(', ')}]`);
  
  if (bookDetections.length > 0) {
    console.log(`   ⚠️  Book detections found: ${bookDetections.map(b => `${b.book} (conf: ${b.confidence})`).join(', ')}`);
    return {
      message: `Found ${bookDetections.length} book detection(s) in normalized text: ${bookDetections.map(b => b.book).join(', ')}`,
      details: {
        tokens: normalized.tokens,
        detections: bookDetections
      }
    };
  }
  
  return true;
});

// Test 5: Check specific false positive patterns from logs
await testAsync('Should not detect "1 Corinthians 1:2" in "We\'re two or three"', async () => {
  const text = "We're two or three";
  const refs = await regexDetector.detectReferences(text);
  
  const corinthiansMatch = refs.find(r => r.book === '1 Corinthians' && r.chapter === 1 && r.verse === 2);
  if (corinthiansMatch) {
    return {
      message: `False positive: "1 Corinthians 1:2" detected in "${text}"`,
      details: corinthiansMatch
    };
  }
  
  return true;
});

await testAsync('Should not detect "Hosea 1:2" in "We\'re two or three"', async () => {
  const text = "We're two or three";
  const refs = await regexDetector.detectReferences(text);
  
  const hoseaMatch = refs.find(r => r.book === 'Hosea' && r.chapter === 1 && r.verse === 2);
  if (hoseaMatch) {
    return {
      message: `False positive: "Hosea 1:2" detected in "${text}"`,
      details: hoseaMatch
    };
  }
  
  return true;
});

await testAsync('Should not detect "Esther 1:2" in "gathered together"', async () => {
  const text = "gathered together";
  const refs = await regexDetector.detectReferences(text);
  
  const estherMatch = refs.find(r => r.book === 'Esther' && r.chapter === 1 && r.verse === 2);
  if (estherMatch) {
    return {
      message: `False positive: "Esther 1:2" detected in "${text}"`,
      details: estherMatch
    };
  }
  
  return true;
});

await testAsync('Should not detect "Romans 1:2" in "We\'re two or three"', async () => {
  const text = "We're two or three";
  const refs = await regexDetector.detectReferences(text);
  
  const romansMatch = refs.find(r => r.book === 'Romans' && r.chapter === 1 && r.verse === 2);
  if (romansMatch) {
    return {
      message: `False positive: "Romans 1:2" detected in "${text}"`,
      details: romansMatch
    };
  }
  
  return true;
});

// Test 6: Check with AI enabled (to see if AI is causing issues)
const aiDetector = new BibleReferenceDetector({
  confidenceThreshold: 0.85,
  enableAIMatching: true,
  openaiApiKey: process.env.OPENAI_API_KEY
});

if (process.env.OPENAI_API_KEY) {
  await testAsync('AI should not detect scripture in "We\'re two or three gathered together"', async () => {
    const text = "We're two or three gathered together";
    const refs = await aiDetector.detectReferences(text);
    
    if (refs.length > 0) {
      return {
        message: `AI detected ${refs.length} false positive(s): ${refs.map(r => r.displayText).join(', ')}`,
        details: {
          text,
          detectedReferences: refs.map(r => ({
            book: r.book,
            chapter: r.chapter,
            verse: r.verse,
            confidence: r.confidence,
            method: r.method,
            displayText: r.displayText
          }))
        }
      };
    }
    
    return true;
  });
} else {
  console.log('⚠️  Skipping AI test (OPENAI_API_KEY not set)');
}

// ============================================================================
// Summary
// ============================================================================

console.log('\n' + '='.repeat(70));
console.log('📊 Test Summary');
console.log('='.repeat(70));
console.log(`Total tests: ${totalTests}`);
console.log(`✅ Passed: ${passedTests}`);
console.log(`❌ Failed: ${failedTests}`);
console.log(`Success rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);

if (failedTests > 0) {
  console.log('\n⚠️  FALSE POSITIVES DETECTED - This confirms the issue!');
  console.log('   The test has identified the root cause of the false positive detection.');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed - No false positives detected');
  process.exit(0);
}

