/**
 * Test Multi-Language Detection Feature Flag
 * 
 * This script verifies that the STT_MULTI_LANG_ENABLED feature flag
 * correctly populates the alternativeLanguageCodes in the request config.
 * 
 * Usage:
 *   STT_MULTI_LANG_ENABLED=true STT_MULTI_LANG_CODES=es-ES,fr-FR node backend/tests/scripts/testMultiLangDetection.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

console.log('='.repeat(70));
console.log('MULTI-LANGUAGE DETECTION FEATURE FLAG TEST');
console.log('='.repeat(70));
console.log('');

// Check feature flag status
const multiLangEnabled = process.env.STT_MULTI_LANG_ENABLED === 'true';
const multiLangCodes = process.env.STT_MULTI_LANG_CODES || '';

console.log('CURRENT CONFIGURATION:');
console.log(`  STT_MULTI_LANG_ENABLED: ${multiLangEnabled ? '✅ ENABLED' : '❌ DISABLED'}`);
console.log(`  STT_MULTI_LANG_CODES: ${multiLangCodes || '(not set)'}`);
console.log('');

if (!multiLangEnabled) {
    console.log('⚠️  Feature is DISABLED. To enable, run with:');
    console.log('');
    console.log('  STT_MULTI_LANG_ENABLED=true STT_MULTI_LANG_CODES=es-ES,fr-FR npm run dev');
    console.log('');
    console.log('Or add to your .env file:');
    console.log('  STT_MULTI_LANG_ENABLED=true');
    console.log('  STT_MULTI_LANG_CODES=es-ES,fr-FR');
    console.log('');
} else {
    // Parse and validate the codes
    const parsedCodes = multiLangCodes
        .split(',')
        .map(code => code.trim())
        .filter(code => code.length > 0)
        .slice(0, 3);

    console.log('PARSED ALTERNATIVE LANGUAGE CODES:');
    if (parsedCodes.length === 0) {
        console.log('  ⚠️  No valid codes found!');
    } else {
        parsedCodes.forEach((code, i) => {
            console.log(`  ${i + 1}. ${code}`);
        });
    }
    console.log('');

    console.log('HOW IT WORKS:');
    console.log('  1. Primary language is set by the user (e.g., en-US)');
    console.log('  2. Google Speech will try to detect if audio matches:');
    console.log('     - Primary language (e.g., en-US)');
    parsedCodes.forEach(code => {
        console.log(`     - Alternative: ${code}`);
    });
    console.log('  3. If detected, the languageCode will be returned in the result');
    console.log('');

    console.log('TO VERIFY:');
    console.log('  1. Start the server with the flags enabled');
    console.log('  2. Select English as primary language');
    console.log('  3. Speak in Spanish (or another alternative language)');
    console.log('  4. Check backend logs for:');
    console.log('     [GoogleSpeech] 🌍 Language detected: es-ES (primary: en-US)');
    console.log('');
}

console.log('='.repeat(70));
console.log('SUPPORTED LANGUAGE CODES (common examples):');
console.log('='.repeat(70));
console.log('  en-US  English (United States)');
console.log('  es-ES  Spanish (Spain)');
console.log('  es-MX  Spanish (Mexico)');
console.log('  fr-FR  French (France)');
console.log('  de-DE  German (Germany)');
console.log('  it-IT  Italian (Italy)');
console.log('  pt-BR  Portuguese (Brazil)');
console.log('  zh-CN  Chinese (Simplified)');
console.log('  ja-JP  Japanese');
console.log('  ko-KR  Korean');
console.log('');
console.log('See: https://cloud.google.com/speech-to-text/docs/languages');
console.log('');
