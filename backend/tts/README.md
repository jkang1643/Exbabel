# TTS Module

Text-to-Speech integration for Exbabel, supporting both unary (batch) and streaming synthesis modes.

## Overview

This module provides a unified interface for TTS synthesis with Google Cloud Text-to-Speech API. It supports:

- **Unary synthesis**: Returns one complete audio file per segment (MP3, OGG_OPUS, LINEAR16, etc.)
- **Streaming synthesis**: Returns audio chunks in real-time for low latency (PCM, OGG_OPUS, ALAW, MULAW)

## Voice Naming Conventions

### Gemini Voices (tier: `gemini`)
Prebuilt voice IDs without locale prefix: `Kore`, `Puck`, `Charon`, `Leda`, `Aoede`, `Fenrir`

Example request:
```javascript
{
  voice: { 
    name: 'Kore',
    modelName: 'gemini-2.5-flash-tts'
  }
}
```

These voices work across all supported languages (multi-language capability).

### Chirp3-HD Voices (tier: `chirp3_hd`)
Pattern: `{locale}-Chirp3-HD-{voiceName}`

Examples:
- `en-US-Chirp3-HD-Kore`
- `es-ES-Chirp3-HD-Leda`
- `fr-FR-Chirp3-HD-Puck`

Example request:
```javascript
{
  voice: { 
    name: 'en-US-Chirp3-HD-Kore',
    languageCode: 'en-US',
    modelName: 'chirp-3-hd'
  }
}
```

These voices are locale-specific and must match the language code.

## Important: Streaming Format Constraints

**Why streaming excludes MP3:**

Google TTS API does not support MP3 encoding for streaming synthesis. This is a technical limitation of the MP3 codec, which requires the entire audio stream to be encoded at once to generate proper headers and frame structure.

**Separate config variables:**

We maintain separate configuration variables for unary and streaming formats:
- `TTS_AUDIO_FORMAT_UNARY`: Can be MP3, OGG_OPUS, LINEAR16, ALAW, MULAW, or PCM
- `TTS_AUDIO_FORMAT_STREAMING`: Can be PCM, OGG_OPUS, ALAW, or MULAW (NO MP3)

This prevents runtime errors and makes the constraint explicit in configuration.

**Unary vs Streaming Modes:**

| Mode | Formats | Use Case | Implementation Status |
|------|---------|----------|----------------------|
| Unary | MP3 (default), OGG_OPUS, LINEAR16, ALAW, MULAW | Complete audio file per segment | ✅ PR2 Complete |
| Streaming | PCM, OGG_OPUS, ALAW, MULAW | Real-time audio chunks | ⏳ Future PR |

Voice catalog (PR4) supports both modes, but only unary is currently implemented.

## Module Structure

```
backend/tts/
├── tts.types.js              # Type definitions, enums, validation helpers
├── ttsPolicy.js              # Tier/voice eligibility, org feature flags
├── ttsService.js             # Service abstraction (unary + streaming)
├── ttsUsage.js               # Usage tracking for billing/compliance
├── ttsRouting.js             # Provider/tier/voice routing logic
├── voiceCatalog.js           # PR4: Server-authoritative voice catalog
├── voiceResolver.js          # PR4: Voice selection precedence
├── ttsTierHelper.js          # PR4: Tier gating helper (stub)
├── ttsMetering.js            # PR4: Metering event builder (stub)
├── defaults/
│   ├── defaultsStore.js      # PR4: Interface selector
│   └── defaultsStoreJson.js  # PR4: JSON file storage
├── index.js                  # Factory and exports
└── README.md                 # This file
```

## Usage

```javascript
import { getTtsService, validateTtsRequest } from './tts/index.js';

// Validate request
const error = await validateTtsRequest({
  orgId: 'org123',
  userId: 'user456',
  tier: 'gemini',
  languageCode: 'en-US',
  voiceName: 'Kore'
});

if (error) {
  console.error('TTS request validation failed:', error);
  return;
}

// Get service instance
const ttsService = getTtsService();

// Unary synthesis
const response = await ttsService.synthesizeUnary({
  sessionId: 'session789',
  userId: 'user456',
  orgId: 'org123',
  languageCode: 'en-US',
  voiceName: 'Kore',
  tier: 'gemini',
  text: 'Hello, world!'
});

// Streaming synthesis (future)
await ttsService.synthesizeStream(
  {
    sessionId: 'session789',
    userId: 'user456',
    orgId: 'org123',
    languageCode: 'en-US',
    voiceName: 'Kore',
    tier: 'gemini',
    text: 'Hello, world!'
  },
  (chunk) => {
    console.log('Received chunk:', chunk.seq, chunk.isLast);
    // Send chunk to client via WebSocket
  }
);
```

## Implementation Status

### PR1: Scaffolding
- ✅ Type definitions and enums
- ✅ Policy validation (stubbed)
- ✅ Service abstraction (stubbed)
- ✅ Usage tracking (stubbed)
- ✅ WebSocket command handlers (scaffold)

### PR2: Backend TTS
- ✅ Google TTS API integration
- ✅ Unary synthesis implementation
- ✅ Retry logic and fallback
- ⏳ Streaming synthesis implementation

### PR3: Frontend Player
- ✅ Audio playback in TtsPlayerController
- ✅ Auto-synthesis on finalized segments
- ✅ Queue management and sequential playback

### PR4: Voice Defaults + Voice List
- ✅ Server-authoritative voice catalog (Gemini + Chirp3-HD)
- ✅ Voice filtering by language and tier
- ✅ Voice resolution with precedence (user → org → catalog → fallback)
- ✅ Org defaults storage (JSON file, atomic operations)
- ✅ WebSocket commands: `tts/list_voices`, `tts/get_defaults`, `tts/set_default`
- ✅ Server-side voice resolution in `tts/synthesize`
- ✅ Metering stub (debug logging only)
- ✅ Unit tests (voice catalog + resolver)

### PR5: Usage Logging
- ⏳ Database integration for usage events
- ⏳ Quota enforcement
- ⏳ Usage summary queries

## Configuration

See `env-template-backend.txt` for all TTS configuration options.

Required environment variables:
- `TTS_ENABLED_DEFAULT`: Feature flag (default: false)
- `TTS_PROVIDER`: Provider name (default: google)
- `TTS_MODE`: Default mode (default: unary)
- `TTS_MODEL_TIER`: Default tier (default: gemini)
- `TTS_AUDIO_FORMAT_UNARY`: Unary format (default: MP3)
- `TTS_AUDIO_FORMAT_STREAMING`: Streaming format (default: PCM)
- `TTS_PLAYING_LEASE_SECONDS`: Lease timeout (default: 30)

PR4 feature flags:
- `TTS_VOICE_CATALOG_ENABLED`: Enable voice catalog features (default: false)
- `TTS_METERING_DEBUG`: Enable metering debug logging (default: false)
