#!/usr/bin/env node
/**
 * TTS Inventory CLI
 * 
 * Command-line interface for managing TTS provider inventories
 * 
 * Commands:
 *   pull --provider=<provider>    Fetch and save latest inventory
 *   diff --provider=<provider>    Compare snapshots
 *   report --provider=<provider>  Generate coverage report
 */

import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from backend/.env
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { saveSnapshot, loadLatestSnapshot, loadPreviousSnapshot, loadSnapshotByDate } from './snapshotStoreFs.js';
import { fetchGoogleCloudInventory } from './providers/googleCloudTts.js';
import { fetchElevenLabsInventory } from './providers/elevenLabs.js';
import { fetchGeminiInventory } from './providers/geminiDocs.js';
import { diffSnapshots, formatDiffMarkdown } from './diff.js';
import { generateCoverageReport, formatCoverageMarkdown } from './report.js';
import { validateCatalogAgainstInventory, formatValidationMarkdown } from '../voiceCatalog/catalogValidate.js';
import { getAllVoicesFromCatalogs } from '../voiceCatalog/catalogLoader.js';

const REPORTS_DIR = path.join(__dirname, 'reports');

// Provider collectors map
const PROVIDERS = {
    google_cloud_tts: fetchGoogleCloudInventory,
    elevenlabs: fetchElevenLabsInventory,
    gemini: fetchGeminiInventory
};

/**
 * Ensure reports directory exists
 */
async function ensureReportsDir() {
    try {
        await fs.mkdir(REPORTS_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
}

/**
 * Pull command: Fetch and save latest inventory
 */
async function pullCommand(options) {
    const providers = options.provider === 'all'
        ? Object.keys(PROVIDERS)
        : [options.provider];

    for (const providerKey of providers) {
        const fetchFn = PROVIDERS[providerKey];
        if (!fetchFn) {
            console.error(`❌ Unknown provider: ${providerKey}`);
            console.error(`   Available: ${Object.keys(PROVIDERS).join(', ')}`);
            process.exit(1);
        }

        try {
            console.log(`\n📥 Pulling inventory for ${providerKey}...`);
            const snapshot = await fetchFn();
            const savedPath = await saveSnapshot(providerKey, snapshot);
            console.log(`✅ Saved: ${savedPath}`);
            console.log(`   Voices: ${snapshot.voices.length}`);
        } catch (error) {
            console.error(`❌ Failed to pull ${providerKey}:`, error.message);
            process.exit(1);
        }
    }

    console.log('\n✅ Pull complete');
}

/**
 * Diff command: Compare snapshots
 */
async function diffCommand(options) {
    const { provider, from, to } = options;

    if (!PROVIDERS[provider]) {
        console.error(`❌ Unknown provider: ${provider}`);
        process.exit(1);
    }

    try {
        console.log(`\n🔍 Comparing snapshots for ${provider}...`);

        // Load snapshots
        let prevSnapshot, latestSnapshot;

        if (from === 'prev') {
            prevSnapshot = await loadPreviousSnapshot(provider);
            if (!prevSnapshot) {
                console.error('❌ No previous snapshot found (need at least 2 snapshots)');
                process.exit(1);
            }
        } else {
            prevSnapshot = await loadSnapshotByDate(provider, from);
            if (!prevSnapshot) {
                console.error(`❌ Snapshot not found: ${from}`);
                process.exit(1);
            }
        }

        if (to === 'latest') {
            latestSnapshot = await loadLatestSnapshot(provider);
            if (!latestSnapshot) {
                console.error('❌ No latest snapshot found');
                process.exit(1);
            }
        } else {
            latestSnapshot = await loadSnapshotByDate(provider, to);
            if (!latestSnapshot) {
                console.error(`❌ Snapshot not found: ${to}`);
                process.exit(1);
            }
        }

        // Generate diff
        const diffResult = diffSnapshots(prevSnapshot, latestSnapshot);

        // Save reports
        await ensureReportsDir();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const jsonPath = path.join(REPORTS_DIR, `diff-${provider}-${timestamp}.json`);
        const mdPath = path.join(REPORTS_DIR, `diff-${provider}-${timestamp}.md`);

        await fs.writeFile(jsonPath, JSON.stringify(diffResult, null, 2), 'utf8');
        await fs.writeFile(mdPath, formatDiffMarkdown(diffResult), 'utf8');

        // Print summary
        console.log('\n📊 Diff Summary:');
        console.log(`   Added: ${diffResult.summary.totalAdded}`);
        console.log(`   Removed: ${diffResult.summary.totalRemoved}`);
        console.log(`   Locale changes: ${diffResult.summary.totalLocaleChanges}`);
        console.log(`   Metadata changes: ${diffResult.summary.totalMetadataChanges}`);
        console.log(`\n📄 Reports saved:`);
        console.log(`   JSON: ${jsonPath}`);
        console.log(`   Markdown: ${mdPath}`);

        // Exit code: 2 if changes detected (for CI), 0 otherwise
        if (diffResult.summary.hasChanges) {
            console.log('\n⚠️  Changes detected');
            process.exit(2);
        } else {
            console.log('\n✅ No changes');
            process.exit(0);
        }
    } catch (error) {
        console.error('❌ Diff failed:', error.message);
        process.exit(1);
    }
}

/**
 * Report command: Generate coverage report
 */
async function reportCommand(options) {
    const providers = options.provider === 'all'
        ? Object.keys(PROVIDERS)
        : [options.provider];

    await ensureReportsDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    for (const providerKey of providers) {
        if (!PROVIDERS[providerKey]) {
            console.error(`❌ Unknown provider: ${providerKey}`);
            continue;
        }

        try {
            console.log(`\n📊 Generating coverage report for ${providerKey}...`);

            const snapshot = await loadLatestSnapshot(providerKey);
            if (!snapshot) {
                console.error(`   ⚠️  No snapshot found for ${providerKey}`);
                continue;
            }

            const report = generateCoverageReport(snapshot);

            // Save reports
            const jsonPath = path.join(REPORTS_DIR, `coverage-${providerKey}-${timestamp}.json`);
            const mdPath = path.join(REPORTS_DIR, `coverage-${providerKey}-${timestamp}.md`);

            await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
            await fs.writeFile(mdPath, formatCoverageMarkdown(report), 'utf8');

            console.log(`   ✅ Voices: ${report.summary.totalVoices}`);
            console.log(`   ✅ Languages: ${report.summary.totalLanguages}`);
            console.log(`   ✅ Families: ${report.summary.totalFamilies}`);

            // Detailed Family Breakdown
            for (const [family, data] of Object.entries(report.byFamily)) {
                const langCount = data.totalLanguages;
                const langLabel = data.multilingual ? `Multilingual (${langCount} languages)` : langCount;

                console.log(`\n   Family: ${family}`);
                console.log(`     Languages supported: ${langLabel}`);
                console.log(`     Total voices: ${data.totalVoices}`);

                if (data.voicesByLanguage) {
                    const topLangs = Object.entries(data.voicesByLanguage)
                        .sort((a, b) => b[1].count - a[1].count)
                        .slice(0, 5);

                    if (topLangs.length > 0) {
                        console.log(`     Top languages:`);
                        for (const [lang, info] of topLangs) {
                            console.log(`       ${lang}: ${info.count} voices`);
                        }
                    }
                }
            }

            console.log(`\n   📄 JSON: ${jsonPath}`);
            console.log(`   📄 Markdown: ${mdPath}`);
        } catch (error) {
            console.error(`   ❌ Failed: ${error.message}`);
        }
    }

    console.log('\n✅ Report generation complete');
}

/**
 * Validate command: Compare catalog against latest inventory
 */
async function validateCommand(options) {
    const providerKey = options.provider;
    if (!PROVIDERS[providerKey]) {
        console.error(`❌ Unknown provider: ${providerKey}`);
        process.exit(1);
    }

    try {
        console.log(`\n🩺 Validating catalog against latest inventory for ${providerKey}...`);

        const snapshot = await loadLatestSnapshot(providerKey);
        if (!snapshot) {
            console.error(`❌ No latest snapshot found for ${providerKey}`);
            process.exit(1);
        }

        const allVoices = await getAllVoicesFromCatalogs();
        const catalogVoices = allVoices.filter(v => v.provider === providerKey);

        const result = validateCatalogAgainstInventory(catalogVoices, snapshot.voices);

        console.log(formatValidationMarkdown(result));

        if (!result.valid) {
            process.exit(2);
        }
    } catch (error) {
        console.error(`❌ Validation failed: ${error.message}`);
        process.exit(1);
    }
}

// CLI setup
const program = new Command();

program
    .name('tts-inventory')
    .description('TTS Provider Inventory Management CLI')
    .version('1.0.0');

program
    .command('pull')
    .description('Fetch and save latest inventory snapshot')
    .option('-p, --provider <provider>', 'Provider key (google_cloud_tts, elevenlabs, gemini, all)', 'all')
    .action(pullCommand);

program
    .command('diff')
    .description('Compare two inventory snapshots')
    .requiredOption('-p, --provider <provider>', 'Provider key')
    .option('--from <date>', 'From date (YYYY-MM-DD) or "prev"', 'prev')
    .option('--to <date>', 'To date (YYYY-MM-DD) or "latest"', 'latest')
    .action(diffCommand);

program
    .command('report')
    .description('Generate coverage report')
    .option('-p, --provider <provider>', 'Provider key (google_cloud_tts, elevenlabs, gemini, all)', 'all')
    .action(reportCommand);

program
    .command('validate')
    .description('Validate catalog against inventory snapshot')
    .requiredOption('-p, --provider <provider>', 'Provider key')
    .action(validateCommand);

program.parse();
