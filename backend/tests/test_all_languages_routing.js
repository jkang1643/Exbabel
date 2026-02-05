
import { resolveTtsRoute } from '../tts/ttsRouting.js';

const LANGUAGES_TO_TEST = [
    "af-ZA", "am-ET", "ar-XA", "bg-BG", "bn-IN", "ca-ES", "cmn-CN", "cmn-TW", "cs-CZ",
    "da-DK", "de-DE", "el-GR", "en-AU", "en-GB", "en-IN", "en-US", "es-ES", "es-US", "es-MX",
    "et-EE", "eu-ES", "fi-FI", "fil-PH", "fr-CA", "fr-FR", "gl-ES", "gu-IN", "he-IL",
    "hi-IN", "hu-HU", "id-ID", "is-IS", "it-IT", "ja-JP", "kn-IN", "ko-KR", "lt-LT",
    "lv-LV", "ml-IN", "mr-IN", "ms-MY", "nb-NO", "nl-NL", "pa-IN", "pl-PL", "pt-BR",
    "pt-PT", "ro-RO", "ru-RU", "sk-SK", "sr-RS", "sv-SE", "ta-IN", "te-IN", "th-TH",
    "tr-TR", "uk-UA", "vi-VN", "yue-HK", "zh-CN", "zh-TW" // Test these variants too
];

async function testAll() {
    console.log("🚀 Starting Comprehensive TTS Routing Test...");
    let passed = 0;
    let failed = 0;
    const failures = [];

    for (const lang of LANGUAGES_TO_TEST) {
        try {
            console.log(`[TEST] ${lang} Request: tier=neural2`);
            const route = await resolveTtsRoute({
                requestedTier: 'neural2',
                requestedVoice: null,
                languageCode: lang
            });

            if (!route.voiceName) {
                throw new Error(`No voice name resolved for ${lang}`);
            }

            console.log(`✅ ${lang} -> ${route.voiceName} (Resolved Tier: ${route.tier}, Req Tier: neural2)`);

            // Validation: Ensure voice name contains language code (roughly)
            // Allow remapping (e.g. es-MX -> es-US), but warn if completely different
            if (!route.voiceName.includes(lang.split('-')[0])) {
                console.warn(`⚠️  WARNING: Resolved voice ${route.voiceName} does not match language ${lang}`);
            }

            passed++;

        } catch (error) {
            console.error(`❌ ${lang} FAILED:`, error.message);
            failed++;
            failures.push({ lang, error: error.message });
        }
    }

    console.log(`\n===================================`);
    console.log(`SUMMARY:`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);

    if (failures.length > 0) {
        console.log("\nFailures:");
        failures.forEach(f => console.log(`- ${f.lang}: ${f.error}`));
        process.exit(1);
    } else {
        console.log("\n🎉 ALL LANGUAGES PASSED ROUTING!");
        process.exit(0);
    }
}

testAll();
