
import fs from 'fs';
import path from 'path';

const catalogsDir = '/home/jkang1643/projects/realtimetranslationapp/backend/tts/voiceCatalog/catalogs';

const catalogFiles = [
    { file: 'gemini_tts.json', tier: 'Gemini (Vertex AI)' },
    { file: 'google_chirp3_hd.json', tier: 'Google Chirp 3 HD' },
    { file: 'google_neural2.json', tier: 'Google Neural2' },
    { file: 'google_studio.json', tier: 'Google Studio' },
    { file: 'google_standard.json', tier: 'Google Standard' },
    { file: 'elevenlabs_flash.json', tier: 'ElevenLabs Flash' },
    { file: 'elevenlabs_turbo.json', tier: 'ElevenLabs Turbo' },
    { file: 'elevenlabs_v3.json', tier: 'ElevenLabs v3' },
    { file: 'elevenlabs_standard.json', tier: 'ElevenLabs Multilingual' }
];

function getLanguages(filePath) {
    try {
        const content = fs.readFileSync(path.join(catalogsDir, filePath), 'utf8');
        const json = JSON.parse(content);
        const voices = json.voices || [];
        const languages = new Set();

        voices.forEach(v => {
            if (v.languageCodes) {
                v.languageCodes.forEach(code => languages.add(code));
            }
        });

        return Array.from(languages).sort();
    } catch (e) {
        console.error(`Error reading ${filePath}: ${e.message}`);
        return [];
    }
}

console.log('## Detailed Tier Support');
console.log('');

catalogFiles.forEach(cat => {
    const langs = getLanguages(cat.file);
    console.log(`### ${cat.tier} (${langs.length} Languages)`);
    console.log('');

    if (langs.includes('*')) {
        console.log('- **Multilingual / Universal Support** (All Languages)');
    } else {
        const codeString = langs.map(l => `\`${l}\``).join(', ');
        console.log(codeString);
    }
    console.log('');
});
