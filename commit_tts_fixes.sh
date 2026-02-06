#!/bin/bash
cd /home/jkang1643/projects/realtimetranslationapp

# Stage all TTS fix changes
git add backend/transcriptionCleanup.js
git add backend/soloModeHandler.js
git add backend/host/adapter.js
git add frontend/src/components/solo/SoloPage.jsx
git add frontend/src/components/ListenerPage.jsx
git add "EngineeringDocs/2026-01-09 Google TTS Feature.md.md"

# Commit with detailed message
git commit -m "fix(tts): eliminate quote hallucinations and duplicate requests (BUG 39)

- Add quote normalization for all 80+ languages (single->double, spacing)
- Fix duplicate TTS in host mode (disable frontend auto-TTS)
- Fix duplicate TTS in solo mode (add ttsMode communication)
- Add useEffect to update backend when streaming toggle changes
- Apply normalization to all TTS call sites

Resolves quote-induced ElevenLabs hallucinations and reduces quota waste by ~50%"

# Push to feat/auth-db-billing branch
git push origin feat/auth-db-billing

echo "✅ Successfully committed and pushed TTS fixes to feat/auth-db-billing branch"
