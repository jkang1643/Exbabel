
const fs = require('fs');
const path = require('path');

// 1. Definition from ttsRouting.js
const FALLBACK_VOICES = {
    "af-ZA": { "standard": "af-ZA-Standard-A" },
    "am-ET": { "standard": "am-ET-Standard-A", "neural2": "am-ET-Wavenet-A" },
    "ar-XA": { "standard": "ar-XA-Standard-A", "neural2": "ar-XA-Wavenet-A", "chirp3_hd": "ar-XA-Chirp3-HD-Kore" },
    "bg-BG": { "standard": "bg-BG-Standard-A" },
    "bn-IN": { "standard": "bn-IN-Standard-A", "neural2": "bn-IN-Wavenet-A", "chirp3_hd": "bn-IN-Chirp3-HD-Kore" },
    "ca-ES": { "standard": "ca-ES-Standard-A" },
    "cmn-CN": { "standard": "cmn-CN-Standard-A", "neural2": "cmn-CN-Wavenet-A", "chirp3_hd": "cmn-CN-Chirp3-HD-Kore" },
    "cmn-TW": { "standard": "cmn-TW-Standard-A", "neural2": "cmn-TW-Wavenet-A", "chirp3_hd": "cmn-TW-Chirp3-HD-Kore" },
    "cs-CZ": { "standard": "cs-CZ-Standard-A", "neural2": "cs-CZ-Wavenet-A", "chirp3_hd": "cs-CZ-Chirp3-HD-Kore" },
    "da-DK": { "standard": "da-DK-Standard-A", "neural2": "da-DK-Neural2-D", "chirp3_hd": "da-DK-Chirp3-HD-Kore" },
    "de-DE": { "standard": "de-DE-Standard-A", "neural2": "de-DE-Neural2-A", "chirp3_hd": "de-DE-Chirp3-HD-Kore" },
    "el-GR": { "standard": "el-GR-Standard-A", "neural2": "el-GR-Wavenet-A" },
    "en-AU": { "standard": "en-AU-Standard-A", "neural2": "en-AU-Neural2-A", "chirp3_hd": "en-AU-Chirp3-HD-Kore" },
    "en-GB": { "standard": "en-GB-Standard-A", "neural2": "en-GB-Neural2-A", "chirp3_hd": "en-GB-Chirp3-HD-Kore" },
    "en-IN": { "standard": "en-IN-Standard-A", "neural2": "en-IN-Neural2-A", "chirp3_hd": "en-IN-Chirp3-HD-Kore" },
    "en-US": { "standard": "en-US-Standard-A", "neural2": "en-US-Neural2-A", "chirp3_hd": "en-US-Chirp3-HD-Kore" },
    "es-ES": { "standard": "es-ES-Standard-A", "neural2": "es-ES-Neural2-A", "chirp3_hd": "es-ES-Chirp3-HD-Kore" },
    "es-US": { "standard": "es-US-Standard-A", "neural2": "es-US-Neural2-A", "chirp3_hd": "es-US-Chirp3-HD-Kore" },
    "et-EE": { "standard": "et-EE-Standard-A" },
    "eu-ES": { "standard": "eu-ES-Standard-A" },
    "fi-FI": { "standard": "fi-FI-Standard-A", "neural2": "fi-FI-Wavenet-A" },
    "fil-PH": { "standard": "fil-PH-Standard-A", "neural2": "fil-PH-Wavenet-A" },
    "fr-CA": { "standard": "fr-CA-Standard-A", "neural2": "fr-CA-Neural2-A", "chirp3_hd": "fr-CA-Chirp3-HD-Kore" },
    "fr-FR": { "standard": "fr-FR-Standard-A", "neural2": "fr-FR-Neural2-A", "chirp3_hd": "fr-FR-Chirp3-HD-Kore" },
    "gl-ES": { "standard": "gl-ES-Standard-A" },
    "gu-IN": { "standard": "gu-IN-Standard-A", "neural2": "gu-IN-Wavenet-A" },
    "he-IL": { "standard": "he-IL-Standard-A", "neural2": "he-IL-Wavenet-A" },
    "hi-IN": { "standard": "hi-IN-Standard-A", "neural2": "hi-IN-Neural2-A", "chirp3_hd": "hi-IN-Chirp3-HD-Kore" },
    "hu-HU": { "standard": "hu-HU-Standard-A", "neural2": "hu-HU-Wavenet-A" },
    "id-ID": { "standard": "id-ID-Standard-A", "neural2": "id-ID-Wavenet-A", "chirp3_hd": "id-ID-Chirp3-HD-Kore" },
    "is-IS": { "standard": "is-IS-Standard-A" },
    "it-IT": { "standard": "it-IT-Standard-A", "neural2": "it-IT-Neural2-A", "chirp3_hd": "it-IT-Chirp3-HD-Kore" },
    "ja-JP": { "standard": "ja-JP-Standard-A", "neural2": "ja-JP-Neural2-B", "chirp3_hd": "ja-JP-Chirp3-HD-Kore" },
    "kn-IN": { "standard": "kn-IN-Standard-A", "neural2": "kn-IN-Wavenet-A" },
    "ko-KR": { "standard": "ko-KR-Standard-A", "neural2": "ko-KR-Neural2-A", "chirp3_hd": "ko-KR-Chirp3-HD-Kore" },
    "lt-LT": { "standard": "lt-LT-Standard-A" },
    "lv-LV": { "standard": "lv-LV-Standard-A" },
    "ml-IN": { "standard": "ml-IN-Standard-A", "neural2": "ml-IN-Wavenet-A" },
    "mr-IN": { "standard": "mr-IN-Standard-A", "neural2": "mr-IN-Wavenet-A" },
    "ms-MY": { "standard": "ms-MY-Standard-A", "neural2": "ms-MY-Wavenet-A" },
    "nb-NO": { "standard": "nb-NO-Standard-A", "neural2": "nb-NO-Wavenet-A" },
    "nl-NL": { "standard": "nl-NL-Standard-A", "neural2": "nl-NL-Wavenet-A", "chirp3_hd": "nl-NL-Chirp3-HD-Kore" },
    "pa-IN": { "standard": "pa-IN-Standard-A", "neural2": "pa-IN-Wavenet-A" },
    "pl-PL": { "standard": "pl-PL-Standard-A", "neural2": "pl-PL-Neural2-A", "chirp3_hd": "pl-PL-Chirp3-HD-Kore" },
    "pt-BR": { "standard": "pt-BR-Standard-A", "neural2": "pt-BR-Neural2-A", "chirp3_hd": "pt-BR-Chirp3-HD-Kore" },
    "pt-PT": { "standard": "pt-PT-Standard-A", "neural2": "pt-PT-Wavenet-A" },
    "ro-RO": { "standard": "ro-RO-Standard-A", "neural2": "ro-RO-Wavenet-A" },
    "ru-RU": { "standard": "ru-RU-Standard-A", "neural2": "ru-RU-Wavenet-A", "chirp3_hd": "ru-RU-Chirp3-HD-Kore" },
    "sk-SK": { "standard": "sk-SK-Standard-A", "neural2": "sk-SK-Wavenet-A" },
    "sr-RS": { "standard": "sr-RS-Standard-A" },
    "sv-SE": { "standard": "sv-SE-Standard-A", "neural2": "sv-SE-Wavenet-A", "chirp3_hd": "sv-SE-Chirp3-HD-Kore" },
    "ta-IN": { "standard": "ta-IN-Standard-A", "neural2": "ta-IN-Wavenet-A" },
    "te-IN": { "standard": "te-IN-Standard-A" },
    "th-TH": { "standard": "th-TH-Standard-A", "neural2": "th-TH-Neural2-C", "chirp3_hd": "th-TH-Chirp3-HD-Kore" },
    "tr-TR": { "standard": "tr-TR-Standard-A", "neural2": "tr-TR-Wavenet-A", "chirp3_hd": "tr-TR-Chirp3-HD-Kore" },
    "uk-UA": { "standard": "uk-UA-Standard-A", "neural2": "uk-UA-Wavenet-A" },
    "vi-VN": { "standard": "vi-VN-Standard-A", "neural2": "vi-VN-Neural2-A", "chirp3_hd": "vi-VN-Chirp3-HD-Kore" },
    "yue-HK": { "standard": "yue-HK-Standard-A", "chirp3_hd": "yue-HK-Chirp3-HD-Kore" },
    "es-MX": { "standard": "es-US-Standard-A", "neural2": "es-US-Neural2-A", "chirp3_hd": "es-US-Chirp3-HD-Kore" },
    "af-ZA": { "standard": "af-ZA-Standard-A" },
};

// 2. Load all catalogs
const CATALOG_DIR = path.join(__dirname, '../tts/voiceCatalog/catalogs');
const catalogFiles = fs.readdirSync(CATALOG_DIR).filter(f => f.endsWith('.json'));

const validVoiceNames = new Set();
const voicesByLangAndTier = {}; // { "ru-RU": { "standard": ["ru-RU-Standard-A", ...], ... } }

console.log('Loading catalogs...');
for (const file of catalogFiles) {
    const content = fs.readFileSync(path.join(CATALOG_DIR, file), 'utf8');
    try {
        const json = JSON.parse(content);
        // Usually the file is an array of voices, or object with 'voices' key
        // Our files seem to be arrays based on previous view_file
        const voices = Array.isArray(json) ? json : (json.voices || []);

        for (const voice of voices) {
            if (voice.voiceName) {
                validVoiceNames.add(voice.voiceName);

                // Index for suggestions
                const lang = voice.languageCodes ? voice.languageCodes[0] : null;
                if (lang) {
                    if (!voicesByLangAndTier[lang]) voicesByLangAndTier[lang] = {};
                    // Map 'gemini' tier to 'gemini' in our map, etc.
                    // Note: catalog voices have a 'tier' property usually, or we infer it from file?
                    // Let's use the file name as a hint or checking voice properties if they have 'tier'
                    // Actually previous grep showed "voiceId" and "voiceName" but no "tier" field in the snippet.
                    // But getVoicesFor returns tier.
                    // Let's try to infer from voiceName for suggestion grouping
                    let tier = 'unknown';
                    if (file.includes('standard')) tier = 'standard';
                    else if (file.includes('neural2') || voice.voiceName.includes('Neural2') || voice.voiceName.includes('Wavenet')) tier = 'neural2';
                    else if (file.includes('chirp3')) tier = 'chirp3_hd';
                    else if (file.includes('gemini')) tier = 'gemini';

                    if (!voicesByLangAndTier[lang][tier]) voicesByLangAndTier[lang][tier] = [];
                    voicesByLangAndTier[lang][tier].push(voice.voiceName);
                }
            }
        }
    } catch (e) {
        console.error(`Error parsing ${file}:`, e.message);
    }
}

console.log(`Loaded ${validVoiceNames.size} valid voices.\n`);
console.log('Verifying mappings...\n');

let errorCount = 0;

for (const [lang, tiers] of Object.entries(FALLBACK_VOICES)) {
    for (const [tier, voiceName] of Object.entries(tiers)) {
        if (!validVoiceNames.has(voiceName)) {
            console.error(`[FAIL] ${lang} -> ${tier}: ${voiceName} does NOT exist.`);
            errorCount++;

            // Suggestion
            const available = voicesByLangAndTier[lang]?.[tier] || [];
            if (available.length > 0) {
                console.log(`       Suggestion: ${available[0]} (Available: ${available.slice(0, 3).join(', ')}...)`);
            } else {
                // Try other tiers for this lang
                const anyTier = voicesByLangAndTier[lang] ? Object.keys(voicesByLangAndTier[lang]) : [];
                console.log(`       No voices found for ${lang} in tier ${tier}. Available tiers: ${anyTier.join(', ')}`);
            }
        }
    }
}

if (errorCount === 0) {
    console.log('\nSUCCESS! All mappings are valid.');
} else {
    console.log(`\nFound ${errorCount} invalid mappings.`);
}
