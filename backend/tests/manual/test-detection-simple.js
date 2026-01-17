// Simple detection test
import { BibleReferenceDetector } from '../core/services/bibleReferenceDetector.js';

console.log('🧪 Testing Bible Reference Detection\n');

const detector = new BibleReferenceDetector({
  confidenceThreshold: 0.85,
  enableLLMConfirmation: false, // Disable AI for faster testing
  openaiApiKey: process.env.OPENAI_API_KEY
});

const testCases = [
  "In Acts 2:38, Peter said to repent",
  "As it is written in John chapter three verse sixteen",
  "We need to repent and be baptized for the forgiveness of sins"
];

async function test() {
  console.log('Testing detection engine...\n');
  
  for (let i = 0; i < testCases.length; i++) {
    const text = testCases[i];
    console.log(`Test ${i + 1}: "${text}"`);
    
    try {
      const refs = await detector.detectReferences(text);
      if (refs.length > 0) {
        console.log(`  ✅ Found: ${refs[0].displayText} (${refs[0].confidence.toFixed(2)} confidence, ${refs[0].method})`);
      } else {
        console.log('  ❌ No references detected');
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error.message}`);
    }
    console.log('');
  }
}

test().catch(console.error);
