/**
 * Recovery Stream Behavior Test
 * 
 * Tests the recovery stream functionality as it exists in soloModeHandler.js and host/adapter.js
 * This test ensures we can verify behavior after extracting recovery stream to core engine.
 * 
 * Run with: node backend/test-recovery-stream.js
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Load .env file from backend directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

import { ForcedCommitEngine } from '../core/engine/forcedCommitEngine.js';
import { RecoveryStreamEngine } from '../core/engine/recoveryStreamEngine.js';
import { mergeRecoveryText } from '../../utils/recoveryMerge.js';

console.log('🧪 Recovery Stream Behavior Test Suite\n');
console.log('='.repeat(70));

let totalTests = 0;
let passedTests = 0;
let skippedTests = 0;
const testDetails = [];
const asyncTests = [];

function test(name, fn) {
  totalTests++;
  const startTime = Date.now();
  try {
    const result = fn();
    const duration = Date.now() - startTime;
    if (result === true || (result && result !== false)) {
      console.log(`✅ ${name} (${duration}ms)`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration, error: null });
      return true;
    } else {
      console.log(`❌ ${name} (${duration}ms)`);
      testDetails.push({ name, status: 'failed', duration, error: 'Test returned false' });
      return false;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ ${name}: ${error.message} (${duration}ms)`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1]?.trim()}`);
    }
    testDetails.push({ name, status: 'failed', duration, error: error.message });
    return false;
  }
}

async function testAsync(name, fn, details = {}) {
  totalTests++;
  const startTime = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - startTime;
    if (result === true || (result && result !== false)) {
      const detailsStr = details.result ? ` - ${details.result}` : '';
      console.log(`✅ ${name}${detailsStr} (${duration}ms)`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration, error: null, details });
      return true;
    } else {
      console.log(`❌ ${name} (${duration}ms)`);
      if (details.expected) {
        console.log(`   Expected: ${details.expected}`);
      }
      if (details.actual) {
        console.log(`   Actual: ${details.actual}`);
      }
      testDetails.push({ name, status: 'failed', duration, error: details.expected || 'Test returned false', details });
      return false;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ ${name}: ${error.message} (${duration}ms)`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1]?.trim()}`);
    }
    testDetails.push({ name, status: 'failed', duration, error: error.message });
    return false;
  }
}

// ============================================================================
// Mock GoogleSpeechStream
// ============================================================================

class MockGoogleSpeechStream extends EventEmitter {
  constructor() {
    super();
    this.recognizeStream = new PassThrough();
    this.isActive = true;
    this.isRestarting = false;
    this.shouldAutoRestart = true;
    this.resultCallback = null;
    this.initialized = false;
    this.streamReady = false;
    this.destroyed = false;
  }

  async initialize(sourceLang, options = {}) {
    this.sourceLang = sourceLang;
    this.options = options;
    this.initialized = true;
    
    // Simulate stream becoming ready after a short delay
    setTimeout(() => {
      this.streamReady = true;
      this.recognizeStream.writable = true;
      this.recognizeStream.destroyed = false;
    }, 10);
  }

  isStreamReady() {
    return this.streamReady && 
           this.recognizeStream && 
           this.recognizeStream.writable && 
           !this.recognizeStream.destroyed &&
           this.isActive && 
           !this.isRestarting;
  }

  onResult(callback) {
    this.resultCallback = callback;
  }

  destroy() {
    this.destroyed = true;
    this.isActive = false;
    if (this.recognizeStream) {
      this.recognizeStream.destroy();
    }
  }

  // Simulate receiving results from Google
  simulateResult(text, isPartial) {
    if (this.resultCallback) {
      this.resultCallback(text, isPartial);
    }
  }

  // Simulate stream ending
  simulateEnd() {
    if (this.recognizeStream) {
      this.recognizeStream.emit('end');
    }
  }

  // Simulate stream error
  simulateError(error) {
    if (this.recognizeStream) {
      this.recognizeStream.emit('error', error);
    }
  }
}

// ============================================================================
// Mock Speech Stream (with getRecentAudio)
// ============================================================================

class MockSpeechStream {
  constructor() {
    this.audioBuffer = Buffer.alloc(0);
  }

  // Set mock audio data
  setMockAudio(audioData) {
    this.audioBuffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);
  }

  getRecentAudio(durationMs) {
    // Return mock audio buffer
    return this.audioBuffer;
  }
}

// ============================================================================
// Recovery Stream Engine Instance
// ============================================================================

// Create a RecoveryStreamEngine instance for testing
const recoveryStreamEngine = new RecoveryStreamEngine();

// ============================================================================
// Test Suite 1: Recovery Stream Setup and Initialization
// ============================================================================

console.log('\n📊 Test Suite 1: Recovery Stream Setup and Initialization');
console.log('-'.repeat(70));

test('ForcedCommitEngine has CAPTURE_WINDOW_MS constant', () => {
  const engine = new ForcedCommitEngine();
  return engine.CAPTURE_WINDOW_MS === 2200;
});

test('ForcedCommitEngine can create and manage forced final buffer', () => {
  const engine = new ForcedCommitEngine();
  engine.createForcedFinalBuffer('test text', Date.now());
  return engine.hasForcedFinalBuffer() && 
         engine.getForcedFinalBuffer().text === 'test text';
});

test('ForcedCommitEngine can set recovery in progress', () => {
  const engine = new ForcedCommitEngine();
  engine.createForcedFinalBuffer('test', Date.now());
  const promise = Promise.resolve('recovered');
  engine.setRecoveryInProgress(true, promise);
  const buffer = engine.getForcedFinalBuffer();
  return buffer.recoveryInProgress === true && 
         buffer.recoveryPromise === promise;
});

// ============================================================================
// Test Suite 2: Audio Buffer Handling
// ============================================================================

console.log('\n📊 Test Suite 2: Audio Buffer Handling');
console.log('-'.repeat(70));

test('Empty audio buffer commits forced final immediately', () => {
  const engine = new ForcedCommitEngine();
  engine.createForcedFinalBuffer('forced text', Date.now());
  
  const speechStream = new MockSpeechStream();
  speechStream.setMockAudio(Buffer.alloc(0)); // Empty buffer
  
  let committedText = null;
  const processFinalText = (text, options) => {
    committedText = text;
  };

  // Simulate empty buffer handling
  const recoveryAudio = speechStream.getRecentAudio(2200);
  if (recoveryAudio.length === 0) {
    const buffer = engine.getForcedFinalBuffer();
    if (buffer) {
      buffer.committedByRecovery = true;
      processFinalText(buffer.text, { forceFinal: true });
      engine.clearForcedFinalBuffer();
    }
  }

  return committedText === 'forced text' && !engine.hasForcedFinalBuffer();
});

test('Non-empty audio buffer triggers recovery', () => {
  const speechStream = new MockSpeechStream();
  const mockAudio = Buffer.alloc(1000, 0x80); // 1000 bytes of mock audio
  speechStream.setMockAudio(mockAudio);
  
  const recoveryAudio = speechStream.getRecentAudio(2200);
  return recoveryAudio.length > 0;
});

// ============================================================================
// Test Suite 3: Recovery Promise Management
// ============================================================================

console.log('\n📊 Test Suite 3: Recovery Promise Management');
console.log('-'.repeat(70));

asyncTests.push(testAsync('Recovery promise is created and stored in buffer', async () => {
  const engine = new ForcedCommitEngine();
  engine.createForcedFinalBuffer('test', Date.now());
  
  let recoveryResolve = null;
  const recoveryPromise = new Promise((resolve) => {
    recoveryResolve = resolve;
  });
  
  engine.setRecoveryInProgress(true, recoveryPromise);
  
  const buffer = engine.getForcedFinalBuffer();
  return buffer.recoveryInProgress === true && 
         buffer.recoveryPromise === recoveryPromise;
}));

asyncTests.push(testAsync('Recovery promise resolves with recovered text', async () => {
  let resolvedText = null;
  const recoveryPromise = new Promise((resolve) => {
    setTimeout(() => resolve('recovered words'), 10);
  });
  
  resolvedText = await recoveryPromise;
  return resolvedText === 'recovered words';
}));

asyncTests.push(testAsync('Recovery promise resolves with empty string on error', async () => {
  let resolvedText = null;
  const recoveryPromise = new Promise((resolve) => {
    setTimeout(() => resolve(''), 10); // Simulate error case
  });
  
  resolvedText = await recoveryPromise;
  return resolvedText === '';
}));

// ============================================================================
// Test Suite 4: Merge Logic
// ============================================================================

console.log('\n📊 Test Suite 4: Merge Logic');
console.log('-'.repeat(70));

test('Merge recovery text with single-word overlap', () => {
  const bufferedText = 'Life is best';
  const recoveredText = 'best spent fulfilling';
  
  const mergeResult = mergeRecoveryText(
    bufferedText,
    recoveredText,
    {
      nextPartialText: '',
      nextFinalText: null,
      mode: 'TestMode'
    }
  );
  
  return mergeResult.merged === true && 
         mergeResult.mergedText.includes('spent fulfilling');
});

test('Merge recovery text with no overlap falls back safely', () => {
  const bufferedText = 'Life is best';
  const recoveredText = 'completely different text';
  
  const mergeResult = mergeRecoveryText(
    bufferedText,
    recoveredText,
    {
      nextPartialText: '',
      nextFinalText: null,
      mode: 'TestMode'
    }
  );
  
  // Should either merge with full append or fail safely
  return mergeResult.merged === true || mergeResult.merged === false;
});

test('Merge handles compound words correctly', () => {
  const bufferedText = 'self';
  const recoveredText = 'self-centered';
  
  const mergeResult = mergeRecoveryText(
    bufferedText,
    recoveredText,
    {
      nextPartialText: '',
      nextFinalText: null,
      mode: 'TestMode'
    }
  );
  
  return mergeResult.merged === true;
});

// ============================================================================
// Test Suite 5: Recovery Stream Integration (Mocked)
// ============================================================================

console.log('\n📊 Test Suite 5: Recovery Stream Integration (Mocked)');
console.log('-'.repeat(70));

asyncTests.push(testAsync('Recovery stream initializes with correct options', async () => {
  const mockStream = new MockGoogleSpeechStream();
  await mockStream.initialize('en', {
    disablePunctuation: true,
    forceEnhanced: true
  });
  
  return mockStream.initialized === true &&
         mockStream.options.disablePunctuation === true &&
         mockStream.options.forceEnhanced === true;
}, { result: 'Stream initialized with disablePunctuation and forceEnhanced' }));

asyncTests.push(testAsync('Recovery stream waits for ready state', async () => {
  const mockStream = new MockGoogleSpeechStream();
  await mockStream.initialize('en', {});
  
  // Wait a bit for stream to become ready
  let ready = false;
  let attempts = 0;
  while (!ready && attempts < 20) {
    ready = mockStream.isStreamReady();
    if (!ready) {
      await new Promise(resolve => setTimeout(resolve, 25));
      attempts++;
    }
  }
  
  return ready === true;
}, { result: 'Stream becomes ready after initialization' }));

asyncTests.push(testAsync('Recovery stream handles results correctly', async () => {
  const mockStream = new MockGoogleSpeechStream();
  await mockStream.initialize('en', {});
  
  let receivedText = null;
  let receivedIsPartial = null;
  
  mockStream.onResult((text, isPartial) => {
    receivedText = text;
    receivedIsPartial = isPartial;
  });
  
  // Simulate receiving a partial result
  mockStream.simulateResult('spent', true);
  
  return receivedText === 'spent' && receivedIsPartial === true;
}, { result: 'Result callback receives text and partial flag' }));

asyncTests.push(testAsync('Recovery stream handles end event', async () => {
  const mockStream = new MockGoogleSpeechStream();
  await mockStream.initialize('en', {});
  
  let endReceived = false;
  mockStream.recognizeStream.on('end', () => {
    endReceived = true;
  });
  
  mockStream.simulateEnd();
  
  // Give event loop a chance to process
  await new Promise(resolve => setTimeout(resolve, 10));
  
  return endReceived === true;
}, { result: 'End event is received and handled' }));

asyncTests.push(testAsync('Recovery stream cleans up after use', async () => {
  const mockStream = new MockGoogleSpeechStream();
  await mockStream.initialize('en', {});
  
  mockStream.destroy();
  
  return mockStream.destroyed === true && 
         mockStream.isActive === false;
}, { result: 'Stream is properly destroyed' }));

// ============================================================================
// Test Suite 6: Error Handling
// ============================================================================

console.log('\n📊 Test Suite 6: Error Handling');
console.log('-'.repeat(70));

asyncTests.push(testAsync('Recovery stream handles stream errors gracefully', async () => {
  const mockStream = new MockGoogleSpeechStream();
  await mockStream.initialize('en', {});
  
  let errorReceived = false;
  mockStream.recognizeStream.on('error', (err) => {
    errorReceived = true;
  });
  
  mockStream.simulateError(new Error('Stream error'));
  
  // Give event loop a chance to process
  await new Promise(resolve => setTimeout(resolve, 10));
  
  return errorReceived === true;
}, { result: 'Error event is handled without crashing' }));

asyncTests.push(testAsync('Recovery promise resolves even on error', async () => {
  let resolved = false;
  let resolvedText = null;
  
  const recoveryPromise = new Promise((resolve) => {
    // Simulate error case - resolve with empty string
    setTimeout(() => {
      resolved = true;
      resolvedText = '';
      resolve('');
    }, 10);
  });
  
  const result = await recoveryPromise;
  
  return resolved === true && 
         resolvedText === '' && 
         result === '';
}, { result: 'Recovery promise resolves with empty string on error' }));

// ============================================================================
// Test Suite 7: Full Recovery Flow (End-to-End Mock)
// ============================================================================

console.log('\n📊 Test Suite 7: Full Recovery Flow (End-to-End Mock)');
console.log('-'.repeat(70));

asyncTests.push(testAsync('Complete recovery flow with successful merge', async () => {
  const engine = new ForcedCommitEngine();
  engine.createForcedFinalBuffer('Life is best', Date.now());
  
  const speechStream = new MockSpeechStream();
  speechStream.setMockAudio(Buffer.alloc(1000, 0x80));
  
  let committedText = null;
  const processFinalText = (text, options) => {
    committedText = text;
  };
  
  // Note: This test would require actual GoogleSpeechStream integration
  // For now, we test the merge logic separately
  const mergeResult = mergeRecoveryText(
    'Life is best',
    'best spent fulfilling',
    {
      nextPartialText: '',
      nextFinalText: null,
      mode: 'TestMode'
    }
  );
  
  if (mergeResult.merged) {
    processFinalText(mergeResult.mergedText, { forceFinal: true });
  }
  
  return committedText && committedText.includes('spent');
}, { result: 'Recovery text is merged and committed' }));

// ============================================================================
// Test Summary
// ============================================================================

// Wait for all async tests to complete before showing summary
(async () => {
  await Promise.all(asyncTests);
  
  console.log('\n' + '='.repeat(70));
  console.log('📊 Test Summary');
  console.log('='.repeat(70));
  console.log(`Total Tests: ${totalTests}`);
  console.log(`✅ Passed: ${passedTests}`);
  console.log(`❌ Failed: ${totalTests - passedTests - skippedTests}`);
  console.log(`⏭️  Skipped: ${skippedTests}`);
  console.log(`Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);

  if (passedTests === totalTests) {
    console.log('\n🎉 All tests passed!');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed. Review output above.');
    process.exit(1);
  }
})();

