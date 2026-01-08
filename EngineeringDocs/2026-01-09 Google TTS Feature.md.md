# Exbabel — Feat/Google TTS Integration
**Last updated:** 2026-01-08 (America/Chicago)

This is a running "what is done" document capturing what we changed, why, and where we are now regarding the Google Text-to-Speech integration.
**Newest items are at the top.**

---

## 0) BUG FIXES (Resolved Issues)
**Most recent at the top.**

---

### BUG 2: FIXED — TTS Audio Playback & Locale Errors
**Status:** ✅ RESOLVED

Resolved issues preventing audio from playing in the browser after successful backend synthesis.

#### Key Fixes:
1.  **WebSocket Routing (Frontend):** Corrected `ListenerPage.jsx` to route `tts/*` messages to `TtsPlayerController`. Previously, audio blobs were arriving but never reaching the playback logic.
2.  **Locale Normalization (Backend):** Implemented `_normalizeLanguageCode` in `GoogleTtsService` to convert short codes (e.g., `'es'`) to the full locale format (e.g., `'es-ES'`) required by the Google API.

---

### BUG 1: FIXED — Spanish TTS "Gemini" Voice Error
**Status:** ✅ RESOLVED

Resolved `INVALID_ARGUMENT` and `PERMISSION_DENIED` errors when requesting "Studio" voices for Spanish.

#### Key Fixes:
1.  **Language-Aware Engine Routing:** Pattern detection in `websocketHandler.js` now routes Google native voices (Neural2, Studio, etc.) to the `chirp3_hd` engine.
2.  **Persona Fallback (Kore -> Neural2):** Spanish "Kore" requests automatically fallback to `es-ES-Neural2-A`.
3.  **Library Upgrade:** Upgraded `@google-cloud/text-to-speech` to `^6.4.0` to support `modelName`.
4.  **Voice Normalization:** Automated correction of shorthand voice names.

---

## 1) What we did (feature updates / changes)

### 2026-01-08 — PR 2: Google TTS Unary Synthesis
**Status:** ✅ IMPLEMENTED - Backend can synthesize audio blobs

Implemented Google TTS unary synthesis for the Gemini tier, allowing the backend to return audio blobs for finalized segments.

**Key Changes:**
- **Backend Implementation:** Added `@google-cloud/text-to-speech` and implemented `GoogleTtsService.synthesizeUnary`.
- **Quota Enforcement:** Created a server-authoritative quota system in `ttsQuota.js` (defaulting to 100k chars/session).
- **WebSocket Integration:** Wired `tts/synthesize` command with policy and quota checks.
- **Frontend Playback:** Implemented audio decoding (Base64 to Blob) and HTMLAudioElement playback in `TtsPlayerController`.

**Where implemented:**
- **Backend:** `backend/tts/ttsService.js`, `backend/tts/ttsQuota.js`, `backend/websocketHandler.js`
- **Frontend:** `frontend/src/tts/TtsPlayerController.js`, `frontend/src/components/TtsPanel.jsx`

---

### 2026-01-08 — PR 1: TTS Feature Flags + Scaffolding
**Status:** ✅ IMPLEMENTED - Core structure and flags in place

Implemented the complete scaffolding for Google TTS integration, supporting both unary and streaming modes behind feature flags.

**Key Changes:**
- **Module Structure:** Created `backend/tts/` and `frontend/src/tts/` modules.
- **Feature Flags:** Added `TTS_ENABLED_DEFAULT` (backend) and `VITE_TTS_UI_ENABLED` (frontend).
- **Control Panel:** Created `TtsPanel.jsx` UI component for managing settings (Voice, Mode, Play/Stop).
- **WebSocket Handlers:** Initial `tts/start` and `tts/stop` command management.

**Where implemented:**
- **Backend:** `backend/tts/index.js`, `backend/tts/ttsPolicy.js`, `backend/tts/tts.types.js`
- **Frontend:** `frontend/src/tts/types.js`, `frontend/src/components/TtsPanel.jsx`

---

## 2) Where we are now (implementation status)

### ✅ Implemented
- **Scaffolding:** Feature flags, policy engine, and WebSocket command architecture.
- **Unary synthesis:** Functional Google TTS integration for the Gemini tier.
- **Voice Fallback:** Intelligent mapping for non-English languages.
- **Audio Playback:** Frontend queuing and playback for unary audio chunks.

### 🔍 Known / Remaining
- **Streaming Mode:** Currently returns `NOT_IMPLEMENTED`.
- **Tier Support:** Only Gemini tier is implemented; `chirp_hd` and `custom_voice` are pending.
- **Persistence:** Usage tracking is currently in-memory (Map); database persistence is next.

---

## 3) What's next (highest-confidence plan)

### Next Step A — Auto-synthesis Integration
**Goal:** Automatically trigger synthesis for finalized segments without manual "Speak" clicks.
- Integrate `TtsPlayerController` logic into the main translation commit loop.

### Next Step B — Database-backed Usage Tracking
**Goal:** Persist `tts_usage_events` to a database table to support multi-node scaling and accurate billing.

### Next Step C — Streaming Synthesis Support (PR 6)
**Goal:** Implement real-time streaming audio for lower latency.

---

## 4) Constraints and guiding principles

- **Safety First:** All TTS functionality MUST remain behind feature flags.
- **Cost Control:** Server-authoritative quota enforcement is mandatory.
- **Audio Constraints:** MP3 for unary synthesis; PCM/OGG for streaming (Google API requirement).
- **Surgical Edits:** Prefer specific, documented changes over broad refactors.

---

**END OF DOCUMENT**
