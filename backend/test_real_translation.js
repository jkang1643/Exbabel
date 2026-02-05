
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { FinalTranslationWorker, PartialTranslationWorker } from './translationWorkers.js';

// Setup environment
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
    console.error('❌ No OPENAI_API_KEY found in .env');
    process.exit(1);
}

async function testTranslation() {
    console.log('--- Testing Translation Workers ---');
    console.log(`API Key present: ${!!API_KEY}`);

    const finalWorker = new FinalTranslationWorker();
    const partialWorker = new PartialTranslationWorker();

    const text = "Hello, this is a test message for translation routing.";
    const source = 'en';
    const target = 'fr'; // Testing French

    console.log(`\nInput: "${text}"`);
    console.log(`Routing: ${source} -> ${target}`);

    // Test Final
    try {
        console.log('\nPlease wait, testing FINAL translation...');
        const finalResult = await finalWorker.translateFinal(text, source, target, API_KEY);
        console.log(`[Final] Result: "${finalResult}"`);
        if (finalResult && finalResult !== text && !finalResult.includes('Hello')) {
            console.log('✅ Final Translation Worker: SUCCESS');
        } else {
            console.log('❌ Final Translation Worker: FAILED (Returned original or english)');
        }
    } catch (err) {
        console.error('❌ Final Translation Worker: ERROR', err);
    }

    // Test Partial
    try {
        console.log('\nPlease wait, testing PARTIAL translation...');
        const partialResult = await partialWorker.translatePartial(text, source, target, API_KEY);
        console.log(`[Partial] Result: "${partialResult}"`);
        if (partialResult && partialResult !== text && !partialResult.includes('Hello')) {
            console.log('✅ Partial Translation Worker: SUCCESS');
        } else {
            console.log('❌ Partial Translation Worker: FAILED');
        }
    } catch (err) {
        console.error('❌ Partial Translation Worker: ERROR', err);
    }
}

testTranslation();
