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
- **Tier Splitting**: Inventory is split by family/model to show accurate coverage:
    - `elevenlabs_v3`: High-fidelity, 75+ languages.
    - `elevenlabs_turbo` / `elevenlabs_flash`: Low-latency, 29 languages.
- **Format**: Each physical voice is expanded into separate entries for each supported tier in the inventory.

---

## 4. Voice Management Workflow

### Adding a New Voice
1.  **Pull Inventory**: `node tts/inventory/cli.js pull --provider=all`
2.  **Find Voice ID**: Locate the voice in `backend/tts/inventory/snapshots/{provider}/{date}.json`.
    - Format: `provider:family:locale:base`
    - Example: `elevenlabs:elevenlabs_v3:-:21m00Tcm4TlvDq8ikWAM`
3.  **Update Catalog**: Add entry to `backend/tts/voiceCatalog/catalogs/{provider}.json`.
4.  **Validate**: `node tts/inventory/cli.js validate --provider={provider}`

### Voice Resolution
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
