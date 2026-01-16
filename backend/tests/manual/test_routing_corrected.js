import { resolveTtsRoute } from '../../tts/ttsRouting.js';

async function test() {
  console.log('Testing corrected voice routing...');

  const routeJa = await resolveTtsRoute({ requestedTier: 'neural2', languageCode: 'ja' });
  console.log('Japanese neural2:', routeJa.voiceName);

  const routeZh = await resolveTtsRoute({ requestedTier: 'neural2', languageCode: 'zh' });
  console.log('Chinese neural2:', routeZh.voiceName);

  const routeDe = await resolveTtsRoute({ requestedTier: 'neural2', languageCode: 'de' });
  console.log('German neural2:', routeDe.voiceName);

  const routeAr = await resolveTtsRoute({ requestedTier: 'neural2', languageCode: 'ar' });
  console.log('Arabic neural2:', routeAr.voiceName);
}

test();
