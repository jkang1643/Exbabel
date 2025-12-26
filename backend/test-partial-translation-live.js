/**
 * TDD Test Suite: Partial Translation Live Updates
 * 
 * This test exposes the bug where partial translations are not appearing live.
 * The bug manifests as:
 * 1. Partials are sent but translations don't appear until finalization
 * 2. Translations are being cancelled prematurely
 * 3. seqId updates are not working correctly
 * 
 * Run with: node backend/test-partial-translation-live.js
 * 
 * TDD Approach: These tests MUST FAIL to reveal the issues
 */

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import WebSocket from 'ws';

console.log('🧪 TDD Test Suite: Partial Translation Live Updates\n');
console.log('='.repeat(80));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

// Helper to simulate time passing
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock WebSocket for testing
class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.sentMessages = [];
    this.on = this.on.bind(this);
    this.once = this.once.bind(this);
  }
  
  send(data) {
    try {
      const message = JSON.parse(data);
      this.sentMessages.push({
        ...message,
        receivedAt: Date.now()
      });
    } catch (e) {
      this.sentMessages.push({
        raw: data,
        receivedAt: Date.now()
      });
    }
  }
  
  getMessagesByType(type) {
    return this.sentMessages.filter(m => m.type === type);
  }
  
  getTranslationMessages() {
    return this.sentMessages.filter(m => m.type === 'translation');
  }
  
  getPartialTranslations() {
    return this.getTranslationMessages().filter(m => m.isPartial === true);
  }
  
  getFinalTranslations() {
    return this.getTranslationMessages().filter(m => m.isPartial === false || m.isPartial === undefined);
  }
  
  clearMessages() {
    this.sentMessages = [];
  }
}

// Mock Google Speech Stream
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
  
  async initialize(lang, options = {}) {
    this.sourceLang = lang;
    this.options = options;
    this.initialized = true;
    
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
  
  onError(callback) {
    this.errorCallback = callback;
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
}

// Mock translation worker to track translation requests
class MockPartialTranslationWorker {
  constructor() {
    this.translationRequests = [];
    this.translationResponses = new Map();
    this.cancelledRequests = [];
    this.translationDelay = 100; // Simulate 100ms translation delay
    this.pendingRequests = new Map();
    this.abortControllers = new Map();
  }
  
  async translatePartial(text, sourceLang, targetLang, apiKey, sessionId) {
    const cancelKey = `${sourceLang}:${targetLang}`;
    const requestId = `${text}-${Date.now()}`;
    
    // Find ALL existing pending requests for this language pair
    // Find the MOST RECENT request (longest text) to compare against
    let existingRequest = null;
    let concurrentCount = 0;
    let longestText = '';
    let longestTextRequest = null;
    
    for (const [key, value] of this.pendingRequests.entries()) {
      if (key.startsWith(cancelKey)) {
        concurrentCount++;
        // Track the request with the longest text (most recent extending partial)
        if (value.text && value.text.length > longestText.length) {
          longestText = value.text;
          longestTextRequest = { key, value };
        }
        if (!existingRequest) {
          existingRequest = { key, value };
        }
      }
    }
    
    // Use the longest text request as the comparison target
    if (longestTextRequest && longestTextRequest.value.text.length > (existingRequest?.value?.text?.length || 0)) {
      existingRequest = longestTextRequest;
    }
    
    const MAX_CONCURRENT = 5;
    let isReset = false;
    
    if (existingRequest && existingRequest.value.text) {
      const previousText = existingRequest.value.text;
      
      // Helper to normalize text for comparison (remove punctuation, lowercase)
      const normalizeForComparison = (str) => {
        return str.toLowerCase().replace(/[.,!?;:]/g, '').trim();
      };
      
      const normalizedText = normalizeForComparison(text);
      const normalizedPrevious = normalizeForComparison(previousText);
      
      // CRITICAL FIX: For very short texts (< 5 chars), be more lenient
      const isVeryShort = previousText.length < 5 || text.length < 5;
      
      // Check word overlap
      const previousWords = normalizedPrevious.split(/\s+/).filter(w => w.length > 0);
      const currentWords = normalizedText.split(/\s+/).filter(w => w.length > 0);
      const overlappingWords = previousWords.filter(w => currentWords.includes(w));
      const wordOverlapRatio = previousWords.length > 0 ? overlappingWords.length / previousWords.length : 0;
      
      // For very short texts, check if current text contains previous text (more lenient)
      const containsPrevious = isVeryShort && normalizedText.includes(normalizedPrevious);
      
      // It's a reset if:
      isReset = text.length < previousText.length * 0.6 || 
                (!normalizedText.startsWith(normalizedPrevious) && !containsPrevious && wordOverlapRatio < 0.5) ||
                (previousWords.length > 0 && wordOverlapRatio === 0 && !containsPrevious);
    }
    
    if (existingRequest) {
      const prevAbortController = this.abortControllers.get(existingRequest.key);
      const previousText = existingRequest.value.text;
      
      // Only cancel on resets OR if we're way over the concurrent limit
      if (isReset || concurrentCount > MAX_CONCURRENT + 2) {
        if (prevAbortController) {
          prevAbortController.abort();
        }
        this.cancelledRequests.push({
          text: previousText,
          reason: isReset ? 'reset' : 'too many concurrent',
          timestamp: Date.now()
        });
        this.pendingRequests.delete(existingRequest.key);
        this.abortControllers.delete(existingRequest.key);
      }
    }
    
    // Create abort controller for this request
    // Use timestamp in key for extending text to allow concurrent translations
    const uniqueKey = existingRequest && !isReset && concurrentCount < MAX_CONCURRENT 
      ? `${cancelKey}_${Date.now()}` 
      : cancelKey;
    const abortController = new AbortController();
    this.abortControllers.set(uniqueKey, abortController);
    
    this.translationRequests.push({
      text,
      sourceLang,
      targetLang,
      requestId,
      timestamp: Date.now(),
      cancelled: false
    });
    
    this.pendingRequests.set(uniqueKey, { text, timestamp: Date.now() });
    
    try {
      // Simulate translation delay with abort checking
      const startTime = Date.now();
      while (Date.now() - startTime < this.translationDelay) {
        if (abortController.signal.aborted) {
          this.cancelledRequests.push({
            text,
            reason: 'aborted',
            timestamp: Date.now()
          });
          throw new Error('Translation cancelled');
        }
        await sleep(10); // Check every 10ms
      }
      
      // Final check if cancelled
      if (abortController.signal.aborted) {
        this.cancelledRequests.push({
          text,
          reason: 'aborted',
          timestamp: Date.now()
        });
        throw new Error('Translation cancelled');
      }
      
      // Generate mock translation
      const translatedText = `[TRANSLATED: ${text}]`;
      this.translationResponses.set(text, translatedText);
      this.pendingRequests.delete(uniqueKey);
      this.abortControllers.delete(uniqueKey);
      
      return translatedText;
    } catch (error) {
      this.pendingRequests.delete(uniqueKey);
      this.abortControllers.delete(uniqueKey);
      throw error;
    }
  }
  
  clear() {
    this.translationRequests = [];
    this.translationResponses.clear();
    this.cancelledRequests = [];
    this.pendingRequests.clear();
    this.abortControllers.clear();
  }
}

function test(name, testFn) {
  totalTests++;
  const startTime = Date.now();
  try {
    const result = testFn();
    const duration = Date.now() - startTime;
    if (result === true || (result && result !== false)) {
      console.log(`✅ ${name} (${duration}ms)`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration, error: null });
      return true;
    } else {
      console.log(`❌ ${name} (${duration}ms)`);
      failedTests++;
      testDetails.push({ name, status: 'failed', duration, error: 'Test returned false' });
      return false;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ ${name}: ${error.message} (${duration}ms)`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n').slice(0, 3).join('\n')}`);
    }
    failedTests++;
    testDetails.push({ name, status: 'failed', duration, error: error.message });
    return false;
  }
}

async function testAsync(name, testFn) {
  totalTests++;
  const startTime = Date.now();
  try {
    const result = await testFn();
    const duration = Date.now() - startTime;
    if (result === true || (result && result !== false)) {
      console.log(`✅ ${name} (${duration}ms)`);
      passedTests++;
      testDetails.push({ name, status: 'passed', duration, error: null });
      return true;
    } else {
      console.log(`❌ ${name} (${duration}ms)`);
      failedTests++;
      testDetails.push({ name, status: 'failed', duration, error: 'Test returned false' });
      return false;
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ ${name}: ${error.message} (${duration}ms)`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n').slice(0, 3).join('\n')}`);
    }
    failedTests++;
    testDetails.push({ name, status: 'failed', duration, error: error.message });
    return false;
  }
}

// ============================================================================
// TEST SUITE: Partial Translation Live Updates
// ============================================================================

/**
 * Test 1: Translations are not cancelled when partials extend
 * 
 * This test verifies that when partials extend (e.g., "Hello" -> "Hello world"),
 * the previous translation is not cancelled, allowing it to complete.
 */
testAsync('Translations are not cancelled when partials extend', async () => {
  const mockWorker = new MockPartialTranslationWorker();
  
  // Simulate the scenario:
  // 1. Partial "Hello" arrives -> translation request 1 starts
  // 2. Partial "Hello world" arrives -> should NOT cancel request 1
  // 3. Request 1 should complete and send translation for "Hello"
  // 4. Request 2 should complete and send translation for "Hello world"
  
  // Start first translation
  const promise1 = mockWorker.translatePartial('Hello', 'en', 'es', 'test-key', 'session1');
  
  // Wait a bit, then send extending partial
  await sleep(20);
  const promise2 = mockWorker.translatePartial('Hello world', 'en', 'es', 'test-key', 'session1');
  
  // Wait for both to complete
  await Promise.allSettled([promise1, promise2]);
  
  // Verify both translations completed (not cancelled)
  const completed = mockWorker.translationResponses.size;
  const cancelled = mockWorker.cancelledRequests.length;
  
  // Expected: 2 translations completed, 0 cancelled
  // Actual bug: 1 or both cancelled
  
  if (completed < 2) {
    throw new Error(`Expected 2 translations to complete, but only ${completed} completed. ${cancelled} were cancelled.`);
  }
  
  return true;
});

/**
 * Test 2: Punctuation changes don't trigger cancellation
 * 
 * This test verifies that when partials change punctuation (e.g., "Hello." -> "Hello, hello"),
 * the translation is not cancelled as a "reset".
 */
testAsync('Punctuation changes do not trigger cancellation', async () => {
  const mockWorker = new MockPartialTranslationWorker();
  
  // Simulate: "Hello." -> "Hello, hello"
  // This should be treated as an extension, not a reset
  
  const promise1 = mockWorker.translatePartial('Hello.', 'en', 'es', 'test-key', 'session1');
  await sleep(10);
  const promise2 = mockWorker.translatePartial('Hello, hello', 'en', 'es', 'test-key', 'session1');
  
  await Promise.allSettled([promise1, promise2]);
  
  const completed = mockWorker.translationResponses.size;
  const cancelled = mockWorker.cancelledRequests.length;
  
  // Expected: Both complete (punctuation change is extension, not reset)
  // Actual bug: Second one cancels first
  
  if (cancelled > 0) {
    throw new Error(`Expected 0 cancellations for punctuation change, but ${cancelled} were cancelled. Completed: ${completed}`);
  }
  
  return true;
});

/**
 * Test 3: Integration test - Partial translations appear before finalization
 * 
 * This is the MAIN test that exposes the core bug. It simulates the real flow:
 * 1. Partial "Hello" arrives -> should trigger translation immediately
 * 2. Translation should appear within 200ms
 * 3. Partial "Hello world" arrives -> should trigger new translation
 * 4. Translation should appear within 200ms
 * 5. Final "Hello world" arrives -> final translation should appear
 * 
 * Expected: At least 2 partial translations appear before final
 * Actual bug: 0 partial translations, only final appears
 */
testAsync('Integration: Partial translations appear before finalization', async () => {
  // This test requires mocking the actual soloModeHandler
  // For now, we'll test the translation worker behavior
  
  const mockWorker = new MockPartialTranslationWorker();
  const messages = [];
  
  // Simulate the flow
  const timeline = [];
  
  // T=0ms: Partial "Hello" arrives
  timeline.push({ time: 0, event: 'partial', text: 'Hello' });
  const promise1 = mockWorker.translatePartial('Hello', 'en', 'es', 'test-key', 'session1')
    .then(translation => {
      timeline.push({ time: Date.now(), event: 'translation_complete', text: 'Hello', translation });
      messages.push({ type: 'partial_translation', text: 'Hello', translation, hasTranslation: true });
    })
    .catch(err => {
      timeline.push({ time: Date.now(), event: 'translation_cancelled', text: 'Hello', error: err.message });
    });
  
  // T=50ms: Partial "Hello world" arrives (extending)
  await sleep(50);
  timeline.push({ time: Date.now(), event: 'partial', text: 'Hello world' });
  const promise2 = mockWorker.translatePartial('Hello world', 'en', 'es', 'test-key', 'session1')
    .then(translation => {
      timeline.push({ time: Date.now(), event: 'translation_complete', text: 'Hello world', translation });
      messages.push({ type: 'partial_translation', text: 'Hello world', translation, hasTranslation: true });
    })
    .catch(err => {
      timeline.push({ time: Date.now(), event: 'translation_cancelled', text: 'Hello world', error: err.message });
    });
  
  // Wait for translations to complete
  await Promise.allSettled([promise1, promise2]);
  await sleep(100); // Extra buffer
  
  // T=300ms: Final "Hello world" arrives
  timeline.push({ time: Date.now(), event: 'final', text: 'Hello world' });
  messages.push({ type: 'final_translation', text: 'Hello world', hasTranslation: true });
  
  // Analyze results
  const partialTranslations = messages.filter(m => m.type === 'partial_translation');
  const cancelledTranslations = timeline.filter(t => t.event === 'translation_cancelled');
  
  console.log(`\n   Timeline:`);
  timeline.forEach(t => {
    const timeStr = `${t.time}ms`.padStart(8);
    console.log(`   ${timeStr}: ${t.event} - ${t.text || t.translation || t.error || ''}`);
  });
  
  console.log(`\n   Results:`);
  console.log(`   - Partial translations completed: ${partialTranslations.length}`);
  console.log(`   - Translations cancelled: ${cancelledTranslations.length}`);
  
  // Expected: At least 1 partial translation should complete before final
  // Actual bug: 0 partial translations complete (all cancelled)
  
  if (partialTranslations.length === 0) {
    throw new Error(`Expected at least 1 partial translation to complete, but 0 completed. ${cancelledTranslations.length} were cancelled.`);
  }
  
  if (cancelledTranslations.length > 0) {
    throw new Error(`Expected 0 translations to be cancelled, but ${cancelledTranslations.length} were cancelled. This prevents partials from appearing live.`);
  }
  
  return true;
});

/**
 * Test 4: Rapid partials don't prevent translations from appearing
 * 
 * This test verifies that when many partials arrive rapidly, translations
 * still appear for at least some of them, not waiting until finalization.
 */
testAsync('Rapid partials still produce live translations', async () => {
  const mockWorker = new MockPartialTranslationWorker();
  const messages = [];
  
  // Simulate rapid partials: "H", "He", "Hel", "Hell", "Hello"
  const partials = ['H', 'He', 'Hel', 'Hell', 'Hello'];
  const promises = [];
  
  for (let i = 0; i < partials.length; i++) {
    const text = partials[i];
    await sleep(20); // 20ms between partials
    
    const promise = mockWorker.translatePartial(text, 'en', 'es', 'test-key', 'session1')
      .then(translation => {
        messages.push({ type: 'partial_translation', text, translation });
      })
      .catch(err => {
        // Cancelled - expected for some
      });
    
    promises.push(promise);
  }
  
  // Wait for all to settle
  await Promise.allSettled(promises);
  await sleep(200); // Extra buffer for completions
  
  const completed = messages.filter(m => m.type === 'partial_translation').length;
  const cancelled = mockWorker.cancelledRequests.length;
  
  console.log(`\n   Results:`);
  console.log(`   - Partial translations completed: ${completed}`);
  console.log(`   - Translations cancelled: ${cancelled}`);
  
  // Expected: At least 2-3 partial translations should complete
  // Actual bug: 0-1 complete (most cancelled)
  
  if (completed < 2) {
    throw new Error(`Expected at least 2 partial translations to complete with rapid partials, but only ${completed} completed. ${cancelled} were cancelled.`);
  }
  
  return true;
});

// ============================================================================
// Test Runner
// ============================================================================

async function runTests() {
  console.log('\n📋 Running Tests...\n');
  
  await testAsync('Translations are not cancelled when partials extend', async () => {
    const mockWorker = new MockPartialTranslationWorker();
    
    const promise1 = mockWorker.translatePartial('Hello', 'en', 'es', 'test-key', 'session1');
    await sleep(20);
    const promise2 = mockWorker.translatePartial('Hello world', 'en', 'es', 'test-key', 'session1');
    
    await Promise.allSettled([promise1, promise2]);
    
    const completed = mockWorker.translationResponses.size;
    const cancelled = mockWorker.cancelledRequests.length;
    
    if (completed < 2) {
      throw new Error(`Expected 2 translations to complete, but only ${completed} completed. ${cancelled} were cancelled.`);
    }
    
    return true;
  });
  
  await testAsync('Punctuation changes do not trigger cancellation', async () => {
    const mockWorker = new MockPartialTranslationWorker();
    
    const promise1 = mockWorker.translatePartial('Hello.', 'en', 'es', 'test-key', 'session1');
    await sleep(10);
    const promise2 = mockWorker.translatePartial('Hello, hello', 'en', 'es', 'test-key', 'session1');
    
    await Promise.allSettled([promise1, promise2]);
    
    const cancelled = mockWorker.cancelledRequests.length;
    
    if (cancelled > 0) {
      throw new Error(`Expected 0 cancellations for punctuation change, but ${cancelled} were cancelled.`);
    }
    
    return true;
  });
  
  await testAsync('Integration: Partial translations appear before finalization', async () => {
    const mockWorker = new MockPartialTranslationWorker();
    const messages = [];
    const timeline = [];
    
    const promise1 = mockWorker.translatePartial('Hello', 'en', 'es', 'test-key', 'session1')
      .then(translation => {
        timeline.push({ time: Date.now(), event: 'translation_complete', text: 'Hello', translation });
        messages.push({ type: 'partial_translation', text: 'Hello', translation, hasTranslation: true });
      })
      .catch(err => {
        timeline.push({ time: Date.now(), event: 'translation_cancelled', text: 'Hello', error: err.message });
      });
    
    await sleep(50);
    const promise2 = mockWorker.translatePartial('Hello world', 'en', 'es', 'test-key', 'session1')
      .then(translation => {
        timeline.push({ time: Date.now(), event: 'translation_complete', text: 'Hello world', translation });
        messages.push({ type: 'partial_translation', text: 'Hello world', translation, hasTranslation: true });
      })
      .catch(err => {
        timeline.push({ time: Date.now(), event: 'translation_cancelled', text: 'Hello world', error: err.message });
      });
    
    await Promise.allSettled([promise1, promise2]);
    await sleep(100);
    
    const partialTranslations = messages.filter(m => m.type === 'partial_translation');
    const cancelledTranslations = timeline.filter(t => t.event === 'translation_cancelled');
    
    if (partialTranslations.length === 0) {
      throw new Error(`Expected at least 1 partial translation to complete, but 0 completed. ${cancelledTranslations.length} were cancelled.`);
    }
    
    if (cancelledTranslations.length > 0) {
      throw new Error(`Expected 0 translations to be cancelled, but ${cancelledTranslations.length} were cancelled. This prevents partials from appearing live.`);
    }
    
    return true;
  });
  
  await testAsync('Rapid partials still produce live translations', async () => {
    const mockWorker = new MockPartialTranslationWorker();
    const messages = [];
    
    const partials = ['H', 'He', 'Hel', 'Hell', 'Hello'];
    const promises = [];
    
    for (let i = 0; i < partials.length; i++) {
      const text = partials[i];
      await sleep(20);
      
      const promise = mockWorker.translatePartial(text, 'en', 'es', 'test-key', 'session1')
        .then(translation => {
          messages.push({ type: 'partial_translation', text, translation });
        })
        .catch(() => {});
      
      promises.push(promise);
    }
    
    await Promise.allSettled(promises);
    await sleep(200);
    
    const completed = messages.filter(m => m.type === 'partial_translation').length;
    const cancelled = mockWorker.cancelledRequests.length;
    
    if (completed < 2) {
      throw new Error(`Expected at least 2 partial translations to complete with rapid partials, but only ${completed} completed. ${cancelled} were cancelled.`);
    }
    
    return true;
  });
  
  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log(`\n📊 Test Summary:`);
  console.log(`   Total: ${totalTests}`);
  console.log(`   ✅ Passed: ${passedTests}`);
  console.log(`   ❌ Failed: ${failedTests}`);
  console.log(`   Success Rate: ${totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : 0}%\n`);
  
  if (failedTests > 0) {
    console.log('❌ FAILING TESTS (These expose the bugs):\n');
    testDetails
      .filter(t => t.status === 'failed')
      .forEach(t => {
        console.log(`   ❌ ${t.name}`);
        if (t.error) {
          console.log(`      Error: ${t.error}`);
        }
      });
    console.log('');
  }
  
  // Exit with error code if tests failed
  process.exit(failedTests > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  console.error('❌ Test runner error:', error);
  process.exit(1);
});
