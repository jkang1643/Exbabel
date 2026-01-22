# TTS Module

Text-to-Speech integration for Exbabel, supporting both unary (batch) and streaming synthesis modes.

## Overview

This module provides a unified interface for TTS synthesis with Google Cloud Text-to-Speech API. It supports:

- **Unary synthesis**: Returns one complete audio file per segment (MP3, OGG_OPUS, LINEAR16, etc.)
- **Streaming synthesis**: Returns audio chunks in real-time for low latency (PCM, OGG_OPUS, ALAW, MULAW)

## Operations Guide

A comprehensive guide for managing voices, inventories, and catalogs is available in [MANUAL.md](./MANUAL.md).

### Quick Command Reference

```bash
# Fetch latest inventory
node tts/inventory/cli.js pull --provider=all

# Compare snapshots
node tts/inventory/cli.js diff --provider=google_cloud_tts --from=prev --to=latest

# Generate coverage report
node tts/inventory/cli.js report --provider=all

# Validate catalog against inventory
node tts/inventory/cli.js validate --provider=google_cloud_tts
```

## Voice ID Format (PR4.1)

Stable identifier: `${provider}:${family}:${localeOrDash}:${baseOrId}`

**Examples:**
- `google_cloud_tts:chirp3_hd:en-US:Kore`
- `gemini:gemini_tts:-:Kore`
- `elevenlabs:eleven_all:-:21m00Tcm4TlvDq8ikWAM`

**Why:**
- Globally unique across all providers
- Survives provider API changes
- Enables safe defaults migration

## Voice Naming Conventions

### Gemini (tier: `gemini`)
- Format: `Kore`, `Puck`, `Charon`, etc.
- Multilingual (supports all languages)
- Model: `gemini-2.5-flash-tts`
- Voice ID: `gemini:gemini_tts:-:Kore`

### Chirp3-HD (tier: `chirp3_hd`)
- Format: `{locale}-Chirp3-HD-{voice}`
- Example: `en-US-Chirp3-HD-Kore`
- Locale-specific
- Voice ID: `google_cloud_tts:chirp3_hd:en-US:Kore`

### Neural2 (tier: `neural2`)
- Format: `{locale}-Neural2-{variant}`
- Example: `en-US-Neural2-A`
- Locale-specific
- Voice ID: `google_cloud_tts:neural2:en-US:A`

### Standard (tier: `standard`)
- Format: `{locale}-Standard-{variant}`
- Example: `en-US-Standard-A`
- Locale-specific
- Voice ID: `google_cloud_tts:standard:en-US:A`

### ElevenLabs (tiers: `elevenlabs`, `elevenlabs_v3`, `elevenlabs_turbo`, `elevenlabs_flash`)
- Format: Voice ID string (e.g., `21m00Tcm4TlvDq8ikWAM`)
- Multilingual (supports all languages)
- Same voice works across multiple tiers (different models)
- Voice ID: `elevenlabs:eleven_all:-:21m00Tcm4TlvDq8ikWAM`

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
├── voiceCatalog.js           # PR4: Legacy wrapper (re-exports from voiceCatalog/)
├── voiceCatalog/             # PR4.1: Modular catalog system
│   ├── index.js              # Main catalog API
│   ├── catalogLoader.js      # JSON catalog loader
│   ├── catalogSchema.js      # Schema validation
│   ├── catalogValidate.js    # Catalog-to-inventory validation
│   └── catalogs/             # Curated voice catalogs
│       ├── gemini_tts.json
│       ├── google_chirp3_hd.json
│       ├── google_neural2.json
│       ├── google_standard.json
│       └── elevenlabs.json
├── voiceResolver.js          # PR4: Voice selection precedence
├── ttsTierHelper.js          # PR4: Tier gating helper (stub)
├── ttsMetering.js            # PR4: Metering event builder (stub)
├── inventory/                # PR4.1: Provider inventory tracking
│   ├── cli.js                # CLI tool (pull, diff, report)
│   ├── diff.js               # Snapshot diff engine
│   ├── report.js             # Coverage report generator
│   ├── snapshotStoreFs.js    # Filesystem snapshot storage
│   ├── providers/            # Inventory collectors
│   │   ├── googleCloudTts.js
│   │   ├── elevenLabs.js
│   │   └── geminiDocs.js
│   ├── snapshots/            # Stored inventory snapshots
│   └── sources/              # Static source files (Gemini)
│       └── gemini_voices.json
├── defaults/
│   ├── defaultsStore.js      # PR4: Interface selector
│   └── defaultsStoreJson.js  # PR4: JSON file storage (supports voiceId)
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
- ✅ Server-authoritative voice catalog (Gemini + Chirp3-HD + Neural2 + Standard + ElevenLabs)
- ✅ Voice filtering by language and tier
- ✅ Voice resolution with precedence (user → org → catalog → fallback)
- ✅ Org defaults storage (JSON file, atomic operations)
- ✅ WebSocket commands: `tts/list_voices`, `tts/get_defaults`, `tts/set_default`
- ✅ Server-side voice resolution in `tts/synthesize`
- ✅ Metering stub (debug logging only)
- ✅ Unit tests (voice catalog + resolver)

### PR4.1: Voice Inventory + Catalog Refactor
- ✅ Provider inventory system (Google Cloud TTS, ElevenLabs, Gemini)
- ✅ Snapshot storage with atomic writes
- ✅ Inventory CLI (pull, diff, report commands)
- ✅ Diff engine for snapshot comparison
- ✅ Coverage report generator
- ✅ Catalog refactor to JSON-based loading
- ✅ Stable voiceId format (`provider:family:locale:base`)
- ✅ Locale fallback matching (exact → base → multilingual → English)
- ✅ Catalog validation against inventory snapshots
- ✅ Backward-compatible defaults store (supports voiceId + voiceName)

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

PR4.1 feature flags:
- `TTS_VOICE_INVENTORY_TOOLS_ENABLED`: Enable inventory CLI tools (default: false)
- `TTS_VOICE_INVENTORY_ADMIN_ENABLED`: Enable admin WS commands (default: false)
