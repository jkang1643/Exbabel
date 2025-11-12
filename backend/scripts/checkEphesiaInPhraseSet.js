/**
 * Check if "Ephesia" is in the actual PhraseSet in Google Cloud
 */

import { GoogleAuth } from 'google-auth-library';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || '222662040787';
const phraseSetId = process.env.GOOGLE_PHRASE_SET_ID || 'church-glossary-10k';

async function checkEphesia() {
  const apiUrl = `https://speech.googleapis.com/v1/projects/${projectId}/locations/global/phraseSets/${phraseSetId}`;

  try {
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credentialsPath) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set');
    }
    
    const auth = new GoogleAuth({
      keyFile: credentialsPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    
    const client = await auth.getClient();
    const accessTokenResponse = await client.getAccessToken();
    const accessToken = accessTokenResponse?.token || accessTokenResponse;
    
    const response = await fetch(apiUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    const data = await response.json();
    
    console.log('🔍 Searching for "Ephesia" in PhraseSet...\n');
    
    const ephesiaPhrases = data.phrases.filter(p => 
      p.value.toLowerCase().includes('ephesia')
    );
    
    if (ephesiaPhrases.length > 0) {
      console.log(`✅ Found ${ephesiaPhrases.length} phrase(s) containing "Ephesia":\n`);
      ephesiaPhrases.forEach(p => {
        console.log(`   - "${p.value}"`);
      });
    } else {
      console.log('❌ No phrases containing "Ephesia" found in PhraseSet');
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('The real question: Is the PhraseSet being used in API requests?');
    console.log('Check your server logs for:');
    console.log('  [GoogleSpeech] 📤 SENDING REQUEST WITH PHRASESET:');
    console.log('='.repeat(70));

  } catch (err) {
    console.error('Error:', err.message);
  }
}

checkEphesia();

