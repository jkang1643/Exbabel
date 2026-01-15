#!/usr/bin/env node
/**
 * Diffs your app's language list vs Google TTS snapshot.
 * Does NOT modify anything — prints a report.
 *
 * Handles language code differences:
 * - Your app uses 2-letter codes (e.g., "en", "es")
 * - TTS config uses locale codes (e.g., "en-US", "es-ES")
 * - Script matches by prefix for accurate comparisons
 *
 * Usage:
 *   node scripts/diffTtsLanguages.js [app-file] [snapshot-file]
 *
 *   app-file: your languages JSON (default: frontend/src/data/appLanguages.json)
 *   snapshot-file: TTS snapshot (default: frontend/src/data/google-tts-voices.snapshot.json)
 */
import fs from "fs";
import path from "path";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function main() {
  const appFile = process.argv[2] || "frontend/src/data/appLanguages.json";
  const snapFile = process.argv[3] || "frontend/src/data/google-tts-voices.snapshot.json";

  const appPath = path.resolve(process.cwd(), appFile);
  const snapPath = path.resolve(process.cwd(), snapFile);

  const app = readJson(appPath);
  const snap = readJson(snapPath);

  const appLangs = new Set(app.languages || []);
  const googleLangs = new Set(snap.languages || []);

  // Check for language matches by prefix (e.g., "en" matches "en-US", "en-GB", etc.)
  const missingInGoogle = [...appLangs].filter(appLang => {
    return !googleLangs.has(appLang) &&
           ![...googleLangs].some(googleLang => googleLang.startsWith(appLang + '-'));
  }).sort();

  const newFromGoogle = [...googleLangs].filter(googleLang => {
    const prefix = googleLang.split('-')[0];
    return !appLangs.has(googleLang) && !appLangs.has(prefix);
  }).sort();

  // Voices per language (for deeper checks) - only Google TTS voices
  const voicesByLang = {};
  for (const v of snap.voices || []) {
    if (v.provider === 'google') { // Only count Google TTS voices by language
      for (const lc of v.languageCodes || []) {
        if (!voicesByLang[lc]) voicesByLang[lc] = [];
        voicesByLang[lc].push(v);
      }
    }
  }
  for (const lc of Object.keys(voicesByLang)) voicesByLang[lc].sort((a, b) => a.name.localeCompare(b.name));

  console.log("=== Google TTS Language Diff Report ===");
  console.log(`App languages: ${appLangs.size}`);
  console.log(`Google snapshot languages: ${googleLangs.size}`);
  console.log("");

  if (missingInGoogle.length) {
    console.log("⚠️ In app but NOT in Google snapshot (possible deprecations / typos):");
    for (const l of missingInGoogle) console.log(`  - ${l}`);
    console.log("");
  } else {
    console.log("✅ All app languages exist in Google snapshot.");
    console.log("");
  }

  if (newFromGoogle.length) {
    console.log("🆕 In Google snapshot but NOT in app (new candidates you may add):");
    for (const l of newFromGoogle) console.log(`  - ${l} (${(voicesByLang[l] || []).length} voices)`);
    console.log("");
  } else {
    console.log("✅ No new languages in Google snapshot relative to your app.");
    console.log("");
  }

  // Show voice counts for your existing languages (including locale variants)
  console.log("=== Voice counts for app languages (from snapshot) ===");

  // Check if Gemini voices exist at all
  const totalGeminiVoices = snap.voices.filter(v => v.provider === 'gemini').length;

  const rows = [...appLangs].sort().map(appLang => {
    // Sum voices for this language across all its locale variants (only Google TTS voices)
    let googleVoices = voicesByLang[appLang]?.length || 0;

    // Also check for locale variants (e.g., "en" includes "en-US", "en-GB", etc.)
    for (const googleLang of googleLangs) {
      if (googleLang.startsWith(appLang + '-')) {
        googleVoices += voicesByLang[googleLang]?.length || 0;
      }
    }

    return {
      lang: appLang,
      googleVoices,
      hasGemini: totalGeminiVoices > 0, // Gemini voices available for all languages if they exist
    };
  });

  for (const r of rows) {
    let voiceDesc = [];

    if (r.googleVoices > 0) voiceDesc.push(`${r.googleVoices} Google`);
    if (r.hasGemini) voiceDesc.push(`${totalGeminiVoices} Gemini`);
    if (voiceDesc.length === 0) voiceDesc.push('no voices');

    console.log(`  - ${r.lang}: ${voiceDesc.join(' + ')}`);
  }

  if (totalGeminiVoices > 0) {
    console.log(`\n💡 Note: Gemini voices (${totalGeminiVoices} total) are language-agnostic and available for all languages`);
    console.log(`   Google TTS voices are language-specific and vary by locale`);
  }
}

main();
