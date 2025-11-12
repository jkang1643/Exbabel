/**
 * Verify PhraseSet exists and show its details
 * 
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   export GOOGLE_CLOUD_PROJECT_ID=222662040787
 *   node backend/scripts/verifyPhraseSet.js
 */

import { GoogleAuth } from 'google-auth-library';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from backend/.env if it exists
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || '222662040787';
const phraseSetId = process.env.GOOGLE_PHRASE_SET_ID || 'church-glossary-10k';

async function verifyPhraseSet() {
  const phraseSetName = `projects/${projectId}/locations/global/phraseSets/${phraseSetId}`;
  const apiUrl = `https://speech.googleapis.com/v1/${phraseSetName}`;

  try {
    // Authenticate using Google Auth Library
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

    console.log(`🔍 Checking PhraseSet: ${phraseSetId}`);
    console.log(`   Full path: ${phraseSetName}\n`);
    
    // Make REST API call to get PhraseSet
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw { message: JSON.stringify(errorData), status: response.status };
    }

    const result = await response.json();

    console.log(`✅ PhraseSet found!\n`);
    console.log(`   Name: ${result.name}`);
    console.log(`   Phrases: ${result.phrases?.length || 0}`);
    console.log(`   Boost: ${result.boost || 'not set'}`);
    
    if (result.phrases && result.phrases.length > 0) {
      console.log(`\n   Sample phrases (first 10):`);
      result.phrases.slice(0, 10).forEach((phrase, i) => {
        console.log(`   ${i + 1}. "${phrase.value}"${phrase.boost ? ` (boost: ${phrase.boost})` : ''}`);
      });
      if (result.phrases.length > 10) {
        console.log(`   ... and ${result.phrases.length - 10} more phrases`);
      }
    }
    
    console.log(`\n🎉 PhraseSet is loaded and ready to use!`);

  } catch (err) {
    const errorMessage = err.message || String(err);
    const status = err.status;
    
    if (status === 404 || errorMessage.includes('404') || errorMessage.includes('NOT_FOUND')) {
      console.error(`\n❌ PhraseSet not found!`);
      console.error(`   Expected: ${phraseSetName}`);
      console.error(`   Make sure you created it in the Google Cloud Console first.`);
    } else if (status === 403 || errorMessage.includes('403') || errorMessage.includes('PERMISSION_DENIED')) {
      console.error(`\n❌ Permission denied!`);
      console.error(`   Make sure your Service Account has "Cloud Speech Administrator" role`);
    } else if (status === 401 || errorMessage.includes('401') || errorMessage.includes('UNAUTHENTICATED')) {
      console.error(`\n❌ Authentication failed!`);
      console.error(`   Make sure GOOGLE_APPLICATION_CREDENTIALS points to a valid Service Account JSON`);
      console.error(`   Current path: ${process.env.GOOGLE_APPLICATION_CREDENTIALS || 'not set'}`);
    } else {
      console.error(`\n❌ Error: ${errorMessage}`);
      console.error(`   Status: ${status}`);
      console.error(`\nFull error:`, err);
    }
    process.exit(1);
  }
}

verifyPhraseSet();

