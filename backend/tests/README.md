# Exbabel Test Suite

This directory contains automated tests for the Exbabel backend.

## Structure

- `tts/unit/`: Unit tests for TTS logic (policy, validation).
- `tts/integration/`: End-to-end tests requiring a running server.

## Running Tests

### Unit Tests
Unit tests can be run directly with Node:
```bash
node tests/tts/unit/ttsPolicy.test.js
```

### Integration Tests
Integration tests require the backend server to be running on port 3001.

1. Start the server:
```bash
npm run dev
```

2. Run the integration suite:
```bash
node tests/tts/integration/tts-flow.test.js
```

## Test Coverage

### TTS Integration (`tts-flow.test.js`)
Verifies:
- **Session Lifecycle**: Create session -> Host Init -> Listener Join.
- **Engine Routing**: Ensures native Google voices (`Neural2`) are routed to the `chirp3_hd` engine.
- **Normalization**: Verifies shorthand names like `es-Neural2-A` are correctly expanded.
- **Fallbacks**: Verifies that Spanish Gemini requests fall back to Neural2 when Studio voices are unavailable.
- **Authentication**: Verifies API Key vs Service Account usage.
