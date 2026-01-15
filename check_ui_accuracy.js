import fs from "fs";

const snap = JSON.parse(fs.readFileSync("./frontend/src/data/google-tts-voices.snapshot.json", "utf-8"));
const langs = await import("./frontend/src/config/languages.js");

// TTS languages (locale codes like "en-US", "es-ES")
const ttsLangs = new Set(snap.languages);

// UI languages (2-letter codes like "en", "es")
const uiLangs = new Set(langs.TRANSLATION_LANGUAGES.map(l => l.code));

console.log("=== TTS Languages vs UI Languages ===");
console.log(`TTS languages: ${ttsLangs.size}`);
console.log(`UI languages: ${uiLangs.size}`);
console.log("");

// Languages in TTS but NOT in UI (missing from UI)
const missingFromUI = [...ttsLangs].filter(ttsLang => {
  const baseLang = ttsLang.split('-')[0]; // "en-US" -> "en"
  return !uiLangs.has(ttsLang) && !uiLangs.has(baseLang);
}).sort();

console.log("🔍 Languages with TTS voices but NOT exposed in UI:");
if (missingFromUI.length === 0) {
  console.log("  ✅ All TTS languages are exposed in UI");
} else {
  missingFromUI.forEach(lang => console.log(`  - ${lang}`));
}
console.log("");

// Languages in UI but NO TTS support (extra in UI)
const extraInUI = [...uiLangs].filter(uiLang => {
  // Check if this UI language has any TTS locale variants
  const hasTTS = [...ttsLangs].some(ttsLang => ttsLang.startsWith(uiLang + '-'));
  return !ttsLangs.has(uiLang) && !hasTTS;
}).sort();

console.log("⚠️ Languages in UI but NO TTS voice support:");
if (extraInUI.length === 0) {
  console.log("  ✅ All UI languages have TTS support");
} else {
  extraInUI.forEach(lang => console.log(`  - ${lang}`));
}
console.log("");

console.log("📋 Summary:");
console.log(`  - ${ttsLangs.size} TTS-supported languages`);
console.log(`  - ${uiLangs.size} UI-exposed languages`);
console.log(`  - ${missingFromUI.length} TTS languages missing from UI`);
console.log(`  - ${extraInUI.length} UI languages without TTS support`);
