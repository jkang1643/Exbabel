/**
 * TDD Test Suite: Partial Translation Real Flow
 * 
 * This test accurately simulates the REAL flow in soloModeHandler to expose
 * why partial translations are not appearing live.
 * 
 * The real flow:
 * 1. Partial arrives -> sends message with hasTranslation=false
 * 2. Checks if shouldTranslateNow (first OR grew 2+ chars OR 150ms passed)
 * 3. If yes, starts translation
 * 4. When translation completes, updates message with hasTranslation=true
 * 
 * Run with: node backend/test-partial-translation-real-flow.js
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';

console.log('🧪 TDD Test Suite: Partial Translation Real Flow\n');
console.log('='.repeat(80));

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.sentMessages = [];
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
  
  getTranslationMessages() {
    return this.sentMessages.filter(m => m.type === 'translation');
  }
  
  getPartialMessages() {
    return this.getTranslationMessages().filter(m => m.isPartial === true);
  }
  
  getMessagesWithTranslation() {
    return this.getTranslationMessages().filter(m => m.hasTranslation === true);
  }
  
  getMessagesWithoutTranslation() {
    return this.getTranslationMessages().filter(m => m.hasTranslation === false || m.hasTranslation === undefined);
  }
  
  clearMessages() {
    this.sentMessages = [];
  }
}

// Simulate the REAL throttling logic from soloModeHandler
class RealFlowSimulator {
  constructor() {
    this.lastPartialTranslation = '';
    this.lastPartialTranslationTime = 0;
    this.pendingPartialTranslation = null;
    this.partialSeqIdMap = new Map();
    this.sentMessages = [];
    this.translationDelay = 100; // Simulate 100ms translation delay
    this.activeTranslationPromises = new Map(); // text -> promise
  }
  
  // Simulate the REAL shouldTranslateNow logic
  shouldTranslateNow(transcriptText) {
    const now = Date.now();
    const timeSinceLastTranslation = now - this.lastPartialTranslationTime;
    const textGrowth = transcriptText.length - this.lastPartialTranslation.length;
    const GROWTH_THRESHOLD = 2;
    const MIN_TIME_MS = 150;
    
    const textGrewSignificantly = textGrowth >= GROWTH_THRESHOLD;
    const enoughTimePassed = timeSinceLastTranslation >= MIN_TIME_MS;
    const isFirstTranslation = this.lastPartialTranslation.length === 0;
    
    return isFirstTranslation || textGrewSignificantly || enoughTimePassed;
  }
  
  // Simulate processing a partial (like soloModeHandler does)
  async processPartial(transcriptText, seqId) {
    // Store seqId in map
    this.partialSeqIdMap.set(transcriptText, seqId);
    
    // Send initial message with hasTranslation=false
    this.sentMessages.push({
      seqId,
      originalText: transcriptText,
      translatedText: undefined,
      hasTranslation: false,
      isPartial: true,
      timestamp: Date.now()
    });
    
    // Check if should translate now (REAL logic)
    if (!this.shouldTranslateNow(transcriptText)) {
      console.log(`   [Simulator] ⏭️ Skipping translation for "${transcriptText}" - doesn't meet threshold`);
      return; // Don't translate yet
    }
    
    // Cancel any pending translation
    if (this.pendingPartialTranslation) {
      clearTimeout(this.pendingPartialTranslation);
      this.pendingPartialTranslation = null;
    }
    
    // CRITICAL FIX: Update lastPartialTranslation when we START translation, not when it completes
    // This ensures that rapid partials can properly check if they should translate
    this.lastPartialTranslation = transcriptText;
    this.lastPartialTranslationTime = Date.now();
    
    // Start translation
    console.log(`   [Simulator] 🔄 Starting translation for "${transcriptText}"`);
    const translationPromise = this.translatePartial(transcriptText);
    this.activeTranslationPromises.set(transcriptText, translationPromise);
    
    translationPromise.then(translatedText => {
      // Find seqId for this text
      const translationSeqId = this.partialSeqIdMap.get(transcriptText);
      
      if (translationSeqId !== undefined && translationSeqId !== null) {
        // Update message with translation
        const messageIndex = this.sentMessages.findIndex(m => m.seqId === translationSeqId);
        if (messageIndex >= 0) {
          this.sentMessages[messageIndex].translatedText = translatedText;
          this.sentMessages[messageIndex].hasTranslation = true;
          console.log(`   [Simulator] ✅ Translation complete for "${transcriptText}" -> "${translatedText}"`);
        }
      }
      
      // NOTE: lastPartialTranslation is now updated when translation STARTS (above)
      // We don't need to update here again
      this.activeTranslationPromises.delete(transcriptText);
    }).catch(error => {
      console.log(`   [Simulator] ❌ Translation failed for "${transcriptText}": ${error.message}`);
      this.activeTranslationPromises.delete(transcriptText);
    });
  }
  
  async translatePartial(text) {
    await sleep(this.translationDelay);
    return `[TRANSLATED: ${text}]`;
  }
  
  clear() {
    this.lastPartialTranslation = '';
    this.lastPartialTranslationTime = 0;
    this.pendingPartialTranslation = null;
    this.partialSeqIdMap.clear();
    this.sentMessages = [];
    this.activeTranslationPromises.clear();
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
// TEST SUITE: Real Flow Simulation
// ============================================================================

/**
 * Test 1: First partial should trigger translation immediately
 */
testAsync('First partial triggers translation immediately', async () => {
  const simulator = new RealFlowSimulator();
  
  // First partial "Hello"
  await simulator.processPartial('Hello', 1);
  
  // Wait for translation to complete
  await sleep(150);
  
  const messagesWithTranslation = simulator.sentMessages.filter(m => m.hasTranslation === true);
  const messagesWithoutTranslation = simulator.sentMessages.filter(m => m.hasTranslation === false);
  
  console.log(`   Messages with translation: ${messagesWithTranslation.length}`);
  console.log(`   Messages without translation: ${messagesWithoutTranslation.length}`);
  
  if (messagesWithTranslation.length === 0) {
    throw new Error(`Expected at least 1 message with translation, but got 0. This means the first partial didn't trigger translation.`);
  }
  
  return true;
});

/**
 * Test 2: Rapid partials - some should get translated
 * 
 * This simulates the real scenario where partials arrive rapidly:
 * - "H" (1 char) -> first, should translate
 * - "He" (2 chars, +1) -> might not translate (only +1 char, < 150ms)
 * - "Hel" (3 chars, +1) -> might not translate
 * - "Hell" (4 chars, +1) -> might not translate
 * - "Hello" (5 chars, +1) -> might not translate
 * 
 * Expected: At least 2-3 should get translated
 * Actual bug: Only first one gets translated, rest wait until final
 */
testAsync('Rapid partials should still produce some translations', async () => {
  const simulator = new RealFlowSimulator();
  
  const partials = ['H', 'He', 'Hel', 'Hell', 'Hello'];
  let seqId = 1;
  
  for (const partial of partials) {
    await simulator.processPartial(partial, seqId++);
    await sleep(20); // 20ms between partials (rapid)
  }
  
  // Wait for all translations to complete
  await sleep(300);
  
  const messagesWithTranslation = simulator.sentMessages.filter(m => m.hasTranslation === true);
  const messagesWithoutTranslation = simulator.sentMessages.filter(m => m.hasTranslation === false);
  
  console.log(`\n   Results:`);
  console.log(`   - Total messages: ${simulator.sentMessages.length}`);
  console.log(`   - Messages WITH translation: ${messagesWithTranslation.length}`);
  console.log(`   - Messages WITHOUT translation: ${messagesWithoutTranslation.length}`);
  console.log(`   - lastPartialTranslation: "${simulator.lastPartialTranslation}"`);
  console.log(`   - lastPartialTranslationTime: ${simulator.lastPartialTranslationTime}`);
  
  simulator.sentMessages.forEach((msg, i) => {
    console.log(`   Message ${i+1}: "${msg.originalText}" - hasTranslation: ${msg.hasTranslation}`);
  });
  
  // Expected: At least 2-3 should have translations
  // Actual bug: Only 1 (the first) has translation
  if (messagesWithTranslation.length < 2) {
    throw new Error(`Expected at least 2 messages with translation for rapid partials, but only ${messagesWithTranslation.length} have translations. This means most partials are not being translated until final.`);
  }
  
  return true;
});

/**
 * Test 3: Slow partials - all should get translated
 * 
 * If partials arrive slowly (> 150ms apart), all should trigger translations
 */
testAsync('Slow partials should all get translated', async () => {
  const simulator = new RealFlowSimulator();
  
  const partials = ['H', 'He', 'Hel', 'Hell', 'Hello'];
  let seqId = 1;
  
  for (const partial of partials) {
    await simulator.processPartial(partial, seqId++);
    await sleep(200); // 200ms between partials (slow enough to trigger)
  }
  
  // Wait for all translations to complete
  await sleep(300);
  
  const messagesWithTranslation = simulator.sentMessages.filter(m => m.hasTranslation === true);
  
  console.log(`\n   Results:`);
  console.log(`   - Messages WITH translation: ${messagesWithTranslation.length}`);
  
  // Expected: All 5 should have translations (they arrive > 150ms apart)
  if (messagesWithTranslation.length < 4) {
    throw new Error(`Expected at least 4 messages with translation for slow partials, but only ${messagesWithTranslation.length} have translations.`);
  }
  
  return true;
});

/**
 * Test 4: Growing partials - should trigger when growth threshold met
 * 
 * Partials that grow by 2+ chars should trigger translation even if < 150ms
 */
testAsync('Partials growing by 2+ chars should trigger translation', async () => {
  const simulator = new RealFlowSimulator();
  
  // First: "Hello" (5 chars) - first translation
  await simulator.processPartial('Hello', 1);
  await sleep(50); // Wait a bit but not 150ms
  
  // Second: "Hello world" (11 chars, +6) - should trigger (grew by 6 chars)
  await simulator.processPartial('Hello world', 2);
  
  // Wait for translations
  await sleep(200);
  
  const messagesWithTranslation = simulator.sentMessages.filter(m => m.hasTranslation === true);
  
  console.log(`\n   Results:`);
  console.log(`   - Messages WITH translation: ${messagesWithTranslation.length}`);
  
  // Expected: Both should have translations (first is first, second grew by 6 chars)
  if (messagesWithTranslation.length < 2) {
    throw new Error(`Expected 2 messages with translation (first + growing by 6 chars), but only ${messagesWithTranslation.length} have translations.`);
  }
  
  return true;
});

// ============================================================================
// Test Runner
// ============================================================================

async function runTests() {
  console.log('\n📋 Running Tests...\n');
  
  await testAsync('First partial triggers translation immediately', async () => {
    const simulator = new RealFlowSimulator();
    await simulator.processPartial('Hello', 1);
    await sleep(150);
    
    const messagesWithTranslation = simulator.sentMessages.filter(m => m.hasTranslation === true);
    if (messagesWithTranslation.length === 0) {
      throw new Error(`Expected at least 1 message with translation, but got 0.`);
    }
    return true;
  });
  
  await testAsync('Rapid partials should still produce some translations', async () => {
    const simulator = new RealFlowSimulator();
    
    const partials = ['H', 'He', 'Hel', 'Hell', 'Hello'];
    let seqId = 1;
    
    for (const partial of partials) {
      await simulator.processPartial(partial, seqId++);
      await sleep(20);
    }
    
    await sleep(300);
    
    const messagesWithTranslation = simulator.sentMessages.filter(m => m.hasTranslation === true);
    
    console.log(`\n   Results:`);
    console.log(`   - Messages WITH translation: ${messagesWithTranslation.length}`);
    simulator.sentMessages.forEach((msg, i) => {
      console.log(`   Message ${i+1}: "${msg.originalText}" - hasTranslation: ${msg.hasTranslation}`);
    });
    
    if (messagesWithTranslation.length < 2) {
      throw new Error(`Expected at least 2 messages with translation for rapid partials, but only ${messagesWithTranslation.length} have translations.`);
    }
    
    return true;
  });
  
  await testAsync('Slow partials should all get translated', async () => {
    const simulator = new RealFlowSimulator();
    
    const partials = ['H', 'He', 'Hel', 'Hell', 'Hello'];
    let seqId = 1;
    
    for (const partial of partials) {
      await simulator.processPartial(partial, seqId++);
      await sleep(200);
    }
    
    await sleep(300);
    
    const messagesWithTranslation = simulator.sentMessages.filter(m => m.hasTranslation === true);
    
    if (messagesWithTranslation.length < 4) {
      throw new Error(`Expected at least 4 messages with translation for slow partials, but only ${messagesWithTranslation.length} have translations.`);
    }
    
    return true;
  });
  
  await testAsync('Partials growing by 2+ chars should trigger translation', async () => {
    const simulator = new RealFlowSimulator();
    
    await simulator.processPartial('Hello', 1);
    await sleep(50);
    await simulator.processPartial('Hello world', 2);
    await sleep(200);
    
    const messagesWithTranslation = simulator.sentMessages.filter(m => m.hasTranslation === true);
    
    if (messagesWithTranslation.length < 2) {
      throw new Error(`Expected 2 messages with translation, but only ${messagesWithTranslation.length} have translations.`);
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
  
  process.exit(failedTests > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.error('❌ Test runner error:', error);
  process.exit(1);
});

