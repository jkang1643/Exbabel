import { resolveTtsRoute } from '../../backend/tts/ttsRouting.js';

// Test the TTS routing fixes
async function testRouting() {
  console.log('Testing TTS Routing Fixes...\n');

  // Test Chinese - should support Gemini
  console.log('Test 1: Chinese with Gemini tier (should work)');
  try {
    const route1 = await resolveTtsRoute({
      requestedTier: 'gemini',
      languageCode: 'zh',
      requestedVoice: 'Kore'
    });
    console.log('Result:', JSON.stringify(route1, null, 2));
    console.log('✓ Expected: tier=gemini, voice=Kore\n');
  } catch (error) {
    console.log('✗ Error:', error.message);
  }

  // Test Spanish - should support Gemini
  console.log('Test 2: Spanish with Gemini tier (should work)');
  try {
    const route2 = await resolveTtsRoute({
      requestedTier: 'gemini',
      languageCode: 'es',
      requestedVoice: 'Kore'
    });
    console.log('Result:', JSON.stringify(route2, null, 2));
    console.log('✓ Expected: tier=gemini, voice=Kore\n');
  } catch (error) {
    console.log('✗ Error:', error.message);
  }

  // Test English - should support Gemini
  console.log('Test 3: English with Gemini tier (should work)');
  try {
    const route3 = await resolveTtsRoute({
      requestedTier: 'gemini',
      languageCode: 'en',
      requestedVoice: 'Charon'
    });
    console.log('Result:', JSON.stringify(route3, null, 2));
    console.log('✓ Expected: tier=gemini, voice=Charon\n');
  } catch (error) {
    console.log('✗ Error:', error.message);
  }

  // Test Chirp3 HD for French
  console.log('Test 4: French with Chirp3 HD tier (should work)');
  try {
    const route4 = await resolveTtsRoute({
      requestedTier: 'chirp3_hd',
      languageCode: 'fr',
      requestedVoice: 'fr-FR-Chirp3-HD-Kore'
    });
    console.log('Result:', JSON.stringify(route4, null, 2));
    console.log('✓ Expected: tier=chirp3_hd, voice=fr-FR-Chirp3-HD-Kore\n');
  } catch (error) {
    console.log('✗ Error:', error.message);
  }
}

testRouting().catch(console.error);
