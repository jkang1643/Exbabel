# Exbabel — Feat/Google TTS Integration
**Last updated:** 2026-01-09 (America/Chicago)

This is a running "what is done" document capturing what we changed, why, and where we are now regarding the Google Text-to-Speech integration.
**Newest items are at the top.**

---

## 0) BUG FIXES (Resolved Issues)
**Most recent at the top.**

---

### BUG 8: FIXED — Gemini Persona Routing & Audio Collision Prevention
**Status:** ✅ RESOLVED (2026-01-12)

Resolved issues where Gemini persona voices (Kore, Aoede, etc.) would fail in non-English locales and prevented "simultaneous playback" where multiple audio streams would overlap.

#### Root Cause:
1. **Engine/Tier Mismatch:** Gemini personas were being incorrectly forced into the Chirp 3 HD engine wrapper or passed to the API with missing locale mappings, causing hangs or errors.
2. **Delayed Audio Overlap:** Slow synthesis responses (especially from Gemini) would arrive after a newer request had already started, causing both audio clips to play at the same time.
3. **Incomplete Voice List:** Users only had access to 6 Gemini personas, missing the full "Studio" range available in the API.

#### Key Fixes:
1.  **Request Sequence Tracking:** Implemented `lastRequestId` in `TtsPlayerController.js`. The frontend now ignores any audio response that doesn't match the most recent request ID, effectively killing out-of-order "ghost" audio.
2.  **Intelligent Engine Switching:** Updated `ttsRouting.js` to automatically switch between `GEMINI_TTS` (for personas) and `CHIRP3_HD` (for Studio/Neural2 voices) regardless of the tier selected, ensuring the best engine is always used.
3.  **Expanded Voice Personas:** Built out the full list of 30+ Gemini personas in `config/ttsVoices.js` and consolidated them with language-specific "Studio" voices in the UI.
4.  **Backend Response Logging:** Added audio size logging to `GoogleTtsService` to verify successful data return during debugging.

---

### BUG 7: FIXED — WebSocket Disconnects & Proxy Enforcement
**Status:** ✅ RESOLVED

Resolved persistent "Disconnected" errors and `404 Not Found` API failures in Host Mode by enforcing strict proxy usage through Vite.

#### Root Cause:
1. **IPv6 Resolution Ambiguity:** Browsers were resolving `localhost` to IPv6 (`::1`) while the Node backend listened on IPv4 (`127.0.0.1`), causing `ECONNREFUSED` or immediate disconnects (Close Code 1006).
2. **Proxy Bypass:** Host and Listener pages were hardcoding direct backend URLs (e.g., `ws://localhost:3001`), bypassing the Vite development proxy. This triggered browser security restrictions and cross-origin issues.
3. **Missing Proxy Rules:** The Vite proxy only handled `/translate` and `/api`, missing the critical `/session` endpoints used by Host Mode.
4. **Logic Crash:** A missing `DEBUG` variable in `useWebSocket.js` caused a runtime crash during connection attempts.

#### Key Fixes:
1.  **Vite Proxy Architecture:**
    -   Configured `server.proxy` in `vite.config.js` to route all `/translate` (WS), `/api` (HTTP), and `/session` (HTTP) traffic to `127.0.0.1:3001`.
    -   Standardized on `127.0.0.1` everywhere to eliminate IPv6 ambiguity.
2.  **Relative URLs:** Updated `HostPage.jsx` and `ListenerPage.jsx` to use relative paths (e.g., `ws://${window.location.host}/translate`), ensuring all traffic flows through the proxy.
3.  **Crash Fix:** Removed the undefined `DEBUG` check in `useWebSocket.js`.

---

### BUG 6: 🟢 RESOLVED — Google TTS Identity & Project Alignment
- **Status:** RESOLVED
- **Root Cause:**
  1. `GoogleTtsService` was prioritizing `GOOGLE_SPEECH_API_KEY` over `GOOGLE_APPLICATION_CREDENTIALS`. Since API Keys are tied to projects but do not provide an identity (Service Account), Vertex AI calls for Gemini/Chirp voices defaulted to the API key's project (the old managed project `222662040787`) and failed.
  2. Multiple utility scripts had the old project number `222662040787` hardcoded as a fallback.
- **Resolution:**
  1. Updated `GoogleTtsService._initClient()` to prioritize `GOOGLE_APPLICATION_CREDENTIALS`. Advanced voices now correctly use the service account identity from `exbabel-tts-prod`.
  2. Standardized environment variables: Now prefers `GOOGLE_PROJECT_ID` across all services.
  3. Updated `backend/googleSpeechStream.js` and all `backend/scripts/` to use dynamic project resolution.
  4. Verified that PhraseSets now correctly target `projects/exbabel-tts-prod/...`.
- **Outcome:** Gemini and Chirp 3 HD voices now authenticate correctly against the new project. No more `PERMISSION_DENIED` errors on the old resource!

#### Current state:
- Implemented graceful fallback to `neural2` so synthesis doesn't crash.
- Added explicit `reason` visibility in the frontend.
- Added support for `GOOGLE_PROJECT_ID` and `GOOGLE_TTS_API_ENDPOINT` in `GoogleTtsService` for project disambiguation.

---

### BUG 5: FIXED — TTS Routing Logic Flaws & Tier Mismatch
**Status:** ✅ RESOLVED

Fixed critical flaws in the TTS routing logic where user-selected voices (Chirp3 HD, Standard) were being incorrectly routed or forced to Neural2 fallbacks.

#### Root Cause:
1. **Engine-to-Tier Mapping Lag:** The backend `ttsService.js` was incorrectly mapping the `CHIRP3_HD` engine to the `neural2` tier by default.
2. **Forced Neural2 Fallback:** The `_resolveVoice` function in `ttsRouting.js` contained logic that forced `chirp3_hd` requests to use `neural2` discovery and mappings.
3. **Frontend Tier Ignorance:** The `TtsPanel.jsx` component was hardcoding `tier: 'gemini'` for all synthesis requests, regardless of whether the user selected a Chirp3, Neural2, or Standard voice.

#### Key Fixes:
1. **Unified Mapping Matrix:** Generated a comprehensive mapping of 80+ language locales to their specific `neural2`, `standard`, and `chirp3_hd` voice names in `ttsRouting.js`.
2. **Backend Engine Correction:** Updated `_tierFromEngine` in `ttsService.js` to correctly distinguish between `chirp3_hd` and `neural2` tiers.
3. **Routing Refactor:** Rewrote `_resolveVoice` to correctly handle all tiers based on user selection, respecting the requested tier before falling back.
4. **Metadata-Driven UI:** Updated `TtsPanel.jsx` to include explicit `tier` metadata for every voice option and propagated this tier to the synthesis request.
5. **Controller Overrides:** Added tier override support to `speakTextNow` in `TtsPlayerController.js`.

#### Impact:
- ✅ **Chirp3 HD** voices can now be selected and heard correctly.
- ✅ **Standard** voices are correctly routed using the standard tier instead of falling back.
- ✅ **Automatic Tier Discovery:** The system now intelligently picks the right tier based on the user's selected voice.
- ✅ **Expanded Language Support:** Support for over 80 language locales added via the comprehensive mapping matrix.

---

### BUG 4: FIXED — "Speak Last Final Segment" Button Data Structure Mismatch
**Status:** ✅ RESOLVED

Fixed the "Speak Last Final Segment" button in the TTS panel that was failing to find and speak real transcript segments despite translations being present in the history.

#### Root Cause:
The TTS panel logic was checking for translation object properties that didn't match the actual data structure used by the ListenerPage. The code expected `text`/`translatedText` properties, but the actual translation history used `original`/`translated` properties.

#### Key Fixes:
1. **Data Structure Analysis:** Identified that translation history entries have `original` and `translated` properties (from auto-segmented final translations) rather than `text` and `translatedText` properties (from manual FINAL messages).
2. **Logic Correction:** Updated `TtsPanel.jsx` segment detection logic to properly handle both data structure types:
   - Auto-segmented entries: `{original, translated, timestamp, seqId, ...}`
   - Manual entries: `{text, translatedText, originalText, ...}`
3. **Property Priority:** Implemented fallback logic prioritizing translated text over original text for TTS synthesis.
4. **Debug Infrastructure:** Added comprehensive console logging to troubleshoot data flow issues between ListenerPage and TtsPanel components.

#### Impact:
- ✅ "Speak Last Final Segment" button now correctly identifies and speaks the most recent final translation
- ✅ TTS can now synthesize real transcript content instead of only test strings
- ✅ Improved debugging capabilities for future TTS-related issues

---

### BUG 3: FIXED — Language Switching and Translation Routing
**Status:** ✅ RESOLVED

Resolved critical issues preventing proper translation delivery when listeners switched languages dynamically. Both partial and final translations were failing for non-English/Spanish languages after language switches.

#### Key Fixes:
1. **Backend Translation Validation:** Fixed null pointer crashes in `hostModeHandler.js` when processing failed translations, which caused routing to break for all languages.
2. **Language Group Management:** Fixed `sessionStore.js` and `websocketHandler.js` to properly remove listeners from old language groups and add them to new ones during language switches.
3. **Frontend State Closure:** Fixed React closure issue in `ListenerPage.jsx` where WebSocket message handlers captured old `targetLang` values, preventing proper language filtering after switches.
4. **Translation Processing:** Ensured both partial and final translation logic uses current language state, allowing history updates to work correctly for all languages.

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

### 2026-01-13 — PR 4: Gemini-TTS Prompted Voices
**Status:** ✅ IMPLEMENTED - Integrated & Production Ready

Implemented full support for Gemini-TTS "Prompted Delivery", enabling natural language style control and Pentecostal-specific presets.

**Key Changes:**
- **Prompt Resolver:** Created `promptResolver.js` for UTF-8 safe byte validation and truncation (4000 byte prompt, 4000 byte text, 8000 combined).
- **Prompt Preset Library:** Implemented 16 high-quality presets including the "UPCI Fire Edition" (Apostolic Fire, Altar Call, Revival Meeting).
- **Intensity Modifiers:** Added 1-5 intensity scale for urgent delivery peaks.
- **SSML-to-Plain Text Extraction:** Automatic stripping of SSML tags for Gemini voices to extract clean text for `input.text`.
- **Frontend UI Refactor:** Updated `TtsPanel.jsx` to dynamically switch between SSML (Chirp) and Prompt (Gemini) controls based on selected voice. Includes real-time byte counters and warning states.
- **Usage Telemetry:** Extended `ttsUsage.js` to log prompt metadata, byte counts, and truncation events.

**Where implemented:**
- **Backend:** `backend/tts/promptResolver.js`, `backend/tts/promptPresets.js`, `backend/tts/ttsService.js`, `backend/websocketHandler.js`
- **Frontend:** `frontend/src/config/promptConfig.js`, `frontend/src/components/TtsPanel.jsx`, `frontend/src/tts/TtsPlayerController.js`

---

### 2026-01-13 — PR 3: Chirp 3 HD SSML Dynamic Prosody
**Status:** ✅ INTEGRATED - Production Ready

Implemented the "Dynamic Prosody Engine" for Chirp 3 HD voices, enabling sermon-style delivery with variable pacing and emphasis.

**Key Changes:**
- **Dynanmic Prosody Engine:** Created `ssmlBuilder.js` with phrase-level tokenization and semantic analysis.
- **Hybrid Prosody:** Implemented strategy using `audioConfig.speaking_rate` for speed control + SSML tags for phrase dynamics (working around Chirp 3 API limitations).
- **XML Entity Handling:** Fixed critical bug where tokenizer split escaped characters (like `&apos;`), ensuring robust multi-language support.
- **Delivery Presets:** Added "Standard Preaching", "Pentecostal", "Teaching" styles.

**Where implemented:**
- **Backend:** `backend/tts/ssmlBuilder.js`, `backend/tts/ttsService.js`
- **Frontend:** `frontend/src/config/ssmlConfig.js`

---

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
- **Gemini Prompted Delivery:** Natural language style control with presets and intensity (PR 4).
- **Chirp 3 Dynamic Prosody:** Phrase-level rate/pitch variation for preaching styles (PR 3).
- **Scaffolding:** Feature flags, policy engine, and WebSocket command architecture.
- **Unary synthesis:** Functional Google TTS integration for multiple tiers.
- **Voice Routing:** Robust routing for Gemini, Chirp3 HD, Neural2, and Standard tiers.
- **Voice Tiering:** 4-tier hierarchy (Ultra HD, Premium, HD, Standard).
- **Smart Truncation:** Real-time UTF-8 byte validation for prompt/text payloads.
- **Audio Playback:** Frontend queuing and playback for unary audio chunks.

### 🔍 Known / Remaining
- **Comprehensive Testing:** Frontend/Backend unit tests for prompted synthesis.
- **Auto-synthesis Integration:** Hooking synthesis into the main translation loop.
- **Persistence:** Usage tracking currently in-memory.
- **Streaming Mode:** Currently returns `NOT_IMPLEMENTED`.

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
