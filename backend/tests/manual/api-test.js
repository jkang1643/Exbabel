/**
 * Simple API Test
 *
 * Tests if the translation API is working at all
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables like server.js does
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { realtimePartialTranslationWorker } from '../../translationWorkersRealtime.js';

async function testTranslationAPI() {
    console.log('🧪 Testing Translation API Connection...\n');

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        console.error('❌ No OPENAI_API_KEY found');
        return;
    }

    if (apiKey.includes('your-openai-api-key-here') || apiKey.includes('sk-your-')) {
        console.error('❌ OPENAI_API_KEY appears to be a placeholder');
        return;
    }

    console.log('✅ API key found (not placeholder)');

    try {
        console.log('🔄 Testing simple translation...');
        const result = await realtimePartialTranslationWorker.translatePartial(
            'Hello world',
            'en',
            'es',
            apiKey
        );

        console.log('✅ Translation successful:', result);
        return true;

    } catch (error) {
        console.error('❌ Translation failed:', error.message);

        if (error.message.includes('API key')) {
            console.error('🔑 Issue: API key problem');
        } else if (error.message.includes('model') || error.message.includes('realtime')) {
            console.error('🤖 Issue: Model access or realtime API not available');
        } else if (error.message.includes('WebSocket') || error.message.includes('connection')) {
            console.error('🔌 Issue: WebSocket connection problem');
        } else {
            console.error('❓ Issue: Unknown error');
        }

        return false;
    }
}

// Run the test
testTranslationAPI().catch(console.error);
