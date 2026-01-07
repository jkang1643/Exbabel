// Test script to trigger [ES_PAYLOAD_TO_LISTENER] output
import sessionStore from './sessionStore.js';

// Simulate the exact message structure that would trigger "Y grito"
async function test() {
  console.log('Testing ES payload logging for "Y grito"...');

  try {
    // Create a test session
    const { sessionId } = sessionStore.createSession();
    console.log('Created test session:', sessionId);

    // Create a mock WebSocket for testing
    const mockSocket = {
      readyState: 1, // WebSocket.OPEN
      send: (data) => {
        console.log('Mock socket received:', data);
      }
    };

    // Add a Spanish listener
    sessionStore.addListener(sessionId, 'test-socket-id', mockSocket, 'es', 'Test User');

    // Create the message that would trigger the "Y grito" logging
    const testMessage = {
      type: 'translation',
      originalText: 'And I show out. Can I tell?',
      translatedText: 'Y grito fuerte. ¿Puedo decirlo?',
      sourceLang: 'en',
      targetLang: 'es',
      timestamp: Date.now(),
      hasTranslation: true,
      sourceSeqId: 504,
      seqId: 12345,
      isPartial: false
    };

    console.log('Broadcasting test message to ES listeners...');

    // This should trigger the [ES_PAYLOAD_TO_LISTENER] logging
    sessionStore.broadcastToListeners(sessionId, testMessage, 'es');

  } catch (error) {
    console.error('Test failed:', error);
  }
}

test().catch(console.error);
