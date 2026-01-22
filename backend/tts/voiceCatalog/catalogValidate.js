/**
 * Catalog Validator
 * 
 * Validates catalog voices against inventory snapshots
 * NOT used on the hot path - only for CLI/CI/admin tools
 */

/**
 * Validate catalog against inventory snapshot
 * @param {Array} catalogVoices - Voices from catalog
 * @param {Array} inventoryVoices - Voices from inventory snapshot
 * @returns {object} Validation result
 */
export function validateCatalogAgainstInventory(catalogVoices, inventoryVoices) {
    // Key inventory voices by voiceId for fast lookup
    const inventoryMap = new Map(inventoryVoices.map(v => [v.voiceId, v]));

    const missingInInventory = [];
    const metadataMismatches = [];

    for (const catalogVoice of catalogVoices) {
        const inventoryVoice = inventoryMap.get(catalogVoice.voiceId);

        if (!inventoryVoice) {
            missingInInventory.push({
                voiceId: catalogVoice.voiceId,
                voiceName: catalogVoice.voiceName,
                reason: 'Voice present in catalog but not found in latest inventory'
            });
            continue;
        }

        // Compare metadata
        // Note: Catalog may have different languageCodes (curated subset)
        // so we check if catalog languages are a subset of inventory languages

        const catalogLangs = new Set(catalogVoice.languageCodes || []);
        const inventoryLangs = new Set(inventoryVoice.languageCodes || []);

        // Check if catalog has languages not in inventory
        const extraLangs = [];
        for (const lang of catalogLangs) {
            if (lang !== '*' && !inventoryLangs.has(lang) && !inventoryLangs.has('*')) {
                extraLangs.push(lang);
            }
        }

        if (extraLangs.length > 0) {
            metadataMismatches.push({
                voiceId: catalogVoice.voiceId,
                voiceName: catalogVoice.voiceName,
                field: 'languageCodes',
                issue: 'Catalog has languages not in inventory',
                catalogValue: Array.from(catalogLangs),
                inventoryValue: Array.from(inventoryLangs),
                extraLanguages: extraLangs
            });
        }

        // Check other metadata fields
        const fieldsToCheck = ['model', 'gender', 'sampleRateHz'];
        for (const field of fieldsToCheck) {
            if (catalogVoice[field] && inventoryVoice[field] &&
                catalogVoice[field] !== inventoryVoice[field]) {
                metadataMismatches.push({
                    voiceId: catalogVoice.voiceId,
                    voiceName: catalogVoice.voiceName,
                    field,
                    issue: 'Metadata mismatch',
                    catalogValue: catalogVoice[field],
                    inventoryValue: inventoryVoice[field]
                });
            }
        }
    }

    return {
        valid: missingInInventory.length === 0 && metadataMismatches.length === 0,
        missingInInventory,
        metadataMismatches,
        deprecatedSuggestions: [], // Future: could add replacement suggestions
        summary: {
            totalCatalogVoices: catalogVoices.length,
            totalInventoryVoices: inventoryVoices.length,
            missingCount: missingInInventory.length,
            mismatchCount: metadataMismatches.length
        }
    };
}

/**
 * Format validation result as markdown
 * @param {object} result - Validation result
 * @returns {string} Markdown formatted report
 */
export function formatValidationMarkdown(result) {
    const lines = [];

    lines.push('# Catalog Validation Report');
    lines.push('');

    if (result.valid) {
        lines.push('✅ **Catalog is valid against inventory**');
        lines.push('');
        lines.push(`- Catalog voices: ${result.summary.totalCatalogVoices}`);
        lines.push(`- Inventory voices: ${result.summary.totalInventoryVoices}`);
        return lines.join('\n');
    }

    lines.push('⚠️  **Validation issues found**');
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push(`- Catalog voices: ${result.summary.totalCatalogVoices}`);
    lines.push(`- Inventory voices: ${result.summary.totalInventoryVoices}`);
    lines.push(`- Missing in inventory: ${result.summary.missingCount}`);
    lines.push(`- Metadata mismatches: ${result.summary.mismatchCount}`);
    lines.push('');

    if (result.missingInInventory.length > 0) {
        lines.push('## ❌ Missing in Inventory');
        lines.push('');
        lines.push('These voices are in the catalog but not found in the latest inventory:');
        lines.push('');
        for (const item of result.missingInInventory) {
            lines.push(`- **${item.voiceName}**`);
            lines.push(`  - Voice ID: \`${item.voiceId}\``);
            lines.push(`  - Reason: ${item.reason}`);
        }
        lines.push('');
    }

    if (result.metadataMismatches.length > 0) {
        lines.push('## ⚠️  Metadata Mismatches');
        lines.push('');
        for (const item of result.metadataMismatches) {
            lines.push(`- **${item.voiceName}** - ${item.field}`);
            lines.push(`  - Issue: ${item.issue}`);
            lines.push(`  - Catalog: ${JSON.stringify(item.catalogValue)}`);
            lines.push(`  - Inventory: ${JSON.stringify(item.inventoryValue)}`);
            if (item.extraLanguages) {
                lines.push(`  - Extra languages: ${item.extraLanguages.join(', ')}`);
            }
        }
        lines.push('');
    }

    return lines.join('\n');
}
