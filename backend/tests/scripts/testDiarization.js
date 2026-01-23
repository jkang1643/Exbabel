/**
 * Test Speaker Diarization Feature Flag
 * 
 * This script verifies that the STT_DIARIZATION_ENABLED feature flag
 * correctly populates the diarizationConfig in the request config.
 * 
 * Usage:
 *   STT_DIARIZATION_ENABLED=true node backend/tests/scripts/testDiarization.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

console.log('='.repeat(70));
console.log('SPEAKER DIARIZATION FEATURE FLAG TEST');
console.log('='.repeat(70));
console.log('');

// Check feature flag status
const diarizationEnabled = process.env.STT_DIARIZATION_ENABLED === 'true';
const minSpeakers = parseInt(process.env.STT_DIARIZATION_MIN_SPEAKERS, 10) || 2;
const maxSpeakers = parseInt(process.env.STT_DIARIZATION_MAX_SPEAKERS, 10) || 6;

console.log('CURRENT CONFIGURATION:');
console.log(`  STT_DIARIZATION_ENABLED: ${diarizationEnabled ? '✅ ENABLED' : '❌ DISABLED'}`);
console.log(`  STT_DIARIZATION_MIN_SPEAKERS: ${minSpeakers}`);
console.log(`  STT_DIARIZATION_MAX_SPEAKERS: ${maxSpeakers}`);
console.log('');

if (!diarizationEnabled) {
    console.log('⚠️  Feature is DISABLED. To enable, run with:');
    console.log('');
    console.log('  STT_DIARIZATION_ENABLED=true npm run dev');
    console.log('');
    console.log('Or add to your .env file:');
    console.log('  STT_DIARIZATION_ENABLED=true');
    console.log('  STT_DIARIZATION_MIN_SPEAKERS=2  # optional, default=2');
    console.log('  STT_DIARIZATION_MAX_SPEAKERS=6  # optional, default=6');
    console.log('');
} else {
    console.log('DIARIZATION CONFIG THAT WILL BE SENT:');
    console.log(JSON.stringify({
        enableSpeakerDiarization: true,
        minSpeakerCount: minSpeakers,
        maxSpeakerCount: maxSpeakers,
    }, null, 2));
    console.log('');

    console.log('HOW IT WORKS:');
    console.log('  1. Google Speech analyzes voice characteristics');
    console.log('  2. Each word is tagged with a speakerTag (1, 2, 3, etc.)');
    console.log('  3. The speakerTag is passed to the result callback in metadata');
    console.log('');

    console.log('TO VERIFY:');
    console.log('  1. Start the server with STT_DIARIZATION_ENABLED=true');
    console.log('  2. Have two people speak alternately');
    console.log('  3. Check backend logs for:');
    console.log('     [GoogleSpeech] 👥 Speaker 1: "Hello, how are you?"');
    console.log('     [GoogleSpeech] 👥 Speaker 2: "I am fine, thank you."');
    console.log('');
}

console.log('='.repeat(70));
console.log('IMPORTANT NOTES:');
console.log('='.repeat(70));
console.log('');
console.log('1. STREAMING DIARIZATION QUIRK:');
console.log('   In streaming mode, Google may retroactively change speaker labels');
console.log('   as more audio is processed. For example, it might initially label');
console.log('   all words as Speaker 1, then correct to Speaker 1 and Speaker 2.');
console.log('');
console.log('2. ACCURACY:');
console.log('   Diarization works best when speakers have distinct voice characteristics.');
console.log('   Similar-sounding speakers may be grouped together.');
console.log('');
console.log('3. SPEAKER COUNT:');
console.log('   Setting minSpeakerCount and maxSpeakerCount helps the model.');
console.log('   If you know there are exactly 2 speakers, set both to 2.');
console.log('');
console.log('4. LANGUAGE SUPPORT:');
console.log('   Not all languages support diarization. Check Google docs for details.');
console.log('');
