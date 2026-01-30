
import { TRANSCRIPTION_LANGUAGES, TRANSLATION_LANGUAGES } from '../frontend/src/config/languages.js';

console.log('--- Language Dictionary Debug ---');
console.log(`TRANSCRIPTION_LANGUAGES length: ${TRANSCRIPTION_LANGUAGES.length}`);
console.log(`TRANSLATION_LANGUAGES length: ${TRANSLATION_LANGUAGES.length}`);

const validCodes = new Set();
const invalidCodes = [];

console.log('\n--- Analyzing TRANSLATION_LANGUAGES ---');
TRANSLATION_LANGUAGES.forEach((l, i) => {
    if (l && l.code) {
        if (!validCodes.has(l.code)) {
            validCodes.add(l.code);
        } else {
            // Duplicate within the array
            // console.log(`Duplicate code in Translation list: ${l.code}`);
        }
    } else {
        invalidCodes.push(i);
    }
});
console.log(`Unique Codes in TRANSLATION_LANGUAGES: ${validCodes.size}`);
console.log(`Invalid entries: ${invalidCodes.length}`);

console.log(`\nStart of Valid Codes: ${Array.from(validCodes).slice(0, 5).join(', ')}`);
console.log(`End of Valid Codes: ${Array.from(validCodes).slice(-5).join(', ')}`);

// Check Transcription overlap
const transcriptionCodes = new Set(TRANSCRIPTION_LANGUAGES.map(l => l.code));
console.log(`\nUnique Codes in TRANSCRIPTION_LANGUAGES: ${transcriptionCodes.size}`);

const union = new Set([...validCodes, ...transcriptionCodes]);
console.log(`Union Size: ${union.size}`);
