/**
 * Test script to show PhraseSet logging
 * Simulates what happens when GoogleSpeechStream initializes
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

console.log('='.repeat(70));
console.log('TESTING PHRASESET LOGGING');
console.log('='.repeat(70));
console.log('');

// Simulate what GoogleSpeechStream does
const projectId = process.env.GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
const phraseSetId = process.env.GOOGLE_PHRASE_SET_ID;

console.log('[GoogleSpeech] Starting stream #0...');
console.log(`[GoogleSpeech] Using language code: en-US`);
console.log(`[GoogleSpeech] Using enhanced model (latest_long) for en-US`);

if (phraseSetId && projectId) {
  const phraseSetRef = `projects/${projectId}/locations/global/phraseSets/${phraseSetId}`;
  console.log(`[GoogleSpeech] ✅ PhraseSet ENABLED: ${phraseSetRef}`);
  console.log(`[GoogleSpeech]    Glossary terms will be recognized with improved accuracy`);
} else {
  console.log(`[GoogleSpeech] ⚠️  PhraseSet NOT configured - set GOOGLE_PHRASE_SET_ID and GOOGLE_CLOUD_PROJECT_ID to enable`);
}

console.log('');
console.log('='.repeat(70));
console.log('When you start your server, you will see these logs above');
console.log('every time a transcription stream starts.');
console.log('='.repeat(70));

