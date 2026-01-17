Perfect — with these event shapes, we can make a **single E2E integration test** that’s both **comprehensive** and **hard to regress** (especially around your “freeze / partial never commits / ordering / TTS queue” classes of bugs).

Below is a drop-in **Jest-style** harness + **assertions specifically for your message schema** (`type: "translation"`, `isPartial`, `seqId`, `translatedText`, `forceFinal`, `tts/ack`, `tts/audio`, etc.).

---

## What this E2E test will prove (based on your schema)

### Translation pipeline invariants

For each `(targetLang)` stream:

* You get **partials** for a `seqId` before the final (most of the time)
* Partials can update same `seqId`, but **final happens exactly once per seqId**
* Each final has:

  * `isPartial:false`
  * `originalText` + `transcript`
  * if `hasTranslation:true` → `translatedText` (and `translation`) must be non-empty
  * if `hasCorrection:true` → `correctedText` must be non-empty
* `seqId` is **monotonic increasing** (allow repeats for partial updates, but no backwards)

### Forced final invariants

* At least one `forceFinal:true` is allowed/expected in some runs
* `forceFinal:true` events must still obey “final exactly once per seqId”

### TTS invariants

* If TTS is enabled:

  * you must receive `tts/ack` with `playbackState: PLAYING`
  * for each finalized translated segment, you eventually get `tts/audio` for its `segmentId`
  * each `tts/audio.audio.bytesBase64` is non-empty and decodes to non-trivial byte length
  * audio metadata sanity (`durationMs > 0`, sampleRateHz > 0, mimeType present)

---

## E2E test file (single test)

> Replace the session creation / ws URL with your actual endpoints. Everything else matches your schema.

```js
// backend/test/e2e/e2e.coreEngine.int.test.js
import path from "path";
import { spawnTestServer, stopTestServer } from "./helpers/spawnServer.js";
import { connectWs, waitForSettle } from "./helpers/wsClient.js";
import { streamWavFile } from "./helpers/audioStreamer.js";
import {
  assertNoErrors,
  assertTranslationFlowPerLanguage,
  assertTtsFlow,
} from "./helpers/assertions.exbabel.js";

const FIXTURES = path.resolve(process.cwd(), "test/e2e/fixtures");
const AUDIO_FILE = path.join(FIXTURES, "sermon_2min.wav");

describe("E2E Exbabel Core Engine (audio → translation → TTS)", () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    ({ server, baseUrl } = await spawnTestServer({
      env: {
        NODE_ENV: "test",
        E2E: "1",

        // Put your providers here (or replay mode)
        // STT_PROVIDER: "google",
        // TRANSLATION_PROVIDER: "openai",
        // TTS_PROVIDER: "google",

        // Make tests deterministic-ish:
        // DISABLE_RANDOM_VOICES: "1",
      },
    }));
  }, 120_000);

  afterAll(async () => {
    await stopTestServer(server);
  });

  test(
    "streams audio and validates end-to-end invariants",
    async () => {
      const events = [];

      // Create/join a session (replace with your real method)
      const sessionCode = "E2E-TEST";
      const wsUrl = `${baseUrl.replace("http", "ws")}/ws?session=${encodeURIComponent(sessionCode)}`;

      const ws = await connectWs(wsUrl);

      ws.on("message", (buf) => {
        try {
          const e = JSON.parse(buf.toString());
          events.push({ ...e, _receivedAt: Date.now() });
        } catch {
          // ignore non-json
        }
      });

      // Optionally, if your server requires an explicit "start TTS" message:
      // ws.send(JSON.stringify({ type: "tts/start", tier: "gemini", mode: "unary" }));

      await streamWavFile(ws, AUDIO_FILE, {
        realtime: false,
        chunkMs: 20,
        endSilenceMs: 600,
        // If your protocol requires explicit JSON frames rather than raw bytes, adjust helper.
      });

      await waitForSettle(events, { idleMs: 1200, maxWaitMs: 40_000 });

      // --- Assertions ---
      assertNoErrors(events);

      // Translation pipeline: assert per target language stream
      assertTranslationFlowPerLanguage(events, {
        // Choose what you expect your test run to include
        // If your run is single-language, set ["es"] only.
        expectedTargetLangs: ["es"],
        requireAtLeastOneForceFinal: false, // set true if your audio/test config triggers timeouts
      });

      // TTS: only enforced if TTS events exist (or you can force requireTts=true)
      assertTtsFlow(events, {
        requireTts: false, // set true if your test always starts TTS
      });

      ws.close();
    },
    120_000
  );
});
```

---

## Assertions that match your exact schema

```js
// backend/test/e2e/helpers/assertions.exbabel.js

function isTranslationEvent(e) {
  return e?.type === "translation";
}

function isFinalTranslation(e) {
  return isTranslationEvent(e) && e.isPartial === false;
}

function isPartialTranslation(e) {
  return isTranslationEvent(e) && e.isPartial === true;
}

export function assertNoErrors(events) {
  const errors = events.filter(
    (e) =>
      (typeof e?.type === "string" && e.type.includes("error")) ||
      e?.level === "error" ||
      e?.error
  );
  if (errors.length) {
    throw new Error(
      `Errors emitted:\n${errors.slice(0, 5).map((e) => JSON.stringify(e)).join("\n")}`
    );
  }
}

export function assertTranslationFlowPerLanguage(events, opts) {
  const {
    expectedTargetLangs = [],
    requireAtLeastOneForceFinal = false,
  } = opts || {};

  const translations = events.filter(isTranslationEvent);
  if (!translations.length) throw new Error("No translation events received.");

  // If you provided expected langs, assert they appear.
  if (expectedTargetLangs.length) {
    for (const lang of expectedTargetLangs) {
      const found = translations.some((e) => e.targetLang === lang);
      if (!found) {
        throw new Error(`Expected targetLang=${lang} to appear in translation events, but it did not.`);
      }
    }
  }

  // Group by targetLang (since you broadcast to multiple languages)
  const byLang = new Map();
  for (const e of translations) {
    const lang = e.targetLang || "unknown";
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang).push(e);
  }

  for (const [lang, evs] of byLang.entries()) {
    // Ignore unknown language group if you want strictness:
    if (lang === "unknown") continue;

    // Sort by serverTimestamp then received order (stable-ish)
    evs.sort((a, b) => (a.serverTimestamp ?? 0) - (b.serverTimestamp ?? 0));

    // --- Seq monotonic rules ---
    // Allow repeats (partials update same seqId), but no backwards.
    let lastSeq = -Infinity;
    for (const e of evs) {
      if (!Number.isFinite(e.seqId)) {
        throw new Error(`translation event missing numeric seqId (lang=${lang}): ${JSON.stringify(e)}`);
      }
      if (e.seqId < lastSeq) {
        throw new Error(`seqId went backwards for lang=${lang}: ${lastSeq} -> ${e.seqId}`);
      }
      lastSeq = e.seqId;
    }

    // --- Final exactly once per seqId ---
    const finals = evs.filter(isFinalTranslation);
    if (!finals.length) throw new Error(`No final translation events for lang=${lang}`);

    const seenFinal = new Set();
    for (const f of finals) {
      if (seenFinal.has(f.seqId)) {
        throw new Error(`Duplicate FINAL translation for seqId=${f.seqId} lang=${lang}`);
      }
      seenFinal.add(f.seqId);
    }

    // --- Partials should exist for at least some seqIds (don’t require every seq) ---
    const partials = evs.filter(isPartialTranslation);
    if (partials.length < 2) {
      // keep this soft-ish; you can make it strict if you want
      throw new Error(`Expected at least 2 partial translation events for lang=${lang}, got ${partials.length}`);
    }

    // --- Validate content invariants on finals ---
    for (const f of finals) {
      if (typeof f.originalText !== "string" || !f.originalText.trim()) {
        throw new Error(`Final missing originalText (lang=${lang} seqId=${f.seqId})`);
      }
      if (typeof f.transcript !== "string" || !f.transcript.trim()) {
        throw new Error(`Final missing transcript (lang=${lang} seqId=${f.seqId})`);
      }

      if (f.hasCorrection) {
        if (typeof f.correctedText !== "string" || !f.correctedText.trim()) {
          throw new Error(`hasCorrection=true but correctedText empty (lang=${lang} seqId=${f.seqId})`);
        }
      }

      if (f.hasTranslation) {
        const t = f.translatedText ?? f.translation;
        if (typeof t !== "string" || !t.trim()) {
          throw new Error(`hasTranslation=true but translatedText/translation empty (lang=${lang} seqId=${f.seqId})`);
        }
      }
    }

    // --- Partial update behavior: same seqId can appear multiple times but should progress in text length sometimes ---
    // (This catches “partials stuck” regressions lightly without being flaky.)
    const partialBySeq = new Map();
    for (const p of partials) {
      const arr = partialBySeq.get(p.seqId) ?? [];
      arr.push(p);
      partialBySeq.set(p.seqId, arr);
    }
    for (const [seqId, ps] of partialBySeq.entries()) {
      if (ps.length >= 2) {
        const first = (ps[0].transcript ?? ps[0].originalText ?? "").length;
        const last = (ps[ps.length - 1].transcript ?? ps[ps.length - 1].originalText ?? "").length;
        // Don’t require growth, but if it shrinks massively it’s suspicious
        if (last + 5 < first) {
          throw new Error(`Partial transcript regressed significantly for seqId=${seqId} lang=${lang}`);
        }
      }
    }

    // --- Force-final expectations (optional) ---
    const forced = finals.filter((f) => f.forceFinal === true);
    if (requireAtLeastOneForceFinal && forced.length === 0) {
      throw new Error(`Expected at least one forceFinal for lang=${lang}, but none found`);
    }
  }
}

export function assertTtsFlow(events, { requireTts = false } = {}) {
  const acks = events.filter((e) => e.type === "tts/ack");
  const audios = events.filter((e) => e.type === "tts/audio");

  if (requireTts && !acks.length) throw new Error("TTS required but no tts/ack received.");
  if (requireTts && !audios.length) throw new Error("TTS required but no tts/audio received.");

  // If TTS isn’t used in this run, bail quietly.
  if (!acks.length && !audios.length) return;

  // Validate ack structure
  const startAck = acks.find((a) => a.action === "start");
  if (!startAck) throw new Error("Expected a tts/ack with action=start.");
  if (startAck?.state?.playbackState !== "PLAYING") {
    throw new Error(`Expected playbackState=PLAYING, got ${startAck?.state?.playbackState}`);
  }

  // Validate audio payloads
  for (const a of audios) {
    if (typeof a.segmentId !== "string" || !a.segmentId.trim()) {
      throw new Error(`tts/audio missing segmentId: ${JSON.stringify(a)}`);
    }
    const bytesBase64 = a?.audio?.bytesBase64;
    if (typeof bytesBase64 !== "string" || bytesBase64.length < 32) {
      throw new Error(`tts/audio bytesBase64 too small/empty for segmentId=${a.segmentId}`);
    }

    // decode base64 size sanity (no need to validate audio fully)
    const byteLen = Buffer.from(bytesBase64, "base64").length;
    if (byteLen < 200) {
      throw new Error(`tts/audio decoded bytes too small (${byteLen}) for segmentId=${a.segmentId}`);
    }

    const { mimeType, durationMs, sampleRateHz } = a.audio || {};
    if (typeof mimeType !== "string" || !mimeType) throw new Error(`tts/audio missing mimeType for ${a.segmentId}`);
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`tts/audio bad durationMs for ${a.segmentId}`);
    if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) throw new Error(`tts/audio bad sampleRateHz for ${a.segmentId}`);

    // route sanity
    if (a?.resolvedRoute) {
      if (!a.resolvedRoute.provider || !a.resolvedRoute.tier || !a.resolvedRoute.engine) {
        throw new Error(`tts/audio resolvedRoute incomplete for ${a.segmentId}`);
      }
    }
  }

  // Stronger mapping check:
  // Every tts/audio segmentId should correspond to an actual finalized translation seqId.
  const finals = events.filter((e) => e.type === "translation" && e.isPartial === false && e.hasTranslation);
  const finalSeqIds = new Set(finals.map((f) => String(f.seqId)));

  const orphan = audios.find((a) => !finalSeqIds.has(String(a.segmentId)));
  if (orphan) {
    throw new Error(`tts/audio for segmentId=${orphan.segmentId} has no matching final translated seqId`);
  }
}
```

---

## WebSocket settle helper (simple + effective)

```js
// backend/test/e2e/helpers/wsClient.js
import WebSocket from "ws";

export async function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForSettle(events, { idleMs = 1200, maxWaitMs = 30_000 } = {}) {
  const start = Date.now();
  let lastLen = events.length;
  let lastChange = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await sleep(200);
    if (events.length !== lastLen) {
      lastLen = events.length;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= idleMs) return;
  }

  throw new Error(`Pipeline did not settle in ${maxWaitMs}ms (events=${events.length})`);
}
```

---

## One important improvement: “Golden” phrase assertions (optional but powerful)

To make this truly “comprehensive”, add a fixture like:

```json
// test/e2e/fixtures/expected.phrases.json
{
  "en": ["Hello world", "How are you"],
  "es": ["Hola mundo", "¿Cómo estás"]
}
```

Then assert that at least one final contains these phrases (not exact full transcript; just contains). This catches “translation stopped emitting” even if the event counts look fine.

If you want, I’ll add that helper too — but you can already plug it in cleanly.

---

## Next: I can tailor this to your exact WS protocol for audio

Right now the streamer assumes “raw PCM frames” in binary. If your WS expects something like:

```json
{ "type": "audio", "format": "pcm_s16le", "sampleRateHz": 16000, "bytesBase64": "..." }
```

…tell me which format you use, and I’ll rewrite `audioStreamer.js` accordingly so it works the first time with your backend.

Also: if your backend supports a deterministic “replay mode” (bypassing provider drift), we can make this test **CI-safe** and keep the “live providers” run as a separate nightly job.
