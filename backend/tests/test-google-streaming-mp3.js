
import { v1beta1 } from '@google-cloud/text-to-speech';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

async function testGoogleStreaming() {
    console.log('--- Google TTS Streaming MP3 Test ---');

    // Check credentials
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_SPEECH_API_KEY) {
        console.error('❌ Credentials missing. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SPEECH_API_KEY');
        return;
    }

    const client = new v1beta1.TextToSpeechClient();
    const stream = client.streamingSynthesize();

    let chunksReceived = 0;
    let errorReceived = null;

    stream.on('data', (response) => {
        if (response.audioContent && response.audioContent.length > 0) {
            chunksReceived++;
            if (chunksReceived === 1) {
                console.log('✅ Received first audio chunk!');
            }
        }
    });

    stream.on('error', (err) => {
        console.error('❌ Stream error:', err.message);
        errorReceived = err;
    });

    stream.on('end', () => {
        console.log(`--- Test ended. Chunks received: ${chunksReceived} ---`);
    });

    console.log('Sending config and text...');

    try {
        // Step 1: Send streaming config
        stream.write({
            streamingConfig: {
                voice: {
                    languageCode: 'en-US',
                    name: 'en-US-Chirp3-HD-Kore'
                },
                audioConfig: {
                    audioEncoding: 'MP3',
                    sampleRateHertz: 24000
                }
            }
        });

        // Step 2: Send input text
        stream.write({
            input: { text: 'This is a test of Google Text-to-Speech streaming with MP3 encoding.' }
        });

        // Step 3: End input
        stream.end();

        // Wait a bit for results
        await new Promise(resolve => setTimeout(resolve, 5000));

        if (errorReceived) {
            console.log('\nCONCLUSION: Google streaming DOES NOT support MP3 (or failed for another reason).');
        } else if (chunksReceived > 0) {
            console.log('\nCONCLUSION: Google streaming DOES support MP3! 🎉');
        } else {
            console.log('\nCONCLUSION: No chunks received and no error? Check logs/credentials.');
        }

    } catch (err) {
        console.error('❌ Synchronous error:', err.message);
    }
}

testGoogleStreaming();
