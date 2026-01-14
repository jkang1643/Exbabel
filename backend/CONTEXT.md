🔴 CONTEXT: REALTIME TRANSLATION PIPELINE BUG (HOST MODE + LISTENER MODE)

I am working on a real-time speech → transcription → translation system (English → Spanish) with:

Host mode (speaker view)

Listener mode (audience view per target language)

Streaming partials + finals

Google Speech for STT

OpenAI Realtime API for translation

Very complex gating, recovery, deduplication, forced-final, quarantine, and buffering logic

⚠️ IMPORTANT CONSTRAINT
I cannot refactor or remove:

recovery gates

deduplication logic

forced-final buffers

quarantine cooldowns

partial tracker behavior

segmenter logic

history logic

All fixes must be surgical, minimal, and not risk regressions in:

partial leakage

duplicate segments

recovery correctness

