
import dotenv from 'dotenv';
import { GoogleTtsService } from './tts/ttsService.js';
import { TtsEngine, TtsEncoding } from './tts/tts.types.js';

dotenv.config();

async function runReproduction() {
    console.log('--- Starting Gemini TTS Bug Reproduction ---');

    const service = new GoogleTtsService();

    // Simulate first request (Spanish Gemini)
    const request = {
        text: '¡Hola! Este es un mensaje de prueba.',
        profile: {
            engine: TtsEngine.GEMINI_TTS,
            languageCode: 'es-ES',
            voiceName: 'Kore',
            modelName: 'gemini-2.5-flash-tts',
            encoding: TtsEncoding.MP3,
            streaming: false
        },
        promptPresetId: 'support_agent_calm',
        intensity: 3
    };

    console.log('\n--- 1. First Request (Simulating Fallback: Gemini -> Neural2) ---');
    try {
        // We'll mock the client.synthesizeSpeech to see the final payload
        await service._initClient();
        const originalSynthesize = service.client.synthesizeSpeech;
        let callCount = 0;

        service.client.synthesizeSpeech = async (payload) => {
            callCount++;
            console.log(`\n[REPRODUCTION] client.synthesizeSpeech call #${callCount} with payload:`);
            console.log(JSON.stringify(payload, (key, value) => {
                if (key === 'audioContent') return '<audio data>';
                return value;
            }, 2));

            if (callCount === 1) {
                console.log('[REPRODUCTION] Simulating Gemini failure (INVALID_ARGUMENT)');
                const error = new Error('INVALID_ARGUMENT: Voice Kore not supported for es-ES');
                error.code = 3;
                throw error;
            }

            console.log('[REPRODUCTION] Simulating Neural2 success');
            // Return a mock response
            return [{
                audioContent: Buffer.from('mock audio')
            }];
        };

        const result = await service.synthesizeUnary(request);
        console.log('\n[REPRODUCTION] Result received from synthesizeUnary');

        // Restore original for next test if needed
        service.client.synthesizeSpeech = originalSynthesize;

    } catch (error) {
        console.error('\n[REPRODUCTION] Error during reproduction:', error);
    }

    console.log('\n--- Reproduction Finished ---');
}

runReproduction().catch(console.error);
