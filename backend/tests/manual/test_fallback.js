import { resolveTtsRoute } from '../../tts/ttsRouting.js';

const route = resolveTtsRoute({ requestedTier: 'gemini', languageCode: 'es-ES' });
console.log('Spanish gemini fallback:', JSON.stringify(route, null, 2));
