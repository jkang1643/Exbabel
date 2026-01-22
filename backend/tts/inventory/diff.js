/**
 * Inventory Diff Engine
 * 
 * Compares two inventory snapshots and detects changes
 */

/**
 * Compare two snapshots and detect changes
 * @param {object} prevSnapshot - Previous snapshot
 * @param {object} latestSnapshot - Latest snapshot
 * @returns {object} Diff result
 */
export function diffSnapshots(prevSnapshot, latestSnapshot) {
    if (!prevSnapshot || !latestSnapshot) {
        throw new Error('Both snapshots are required for diff');
    }

    if (prevSnapshot.providerKey !== latestSnapshot.providerKey) {
        throw new Error('Cannot diff snapshots from different providers');
    }

    // Key voices by voiceId
    const prevVoices = new Map(prevSnapshot.voices.map(v => [v.voiceId, v]));
    const latestVoices = new Map(latestSnapshot.voices.map(v => [v.voiceId, v]));

    const addedVoices = [];
    const removedVoices = [];
    const changedLocales = [];
    const changedMetadata = [];

    // Detect additions
    for (const [voiceId, voice] of latestVoices) {
        if (!prevVoices.has(voiceId)) {
            addedVoices.push({
                voiceId: voice.voiceId,
                voiceName: voice.voiceName,
                family: voice.family,
                languageCodes: voice.languageCodes
            });
        }
    }

    // Detect removals
    for (const [voiceId, voice] of prevVoices) {
        if (!latestVoices.has(voiceId)) {
            removedVoices.push({
                voiceId: voice.voiceId,
                voiceName: voice.voiceName,
                family: voice.family,
                languageCodes: voice.languageCodes
            });
        }
    }

    // Detect changes in existing voices
    for (const [voiceId, latestVoice] of latestVoices) {
        const prevVoice = prevVoices.get(voiceId);
        if (!prevVoice) continue; // Already handled in additions

        // Check locale changes
        const prevLocales = JSON.stringify(prevVoice.languageCodes?.sort() || []);
        const latestLocales = JSON.stringify(latestVoice.languageCodes?.sort() || []);

        if (prevLocales !== latestLocales) {
            changedLocales.push({
                voiceId,
                voiceName: latestVoice.voiceName,
                before: prevVoice.languageCodes || [],
                after: latestVoice.languageCodes || []
            });
        }

        // Check metadata changes
        const metadataFields = ['gender', 'sampleRateHz', 'model', 'displayName'];
        for (const field of metadataFields) {
            if (prevVoice[field] !== latestVoice[field]) {
                changedMetadata.push({
                    voiceId,
                    voiceName: latestVoice.voiceName,
                    field,
                    before: prevVoice[field],
                    after: latestVoice[field]
                });
            }
        }
    }

    const fromDate = prevSnapshot.fetchedAt?.split('T')[0] || 'unknown';
    const toDate = latestSnapshot.fetchedAt?.split('T')[0] || 'unknown';

    return {
        providerKey: latestSnapshot.providerKey,
        fromDate,
        toDate,
        addedVoices,
        removedVoices,
        changedLocales,
        changedMetadata,
        summary: {
            totalAdded: addedVoices.length,
            totalRemoved: removedVoices.length,
            totalLocaleChanges: changedLocales.length,
            totalMetadataChanges: changedMetadata.length,
            hasChanges: addedVoices.length > 0 || removedVoices.length > 0 ||
                changedLocales.length > 0 || changedMetadata.length > 0
        }
    };
}

/**
 * Format diff result as markdown
 * @param {object} diffResult - Diff result from diffSnapshots()
 * @returns {string} Markdown formatted report
 */
export function formatDiffMarkdown(diffResult) {
    const lines = [];

    lines.push(`# Voice Inventory Diff: ${diffResult.providerKey}`);
    lines.push('');
    lines.push(`**From:** ${diffResult.fromDate}`);
    lines.push(`**To:** ${diffResult.toDate}`);
    lines.push('');

    if (!diffResult.summary.hasChanges) {
        lines.push('✅ **No changes detected**');
        return lines.join('\n');
    }

    lines.push('## Summary');
    lines.push('');
    lines.push(`- Added voices: ${diffResult.summary.totalAdded}`);
    lines.push(`- Removed voices: ${diffResult.summary.totalRemoved}`);
    lines.push(`- Locale changes: ${diffResult.summary.totalLocaleChanges}`);
    lines.push(`- Metadata changes: ${diffResult.summary.totalMetadataChanges}`);
    lines.push('');

    if (diffResult.addedVoices.length > 0) {
        lines.push('## ➕ Added Voices');
        lines.push('');
        for (const voice of diffResult.addedVoices) {
            lines.push(`- **${voice.voiceName}** (${voice.family})`);
            lines.push(`  - Voice ID: \`${voice.voiceId}\``);
            lines.push(`  - Languages: ${voice.languageCodes.join(', ')}`);
        }
        lines.push('');
    }

    if (diffResult.removedVoices.length > 0) {
        lines.push('## ➖ Removed Voices');
        lines.push('');
        for (const voice of diffResult.removedVoices) {
            lines.push(`- **${voice.voiceName}** (${voice.family})`);
            lines.push(`  - Voice ID: \`${voice.voiceId}\``);
        }
        lines.push('');
    }

    if (diffResult.changedLocales.length > 0) {
        lines.push('## 🔄 Locale Changes');
        lines.push('');
        for (const change of diffResult.changedLocales) {
            lines.push(`- **${change.voiceName}**`);
            lines.push(`  - Before: ${change.before.join(', ')}`);
            lines.push(`  - After: ${change.after.join(', ')}`);
        }
        lines.push('');
    }

    if (diffResult.changedMetadata.length > 0) {
        lines.push('## 📝 Metadata Changes');
        lines.push('');
        for (const change of diffResult.changedMetadata) {
            lines.push(`- **${change.voiceName}** - ${change.field}`);
            lines.push(`  - Before: ${change.before}`);
            lines.push(`  - After: ${change.after}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}
