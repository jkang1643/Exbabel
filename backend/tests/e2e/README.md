# End-to-End Core Engine Integration Test Walkthrough

This document describes the newly implemented E2E test harness for the Exbabel Core Engine and how to run it.

## Overview

We have created a comprehensive integration test suite that verifies the entire pipeline:
**Audio Input (MP3) -> STT (Google) -> Orchestration (SoloMode) -> Translation (OpenAI) -> Output Events**

## Key Features

- **Real Backend Instance**: Spawns a real instance of the backend server.
- **Mock-Free**: Uses actual Google Cloud Speech-to-Text and OpenAI APIs (requires valid credentials).
- **MP3 Support**: Enhanced the backend to support MP3 streaming for testing convenience.
- **Robust Assertions**: Verifies message sequence, partial/final progression, and error-free operation.

## Files

| File | Description |
| :--- | :--- |
| [e2e.coreEngine.int.test.js](file:///home/jkang1643/projects/realtimetranslationapp/backend/tests/e2e/e2e.coreEngine.int.test.js) | Main Jest test file. Connects to WS, streams audio, runs assertions. |
| [e2e.golden.test.js](file:///home/jkang1643/projects/realtimetranslationapp/backend/tests/e2e/e2e.golden.test.js) | Golden Run integration test. Uses `GoldenRecorder` for baseline comparisons. |
| [golden/](file:///home/jkang1643/projects/realtimetranslationapp/backend/tests/e2e/golden/) | Directory containing [Golden Baseline JSON files](file:///home/jkang1643/projects/realtimetranslationapp/backend/tests/e2e/golden/README.md). |
| [goldenRecorder.js](file:///home/jkang1643/projects/realtimetranslationapp/backend/tests/e2e/helpers/goldenRecorder.js) | Normalization, Invariant checking, and Comparison logic for Golden Runs. |
| [spawnServer.js](file:///home/jkang1643/projects/realtimetranslationapp/backend/tests/e2e/helpers/spawnServer.js) | Spawns `server.js` as a child process on a test port. |
| [wsClient.js](file:///home/jkang1643/projects/realtimetranslationapp/backend/tests/e2e/helpers/wsClient.js) | WebSocket client wrapper with `waitForSettle` logic. |
| [audioStreamer.js](file:///home/jkang1643/projects/realtimetranslationapp/backend/tests/e2e/helpers/audioStreamer.js) | Streams audio file chunks to WebSocket. Correctly handles MP3/WAV. |
| [assertions.exbabel.js](file:///home/jkang1643/projects/realtimetranslationapp/backend/tests/e2e/helpers/assertions.exbabel.js) | Reusable assertion logic for pipeline invariants. |

## How to Run

### Ensure Credentials

The test runs against real APIs, so your environment must have:
1. `OPENAI_API_KEY` in `.env`
2. `GOOGLE_APPLICATION_CREDENTIALS` (or `GOOGLE_SPEECH_API_KEY`) pointing to a valid service account.

### Run the Test

You can run the E2E tests using the following command from the `backend` directory:

```bash
npm run test:e2e
```

Alternatively, you can run Jest directly:

```bash
# Run with Jest from the backend directory
NODE_OPTIONS="$NODE_OPTIONS --experimental-vm-modules" ./node_modules/.bin/jest tests/e2e/e2e.coreEngine.int.test.js
```

## Test Flow

### Test 1: Solo Mode
1. **Setup**: Spawns backend server on port 3002.
2. **Connect**: Establishes WebSocket connection to `/translate` (Solo Mode).
3. **Init**: Sends `init` message with encoding: 'MP3' and sampleRateHertz: 44100.
4. **Stream**: Streams `integrationtestmotionconference.mp3` in 20ms chunks.
5. **Verify**: Asserts translation events and valid sequence IDs.

### Test 2: Host Mode
1. **Create Session**: POST `/session/start` to create a new session.
2. **Connect**: Connects to `/translate?role=host&sessionId=....`
3. **Init**: Sends `init` message (same config).
4. **Stream**: Streams the same audio file.
5. **Verify**: Asserts that the Host receives translation events for their own speech.

## Troubleshooting

### "No translation events received"
- Check API keys in `.env`.
- Check network connectivity to Google/OpenAI.
- Verify audio file format matches `init` options (44.1kHz MP3).

### "GoogleSpeechStream Error"
- Usually indicates credentials issue or quota limits.
- Check server stdout logs (uncomment logging in `spawnServer.js` if needed).
