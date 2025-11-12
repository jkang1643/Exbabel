/**
 * Segment glossary.json into categories for frontend organization
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the glossary file
const glossaryPath = path.join(__dirname, 'glossary.json');
const glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));

if (!glossary.phrases || !Array.isArray(glossary.phrases)) {
  console.error('Error: glossary.json must contain a "phrases" array');
  process.exit(1);
}

console.log(`📚 Loaded ${glossary.phrases.length} phrases from glossary.json\n`);

// Find marker indices
function findPhraseIndex(phraseValue) {
  return glossary.phrases.findIndex(p => p.value === phraseValue);
}

const markers = {
  'Revelation': findPhraseIndex('Revelation'),
  'Absalom\'s Monument': findPhraseIndex('Absalom\'s Monument'),
  'Zobah': findPhraseIndex('Zobah'),
  'Aaronites': findPhraseIndex('Aaronites'),
  'Zuzims': findPhraseIndex('Zuzims'),
  'Aaron': findPhraseIndex('Aaron'),
  'Zurishaddai': findPhraseIndex('Zurishaddai'),
  'Reversionism': findPhraseIndex('Reversionism'),
  'Zechariah\'s song': findPhraseIndex('Zechariah\'s song'),
  'Abomination': findPhraseIndex('Abomination'),
  'Zion': findPhraseIndex('Zion'),
  'Abaddon': findPhraseIndex('Abaddon'),
  'Wisdom of Solomon': findPhraseIndex('Wisdom of Solomon'),
  'the word of God': findPhraseIndex('the word of God'),
  'the meek': findPhraseIndex('the meek'),
  'piece of cake': findPhraseIndex('piece of cake'),
  'ivory tower': findPhraseIndex('ivory tower'),
  'Agape': findPhraseIndex('Agape'),
  'Ethnos': findPhraseIndex('Ethnos'),
  'Afikomen': findPhraseIndex('Afikomen'),
  'Zionism': findPhraseIndex('Zionism'),
  'Adoptionism': findPhraseIndex('Adoptionism'),
  'Subordinationism': findPhraseIndex('Subordinationism')
};

// Verify all markers found
for (const [name, index] of Object.entries(markers)) {
  if (index === -1) {
    console.error(`❌ Error: Marker "${name}" not found in glossary`);
    process.exit(1);
  }
}

console.log('✅ All markers found:\n');
for (const [name, index] of Object.entries(markers)) {
  console.log(`   ${name.padEnd(25)} → line ${index + 1}`);
}
console.log('');

// Segment the phrases
const categories = {
  'Bible Book Names': {
    start: 0,
    end: markers['Revelation']
  },
  'Bible Places': {
    start: markers['Absalom\'s Monument'],
    end: markers['Zobah']
  },
  'Names of Peoples and Nations': {
    start: markers['Aaronites'],
    end: markers['Zuzims']
  },
  'Names of Biblical Persons': {
    start: markers['Aaron'],
    end: markers['Zurishaddai']
  },
  'Theological Terms': {
    start: markers['Reversionism'],
    end: markers['Zechariah\'s song']
  },
  'Bible Glossary': {
    // User specified: "Abaddon to Wisdom of Solomon" AND "Abomination to Zion"
    // Since "Abomination to Zion" is backwards (Zion 311 < Abomination 2902),
    // we'll use "Abaddon to Wisdom of Solomon" as the main range
    // This includes "Abaddon" (2516) which is between Persons and Theological Terms
    // Note: This will overlap slightly with Theological Terms (2518-2901)
    start: markers['Abaddon'],
    end: markers['Wisdom of Solomon']
  },
  'Sermon Phrases': {
    start: markers['the word of God'],
    end: markers['the meek']
  },
  'General Purpose': {
    start: markers['piece of cake'],
    end: markers['ivory tower']
  },
  'Greek Biblical Terms': {
    start: markers['Agape'],
    end: markers['Ethnos']
  },
  'Hebrew Biblical Terms': {
    start: markers['Afikomen'],
    end: markers['Zionism']
  },
  'Liturgical Terms': {
    start: markers['Adoptionism'],
    end: markers['Subordinationism']
  }
};

// Extract phrases for each category and track which indices are used
const segmented = {};
const categorizedIndices = new Set();

for (const [categoryName, config] of Object.entries(categories)) {
  if (config.ranges) {
    // Handle multiple ranges
    segmented[categoryName] = [];
    for (const range of config.ranges) {
      const phrases = glossary.phrases.slice(range.start, range.end + 1);
      segmented[categoryName].push(...phrases);
      // Track indices
      for (let i = range.start; i <= range.end; i++) {
        categorizedIndices.add(i);
      }
    }
  } else {
    // Single range
    segmented[categoryName] = glossary.phrases.slice(config.start, config.end + 1);
    // Track indices
    for (let i = config.start; i <= config.end; i++) {
      categorizedIndices.add(i);
    }
  }
  
  console.log(`📁 ${categoryName.padEnd(35)} → ${segmented[categoryName].length} phrases`);
}

// Find uncategorized phrases and add to Others/Misc
const uncategorizedPhrases = [];
for (let i = 0; i < glossary.phrases.length; i++) {
  if (!categorizedIndices.has(i)) {
    uncategorizedPhrases.push(glossary.phrases[i]);
  }
}

if (uncategorizedPhrases.length > 0) {
  segmented['Others/Misc'] = uncategorizedPhrases;
  console.log(`📁 ${'Others/Misc'.padEnd(35)} → ${uncategorizedPhrases.length} phrases`);
}

console.log('');

// Create segmented structure
const segmentedGlossary = {
  metadata: {
    totalPhrases: glossary.phrases.length,
    segmentedAt: new Date().toISOString(),
    categories: Object.keys(segmented)
  },
  categories: {}
};

// Add each category
for (const [categoryName, phrases] of Object.entries(segmented)) {
  segmentedGlossary.categories[categoryName] = {
    count: phrases.length,
    phrases: phrases
  };
}

// Write segmented glossary
const outputPath = path.join(__dirname, 'glossary-segmented.json');
fs.writeFileSync(outputPath, JSON.stringify(segmentedGlossary, null, 2), 'utf8');

console.log(`✅ Segmented glossary written to: ${outputPath}`);
console.log(`\n📊 Summary:`);
console.log(`   Total categories: ${Object.keys(segmented).length}`);
console.log(`   Total phrases: ${glossary.phrases.length}`);

let segmentedTotal = 0;
for (const [categoryName, phrases] of Object.entries(segmented)) {
  segmentedTotal += phrases.length;
  console.log(`   ${categoryName.padEnd(35)}: ${phrases.length.toString().padStart(5)} phrases`);
}

console.log(`\n   Segmented total: ${segmentedTotal}`);
const uniqueCategorized = categorizedIndices.size;
console.log(`   Unique phrases categorized: ${uniqueCategorized}`);
console.log(`   Uncategorized phrases: ${uncategorizedPhrases.length}`);

if (segmentedTotal !== glossary.phrases.length) {
  const overlap = segmentedTotal - uniqueCategorized - uncategorizedPhrases.length;
  if (overlap > 0) {
    console.log(`\nℹ️  Note: ${overlap} phrases appear in multiple categories (overlaps are expected)`);
    console.log(`   This is normal - some phrases like "Abaddon" appear in both Bible Glossary and Theological Terms`);
  }
}

if (uniqueCategorized + uncategorizedPhrases.length === glossary.phrases.length) {
  console.log(`\n✅ All phrases accounted for!`);
}
