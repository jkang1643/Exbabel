#!/usr/bin/env node
/**
 * Expand ElevenLabs Catalogs with All Voices from Inventory
 * 
 * This script reads the ElevenLabs inventory snapshot and updates all catalog files
 * with the complete set of available voices (including custom church voices).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const INVENTORY_PATH = path.resolve(__dirname, '../backend/tts/inventory/snapshots/elevenlabs/2026-02-04.json');
const CATALOGS_DIR = path.resolve(__dirname, '../backend/tts/voiceCatalog/catalogs');

// Family/tier mapping
const FAMILIES = {
    'elevenlabs_v3': {
        filename: 'elevenlabs_v3.json',
        displaySuffix: ' (v3)',
        tier: 'elevenlabs_v3'
    },
    'elevenlabs_turbo': {
        filename: 'elevenlabs_turbo.json',
        displaySuffix: ' (Turbo)',
        tier: 'elevenlabs_turbo'
    },
    'elevenlabs_flash': {
        filename: 'elevenlabs_flash.json',
        displaySuffix: ' (Flash)',
        tier: 'elevenlabs_flash'
    },
    'elevenlabs': {
        filename: 'elevenlabs_standard.json',
        displaySuffix: '',
        tier: 'elevenlabs'
    }
};

async function main() {
    console.log('🔄 Expanding ElevenLabs catalogs from inventory...\n');

    // 1. Load inventory
    if (!fs.existsSync(INVENTORY_PATH)) {
        console.error(`❌ Inventory not found at: ${INVENTORY_PATH}`);
        process.exit(1);
    }

    const inventoryRaw = fs.readFileSync(INVENTORY_PATH, 'utf8');
    const inventory = JSON.parse(inventoryRaw);
    console.log(`✅ Loaded inventory with ${inventory.voices.length} total voice entries`);

    // 2. Group by family
    const voicesByFamily = {};
    inventory.voices.forEach(voice => {
        if (!voicesByFamily[voice.family]) {
            voicesByFamily[voice.family] = [];
        }
        voicesByFamily[voice.family].push(voice);
    });

    console.log('\n📊 Inventory breakdown:');
    Object.entries(voicesByFamily).forEach(([family, voices]) => {
        console.log(`   ${family}: ${voices.length} voices`);
    });

    // 3. Transform and write catalogs
    console.log('\n📝 Writing catalogs...');

    for (const [family, config] of Object.entries(FAMILIES)) {
        const voices = voicesByFamily[family] || [];

        if (voices.length === 0) {
            console.log(`⚠️  No voices found for ${family}, skipping...`);
            continue;
        }

        // Filter to ONLY custom/generated voices (exclude pre-made voices)
        const customVoices = voices.filter(v => v.category === 'generated');

        if (customVoices.length === 0) {
            console.log(`⚠️  No custom voices found for ${family}, skipping...`);
            continue;
        }

        console.log(`   ${family}: ${customVoices.length} custom voices (filtered from ${voices.length} total)`);

        // Transform voices to catalog format
        const catalogVoices = customVoices.map(v => {
            // Use the full display name for custom voices
            return {
                voiceId: v.voiceId,
                voiceName: v.voiceName,
                displayName: v.displayName + config.displaySuffix,
                languageCodes: v.languageCodes
            };
        });

        // Create catalog object
        const catalog = {
            provider: 'elevenlabs',
            family: family,
            tier: config.tier,
            voices: catalogVoices
        };

        // Write to file
        const destPath = path.join(CATALOGS_DIR, config.filename);
        fs.writeFileSync(destPath, JSON.stringify(catalog, null, 4), 'utf8');
        console.log(`✅ Updated ${config.filename} (${catalogVoices.length} voices)`);
    }

    console.log('\n✨ Catalog expansion complete!');
    console.log('\n💡 Next steps:');
    console.log('   1. Run validation: cd backend && node tts/inventory/cli.js validate --provider=elevenlabs');
    console.log('   2. Restart the server to load new catalogs');
}

main().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
