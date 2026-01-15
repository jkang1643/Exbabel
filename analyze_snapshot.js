import data from './temp_snapshot.json' with { type: 'json' };
const tierLanguages = {};

data.voices.forEach(voice => {
  const tier = voice.tier;
  if (!tierLanguages[tier]) tierLanguages[tier] = new Set();

  voice.languageCodes.forEach(lang => tierLanguages[tier].add(lang));
});

console.log('=== TTS Language Support Analysis ===');
console.log('Total voices:', data.voiceCount);
console.log('Total languages:', data.languagesCount);
console.log('');

console.log('Per-tier language counts:');
Object.entries(tierLanguages)
  .sort((a, b) => b[1].size - a[1].size)
  .forEach(([tier, langs]) => {
    console.log(`${tier}: ${langs.size} languages`);
    if (tier === 'gemini') {
      console.log('  Languages:', Array.from(langs).sort().join(', '));
      console.log(`  Expected: 87+ languages, Got: ${langs.size} languages`);
      console.log(`  Status: ${langs.size >= 87 ? '✅ SUCCESS' : '⚠️ INCOMPLETE - Use Vertex AI auth for full access'}`);
    }
    if (tier === 'chirp3_hd') {
      console.log(`  Expected: 61+ languages, Got: ${langs.size} languages`);
      console.log(`  Status: ${langs.size >= 61 ? '✅ SUCCESS' : '⚠️ INCOMPLETE'}`);
    }
  });
