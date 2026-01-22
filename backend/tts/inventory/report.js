/**
 * Inventory Coverage Report Generator
 * 
 * Generates coverage statistics from inventory snapshots
 */

/**
 * Generate coverage report from a snapshot
 * @param {object} snapshot - Inventory snapshot
 * @returns {object} Coverage report
 */
export function generateCoverageReport(snapshot) {
    if (!snapshot || !snapshot.voices) {
        throw new Error('Invalid snapshot: missing voices array');
    }

    const byFamily = {};
    const allLanguages = new Set();

    // Group voices by family
    for (const voice of snapshot.voices) {
        const family = voice.family || 'unknown';

        if (!byFamily[family]) {
            byFamily[family] = {
                totalVoices: 0,
                languages: new Set(),
                voicesByLanguage: {}
            };
        }

        byFamily[family].totalVoices++;

        const languages = voice.languageCodes || [];
        const isMultilingual = languages.includes('*');

        if (isMultilingual) {
            byFamily[family].multilingual = true;
            // For gemini/elevenlabs which often use '*', we still want to count them in summary
            // if we have a known list, but usually '*' means 'all'.
        }

        for (const lang of languages) {
            if (lang === '*') continue;

            byFamily[family].languages.add(lang);
            allLanguages.add(lang);

            if (!byFamily[family].voicesByLanguage[lang]) {
                byFamily[family].voicesByLanguage[lang] = {
                    count: 0,
                    samples: []
                };
            }

            byFamily[family].voicesByLanguage[lang].count++;

            if (byFamily[family].voicesByLanguage[lang].samples.length < 5) {
                const displayName = voice.displayName || voice.voiceName;
                byFamily[family].voicesByLanguage[lang].samples.push(displayName);
            }
        }
    }

    // Convert Sets to counts and arrays
    const byFamilyReport = {};
    for (const [family, data] of Object.entries(byFamily)) {
        byFamilyReport[family] = {
            totalVoices: data.totalVoices,
            totalLanguages: data.languages.size,
            multilingual: data.multilingual || false,
            voicesByLanguage: data.voicesByLanguage
        };
    }

    return {
        providerKey: snapshot.providerKey,
        fetchedAt: snapshot.fetchedAt,
        byFamily: byFamilyReport,
        summary: {
            totalVoices: snapshot.voices.length,
            totalLanguages: allLanguages.size,
            totalFamilies: Object.keys(byFamily).length
        }
    };
}

/**
 * Format coverage report as markdown
 * @param {object} report - Coverage report from generateCoverageReport()
 * @returns {string} Markdown formatted report
 */
export function formatCoverageMarkdown(report) {
    const lines = [];

    lines.push(`# Voice Inventory Coverage: ${report.providerKey}`);
    lines.push('');
    lines.push(`**Fetched:** ${report.fetchedAt?.split('T')[0] || 'unknown'}`);
    lines.push('');

    lines.push('## Summary');
    lines.push('');
    lines.push(`- Total voices: ${report.summary.totalVoices}`);
    lines.push(`- Total languages: ${report.summary.totalLanguages}`);
    lines.push(`- Total families: ${report.summary.totalFamilies}`);
    lines.push('');

    lines.push('## By Family');
    lines.push('');

    for (const [family, data] of Object.entries(report.byFamily)) {
        lines.push(`### ${family}`);
        lines.push('');
        lines.push(`- Total voices: ${data.totalVoices}`);

        if (data.multilingual) {
            lines.push(`- Languages: **Multilingual** (${data.totalLanguages} languages supported)`);
        } else {
            lines.push(`- Total languages: ${data.totalLanguages}`);
        }

        // Show top 10 languages by voice count
        const langEntries = Object.entries(data.voicesByLanguage)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10);

        if (langEntries.length > 0) {
            lines.push('');
            lines.push('**Top Languages:**');
            lines.push('');

            for (const [lang, info] of langEntries) {
                const samples = info.samples.slice(0, 3).join(', ');
                lines.push(`- **${lang}**: ${info.count} voices (e.g., ${samples})`);
            }
        }

        lines.push('');
    }

    return lines.join('\n');
}
