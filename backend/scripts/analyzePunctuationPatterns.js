#!/usr/bin/env node

/**
 * Analyze Punctuation Patterns
 * 
 * This script analyzes the generated translations to identify all unique
 * punctuation variants (quotes, commas, periods) that need normalization.
 * 
 * Usage: node backend/scripts/analyzePunctuationPatterns.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the generated samples
const samplesPath = path.join(__dirname, 'punctuation-samples.json');
if (!fs.existsSync(samplesPath)) {
    console.error('❌ Error: punctuation-samples.json not found');
    console.error('   Run: node backend/scripts/generatePunctuationSamples.js first');
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(samplesPath, 'utf8'));

// Character categories
const quoteChars = new Set();
const commaChars = new Set();
const periodChars = new Set();
const otherPunctuation = new Set();

// Language family groupings
const languageFamilies = {
    CJK: new Set(['zh', 'zh-TW', 'ja', 'ko']),
    Arabic: new Set(['ar', 'fa', 'ur', 'ps', 'sd']),
    Indic: new Set(['hi', 'bn', 'mr', 'ta', 'te', 'gu', 'kn', 'ml', 'or', 'pa', 'si', 'ne', 'mai', 'kok']),
    Cyrillic: new Set(['ru', 'uk', 'be', 'bg', 'sr', 'mk', 'mn']),
    European: new Set(['fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'cs', 'sk', 'sl', 'hr', 'ro', 'hu', 'el', 'sv', 'da', 'no', 'nn', 'fi', 'et', 'lv', 'lt', 'is']),
    Other: new Set()
};

// Categorize languages
for (const code in data.translations) {
    let found = false;
    for (const family in languageFamilies) {
        if (languageFamilies[family].has(code)) {
            found = true;
            break;
        }
    }
    if (!found) {
        languageFamilies.Other.add(code);
    }
}

// Known Western punctuation (to exclude from results)
const westernPunctuation = new Set(['"', "'", ',', '.', '!', '?', ';', ':', '-', '(', ')', '[', ']', '{', '}']);

// Analyze each translation
const familyPatterns = {};
for (const family in languageFamilies) {
    familyPatterns[family] = {
        quotes: new Set(),
        commas: new Set(),
        periods: new Set(),
        other: new Set(),
        examples: []
    };
}

console.log('🔍 Analyzing punctuation patterns...\n');

for (const [code, info] of Object.entries(data.translations)) {
    if (info.error) continue;

    const text = info.translation;
    const family = Object.keys(languageFamilies).find(f => languageFamilies[f].has(code)) || 'Other';

    // Extract all unique characters
    for (const char of text) {
        const codePoint = char.charCodeAt(0);

        // Skip ASCII letters, numbers, and spaces
        if ((codePoint >= 65 && codePoint <= 90) || // A-Z
            (codePoint >= 97 && codePoint <= 122) || // a-z
            (codePoint >= 48 && codePoint <= 57) || // 0-9
            codePoint === 32) { // space
            continue;
        }

        // Categorize punctuation
        // Quote-like characters (various Unicode ranges)
        if ((codePoint >= 0x2018 && codePoint <= 0x201F) || // Smart quotes
            (codePoint >= 0x00AB && codePoint <= 0x00BB && (codePoint === 0x00AB || codePoint === 0x00BB)) || // Guillemets
            (codePoint >= 0x2039 && codePoint <= 0x203A) || // Single guillemets
            (codePoint >= 0x300C && codePoint <= 0x300F) || // CJK corner brackets
            (codePoint >= 0x3008 && codePoint <= 0x3011) || // CJK angle brackets
            (codePoint >= 0xFF02 && codePoint <= 0xFF02) || // Fullwidth quotation mark
            char === '„' || char === '‚' || char === '‹' || char === '›') {
            quoteChars.add(char);
            familyPatterns[family].quotes.add(char);
        }
        // Comma-like characters
        else if (char === '،' || char === '、' || char === '，' || char === '՝' || char === '፣') {
            commaChars.add(char);
            familyPatterns[family].commas.add(char);
        }
        // Period-like characters
        else if (char === '。' || char === '।' || char === '॥' || char === '။' || char === '።' || char === '܁' || char === '܂') {
            periodChars.add(char);
            familyPatterns[family].periods.add(char);
        }
        // Other non-Western punctuation
        else if (!westernPunctuation.has(char) && codePoint > 127) {
            otherPunctuation.add(char);
            familyPatterns[family].other.add(char);
        }
    }

    // Store example for this language
    if (familyPatterns[family].examples.length < 3) {
        familyPatterns[family].examples.push({
            code,
            name: info.name,
            text: text.substring(0, 100) + '...'
        });
    }
}

// Generate report
console.log('='.repeat(80));
console.log('📊 PUNCTUATION ANALYSIS REPORT');
console.log('='.repeat(80));
console.log(`\n📝 Analyzed ${Object.keys(data.translations).length} languages\n`);

// Overall statistics
console.log('🎯 Overall Statistics:');
console.log(`   Quote variants found: ${quoteChars.size}`);
console.log(`   Comma variants found: ${commaChars.size}`);
console.log(`   Period variants found: ${periodChars.size}`);
console.log(`   Other punctuation: ${otherPunctuation.size}\n`);

// Family-by-family breakdown
for (const [family, patterns] of Object.entries(familyPatterns)) {
    if (languageFamilies[family].size === 0) continue;

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`📚 ${family} Languages (${languageFamilies[family].size} languages)`);
    console.log('─'.repeat(80));

    if (patterns.quotes.size > 0) {
        console.log(`\n   Quotes (${patterns.quotes.size}):`);
        for (const char of patterns.quotes) {
            console.log(`      '${char}' (U+${char.charCodePoint(0).toString(16).toUpperCase().padStart(4, '0')})`);
        }
    }

    if (patterns.commas.size > 0) {
        console.log(`\n   Commas (${patterns.commas.size}):`);
        for (const char of patterns.commas) {
            console.log(`      '${char}' (U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
        }
    }

    if (patterns.periods.size > 0) {
        console.log(`\n   Periods (${patterns.periods.size}):`);
        for (const char of patterns.periods) {
            console.log(`      '${char}' (U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
        }
    }

    if (patterns.other.size > 0 && patterns.other.size <= 10) {
        console.log(`\n   Other (${patterns.other.size}):`);
        for (const char of patterns.other) {
            console.log(`      '${char}' (U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
        }
    }

    if (patterns.examples.length > 0) {
        console.log(`\n   Examples:`);
        for (const ex of patterns.examples) {
            console.log(`      ${ex.code} (${ex.name}): ${ex.text}`);
        }
    }
}

// Generate code for cleanupRules.js
console.log(`\n\n${'='.repeat(80)}`);
console.log('💻 SUGGESTED CODE FOR cleanupRules.js');
console.log('='.repeat(80));
console.log('\nAdd these entries to the punctuationNormalization map:\n');
console.log('```javascript');

// Quotes
if (quoteChars.size > 0) {
    console.log('  // Quote variants');
    for (const char of quoteChars) {
        const unicode = 'U+' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
        console.log(`  '${char}': '"',  // ${unicode}`);
    }
    console.log('');
}

// Commas
if (commaChars.size > 0) {
    console.log('  // Comma variants');
    for (const char of commaChars) {
        const unicode = 'U+' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
        console.log(`  '${char}': ',',  // ${unicode}`);
    }
    console.log('');
}

// Periods
if (periodChars.size > 0) {
    console.log('  // Period variants');
    for (const char of periodChars) {
        const unicode = 'U+' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
        console.log(`  '${char}': '.',  // ${unicode}`);
    }
}

console.log('```\n');

// Save detailed report
const reportPath = path.join(__dirname, 'punctuation-analysis-report.json');
const report = {
    generatedAt: new Date().toISOString(),
    statistics: {
        totalLanguages: Object.keys(data.translations).length,
        quoteVariants: quoteChars.size,
        commaVariants: commaChars.size,
        periodVariants: periodChars.size,
        otherPunctuation: otherPunctuation.size
    },
    characterMappings: {
        quotes: Array.from(quoteChars).map(c => ({
            char: c,
            unicode: 'U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'),
            replacement: '"'
        })),
        commas: Array.from(commaChars).map(c => ({
            char: c,
            unicode: 'U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'),
            replacement: ','
        })),
        periods: Array.from(periodChars).map(c => ({
            char: c,
            unicode: 'U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'),
            replacement: '.'
        }))
    },
    familyPatterns
};

fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log('='.repeat(80));
console.log(`✅ Analysis complete!`);
console.log(`   📄 Detailed report saved to: ${reportPath}`);
console.log('='.repeat(80));
console.log('\n📝 Next steps:');
console.log('   1. Review the suggested code above');
console.log('   2. Update backend/cleanupRules.js with new mappings');
console.log('   3. Test with: npm run dev\n');
