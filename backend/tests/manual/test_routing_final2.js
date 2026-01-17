import { resolveTtsRoute } from '../../tts/ttsRouting.js';

async function test() {
  console.log('Testing TTS routing after circular import fix...');

  const route = await resolveTtsRoute({ requestedTier: 'neural2', languageCode: 'es' });
  console.log('Spanish route:', {
    voice: route.voiceName,
    language: route.languageCode,
    tier: route.tier
  });
}

test();
