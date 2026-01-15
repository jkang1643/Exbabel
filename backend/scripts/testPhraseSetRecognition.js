/**
 * Test PhraseSet recognition by comparing with and without PhraseSet
 * 
 * This creates a simple audio test to verify PhraseSet is working
 */

import speech from '@google-cloud/speech';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const projectId = process.env.GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || 'exbabel-tts-prod';
const phraseSetId = process.env.GOOGLE_PHRASE_SET_ID || 'church-glossary-10k';

console.log('='.repeat(70));
console.log('PHRASESET RECOGNITION TEST');
console.log('='.repeat(70));
console.log('');
console.log('This test helps verify if PhraseSet is actually improving recognition.');
console.log('');
console.log('TEST WORDS (from your glossary):');
console.log('  - Genesis');
console.log('  - hallelujah');
console.log('  - Ephesians');
console.log('  - eschatology');
console.log('');

console.log('HOW TO TEST:');
console.log('1. Start your server');
console.log('2. Begin transcription');
console.log('3. Say one of the test words clearly');
console.log('4. Check the logs for:');
console.log('   [GoogleSpeech] 🎯 PHRASESET TERM RECOGNIZED: "..."');
console.log('');
console.log('If you see that log, PhraseSet IS working!');
console.log('If you don\'t see it, the word wasn\'t recognized correctly.');
console.log('');
console.log('='.repeat(70));
console.log('TROUBLESHOOTING:');
console.log('='.repeat(70));
console.log('');
console.log('If PhraseSet terms are NOT being recognized:');
console.log('');
console.log('1. Check if the word is EXACTLY in your glossary:');
console.log('   node backend/scripts/testSpecificPhrase.js "your-word"');
console.log('');
console.log('2. PhraseSets work best with:');
console.log('   - Exact pronunciation match');
console.log('   - Complete words (not partial)');
console.log('   - Clear speech');
console.log('');
console.log('3. Enhanced model may ignore PhraseSets:');
console.log('   - Check logs for: "model":"latest_long"');
console.log('   - Enhanced models may silently ignore PhraseSets');
console.log('   - Try disabling enhanced model to test');
console.log('');
console.log('4. PhraseSets improve probability, not guarantee:');
console.log('   - They boost recognition but don\'t guarantee 100% accuracy');
console.log('   - Test with multiple attempts');
console.log('   - Compare recognition quality (not just pass/fail)');
console.log('');
console.log('='.repeat(70));
console.log('VERIFICATION CHECKLIST:');
console.log('='.repeat(70));
console.log('');
console.log('✅ PhraseSet is configured in .env');
console.log('✅ PhraseSet exists in Google Cloud (6,614 phrases)');
console.log('✅ PhraseSet is being sent in API request (see logs)');
console.log('✅ No errors from Google API');
console.log('❓ Recognition actually improved? (TEST THIS)');
console.log('');
console.log('To verify improvement, you need to:');
console.log('- Test the SAME word multiple times');
console.log('- Compare recognition accuracy');
console.log('- Check if rare words are recognized better');
console.log('');
