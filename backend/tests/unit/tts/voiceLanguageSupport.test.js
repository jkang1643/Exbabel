/**
 * Voice Language Support Tests - Comprehensive Tier Validation
 * 
 * This test verifies:
 * 1. Every language shows exactly which tiers it supports
 * 2. Tier totals match expected counts from documentation
 * 
 * Run: node --experimental-vm-modules backend/tests/unit/tts/voiceLanguageSupport.test.js
 */

const langSupportPath = '../../../../frontend/src/config/languageSupportData.js';
const {
    LANGUAGE_TIER_AVAILABILITY,
    GEMINI_SUPPORTED_LANGUAGES,
    ELEVENLABS_FLASH_LANGUAGES,
    ELEVENLABS_V3_LANGUAGES,
    ELEVENLABS_TURBO_LANGUAGES,
    ELEVENLABS_MULTILINGUAL_LANGUAGES,
    isGeminiSupported,
    isElevenLabsSupported,
    isGoogleTierSupported,
    getAvailableTiersForLanguage
} = await import(langSupportPath);

// ============================================================================
// EXPECTED TIER COUNTS
// Note: These are counts from LANGUAGE_TIER_AVAILABILITY (our configuration)
// Gemini API supports 87 languages but we only expose 27 in the dropdown
// ============================================================================
const EXPECTED_TIER_COUNTS = {
    // Google tiers (from LANGUAGE_TIER_AVAILABILITY - our configured languages)
    gemini: 27,        // Languages with Gemini enabled in dropdown (subset of 87 Gemini API supports)
    chirp3_hd: 53,     // Chirp3 HD supports 53 languages
    neural2: 48,       // Neural2 supports 48 languages
    standard: 60,      // Standard supports 60 languages
    studio: 7,         // Studio voices for en-US, en-GB, en-IN, fr-FR, de-DE, es-ES, es-US
    // ElevenLabs tiers (base language code counts)
    elevenlabs_flash: 29,    // ElevenLabs Flash supports 29 base language codes
    elevenlabs_turbo: 29,    // Same as flash
    elevenlabs_v3: 75,       // ElevenLabs v3 supports 75 base language codes
    elevenlabs_multilingual: 29  // Same as flash
};

// ============================================================================
// Collect tier counts from LANGUAGE_TIER_AVAILABILITY
// ============================================================================
const tierCounts = {
    gemini: 0,
    chirp3_hd: 0,
    neural2: 0,
    standard: 0,
    studio: 0
};

const allLanguages = Object.keys(LANGUAGE_TIER_AVAILABILITY);

console.log('='.repeat(80));
console.log('COMPREHENSIVE LANGUAGE-TIER SUPPORT MATRIX');
console.log('='.repeat(80));
console.log('');
console.log('Legend: G=Gemini, C=Chirp3HD, S=Studio, N=Neural2, T=Standard');
console.log('        E3=ElevenLabs v3, EF=ElevenLabs Flash');
console.log('');

// Print header
const header = 'Language'.padEnd(12) + '| Google Tiers                    | ElevenLabs Tiers';
console.log(header);
console.log('-'.repeat(80));

// For each language, show which tiers it supports
for (const lang of allLanguages.sort()) {
    const googleTiers = LANGUAGE_TIER_AVAILABILITY[lang] || [];

    // Count Google tiers
    for (const tier of googleTiers) {
        if (tierCounts[tier] !== undefined) {
            tierCounts[tier]++;
        }
    }

    // Build tier string
    const hasGemini = googleTiers.includes('gemini') ? 'G' : '-';
    const hasChirp3 = googleTiers.includes('chirp3_hd') ? 'C' : '-';
    const hasStudio = googleTiers.includes('studio') ? 'S' : '-';
    const hasNeural2 = googleTiers.includes('neural2') ? 'N' : '-';
    const hasStandard = googleTiers.includes('standard') ? 'T' : '-';

    const hasE3 = isElevenLabsSupported(lang, 'elevenlabs_v3') ? 'E3' : '--';
    const hasEF = isElevenLabsSupported(lang, 'elevenlabs_flash') ? 'EF' : '--';

    const tierStr = `${hasGemini} ${hasChirp3} ${hasStudio} ${hasNeural2} ${hasStandard}`.padEnd(33);
    const elStr = `${hasE3} ${hasEF}`;

    console.log(`${lang.padEnd(12)}| ${tierStr}| ${elStr}`);
}

console.log('-'.repeat(80));
console.log('');

// ============================================================================
// TIER TOTALS VALIDATION
// ============================================================================
console.log('='.repeat(80));
console.log('TIER TOTALS VALIDATION');
console.log('='.repeat(80));
console.log('');
console.log('Tier'.padEnd(25) + 'Actual'.padEnd(10) + 'Expected'.padEnd(10) + 'Status');
console.log('-'.repeat(55));

let allMatch = true;

// Google tiers (from LANGUAGE_TIER_AVAILABILITY)
for (const tier of ['gemini', 'chirp3_hd', 'neural2', 'standard', 'studio']) {
    const actual = tierCounts[tier];
    const expected = EXPECTED_TIER_COUNTS[tier];
    const status = actual === expected ? '✓ MATCH' : `✗ MISMATCH (diff: ${actual - expected})`;
    if (actual !== expected) allMatch = false;
    console.log(`${tier.padEnd(25)}${String(actual).padEnd(10)}${String(expected).padEnd(10)}${status}`);
}

console.log('-'.repeat(55));

// ElevenLabs tiers (from Sets)
const elTiers = [
    { name: 'elevenlabs_v3', set: ELEVENLABS_V3_LANGUAGES },
    { name: 'elevenlabs_flash', set: ELEVENLABS_FLASH_LANGUAGES },
    { name: 'elevenlabs_turbo', set: ELEVENLABS_TURBO_LANGUAGES },
    { name: 'elevenlabs_multilingual', set: ELEVENLABS_MULTILINGUAL_LANGUAGES }
];

for (const { name, set } of elTiers) {
    const actual = set.size;
    const expected = EXPECTED_TIER_COUNTS[name];
    const status = actual === expected ? '✓ MATCH' : `✗ MISMATCH (diff: ${actual - expected})`;
    if (actual !== expected) allMatch = false;
    console.log(`${name.padEnd(25)}${String(actual).padEnd(10)}${String(expected).padEnd(10)}${status}`);
}

console.log('-'.repeat(55));

// GEMINI_SUPPORTED_LANGUAGES Set
const geminiSetSize = GEMINI_SUPPORTED_LANGUAGES.size;
const geminiExpected = EXPECTED_TIER_COUNTS.gemini;
const geminiStatus = geminiSetSize === geminiExpected ? '✓ MATCH' : `✗ MISMATCH (diff: ${geminiSetSize - geminiExpected})`;
if (geminiSetSize !== geminiExpected) allMatch = false;
console.log(`${'GEMINI_SUPPORTED_LANGUAGES'.padEnd(25)}${String(geminiSetSize).padEnd(10)}${String(geminiExpected).padEnd(10)}${geminiStatus}`);

console.log('');

// ============================================================================
// SUMMARY BY TIER - Languages list
// ============================================================================
console.log('='.repeat(80));
console.log('LANGUAGES BY TIER');
console.log('='.repeat(80));

for (const tier of ['gemini', 'chirp3_hd', 'studio', 'neural2', 'standard']) {
    const langsWithTier = allLanguages.filter(lang =>
        LANGUAGE_TIER_AVAILABILITY[lang]?.includes(tier)
    ).sort();
    console.log(`\n${tier.toUpperCase()} (${langsWithTier.length} languages):`);
    console.log(langsWithTier.join(', '));
}

console.log('');

// ============================================================================
// EDGE CASE VERIFICATION
// ============================================================================
console.log('='.repeat(80));
console.log('EDGE CASE VERIFICATION');
console.log('='.repeat(80));

let edgeCasesPassed = 0;
let edgeCasesFailed = 0;

function verifyEdgeCase(description, condition) {
    if (condition) {
        console.log(`✓ ${description}`);
        edgeCasesPassed++;
    } else {
        console.log(`✗ ${description}`);
        edgeCasesFailed++;
    }
}

console.log('\n--- Languages with ONLY chirp3_hd (no standard fallback) ---');
verifyEdgeCase('hr-HR has only chirp3_hd',
    LANGUAGE_TIER_AVAILABILITY['hr-HR']?.length === 1 &&
    LANGUAGE_TIER_AVAILABILITY['hr-HR'][0] === 'chirp3_hd');
verifyEdgeCase('sl-SI has only chirp3_hd',
    LANGUAGE_TIER_AVAILABILITY['sl-SI']?.length === 1 &&
    LANGUAGE_TIER_AVAILABILITY['sl-SI'][0] === 'chirp3_hd');

console.log('\n--- Languages with ONLY standard ---');
verifyEdgeCase('af-ZA has only standard',
    LANGUAGE_TIER_AVAILABILITY['af-ZA']?.length === 1 &&
    LANGUAGE_TIER_AVAILABILITY['af-ZA'][0] === 'standard');
verifyEdgeCase('eu-ES has only standard',
    LANGUAGE_TIER_AVAILABILITY['eu-ES']?.length === 1 &&
    LANGUAGE_TIER_AVAILABILITY['eu-ES'][0] === 'standard');
verifyEdgeCase('ca-ES has only standard',
    LANGUAGE_TIER_AVAILABILITY['ca-ES']?.length === 1 &&
    LANGUAGE_TIER_AVAILABILITY['ca-ES'][0] === 'standard');
verifyEdgeCase('gl-ES has only standard',
    LANGUAGE_TIER_AVAILABILITY['gl-ES']?.length === 1 &&
    LANGUAGE_TIER_AVAILABILITY['gl-ES'][0] === 'standard');
verifyEdgeCase('is-IS has only standard',
    LANGUAGE_TIER_AVAILABILITY['is-IS']?.length === 1 &&
    LANGUAGE_TIER_AVAILABILITY['is-IS'][0] === 'standard');

console.log('\n--- Languages with ALL premium tiers (gemini + chirp3_hd + studio) ---');
const premiumLanguages = ['en-US', 'en-GB', 'en-IN', 'fr-FR', 'de-DE', 'es-ES', 'es-US'];
for (const lang of premiumLanguages) {
    const tiers = LANGUAGE_TIER_AVAILABILITY[lang] || [];
    verifyEdgeCase(`${lang} has gemini, chirp3_hd, studio, neural2, standard`,
        tiers.includes('gemini') &&
        tiers.includes('chirp3_hd') &&
        tiers.includes('studio') &&
        tiers.includes('neural2') &&
        tiers.includes('standard'));
}

console.log('\n--- Chinese language aliases ---');
verifyEdgeCase('cmn-CN supports gemini', LANGUAGE_TIER_AVAILABILITY['cmn-CN']?.includes('gemini'));
verifyEdgeCase('zh-CN supports gemini', LANGUAGE_TIER_AVAILABILITY['zh-CN']?.includes('gemini'));

console.log('');

// ============================================================================
// FINAL SUMMARY
// ============================================================================
console.log('='.repeat(80));
console.log('FINAL TEST SUMMARY');
console.log('='.repeat(80));
console.log(`Total languages tested: ${allLanguages.length}`);
console.log(`Tier count validation: ${allMatch ? '✓ ALL MATCH' : '✗ MISMATCHES FOUND'}`);
console.log(`Edge cases: ${edgeCasesPassed} passed, ${edgeCasesFailed} failed`);
console.log('='.repeat(80));

if (allMatch && edgeCasesFailed === 0) {
    console.log('\n✓ ALL TESTS PASSED!');
    process.exit(0);
} else {
    console.log('\n✗ SOME TESTS FAILED');
    process.exit(1);
}
