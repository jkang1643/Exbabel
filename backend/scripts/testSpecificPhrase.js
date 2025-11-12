/**
 * Test if a specific phrase is in the PhraseSet
 * 
 * Usage:
 *   node backend/scripts/testSpecificPhrase.js "Ephesians"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testPhrase = process.argv[2] || 'Ephesians';

// Load glossary
const glossaryPath = path.join(__dirname, '../../glossary.json');
const glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));

console.log(`🔍 Searching for: "${testPhrase}"`);
console.log('');

// Exact match
const exactMatch = glossary.phrases.find(p => 
  p.value.toLowerCase() === testPhrase.toLowerCase()
);

// Partial match
const partialMatches = glossary.phrases.filter(p => 
  p.value.toLowerCase().includes(testPhrase.toLowerCase()) ||
  testPhrase.toLowerCase().includes(p.value.toLowerCase())
);

if (exactMatch) {
  console.log(`✅ EXACT MATCH FOUND:`);
  console.log(`   "${exactMatch.value}"`);
  console.log(`   Boost: ${exactMatch.boost || 'default (10)'}`);
  console.log('');
} else {
  console.log(`❌ No exact match found`);
  console.log('');
}

if (partialMatches.length > 0) {
  console.log(`📋 PARTIAL MATCHES (${partialMatches.length}):`);
  partialMatches.slice(0, 10).forEach(p => {
    console.log(`   - "${p.value}"`);
  });
  if (partialMatches.length > 10) {
    console.log(`   ... and ${partialMatches.length - 10} more`);
  }
} else {
  console.log(`❌ No partial matches found`);
}

console.log('');
console.log('='.repeat(70));
if (exactMatch) {
  console.log(`✅ "${testPhrase}" IS in your PhraseSet - it should be recognized!`);
  console.log(`   If it's not working, the PhraseSet may not be active in the API request.`);
} else {
  console.log(`❌ "${testPhrase}" is NOT in your PhraseSet exactly as written.`);
  if (partialMatches.length > 0) {
    console.log(`   But similar phrases exist - check if you need to add the exact phrase.`);
  }
}
console.log('='.repeat(70));

