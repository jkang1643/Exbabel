// backend/tests/e2e/helpers/timeline.js
export function toTimelineMarkdown(events) {
    const rows = events
        .slice()
        .sort((a, b) => (a.serverTimestamp ?? 0) - (b.serverTimestamp ?? 0))
        .map((e) => {
            const ts = e.serverTimestamp ? new Date(e.serverTimestamp).toISOString() : "(no-ts)";
            if (e.type === "translation") {
                const kind = e.isPartial ? "PART" : (e.forceFinal ? "FINAL(force)" : "FINAL");
                const text = (e.isPartial ? e.transcript : (e.translatedText ?? e.translation ?? e.transcript)) ?? "";
                const short = String(text).replace(/\s+/g, " ").slice(0, 120);
                return `- ${ts} **translation/${kind}** lang=${e.targetLang} seq=${e.seqId} :: ${short}`;
            }
            if (e.type === "tts/ack") {
                return `- ${ts} **tts/ack** action=${e.action} state=${e?.state?.playbackState} tier=${e?.state?.tier} mode=${e?.state?.mode}`;
            }
            if (e.type === "tts/audio") {
                return `- ${ts} **tts/audio** seg=${e.segmentId} dur=${e?.audio?.durationMs}ms mime=${e?.audio?.mimeType}`;
            }
            return `- ${ts} **${e.type}** ${JSON.stringify(e).slice(0, 140)}…`;
        });

    return `# E2E Timeline\n\n${rows.join("\n")}\n`;
}
