#!/usr/bin/env node
/**
 * Fetch available ElevenLabs models from the API
 * Usage: node scripts/fetch-elevenlabs-models.js
 */

import 'dotenv/config';

async function fetchModels() {
    const apiKey = process.env.ELEVENLABS_API_KEY;

    if (!apiKey) {
        console.error('❌ ELEVENLABS_API_KEY not found in environment');
        console.error('   Please set it in backend/.env');
        process.exit(1);
    }

    console.log('🔍 Fetching available models from ElevenLabs API...\n');

    try {
        const res = await fetch('https://api.elevenlabs.io/v1/models', {
            headers: { 'xi-api-key': apiKey }
        });

        if (!res.ok) {
            const errorText = await res.text();
            console.error(`❌ API error ${res.status}: ${errorText}`);
            process.exit(1);
        }

        const models = await res.json();

        console.log('✅ Available Models:\n');
        console.log('┌─────────────────────────────┬──────────────────────────────────┬─────┐');
        console.log('│ Model ID                    │ Name                             │ TTS │');
        console.log('├─────────────────────────────┼──────────────────────────────────┼─────┤');

        models.forEach(m => {
            const id = (m.model_id || '').padEnd(27);
            const name = (m.name || '').padEnd(32);
            const tts = m.can_do_text_to_speech ? '✓' : '✗';
            console.log(`│ ${id} │ ${name} │  ${tts}  │`);
        });

        console.log('└─────────────────────────────┴──────────────────────────────────┴─────┘\n');

        // Filter TTS-capable models
        const ttsModels = models.filter(m => m.can_do_text_to_speech);

        console.log('📋 TTS-Capable Models for Exbabel Integration:\n');
        ttsModels.forEach(m => {
            console.log(`   • ${m.model_id}`);
            console.log(`     Name: ${m.name}`);
            if (m.description) {
                console.log(`     Description: ${m.description}`);
            }
            console.log('');
        });

        // Suggest tier mapping
        console.log('💡 Suggested Tier Mapping:\n');

        const v3 = ttsModels.find(m => m.model_id.includes('v3'));
        const flash = ttsModels.find(m => m.model_id.includes('flash_v2_5'));
        const turbo = ttsModels.find(m => m.model_id.includes('turbo_v2_5'));
        const multilingual = ttsModels.find(m => m.model_id === 'eleven_multilingual_v2');

        if (v3) {
            console.log(`   Ultra HD (Expressive):  ${v3.model_id}`);
        }
        if (turbo) {
            console.log(`   Premium (Balanced):     ${turbo.model_id}`);
        }
        if (flash) {
            console.log(`   Fast (Low Latency):     ${flash.model_id}`);
        }
        if (multilingual) {
            console.log(`   Standard (Stable):      ${multilingual.model_id}`);
        }

        console.log('');

    } catch (error) {
        console.error('❌ Error fetching models:', error.message);
        process.exit(1);
    }
}

fetchModels();
