/**
 * Test Google Cloud TTS Streaming API
 * 
 * Standalone script to verify streamingSynthesize works correctly
 */

async function testGoogleStreaming() {
    const { v1beta1 } = await import('@google-cloud/text-to-speech');

    console.log('Initializing Google TTS client...');
    const client = new v1beta1.TextToSpeechClient();

    const text = "Hello, this is a test of Google Cloud Text-to-Speech streaming.";
    const voiceName = "es-ES-Chirp3-HD-Kore";
    const languageCode = "es-ES";
    const modelName = "chirp-3-hd";

    console.log('Creating streaming request...');
    console.log('Voice:', voiceName);
    console.log('Language:', languageCode);
    console.log('Model:', modelName);
    console.log('Text:', text);

    try {
        const stream = client.streamingSynthesize();

        // Track events
        stream.on('error', (err) => {
            console.error('Stream error:', err);
        });

        stream.on('end', () => {
            console.log('Stream ended');
        });

        stream.on('close', () => {
            console.log('Stream closed');
        });

        // Send streaming config
        console.log('Sending streaming config...');
        stream.write({
            streamingConfig: {
                voice: {
                    languageCode: languageCode,
                    name: voiceName
                },
                streamingAudioConfig: {
                    audioEncoding: 3, // OGG_OPUS
                    sampleRateHertz: 24000
                }
            }
        });

        // Send text input
        console.log('Sending text input...');
        stream.write({
            input: { text: text }
        });

        // End the stream
        console.log('Ending stream...');
        stream.end();

        // Read responses
        console.log('Waiting for responses...');
        let responseCount = 0;
        let totalBytes = 0;

        for await (const response of stream) {
            responseCount++;
            console.log(`Response ${responseCount}:`, {
                hasAudioContent: !!response.audioContent,
                audioContentLength: response.audioContent?.length || 0,
                keys: Object.keys(response)
            });

            if (response.audioContent) {
                totalBytes += response.audioContent.length;
            }
        }

        console.log('\n=== RESULTS ===');
        console.log('Total responses:', responseCount);
        console.log('Total audio bytes:', totalBytes);

        if (totalBytes === 0) {
            console.error('\n❌ FAILED: No audio received');
            console.error('This indicates the streaming API is not working as expected');
        } else {
            console.log('\n✅ SUCCESS: Received audio data');
        }

    } catch (error) {
        console.error('\n❌ ERROR:', error);
        console.error('Error details:', {
            code: error.code,
            message: error.message,
            details: error.details
        });
    }
}

// Run the test
testGoogleStreaming()
    .then(() => {
        console.log('\nTest complete');
        process.exit(0);
    })
    .catch((err) => {
        console.error('\nTest failed:', err);
        process.exit(1);
    });
