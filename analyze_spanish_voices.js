import fs from "fs";

const data = JSON.parse(fs.readFileSync("./frontend/src/config/ttsVoices.json", "utf-8"));

const esVoices = [
  ...(data['es-ES'] || []),
  ...(data['es-US'] || [])
];

const tiers = [...new Set(esVoices.map(v => v.tier))];

console.log('Spanish voice tiers:', tiers.sort());
console.log('Total Spanish voices:', esVoices.length);
console.log('Breakdown by tier:');

const byTier = esVoices.reduce((acc, v) => {
  acc[v.tier] = (acc[v.tier] || 0) + 1;
  return acc;
}, {});

Object.entries(byTier)
  .sort((a,b) => b[1] - a[1])
  .forEach(([tier, count]) => console.log(`  ${tier}: ${count} voices`));

// Show some examples from each tier
console.log('\nExamples from each tier:');
tiers.forEach(tier => {
  const examples = esVoices.filter(v => v.tier === tier).slice(0, 3);
  console.log(`\n${tier.toUpperCase()}:`);
  examples.forEach(v => console.log(`  ${v.value} - ${v.label}`));
});
