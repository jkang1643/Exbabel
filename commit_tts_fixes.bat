@echo off
cd /d \\wsl.localhost\Ubuntu\home\jkang1643\projects\realtimetranslationapp
git add backend/transcriptionCleanup.js
git add backend/soloModeHandler.js
git add backend/host/adapter.js
git add frontend/src/components/solo/SoloPage.jsx
git add frontend/src/components/ListenerPage.jsx
git add "EngineeringDocs/2026-01-09 Google TTS Feature.md.md"
git commit -m "fix(tts): eliminate quote hallucinations and duplicate requests (BUG 39)" -m "- Add quote normalization for all 80+ languages (single->double, spacing)" -m "- Fix duplicate TTS in host mode (disable frontend auto-TTS)" -m "- Fix duplicate TTS in solo mode (add ttsMode communication)" -m "- Add useEffect to update backend when streaming toggle changes" -m "- Apply normalization to all TTS call sites" -m "" -m "Resolves quote-induced ElevenLabs hallucinations and reduces quota waste by ~50%%"
echo.
echo Commit complete! Now checking out feat/auth-db-billing branch...
git checkout feat/auth-db-billing
echo.
echo Done! You can now push with: git push origin feat/auth-db-billing
pause
