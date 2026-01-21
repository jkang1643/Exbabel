/**
 * Unit Tests for ElevenLabs TTS Service
 * 
 * Run with: node tests/unit/tts/elevenlabsTtsService.test.js
 */

// Test counter
let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`✓ ${message}`);
        passed++;
    } else {
        console.error(`✗ ${message}`);
        failed++;
    }
}

function assertEquals(actual, expected, message) {
    if (actual === expected) {
        console.log(`✓ ${message}`);
        passed++;
    } else {
        console.error(`✗ ${message} (expected: ${expected}, got: ${actual})`);
        failed++;
    }
}

// Mock fetch for testing
let mockFetchResponse = null;
let mockFetchError = null;

global.fetch = async (url, options) => {
    if (mockFetchError) {
        throw mockFetchError;
    }
    return mockFetchResponse;
};

// Import the service (dynamic import for ES modules)
const { ElevenLabsTtsService } = await import('../../../tts/elevenlabsTtsService.js');

console.log('\\n=== ElevenLabs TTS Service Unit Tests ===\\n');

// Test 1: Missing API key returns config error
console.log('\\n=== Test 1: Missing API key returns config error ===');

const serviceNoKey = new ElevenLabsTtsService({ apiKey: null });
try {
    await serviceNoKey.synthesizeUnary({
        text: 'Hello world',
        segmentId: 'test-1',
        profile: { languageCode: 'en-US' }
    });
    assert(false, 'Should have thrown error for missing API key');
} catch (error) {
    const parsed = JSON.parse(error.message);
    assertEquals(parsed.code, 'TTS_ELEVENLABS_CONFIG_ERROR', 'Error code should be TTS_ELEVENLABS_CONFIG_ERROR');
    assert(parsed.message.includes('ELEVENLABS_API_KEY'), 'Error message should mention missing API key');
}

// Test 2: Empty text returns invalid request error
console.log('\\n=== Test 2: Empty text returns invalid request error ===');

const serviceWithKey = new ElevenLabsTtsService({
    apiKey: 'test-api-key',
    defaultVoiceId: 'test-voice-id'
});

try {
    await serviceWithKey.synthesizeUnary({
        text: '',
        segmentId: 'test-2',
        profile: { languageCode: 'en-US' }
    });
    assert(false, 'Should have thrown error for empty text');
} catch (error) {
    const parsed = JSON.parse(error.message);
    assertEquals(parsed.code, 'INVALID_REQUEST', 'Error code should be INVALID_REQUEST');
    assert(parsed.message.includes('required'), 'Error message should mention required field');
}

// Test 3: Missing voice ID returns config error
console.log('\\n=== Test 3: Missing voice ID returns config error ===');

const serviceNoVoice = new ElevenLabsTtsService({
    apiKey: 'test-api-key',
    defaultVoiceId: null
});

try {
    await serviceNoVoice.synthesizeUnary({
        text: 'Hello world',
        segmentId: 'test-3',
        profile: { languageCode: 'en-US' }
    });
    assert(false, 'Should have thrown error for missing voice ID');
} catch (error) {
    const parsed = JSON.parse(error.message);
    assertEquals(parsed.code, 'TTS_ELEVENLABS_CONFIG_ERROR', 'Error code should be TTS_ELEVENLABS_CONFIG_ERROR');
    assert(parsed.message.includes('voice'), 'Error message should mention missing voice');
}

// Test 4: Voice ID resolution strips elevenlabs- prefix
console.log('\\n=== Test 4: Voice ID resolution strips elevenlabs- prefix ===');

const service = new ElevenLabsTtsService({
    apiKey: 'test-key',
    defaultVoiceId: 'default-id'
});

// Test the private _resolveVoiceId method directly
assertEquals(service._resolveVoiceId('elevenlabs-abc123'), 'abc123', 'Should strip elevenlabs- prefix');
assertEquals(service._resolveVoiceId('xyz789'), 'xyz789', 'Should keep raw voice ID unchanged');
assertEquals(service._resolveVoiceId(null), null, 'Should return null for null input');

// Test 5: MIME type detection from output format
console.log('\\n=== Test 5: MIME type detection from output format ===');

assertEquals(service._getMimeTypeFromFormat('mp3_44100_128'), 'audio/mpeg', 'mp3 format should return audio/mpeg');
assertEquals(service._getMimeTypeFromFormat('pcm_16000'), 'audio/pcm', 'pcm format should return audio/pcm');
assertEquals(service._getMimeTypeFromFormat('opus_48000_128'), 'audio/ogg', 'opus format should return audio/ogg');

// Test 6: Sample rate extraction from output format
console.log('\\n=== Test 6: Sample rate extraction from output format ===');

assertEquals(service._getSampleRateFromFormat('mp3_44100_128'), 44100, 'Should extract 44100 from mp3_44100_128');
assertEquals(service._getSampleRateFromFormat('pcm_16000'), 16000, 'Should extract 16000 from pcm_16000');
assertEquals(service._getSampleRateFromFormat('invalid'), 44100, 'Should return default 44100 for invalid format');

// Test 7: Successful synthesis (mocked)
console.log('\\n=== Test 7: Successful synthesis (mocked) ===');

// Set up mock response
const mockAudioData = Buffer.from('mock-audio-data');
mockFetchResponse = {
    ok: true,
    arrayBuffer: async () => mockAudioData,
    headers: {
        get: (name) => {
            if (name === 'request-id') return 'test-request-id';
            if (name === 'x-character-count') return '12';
            return null;
        }
    }
};
mockFetchError = null;

const successService = new ElevenLabsTtsService({
    apiKey: 'test-api-key',
    defaultVoiceId: 'test-voice-id',
    modelId: 'eleven_multilingual_v2',
    outputFormat: 'mp3_44100_128'
});

try {
    const result = await successService.synthesizeUnary({
        text: 'Hello world',
        segmentId: 'test-7',
        profile: { languageCode: 'cmn-CN' }
    }, { tier: 'elevenlabs' });

    assert(result.audio.bytesBase64.length > 0, 'Audio base64 should not be empty');
    assertEquals(result.audio.mimeType, 'audio/mpeg', 'MIME type should be audio/mpeg');
    assertEquals(result.mode, 'unary', 'Mode should be unary');
    assertEquals(result.route.provider, 'elevenlabs', 'Provider should be elevenlabs');
    assertEquals(result.providerMeta.requestId, 'test-request-id', 'Request ID should be captured from headers');
    assertEquals(result.providerMeta.characterCount, '12', 'Character count should be captured from headers');
    console.log('✓ Successful synthesis returns correct structure');
    passed++;
} catch (error) {
    console.error('✗ Successful synthesis failed:', error.message);
    failed++;
}

// Test 8: API error handling
console.log('\\n=== Test 8: API error handling ===');

mockFetchResponse = {
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => 'Invalid API key'
};
mockFetchError = null;

try {
    await successService.synthesizeUnary({
        text: 'Hello world',
        segmentId: 'test-8',
        profile: { languageCode: 'en-US' }
    }, { tier: 'elevenlabs' });
    assert(false, 'Should have thrown error for API error');
} catch (error) {
    let parsed;
    try {
        parsed = JSON.parse(error.message);
    } catch (e) {
        parsed = { code: 'UNKNOWN', message: error.message };
    }
    assertEquals(parsed.code, 'TTS_ELEVENLABS_API_ERROR', 'Error code should be TTS_ELEVENLABS_API_ERROR');
    assert(parsed.message.includes('401'), 'Error message should include status code');
    console.log('✓ API error properly handled');
}

// Test 9: Language code mapping
console.log('\n=== Test 9: Language code mapping ===');

const mapService = new ElevenLabsTtsService({ apiKey: 'test' });

assertEquals(mapService._mapLanguageCode('en-US'), 'en', 'en-US should map to en');
assertEquals(mapService._mapLanguageCode('en-GB'), 'en', 'en-GB should map to en');
assertEquals(mapService._mapLanguageCode('cmn-CN'), 'zh', 'cmn-CN should map to zh');
assertEquals(mapService._mapLanguageCode('zh-CN'), 'zh', 'zh-CN should map to zh');
assertEquals(mapService._mapLanguageCode('cmn'), 'zh', 'cmn should map to zh');
assertEquals(mapService._mapLanguageCode('yue-HK'), 'zh', 'yue-HK should map to zh');
assertEquals(mapService._mapLanguageCode('fil-PH'), 'fil', 'fil-PH should map to fil');
assertEquals(mapService._mapLanguageCode('fil'), 'fil', 'fil should map to fil');
assertEquals(mapService._mapLanguageCode('es-ES'), 'es', 'es-ES should map to es');
assertEquals(mapService._mapLanguageCode(null), 'en', 'null should map to en');

// Summary
console.log('\\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed === 0) {
    console.log('\\n✓ All tests passed!');
    process.exit(0);
} else {
    console.log('\\n✗ Some tests failed');
    process.exit(1);
}
