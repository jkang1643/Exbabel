# TTS Module

Text-to-Speech integration for Exbabel, supporting both unary (batch) and streaming synthesis modes.

## Overview

This module provides a unified interface for TTS synthesis with Google Cloud Text-to-Speech API. It supports:

- **Unary synthesis**: Returns one complete audio file per segment (MP3, OGG_OPUS, LINEAR16, etc.)
- **Streaming synthesis**: Returns audio chunks in real-time for low latency (PCM, OGG_OPUS, ALAW, MULAW)

## Important: Streaming Format Constraints

**Why streaming excludes MP3:**

Google TTS API does not support MP3 encoding for streaming synthesis. This is a technical limitation of the MP3 codec, which requires the entire audio stream to be encoded at once to generate proper headers and frame structure.

**Separate config variables:**

We maintain separate configuration variables for unary and streaming formats:
- `TTS_AUDIO_FORMAT_UNARY`: Can be MP3, OGG_OPUS, LINEAR16, ALAW, MULAW, or PCM
- `TTS_AUDIO_FORMAT_STREAMING`: Can be PCM, OGG_OPUS, ALAW, or MULAW (NO MP3)

This prevents runtime errors and makes the constraint explicit in configuration.

## Module Structure

```
backend/tts/
├── tts.types.js       # Type definitions, enums, validation helpers
├── ttsPolicy.js       # Tier/voice eligibility, org feature flags
├── ttsService.js      # Service abstraction (unary + streaming)
├── ttsUsage.js        # Usage tracking for billing/compliance
├── index.js           # Factory and exports
└── README.md          # This file
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

// Streaming synthesis
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

### PR1 (Current): Scaffolding
- ✅ Type definitions and enums
- ✅ Policy validation (stubbed)
- ✅ Service abstraction (stubbed)
- ✅ Usage tracking (stubbed)
- ✅ WebSocket command handlers (scaffold)

### PR2 (Next): Backend TTS
- ⏳ Google TTS API integration
- ⏳ Unary synthesis implementation
- ⏳ Streaming synthesis implementation
- ⏳ Retry logic and fallback

### PR3: Frontend Player
- ⏳ Audio playback in TtsPlayerController
- ⏳ Auto-synthesis on finalized segments
- ⏳ Queue management and sequential playback

### PR4: Tier Enforcement
- ⏳ Full subscription-based tier resolution
- ⏳ Voice-language-tier matrix validation
- ⏳ Admin defaults per language

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
