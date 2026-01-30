
import fs from 'fs';
import path from 'path';

// Paths
const SNAPSHOT_PATH = path.resolve('frontend/src/data/google-tts-voices.snapshot.json');
const CATALOGS_DIR = path.resolve('backend/tts/voiceCatalog/catalogs');

// Tier mapping to filename and metadata
const TIER_MAPPING = {
    'standard': {
        filename: 'google_standard.json',
        provider: 'google_cloud_tts',
        family: 'standard'
    },
    'neural2': {
        filename: 'google_neural2.json',
        provider: 'google_cloud_tts',
        family: 'neural2'
    },
    'chirp3_hd': {
        filename: 'google_chirp3_hd.json',
        provider: 'google_cloud_tts',
        family: 'chirp3_hd'
    },
    'studio': {
        filename: 'google_studio.json',
        provider: 'google_cloud_tts',
        family: 'studio'
    }
};

async function main() {
    console.log('🔄 Updating backend voice catalogs from snapshot...');

    // 1. Read Snapshot
    if (!fs.existsSync(SNAPSHOT_PATH)) {
        console.error(`❌ Snapshot not found at: ${SNAPSHOT_PATH}`);
        console.error('   Run "npm run tts:snapshot" first.');
        process.exit(1);
    }

    const snapshotRaw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    const snapshot = JSON.parse(snapshotRaw);
    console.log(`✅ Loaded snapshot with ${snapshot.voices.length} voices`);

    // 2. Group by Tier
    const voicesByTier = {
        standard: [],
        neural2: [],
        chirp3_hd: [],
        studio: []
    };

    let otherCount = 0;

    snapshot.voices.forEach(v => {
        // Map snapshot tier to our catalog tiers
        // Note: Snapshot might call it 'marketing', 'polyglot', etc. 
        // But the fetch script categorizes them into standard, neural2, chirp3_hd

        if (voicesByTier[v.tier]) {
            // Transform to backend voice format
            // Backend expects: { voiceId, voiceName, displayName, languageCodes, gender?, model? }

            // Construct Voice ID consistent with backend convention
            // google_cloud_tts:family:lang:name
            // But checking existing catalogs, Standard uses: google_cloud_tts:standard:en-US:A

            // Extract necessary parts
            const tierInfo = TIER_MAPPING[v.tier];
            const lang = v.languageCodes[0];
            // voice name is like "en-US-Standard-A"
            const uniquePart = v.name.split('-').pop(); // "A"

            // Reconstruct ID to match existing format exactly
            // existing: google_cloud_tts:standard:en-US:A
            // name: en-US-Standard-A

            let idMiddle = tierInfo.family;
            // Handle special cases if any, but standard/neural2/chirp seem consistent

            // For Chirp: en-US-Chirp3-HD-Fenrir -> Fenrir? No, chirp names are unique.
            // Let's rely on the name.

            const voiceValues = {
                voiceId: `google_cloud_tts:${tierInfo.family}:${lang}:${uniquePart}`, // Approximation, might need refinement
                voiceName: v.name,
                displayName: v.name, // Use full name as display name for now
                languageCodes: v.languageCodes,
                ssmlGender: v.ssmlGender
            };

            // Fix ID for consistency
            // If name is en-US-Standard-A -> ID: google_cloud_tts:standard:en-US:A
            // If name is en-US-Neural2-A -> ID: google_cloud_tts:neural2:en-US:A
            // If name is en-US-Chirp3-HD-F -> ID: google_cloud_tts:chirp3_hd:en-US:F

            // Better ID generation based on exact name components
            const nameParts = v.name.split('-');
            const tag = nameParts[nameParts.length - 1]; // "A", "Fenrir"

            // Override ID with more robust logic
            voiceValues.voiceId = `google_cloud_tts:${tierInfo.family}:${lang}:${tag}`;

            voicesByTier[v.tier].push(voiceValues);
        } else {
            otherCount++;
        }
    });

    console.log(`\n📊 Voices to update:`);
    console.log(`   Standard: ${voicesByTier.standard.length}`);
    console.log(`   Neural2: ${voicesByTier.neural2.length}`);
    console.log(`   Chirp3 HD: ${voicesByTier.chirp3_hd.length}`);
    console.log(`   Studio: ${voicesByTier.studio.length}`);
    console.log(`   Other/Skipped: ${otherCount}`);

    // 3. Write Catalogs
    for (const [tier, info] of Object.entries(TIER_MAPPING)) {
        const voices = voicesByTier[tier];
        if (voices.length === 0) {
            console.log(`⚠️  No voices for ${tier}, skipping update.`);
            continue;
        }

        const catalog = {
            provider: info.provider,
            family: info.family,
            tier: tier,
            voices: voices
        };

        const destPath = path.join(CATALOGS_DIR, info.filename);
        fs.writeFileSync(destPath, JSON.stringify(catalog, null, 2), 'utf8');
        console.log(`✅ Updated ${info.filename} (${voices.length} voices)`);
    }

    console.log('\n✨ Catalog update complete!');
}

main();
