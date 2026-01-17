/**
 * Populate existing PhraseSet with phrases from glossary.json
 * 
 * Prerequisites:
 *   1. PhraseSet must already exist in Google Cloud Console
 *   2. Set GOOGLE_APPLICATION_CREDENTIALS to Service Account JSON path
 *   3. Set GOOGLE_CLOUD_PROJECT_ID=exbabel-tts-prod (or set in .env)
 * 
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   export GOOGLE_CLOUD_PROJECT_ID=exbabel-tts-prod
 *   node backend/scripts/populatePhraseSet.js
 * 
 * This script uses Service Account JSON to update the PhraseSet via REST API.
 * Once populated, your API key can use it for transcription.
 */

import { GoogleAuth } from 'google-auth-library';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from backend/.env if it exists
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const projectId = process.env.GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || 'exbabel-tts-prod';
const phraseSetId = process.env.GOOGLE_PHRASE_SET_ID || 'church-glossary-10k';
// Boost value: 0-20, higher = more likely to recognize these phrases
// Using 20 (maximum) for maximum recognition probability
const boostValue = parseInt(process.env.PHRASESET_BOOST) || 20;

// Load glossary
const glossaryPath = path.join(__dirname, '../../glossary.json');
if (!fs.existsSync(glossaryPath)) {
  console.error(`❌ Error: glossary.json not found at ${glossaryPath}`);
  process.exit(1);
}

const glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));

if (!glossary.phrases || !Array.isArray(glossary.phrases)) {
  console.error('❌ Error: glossary.json must contain a "phrases" array');
  process.exit(1);
}

console.log(`📚 Loaded ${glossary.phrases.length} phrases from glossary.json`);
console.log(`🔧 Updating PhraseSet: ${phraseSetId}`);
console.log(`   Full path: projects/${projectId}/locations/global/phraseSets/${phraseSetId}`);
console.log('');

async function populatePhraseSet() {
  const phraseSetName = `projects/${projectId}/locations/global/phraseSets/${phraseSetId}`;
  const apiUrl = `https://speech.googleapis.com/v1/${phraseSetName}?updateMask=phrases,boost`;

  try {
    // Authenticate using Google Auth Library with explicit credentials path
    const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credentialsPath) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS environment variable not set');
    }
    
    const auth = new GoogleAuth({
      keyFile: credentialsPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    });
    
    const client = await auth.getClient();
    const accessTokenResponse = await client.getAccessToken();
    const accessToken = accessTokenResponse?.token || accessTokenResponse;
    
    if (!accessToken) {
      throw new Error('Failed to get access token');
    }

    console.log('⏳ Updating PhraseSet...');
    
    // Make REST API call to update PhraseSet
    const response = await fetch(apiUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: phraseSetName,
        phrases: glossary.phrases,
        boost: boostValue
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
      const errorMessage = JSON.stringify(errorData);
      throw { message: errorMessage, status: response.status };
    }

    const result = await response.json();

    console.log(`\n✅ PhraseSet populated successfully!`);
    console.log(`   Name: ${result.name}`);
    console.log(`   Phrases: ${glossary.phrases.length}`);
    console.log(`   Boost: ${boostValue} (maximum: 20)`);
    console.log(`\n🎉 Your API key can now use this PhraseSet for transcription!`);
    console.log(`   Make sure GOOGLE_PHRASE_SET_ID and GOOGLE_CLOUD_PROJECT_ID are set in your .env`);
    console.log(`\n💡 Boost value ${boostValue} maximizes recognition probability for glossary terms`);

  } catch (err) {
    const errorMessage = err.message || String(err);
    const status = err.status;
    
    if (status === 404 || errorMessage.includes('404') || errorMessage.includes('NOT_FOUND')) {
      console.error(`\n❌ PhraseSet not found!`);
      console.error(`   Expected: ${phraseSetName}`);
      console.error(`   Make sure you created it in the Google Cloud Console first.`);
      console.error(`   Go to: https://console.cloud.google.com/speech-to-text`);
    } else if (status === 403 || errorMessage.includes('403') || errorMessage.includes('PERMISSION_DENIED')) {
      console.error(`\n❌ Permission denied!`);
      console.error(`   Make sure your Service Account has "Cloud Speech Administrator" role`);
      console.error(`   Go to: https://console.cloud.google.com/iam-admin/serviceaccounts`);
      console.error(`   Edit your Service Account → Add Role → Cloud Speech Administrator`);
    } else if (status === 401 || errorMessage.includes('401') || errorMessage.includes('UNAUTHENTICATED')) {
      console.error(`\n❌ Authentication failed!`);
      console.error(`   Make sure GOOGLE_APPLICATION_CREDENTIALS points to a valid Service Account JSON`);
      console.error(`   Current path: ${process.env.GOOGLE_APPLICATION_CREDENTIALS || 'not set'}`);
      console.error(`   Error details:`, errorMessage);
    } else {
      console.error(`\n❌ Error: ${errorMessage}`);
      console.error(`   Status: ${status}`);
      console.error(`\nFull error:`, err);
    }
    process.exit(1);
  }
}

populatePhraseSet();
