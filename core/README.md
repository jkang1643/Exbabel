# Core Engine

This directory contains the shared core engine that powers both solo mode and host mode.

## Architecture

The core engine is designed to be mode-agnostic - it processes audio and emits events, but doesn't know about WebSockets, UI, or session management. This ensures zero behavioral drift between solo and host modes.

## Directory Structure

```
/core/
  /engine/          # Core processing engines (to be created in later phases)
  /events/          # Event type definitions
  /shared/          # Shared types and configuration
  /audio/           # Audio processing (AudioBufferManager - to be moved)
  /transcription/   # STT integration (GoogleSpeechStream - to be moved)
  /translation/     # Translation services (translationManager, etc. - to be moved)
```

## Phase 1 Status

✅ **Phase 1 Complete**: Directory structure and event contract defined

- `/core/events/eventTypes.js` - Event type definitions
- `/core/shared/types/config.js` - Shared configuration constants

**No behavior changes** - This phase only establishes the foundation.

## Next Steps

Phase 2 will extract the RTT Tracker, the first component to be moved into the core engine.

