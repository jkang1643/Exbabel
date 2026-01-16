import { resolveTtsRoute } from '../../tts/ttsRouting.js';

async function test() {
  console.log('Testing corrected voice routing...');

  const routeZh = await resolveTtsRoute({ requestedTier: 'neural2', languageCode: 'zh' });
  console.log('Chinese (zh) route:', {
    voice: routeZh.voiceName,
    language: routeZh.languageCode,
    tier: routeZh.tier
  });

  const routeJa = await resolveTtsRoute({ requestedTier: 'neural2', languageCode: 'ja' });
  console.log('Japanese (ja) route:', {
    voice: routeJa.voiceName,
    language: routeJa.languageCode,
    tier: routeJa.tier
  });

  const routeEs = await resolveTtsRoute({ requestedTier: 'chirp3_hd', languageCode: 'es' });
  console.log('Spanish Chirp3 route:', {
    voice: routeEs.voiceName,
    language: routeEs.languageCode,
    tier: routeEs.tier
  });
}

test();
