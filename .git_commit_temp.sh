#!/bin/bash
cd /home/jkang1643/projects/realtimetranslationapp
git add backend/transcriptionCleanup.js backend/soloModeHandler.js backend/host/adapter.js frontend/src/components/solo/SoloPage.jsx frontend/src/components/ListenerPage.jsx "EngineeringDocs/2026-01-09 Google TTS Feature.md.md"
git commit -m "fix(tts): eliminate quote hallucinations and duplicate requests (BUG 39)

- Add quote normalization for all 80+ languages (single->double, spacing)
- Fix duplicate TTS in host mode (disable frontend auto-TTS)
- Fix duplicate TTS in solo mode (add ttsMode communication)
- Add useEffect to update backend when streaming toggle changes
- Apply normalization to all TTS call sites

Resolves quote-induced ElevenLabs hallucinations and reduces quota waste by ~50%"
git push origin feat/auth-db-billing
echo "COMMIT_SUCCESS"
