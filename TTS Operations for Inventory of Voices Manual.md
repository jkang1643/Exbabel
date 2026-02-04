# Exbabel TTS Operations Manual

This guide covers how to manage the Text-to-Speech (TTS) system, including provider inventories, curated catalogs, and voice resolution.

## 1. Architecture Overview

Exbabel uses a 3-layer architecture for TTS voices:

1.  **Inventory**: Raw data from providers (Google, ElevenLabs, Gemini).
2.  **Catalog**: Curated allowlist of voices we offer to users.
3.  **Resolver**: Runtime logic that decides which voice to use for a specific request.

---

## 2. Command Reference

All commands should be run from the `backend/` directory. The CLI tool automatically loads configuration (like your `ELEVENLABS_API_KEY`) from the `backend/.env` file.

### Pull Latest Inventory
Fetch the current list of available voices from provider APIs.
```bash
# Pull everything
node tts/inventory/cli.js pull --provider=all

# Pull specific provider
node tts/inventory/cli.js pull --provider=elevenlabs
```
*Providers: `google_cloud_tts`, `elevenlabs`, `gemini`*

### Catalog Validation
Verify that our curated catalog voices still exist in the provider's inventory and have matching metadata.
```bash
node tts/inventory/cli.js validate --provider=google_cloud_tts
```

### Compare Snapshots (Diff)
See what changed between two snapshots (e.g., added/removed voices).
```bash
node tts/inventory/cli.js diff --provider=google_cloud_tts --from=prev --to=latest
```

### Coverage Reports
Generate a summary of language and voice coverage with detailed family breakdowns.
```bash
node tts/inventory/cli.js report --provider=all
```
*Shows: Total voices, language count per family (e.g., Chirp3-HD vs Studio), and top languages.*

---

## 3. Provider Specifics

### Gemini (Vertex AI)
- **Status**: Static inventory (maintained in `backend/tts/inventory/sources/gemini_voices.json`).
- **Count**: 30 voices.
- **Coverage**: All 30 voices support **87+ languages** (full parity with Vertex AI).

### ElevenLabs
- **Authentication**: Requires `ELEVENLABS_API_KEY` in `backend/.env`.
- **Voice Count**: 23 custom church-themed voices per model family.
- **Tier Splitting**: Inventory is split by family/model to show accurate coverage:
    - `elevenlabs_v3`: High-fidelity, 75+ languages, 23 custom voices.
    - `elevenlabs_turbo` / `elevenlabs_flash`: Low-latency, 29 languages, 23 custom voices each.
    - `elevenlabs` (legacy): Multilingual model, 23 custom voices.
- **Format**: Each physical voice is expanded into separate entries for each supported tier in the inventory.
- **Note**: Pre-made ElevenLabs voices (Roger, Sarah, Laura, etc.) are excluded from catalogs.

---

## 4. End-to-End Voice Management Flow

This generalized workflow covers the lifecycle of a voice from provider discovery to production catalog availability.

### Step 1: Discovery & Ingestion (Inventory Layer)
Before a voice can be used, it must exist in the system's local inventory snapshot. This captures the provider's ground truth.
1.  **Sync Provider Data**: Fetch the latest voice list from the provider API.
    ```bash
    node tts/inventory/cli.js pull --provider={provider}
    ```
2.  **Verify Presence**: Locate the voice in the newly generated snapshot at `backend/tts/inventory/snapshots/{provider}/{date}.json`.
3.  **Note Stable ID**: Copy the `voiceId` for the specific tier/model you wish to support. 
    > [!IMPORTANT]
    > A single physical voice (e.g., ElevenLabs "Kore") may have multiple `voiceId` entries in the inventory if it supports multiple tiers (e.g., `elevenlabs_v3` vs `elevenlabs_flash`). Choose the one matching your target performance tier.

### Step 2: Quality Control (Catalog Layer)
The Catalog is our curated "storefront." Not every voice in the inventory should be in the catalog.
1.  **Select & Format**: Add the `voiceId` to the provider-specific catalog at `backend/tts/voiceCatalog/catalogs/{provider}.json`.
2.  **Map Metadata**: Ensure the catalog entry includes the correct `displayName`, `tier`, and `voiceId`.
3.  **Local Validation**: Run the validation tool to ensure the catalog remains in sync with the current inventory snapshot.
    ```bash
    node tts/inventory/cli.js validate --provider={provider}
    ```

### Step 3: Promotion & Defaults (Resolution Layer)
Once a voice is in the catalog, it is available for selection. You may now promote it as a default.
1.  **Set as Local Default**: (Optional) Update `backend/tts/defaults/org_defaults.json` or equivalent stores to use the new `voiceId` for specific languages.
2.  **Test Resolution**: Restart the server and verify that the `voiceResolver` correctly identifies the new voice when that language is requested.

### Step 4: Distribution (Client Layer)
The catalog is automatically synchronized with clients via WebSocket.
1.  **WebSocket Broadcast**: Clients receive the updated catalog upon connection or language change via `tts/voices` and `tts/defaults` messages.
2.  **UI Verification**: Confirm the new voice appears in the `ListenerPage` or `TtsPanel` dropdowns.

---

## 5. Voice Resolution
When a client requests a voice, the server resolves it in this order:
1.  **Requested VoiceId**: If the client provides a stable `voiceId`.
2.  **User Default**: Saved in defaults store.
3.  **Org Default**: Saved in `backend/tts/defaults/org_defaults.json`.
4.  **Fallback**: Usually Gemini/Kore.

---

## 5. Troubleshooting

### "Voice not found in catalog"
- Check that the `voiceId` exists in the relevant catalog JSON.
- Ensure the `tier` is allowed for that organization in `ttsPolicy.js`.

### "ElevenLabs pull failed"
- Ensure `ELEVENLABS_API_KEY` is set in `backend/.env`.
- Check network connectivity to `api.elevenlabs.io`.

### "Catalog validation failed"
- Provider snapshots are newer than your catalog. Use `diff` to find the changes and update your catalog JSON files.
