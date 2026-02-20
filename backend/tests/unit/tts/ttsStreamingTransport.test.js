/**
 * Unit Tests for TTS Streaming Transport
 * 
 * Tests binary frame encoding/decoding and message creation.
 * Run with: node backend/tests/unit/tts/ttsStreamingTransport.test.js
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
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        console.log(`✓ ${message}`);
        passed++;
    } else {
        console.error(`✗ ${message}`);
        console.error(`  Expected: ${JSON.stringify(expected)}`);
        console.error(`  Actual:   ${JSON.stringify(actual)}`);
        failed++;
    }
}

// Import functions to test
const { encodeAudioFrame, decodeAudioFrame, createStartMessage, createEndMessage, createCancelMessage } = await import('../../../tts/ttsStreamingTransport.js');

console.log('\n=== TTS Streaming Transport Unit Tests ===\n');

// Test 1: Encode/decode round-trip
console.log('=== Test 1: Encode/decode round-trip ===');

const testMeta = {
    streamId: 'test-session:123',
    segmentId: 'test-session:seg:1',
    version: 1,
    chunkIndex: 0,
    isLast: false
};
const testAudio = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE]);

const encoded = encodeAudioFrame(testMeta, testAudio);
assert(encoded instanceof Uint8Array, 'Encoded frame is Uint8Array');
assert(encoded.length > testAudio.length, 'Encoded frame includes header');

const decoded = decodeAudioFrame(encoded);
assertEquals(decoded.meta, testMeta, 'Decoded metadata matches');
assertEquals(Array.from(decoded.audioBytes), Array.from(testAudio), 'Decoded audio matches');

// Test 2: Magic bytes verification
console.log('\n=== Test 2: Magic bytes verification ===');

const magic = new TextDecoder().decode(encoded.slice(0, 4));
assertEquals(magic, 'EXA1', 'Magic bytes are EXA1');

// Test 3: Invalid magic bytes rejection
console.log('\n=== Test 3: Invalid magic bytes rejection ===');

const badFrame = new Uint8Array([0x42, 0x41, 0x44, 0x21, 0x05, ...new TextEncoder().encode('{}'), 0x00]);
try {
    decodeAudioFrame(badFrame);
    assert(false, 'Should throw for invalid magic');
} catch (err) {
    assert(err.message.includes('Invalid frame magic'), 'Throws correct error for invalid magic');
}

// Test 4: createStartMessage
console.log('\n=== Test 4: createStartMessage ===');

const startMsg = createStartMessage({
    streamId: 'stream-1',
    segmentId: 'seg-1',
    version: 1,
    seqId: 42,
    lang: 'es-ES',
    voiceId: 'elevenlabs-abc123',
    textPreview: 'Hello world'
});

assertEquals(startMsg.type, 'audio.start', 'Start message has correct type');
assertEquals(startMsg.streamId, 'stream-1', 'Start message has streamId');
assertEquals(startMsg.segmentId, 'seg-1', 'Start message has segmentId');
assertEquals(startMsg.seqId, 42, 'Start message has seqId');

// Test 5: createEndMessage
console.log('\n=== Test 5: createEndMessage ===');

const endMsg = createEndMessage('stream-1', 'seg-1', 1);
assertEquals(endMsg.type, 'audio.end', 'End message has correct type');
assertEquals(endMsg.streamId, 'stream-1', 'End message has streamId');
assertEquals(endMsg.segmentId, 'seg-1', 'End message has segmentId');

// Test 6: createCancelMessage
console.log('\n=== Test 6: createCancelMessage ===');

const cancelMsg = createCancelMessage('stream-1', 'user_stop', 'seg-1');
assertEquals(cancelMsg.type, 'audio.cancel', 'Cancel message has correct type');
assertEquals(cancelMsg.reason, 'user_stop', 'Cancel message has reason');

// Test 7: Large metadata rejection
console.log('\n=== Test 7: Large metadata rejection ===');

const largeMeta = {
    streamId: 'x'.repeat(300),
    segmentId: 'y',
    version: 1,
    chunkIndex: 0,
    isLast: false
};

try {
    encodeAudioFrame(largeMeta, new Uint8Array(0));
    assert(false, 'Should throw for oversized metadata');
} catch (err) {
    assert(err.message.includes('too large'), 'Throws correct error for large metadata');
}

// Test 8: Empty audio bytes
console.log('\n=== Test 8: Empty audio bytes ===');

const emptyMeta = { streamId: 's', segmentId: 'g', version: 1, chunkIndex: 0, isLast: true };
const emptyFrame = encodeAudioFrame(emptyMeta, new Uint8Array(0));
const emptyDecoded = decodeAudioFrame(emptyFrame);
assertEquals(emptyDecoded.audioBytes.length, 0, 'Empty audio bytes decoded correctly');
assertEquals(emptyDecoded.meta.isLast, true, 'isLast flag preserved');

// ============================================================
// Language Filtering Tests
// ============================================================

const { registerClient, unregisterClient, broadcastAudioFrame, broadcastControl, updateClientLang } = await import('../../../tts/ttsStreamingTransport.js');

// Test 9: registerClient stores lang field
console.log('\n=== Test 9: registerClient stores lang field ===');

const sentMessages9 = [];
const mockWs9 = { readyState: 1, send: (data) => sentMessages9.push(data) };
registerClient('session9', { ws: mockWs9, clientId: 'c1', lang: 'es' });

// Verify: broadcastAudioFrame with matching lang sends to client
broadcastAudioFrame('session9', new Uint8Array([1, 2, 3]), 'es');
assert(sentMessages9.length === 1, 'Spanish client receives Spanish audio frame');

// Verify: broadcastAudioFrame with non-matching lang skips client
broadcastAudioFrame('session9', new Uint8Array([4, 5, 6]), 'fr');
assert(sentMessages9.length === 1, 'Spanish client does NOT receive French audio frame');

// Verify: broadcastAudioFrame with no lang sends to everyone (backwards compat)
broadcastAudioFrame('session9', new Uint8Array([7, 8, 9]), null);
assert(sentMessages9.length === 2, 'No-lang broadcast reaches all clients');

// Cleanup
unregisterClient('session9', { ws: mockWs9, clientId: 'c1', lang: 'es' });

// Test 10: Multiple language groups in same session
console.log('\n=== Test 10: Multi-language session filtering ===');

const esSent = [];
const frSent = [];
const mockWsEs = { readyState: 1, send: (d) => esSent.push(d) };
const mockWsFr = { readyState: 1, send: (d) => frSent.push(d) };
const esClient = { ws: mockWsEs, clientId: 'es-client', lang: 'es' };
const frClient = { ws: mockWsFr, clientId: 'fr-client', lang: 'fr' };

registerClient('session10', esClient);
registerClient('session10', frClient);

// Broadcast Spanish audio
broadcastAudioFrame('session10', new Uint8Array([1]), 'es');
assert(esSent.length === 1, 'Spanish client gets Spanish audio');
assert(frSent.length === 0, 'French client does NOT get Spanish audio');

// Broadcast French audio
broadcastAudioFrame('session10', new Uint8Array([2]), 'fr');
assert(esSent.length === 1, 'Spanish client does NOT get French audio');
assert(frSent.length === 1, 'French client gets French audio');

unregisterClient('session10', esClient);
unregisterClient('session10', frClient);

// Test 11: updateClientLang changes filter mid-session
console.log('\n=== Test 11: updateClientLang mid-session switch ===');

const switchSent = [];
const mockWsSwitch = { readyState: 1, send: (d) => switchSent.push(d) };
const switchClient = { ws: mockWsSwitch, clientId: 'switch-client', lang: 'es' };

registerClient('session11', switchClient);

// Before switch: receives Spanish, not French
broadcastAudioFrame('session11', new Uint8Array([1]), 'es');
assert(switchSent.length === 1, 'Before switch: receives Spanish');
broadcastAudioFrame('session11', new Uint8Array([2]), 'fr');
assert(switchSent.length === 1, 'Before switch: does NOT receive French');

// Switch to French
const updated = updateClientLang('session11', 'switch-client', 'fr');
assert(updated === true, 'updateClientLang returns true for found client');

// After switch: receives French, not Spanish
broadcastAudioFrame('session11', new Uint8Array([3]), 'es');
assert(switchSent.length === 1, 'After switch: does NOT receive Spanish');
broadcastAudioFrame('session11', new Uint8Array([4]), 'fr');
assert(switchSent.length === 2, 'After switch: receives French');

unregisterClient('session11', switchClient);

// Test 12: updateClientLang returns false for unknown client
console.log('\n=== Test 12: updateClientLang unknown client ===');
const notFound = updateClientLang('session11', 'nonexistent', 'de');
assert(notFound === false, 'updateClientLang returns false for unknown client');

// Test 13: broadcastControl language filtering
console.log('\n=== Test 13: broadcastControl language filtering ===');

const ctrlEs = [];
const ctrlFr = [];
const wsCtrlEs = { readyState: 1, send: (d) => ctrlEs.push(d) };
const wsCtrlFr = { readyState: 1, send: (d) => ctrlFr.push(d) };
registerClient('session13', { ws: wsCtrlEs, clientId: 'ctrl-es', lang: 'es' });
registerClient('session13', { ws: wsCtrlFr, clientId: 'ctrl-fr', lang: 'fr' });

broadcastControl('session13', { type: 'audio.start', lang: 'es' }, 'es');
assert(ctrlEs.length === 1, 'broadcastControl sends to matching lang');
assert(ctrlFr.length === 0, 'broadcastControl skips non-matching lang');

// Summary
console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed === 0) {
    console.log('\n✓ All tests passed!');
    process.exit(0);
} else {
    console.log('\n✗ Some tests failed');
    process.exit(1);
}
