
// backend/tests/e2e/e2e.golden.test.js
import path from "path";
import { spawnTestServer, stopTestServer } from "./helpers/spawnServer.js";
import { connectWs, waitForSettle } from "./helpers/wsClient.js";
import { streamWavFile } from "./helpers/audioStreamer.js";
import { GoldenRecorder } from "./helpers/goldenRecorder.js";

const FIXTURES = path.resolve(process.cwd(), "tests/e2e/fixtures");
// Correctly resolve the path relative to the backend directory
const AUDIO_FILE = path.resolve(process.cwd(), "../EngineeringDocs/integrationtestmotionconference.mp3");

describe("Golden Run: MP3 E2E Pipeline", () => {
    let server;
    let baseUrl;

    beforeAll(async () => {
        // Spawn a fresh server for isolation
        ({ server, baseUrl } = await spawnTestServer({
            port: 3003, // Different port to avoid conflicts
            env: { NODE_ENV: "test" }
        }));
    }, 40000);

    afterAll(async () => {
        await stopTestServer(server);
    });

    test("Golden Record/Verify for Core Engine", async () => {
        const testName = "coreEngine_fullPipeline.mp3.es-en";
        // Hybrid mode with some example anchors (seqId 20, 50, 80)
        const recorder = new GoldenRecorder(testName, {
            mode: process.env.GOLDEN_TEXT_MODE || 'hybrid',
            anchors: [80]
        });

        const wsUrl = `${baseUrl.replace("http", "ws")}/translate`;
        const ws = await connectWs(wsUrl);

        // Attach recorder
        const originalOnMessage = ws.onmessage;
        ws.on("message", (data) => {
            try {
                const str = data.toString();
                const e = JSON.parse(str);
                recorder.record(e);
            } catch (err) {
                // Ignore non-JSON or parse errors for golden run, or log them
            }
        });

        // Init
        ws.send(JSON.stringify({
            type: "init",
            sourceLang: "en",
            targetLang: "es", // Multi-lingual as per sample requirement
            tier: "basic",
            encoding: "MP3",
            sampleRateHertz: 44100
        }));

        // Stream Audio
        console.log(`[Golden] Streaming ${AUDIO_FILE}...`);
        await streamWavFile(ws, AUDIO_FILE, {
            realtime: true,
            chunkMs: 20,
            // The user mentioned "sermon_sample_01.mp3" in the prompt example but specifically pointed to 
            // `EngineeringDocs/integrationtestmotionconference.mp3` for the actual test.
            // We'll stream the whole file or a significant portion.
            // Let's stream 30 seconds to be sure we get enough data, or the whole file if shorter.
            durationMs: 30000,
        });

        // Wait for settle
        // We can pass a dummy array to waitForSettle since we are recording internally
        // But waitForSettle expects an array to check length changes.
        // We can pass recorder.events
        await waitForSettle(recorder.events, { idleMs: 2000, maxWaitMs: 20000, debug: true });

        ws.close();

        // Phase A vs Phase B
        if (process.env.GOLDEN_RECORD === "1") {
            await recorder.save();
        } else {
            await recorder.verify();
        }

    }, 90000); // Long timeout for streaming
});
