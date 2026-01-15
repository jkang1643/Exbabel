import fs from "fs";

const snap = JSON.parse(fs.readFileSync("./frontend/src/data/google-tts-voices.snapshot.json", "utf-8"));
const ttsVoices = JSON.parse(fs.readFileSync("./frontend/src/config/ttsVoices.json", "utf-8"));

console.log("=== TTS Voice Model Verification ===");
console.log(`Total TTS-supported languages: ${snap.languages.length}`);
console.log(`Total Google TTS voices: ${snap.googleVoiceCount}`);
console.log(`Total Gemini voices: ${snap.geminiVoiceCount}`);
console.log(`Total voices: ${snap.voiceCount}`);
console.log("");

console.log("🔍 Checking if UI matches TTS data...");

// Check a few major languages
const testLangs = ['en-US', 'es-ES', 'fr-FR', 'de-DE', 'ja-JP', 'ko-KR', 'zh-CN'];

console.log("Sample language voice counts:");
testLangs.forEach(lang => {
  const uiVoices = ttsVoices[lang] || [];
  const snapVoices = snap.voices.filter(v =>
    v.provider === 'google' && v.languageCodes.includes(lang)
  );

  console.log(`  ${lang}: UI=${uiVoices.length}, Snapshot=${snapVoices.length} ${uiVoices.length === snapVoices.length ? '✅' : '❌'}`);
});

console.log("");
console.log("Gemini voices (should be available for all languages):");
const geminiVoices = snap.voices.filter(v => v.provider === 'gemini');
console.log(`  ${geminiVoices.length} voices: ${geminiVoices.slice(0, 5).map(v => v.name).join(', ')}${geminiVoices.length > 5 ? '...' : ''}`);

console.log("");
console.log("🎯 Question: For TTS-supported languages, does your UI show:");
console.log("   - All Google TTS voices for that language/locale?");
console.log("   - All 30 Gemini voices (language-agnostic)?");
console.log("   - Correct voice tiers (chirp3_hd, neural2, standard, gemini)?");
