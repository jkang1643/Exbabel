
import { getLanguageName } from '../backend/languageConfig.js';

const testCodes = [
    'es-MX',
    'es-ES',
    'en-GB',
    'en-US',
    'pt-BR',
    'zh-CN',
    'zh-TW',
    'fr-CA'
];

console.log('--- Regional Language Name Verification ---');
console.log('Verifying that regional codes resolve to specific names:\n');

testCodes.forEach(code => {
    const name = getLanguageName(code);
    console.log(`${code.padEnd(10)} -> ${name}`);
});

console.log('\n--- Verification Complete ---');
