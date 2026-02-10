#!/usr/bin/env node

/**
 * Generate Punctuation Samples for All Languages
 * 
 * This script generates translations of a quote-heavy English text
 * for all 87 supported languages to identify non-Western punctuation
 * patterns (quotes, commas, periods) that need normalization.
 * 
 * Usage: node backend/scripts/generatePunctuationSamples.js
 */

import dotenv from 'dotenv';
import { finalTranslationWorker } from '../translationWorkers.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from backend/.env
dotenv.config({ path: path.join(__dirname, '../.env') });

// All 87 Gemini-supported languages (using 2-letter codes for translation API)
const SUPPORTED_LANGUAGES = [
    // GA Languages
    { code: 'ar', name: 'Arabic' },
    { code: 'bn', name: 'Bangla' },
    { code: 'nl', name: 'Dutch' },
    { code: 'en', name: 'English' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'hi', name: 'Hindi' },
    { code: 'id', name: 'Indonesian' },
    { code: 'it', name: 'Italian' },
    { code: 'ja', name: 'Japanese' },
    { code: 'ko', name: 'Korean' },
    { code: 'mr', name: 'Marathi' },
    { code: 'pl', name: 'Polish' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'ro', name: 'Romanian' },
    { code: 'ru', name: 'Russian' },
    { code: 'es', name: 'Spanish' },
    { code: 'ta', name: 'Tamil' },
    { code: 'te', name: 'Telugu' },
    { code: 'th', name: 'Thai' },
    { code: 'tr', name: 'Turkish' },
    { code: 'uk', name: 'Ukrainian' },
    { code: 'vi', name: 'Vietnamese' },

    // Preview Languages
    { code: 'af', name: 'Afrikaans' },
    { code: 'sq', name: 'Albanian' },
    { code: 'am', name: 'Amharic' },
    { code: 'hy', name: 'Armenian' },
    { code: 'az', name: 'Azerbaijani' },
    { code: 'eu', name: 'Basque' },
    { code: 'be', name: 'Belarusian' },
    { code: 'bg', name: 'Bulgarian' },
    { code: 'my', name: 'Burmese' },
    { code: 'ca', name: 'Catalan' },
    { code: 'ceb', name: 'Cebuano' },
    { code: 'zh', name: 'Chinese (Simplified)' },
    { code: 'zh-TW', name: 'Chinese (Traditional)' },
    { code: 'hr', name: 'Croatian' },
    { code: 'cs', name: 'Czech' },
    { code: 'da', name: 'Danish' },
    { code: 'et', name: 'Estonian' },
    { code: 'fil', name: 'Filipino' },
    { code: 'fi', name: 'Finnish' },
    { code: 'gl', name: 'Galician' },
    { code: 'ka', name: 'Georgian' },
    { code: 'el', name: 'Greek' },
    { code: 'gu', name: 'Gujarati' },
    { code: 'ht', name: 'Haitian Creole' },
    { code: 'he', name: 'Hebrew' },
    { code: 'hu', name: 'Hungarian' },
    { code: 'is', name: 'Icelandic' },
    { code: 'jv', name: 'Javanese' },
    { code: 'kn', name: 'Kannada' },
    { code: 'kok', name: 'Konkani' },
    { code: 'lo', name: 'Lao' },
    { code: 'la', name: 'Latin' },
    { code: 'lv', name: 'Latvian' },
    { code: 'lt', name: 'Lithuanian' },
    { code: 'lb', name: 'Luxembourgish' },
    { code: 'mk', name: 'Macedonian' },
    { code: 'mai', name: 'Maithili' },
    { code: 'mg', name: 'Malagasy' },
    { code: 'ms', name: 'Malay' },
    { code: 'ml', name: 'Malayalam' },
    { code: 'mn', name: 'Mongolian' },
    { code: 'ne', name: 'Nepali' },
    { code: 'no', name: 'Norwegian' },
    { code: 'nn', name: 'Norwegian Nynorsk' },
    { code: 'or', name: 'Odia' },
    { code: 'ps', name: 'Pashto' },
    { code: 'fa', name: 'Persian' },
    { code: 'pa', name: 'Punjabi' },
    { code: 'sr', name: 'Serbian' },
    { code: 'sd', name: 'Sindhi' },
    { code: 'si', name: 'Sinhala' },
    { code: 'sk', name: 'Slovak' },
    { code: 'sl', name: 'Slovenian' },
    { code: 'sw', name: 'Swahili' },
    { code: 'sv', name: 'Swedish' },
    { code: 'ur', name: 'Urdu' },
];

// Test text designed to trigger all punctuation types
const TEST_TEXT = `Peter said to them, "Repent and be baptized, every one of you, in the name of Jesus Christ." He continued, "You will receive the gift of the Holy Spirit."`;

async function main() {
    console.log('🚀 Starting punctuation sample generation for all languages...\n');
    console.log(`📝 Source text: "${TEST_TEXT}"\n`);

    // Check for OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
        console.error('❌ Error: OPENAI_API_KEY environment variable not set');
        console.error('   Make sure backend/.env file exists with OPENAI_API_KEY');
        process.exit(1);
    }

    const results = {
        metadata: {
            generatedAt: new Date().toISOString(),
            sourceText: TEST_TEXT,
            totalLanguages: SUPPORTED_LANGUAGES.length,
            sourceLang: 'en'
        },
        translations: {}
    };

    let successCount = 0;
    let failureCount = 0;

    // Process in batches of 10 to avoid overwhelming the API
    const BATCH_SIZE = 10;
    for (let i = 0; i < SUPPORTED_LANGUAGES.length; i += BATCH_SIZE) {
        const batch = SUPPORTED_LANGUAGES.slice(i, i + BATCH_SIZE);
        const targetLangs = batch.map(l => l.code);

        console.log(`\n📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(SUPPORTED_LANGUAGES.length / BATCH_SIZE)}: ${targetLangs.join(', ')}`);

        try {
            const translations = await finalTranslationWorker.translateToMultipleLanguages(
                TEST_TEXT,
                'en',
                targetLangs,
                process.env.OPENAI_API_KEY,
                'punctuation-test-session'
            );

            // Store results
            for (const lang of batch) {
                const translation = translations[lang.code];
                if (translation && !translation.startsWith('[Translation error')) {
                    results.translations[lang.code] = {
                        name: lang.name,
                        translation: translation,
                        length: translation.length
                    };
                    console.log(`   ✅ ${lang.code.padEnd(6)} (${lang.name}): ${translation.substring(0, 60)}...`);
                    successCount++;
                } else {
                    results.translations[lang.code] = {
                        name: lang.name,
                        error: translation || 'No translation returned'
                    };
                    console.log(`   ❌ ${lang.code.padEnd(6)} (${lang.name}): ${translation || 'No translation'}`);
                    failureCount++;
                }
            }
        } catch (error) {
            console.error(`   ❌ Batch error:`, error.message);
            for (const lang of batch) {
                results.translations[lang.code] = {
                    name: lang.name,
                    error: error.message
                };
                failureCount++;
            }
        }

        // Rate limiting: wait 2 seconds between batches
        if (i + BATCH_SIZE < SUPPORTED_LANGUAGES.length) {
            console.log('   ⏳ Waiting 2s before next batch...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Save results
    const outputPath = path.join(__dirname, 'punctuation-samples.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

    console.log('\n' + '='.repeat(70));
    console.log('✅ Generation complete!');
    console.log('='.repeat(70));
    console.log(`📊 Results:`);
    console.log(`   ✅ Successful: ${successCount}/${SUPPORTED_LANGUAGES.length}`);
    console.log(`   ❌ Failed: ${failureCount}/${SUPPORTED_LANGUAGES.length}`);
    console.log(`   💾 Output saved to: ${outputPath}`);
    console.log('='.repeat(70));
    console.log('\n📝 Next steps:');
    console.log('   1. Run: node backend/scripts/analyzePunctuationPatterns.js');
    console.log('   2. Review the analysis report');
    console.log('   3. Update backend/cleanupRules.js with new mappings\n');
}

main().catch(console.error);
