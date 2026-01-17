
import fs from "fs";

/**
 * Streams a buffer/file to the WebSocket as JSON audio chunks
 * Protocol: { type: 'audio', data: 'base64...' }
 */
export async function streamWavFile(ws, wavPath, { chunkMs = 20, realtime = false, endSilenceMs = 600, durationMs = 0 } = {}) {
    const buf = fs.readFileSync(wavPath);
    const isMp3 = wavPath.toLowerCase().endsWith('.mp3');

    // Minimal WAV header skip (typically 44 bytes); for MP3, send everything.
    const PCM_OFFSET = isMp3 ? 0 : 44;
    const pcm = buf.subarray(PCM_OFFSET);

    // Assume 16kHz, 16-bit mono for WAV. For MP3, caller handles metadata.
    const sampleRate = 16000;
    const bytesPerSample = 2;
    const channels = 1;

    // For WAV (PCM), use calculated rate. For MP3, approximate 128kbps (16 bytes/ms).
    // Sending too fast can cause server to close connection.
    const bytesPerMs = isMp3 ? 16 : (sampleRate * bytesPerSample * channels) / 1000;
    const chunkBytes = Math.floor(bytesPerMs * chunkMs); // ~640 bytes for 20ms

    // Calculate max bytes if duration limit applies
    const maxBytes = durationMs > 0 ? Math.floor(durationMs * bytesPerMs) : pcm.length;
    const endByte = Math.min(pcm.length, maxBytes);

    console.log(`[Streamer] Streaming ${wavPath} (${endByte} bytes of ${pcm.length}) in ${chunkMs}ms chunks...`);

    // Throttle logging to avoid spam
    let sentChunks = 0;

    for (let i = 0; i < endByte; i += chunkBytes) {
        const chunk = pcm.subarray(i, i + chunkBytes);
        const base64Audio = chunk.toString("base64");

        const msg = {
            type: "audio",
            audioData: base64Audio
        };

        if (ws.readyState === 1) { // OPEN
            ws.send(JSON.stringify(msg));
            sentChunks++;
        } else {
            console.warn("[Streamer] WebSocket not open, skipping chunk");
        }

        // if (realtime) await sleep(chunkMs);
        // Since node's sleep usually drifts, we can just busy-wait or use regular sleep.
        // For "realtime-ish" test, regular sleep is fine. 
        // Usually tests run faster than realtime if the backend allows, but speech APIs often need somewhat realtime pacing.
        if (realtime) {
            await new Promise(r => setTimeout(r, chunkMs));
        } else {
            // Just a tiny yield to let event loop breathe if not realtime
            if (sentChunks % 10 === 0) await new Promise(r => setImmediate(r));
        }
    }

    console.log(`[Streamer] Sent ${sentChunks} audio chunks.`);

    // Send end stream marker if protocol supports it (e.g., 'audio_end' or just silence)
    // Based on inputValidator.js, 'audio_end' is a valid type.
    try {
        ws.send(JSON.stringify({ type: "audio_end" }));
    } catch (e) {
        // ignore
    }

    if (endSilenceMs > 0) {
        console.log(`[Streamer] Waiting ${endSilenceMs}ms end silence...`);
        await new Promise(r => setTimeout(r, endSilenceMs));
    }
}
