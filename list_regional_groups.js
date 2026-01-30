
import { loadAllCatalogs, getAllVoicesFromCatalogs } from './backend/tts/voiceCatalog/catalogLoader.js';
import { normalizeLanguageCode } from './backend/tts/voiceCatalog/index.js';

async function listGroups() {
    await loadAllCatalogs();
    const voices = await getAllVoicesFromCatalogs();

    // Group by base language
    const groups = {};

    for (const voice of voices) {
        for (const lang of voice.languageCodes) {
            // Check if this is a specific locale (has -)
            if (lang.includes('-')) {
                const { base } = normalizeLanguageCode(lang);
                if (!groups[base]) groups[base] = new Set();
                groups[base].add(lang);
            }
        }
    }

    console.log('# Language Groupings (Base Code -> Variants Found)');

    // Sort and print
    Object.keys(groups).sort().forEach(base => {
        const variants = Array.from(groups[base]).sort();
        if (variants.length > 1) {
            console.log(`\n### ${base.toUpperCase()} (${variants.length} variants)`);
            variants.forEach(v => console.log(`- ${v}`));
        }
    });
}

listGroups();
