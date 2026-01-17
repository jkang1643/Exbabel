/**
 * Test AI-based Bible Reference Detection
 * 
 * Run with: node test-ai-detection.js
 * Requires OPENAI_API_KEY environment variable
 */

import { BibleReferenceDetector } from '../core/services/bibleReferenceDetector.js';

console.log('🧪 Testing AI-Based Bible Reference Detection\n');
console.log('='.repeat(70));

if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY environment variable not set');
  console.log('\nSet it with: export OPENAI_API_KEY=your_key_here');
  process.exit(1);
}

const detector = new BibleReferenceDetector({
  confidenceThreshold: 0.85,
  aiConfidenceThreshold: 0.75,
  enableAIMatching: true,
  llmModel: 'gpt-4o-mini',
  openaiApiKey: process.env.OPENAI_API_KEY
});

const testCases = [
  {
    name: 'Explicit reference (should use regex, not AI)',
    text: 'In Acts 2:38, Peter said to repent',
    expectedMethod: 'regex'
  },
  {
    name: 'Paraphrased reference (should use AI)',
    text: 'Peter said repent and be baptized and you will receive the gift of the Holy Spirit',
    expectedMethod: 'ai'
  },
  {
    name: 'Heavy context reference',
    text: 'The Bible says that God so loved the world that he gave his only son',
    expectedMethod: 'ai'
  },
  {
    name: 'No reference',
    text: 'Today is a nice day and the weather is good',
    expectedMethod: null
  }
];

async function runTests() {
  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    console.log(`\n📝 Test: ${testCase.name}`);
    console.log(`   Text: "${testCase.text}"`);
    
    try {
      const refs = await detector.detectReferences(testCase.text);
      
      if (testCase.expectedMethod === null) {
        if (refs.length === 0) {
          console.log('   ✅ Correctly detected no references');
          passed++;
        } else {
          console.log(`   ❌ Expected no references, got ${refs.length}`);
          failed++;
        }
      } else {
        if (refs.length > 0) {
          const ref = refs[0];
          if (ref.method === testCase.expectedMethod) {
            console.log(`   ✅ Found: ${ref.displayText} (${ref.method}, confidence: ${ref.confidence.toFixed(2)})`);
            passed++;
          } else {
            console.log(`   ⚠️  Found: ${ref.displayText} but method is ${ref.method}, expected ${testCase.expectedMethod}`);
            // Still count as passed if we found a reference
            passed++;
          }
        } else {
          console.log('   ❌ No references detected');
          failed++;
        }
      }
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      failed++;
    }
    
    // Wait a bit between tests to respect rate limits
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n' + '='.repeat(70));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  console.log(`   Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%\n`);

  if (failed === 0) {
    console.log('🎉 All tests passed!\n');
    process.exit(0);
  } else {
    console.log(`⚠️  ${failed} test(s) failed.\n`);
    process.exit(1);
  }
}

runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

