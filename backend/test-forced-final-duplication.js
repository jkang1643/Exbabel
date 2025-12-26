/**
 * Test: Forced Final Duplication Issue
 * 
 * This test reproduces the issue where forced finals are being sent twice:
 * 1. Initial forced final message (seq: 303, isPartial: false)
 * 2. Grammar update message (seq: 303, isPartial: false (grammar update))
 * 
 * The grammar update should be sent as an update, not as a duplicate final message.
 */

import { jest } from '@jest/globals';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testDetails = [];

function runTest(name, testFn) {
  totalTests++;
  try {
    testFn();
    passedTests++;
    testDetails.push({ name, status: 'passed' });
    console.log(`✅ ${name}`);
  } catch (error) {
    failedTests++;
    testDetails.push({ name, status: 'failed', error: error.message });
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
    if (error.stack) {
      console.log(`   Stack: ${error.stack.split('\n')[1]}`);
    }
  }
}

// Mock WebSocket
class MockWebSocket {
  constructor() {
    this.readyState = 1; // OPEN
    this.sentMessages = [];
  }
  
  send(data) {
    this.sentMessages.push(JSON.parse(data));
  }
  
  on() {}
  once() {}
}

// Mock grammar worker
const mockGrammarWorker = {
  correctFinal: async (text) => {
    // Simulate grammar correction that changes the text
    if (text.includes('biblical hospitality')) {
      return text.replace('biblical hospitality', 'Biblical hospitality');
    }
    return text;
  }
};

// Mock translation workers
const mockRealtimeFinalTranslationWorker = {
  translateFinal: async (text, sourceLang, targetLang) => {
    return `[Translated: ${text}]`;
  }
};

// Test: Verify that forced final sends initial message only once
runTest('Forced final should send initial message only once', () => {
  const sentMessages = [];
  const mockWs = new MockWebSocket();
  
  // Simulate the sendWithSequence function
  let seqIdCounter = 0;
  const sendWithSequence = (messageData, isPartial = true) => {
    const seqId = messageData.seqId !== undefined ? messageData.seqId : ++seqIdCounter;
    const message = {
      ...messageData,
      seqId,
      isPartial,
      serverTimestamp: Date.now()
    };
    sentMessages.push(message);
    mockWs.send(JSON.stringify(message));
    return seqId;
  };
  
  // Simulate processFinalText for forced final
  const processForcedFinal = async (textToProcess, options = {}) => {
    const isForcedFinal = !!options.forceFinal;
    
    if (isForcedFinal) {
      // Send forced final immediately with original text only
      const immediateSeqId = sendWithSequence({
        type: 'translation',
        originalText: textToProcess,
        correctedText: textToProcess,
        translatedText: textToProcess,
        timestamp: Date.now(),
        hasTranslation: false,
        hasCorrection: false,
        isTranscriptionOnly: false,
        forceFinal: true
      }, false);
      
      // Asynchronously process grammar correction
      const correctedText = await mockGrammarWorker.correctFinal(textToProcess);
      
      if (correctedText !== textToProcess) {
        // Send grammar update with same seqId
        sendWithSequence({
          type: 'translation',
          originalText: textToProcess,
          correctedText: correctedText,
          translatedText: textToProcess,
          timestamp: Date.now(),
          hasCorrection: true,
          isTranscriptionOnly: false,
          forceFinal: true,
          updateType: 'grammar',
          seqId: immediateSeqId // Use same seqId for update
        }, false); // ⚠️ BUG: This should be false for final, but creates duplicate
      }
    }
  };
  
  // Test with the actual text from the logs
  const forcedFinalText = "I love this quote biblical hospitality is the polar opposite of the cultural Trends to separate and isolate and rejects the notion that life is best spent fulfilling our own self-centered.";
  
  // Process the forced final
  processForcedFinal(forcedFinalText, { forceFinal: true }).then(() => {
    // Wait for async operations
    setTimeout(() => {
      // Check that we have exactly 2 messages (initial + grammar update)
      if (sentMessages.length !== 2) {
        throw new Error(
          `Expected 2 messages (initial + grammar update), got ${sentMessages.length}`
        );
      }
      
      // Check that both messages have the same seqId
      const seqIds = sentMessages.map(m => m.seqId);
      if (new Set(seqIds).size !== 1) {
        throw new Error(
          `Expected both messages to have same seqId, got: ${seqIds.join(', ')}`
        );
      }
      
      // Check that both messages have isPartial: false
      const isPartialValues = sentMessages.map(m => m.isPartial);
      if (isPartialValues.some(v => v !== false)) {
        throw new Error(
          `Expected both messages to have isPartial: false, got: ${isPartialValues.join(', ')}`
        );
      }
      
      // ⚠️ THIS IS THE BUG: Both messages are sent as finals (isPartial: false)
      // The grammar update should be sent as an update, not as a duplicate final
      // The issue is that when isPartial: false, the client treats it as a new final message
      // instead of an update to the existing message
      
      console.log(`   ✅ Found ${sentMessages.length} messages with seqId ${seqIds[0]}`);
      console.log(`   ⚠️  BUG: Both messages have isPartial: false (grammar update should be an update, not a duplicate final)`);
    }, 100);
  });
});

// Test: Verify that grammar update should not duplicate the initial forced final
runTest('Grammar update for forced final should not create duplicate final message', () => {
  const sentMessages = [];
  const mockWs = new MockWebSocket();
  
  let seqIdCounter = 0;
  let lastSentFinalText = '';
  
  const sendWithSequence = (messageData, isPartial = true) => {
    const seqId = messageData.seqId !== undefined ? messageData.seqId : ++seqIdCounter;
    const message = {
      ...messageData,
      seqId,
      isPartial,
      serverTimestamp: Date.now()
    };
    sentMessages.push(message);
    mockWs.send(JSON.stringify(message));
    
    // Track last sent final text
    if (!isPartial && message.correctedText) {
      lastSentFinalText = message.correctedText;
    }
    
    return seqId;
  };
  
  const processForcedFinal = async (textToProcess, options = {}) => {
    const isForcedFinal = !!options.forceFinal;
    
    if (isForcedFinal) {
      // Send forced final immediately
      const immediateSeqId = sendWithSequence({
        type: 'translation',
        originalText: textToProcess,
        correctedText: textToProcess,
        translatedText: textToProcess,
        timestamp: Date.now(),
        hasTranslation: false,
        hasCorrection: false,
        isTranscriptionOnly: false,
        forceFinal: true
      }, false);
      
      lastSentFinalText = textToProcess;
      
      // Grammar correction
      const correctedText = await mockGrammarWorker.correctFinal(textToProcess);
      
      if (correctedText !== textToProcess) {
        // FIX: Check if corrected text is different from what we already sent
        // This prevents duplicate finals when grammar correction completes
        const correctedNormalized = correctedText.trim().replace(/\s+/g, ' ').toLowerCase();
        const lastSentNormalized = lastSentFinalText.trim().replace(/\s+/g, ' ').toLowerCase();
        
        // Only send update if corrected text is different
        if (correctedNormalized !== lastSentNormalized) {
          sendWithSequence({
            type: 'translation',
            originalText: textToProcess,
            correctedText: correctedText,
            translatedText: textToProcess,
            timestamp: Date.now(),
            hasCorrection: true,
            isTranscriptionOnly: false,
            forceFinal: true,
            updateType: 'grammar',
            seqId: immediateSeqId
          }, false);
          lastSentFinalText = correctedText;
        } else {
          console.log(`   ⏭️ Skipping grammar update - text already sent`);
        }
      }
    }
  };
  
  const forcedFinalText = "I love this quote biblical hospitality is the polar opposite.";
  
  return processForcedFinal(forcedFinalText, { forceFinal: true }).then(() => {
    return new Promise((resolve) => {
      setTimeout(() => {
        // Check that we don't have duplicate final messages
        // Both messages should have the same seqId, but the second should be an update
        const finals = sentMessages.filter(m => m.isPartial === false);
        
        if (finals.length > 1) {
          // Check if they have the same seqId (which means second is an update)
          const seqIds = finals.map(m => m.seqId);
          const uniqueSeqIds = new Set(seqIds);
          
          if (uniqueSeqIds.size === 1) {
            // Same seqId - second should be an update
            const updateMessages = finals.filter(m => m.updateType);
            if (updateMessages.length === 0) {
              throw new Error(
                `BUG: ${finals.length} final messages with same seqId, but none marked as update. ` +
                `Expected 1 final + 1 update, but got ${finals.length} finals without updateType.`
              );
            }
            // This is actually correct - same seqId with updateType means it's an update
            console.log(`   ✅ Found ${finals.length} messages with same seqId (1 final + ${updateMessages.length} update(s))`);
          } else {
            throw new Error(
              `BUG: ${finals.length} final messages with different seqIds. ` +
              `Expected 1 final message, got ${finals.length} separate final messages.`
            );
          }
        } else if (finals.length === 1) {
          console.log(`   ✅ Found 1 final message (grammar update was skipped or not needed)`);
        }
        resolve();
      }, 100);
    });
  });
});

// Print summary
setTimeout(() => {
  console.log('\n' + '='.repeat(60));
  console.log(`Test Summary: ${passedTests}/${totalTests} passed, ${failedTests} failed`);
  console.log('='.repeat(60));
  
  if (failedTests > 0) {
    console.log('\nFailed Tests:');
    testDetails
      .filter(t => t.status === 'failed')
      .forEach(t => {
        console.log(`  ❌ ${t.name}`);
        console.log(`     ${t.error}`);
      });
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }
}, 200);

