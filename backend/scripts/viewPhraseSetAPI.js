/**
 * View PhraseSet using REST API (faster than console)
 * 
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   export GOOGLE_CLOUD_PROJECT_ID=222662040787
 *   node backend/scripts/viewPhraseSetAPI.js
 */

import { GoogleAuth } from 'google-auth-library';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || '222662040787';
const phraseSetId = process.env.GOOGLE_PHRASE_SET_ID || 'church-glossary-10k';

async function viewPhraseSet() {
  // Use API v1 (v2 may not be available for all resources)
  const phraseSetName = `projects/${projectId}/locations/global/phraseSets/${phraseSetId}`;
  const apiUrl = `https://speech.googleapis.com/v1/${phraseSetName}`;

  try {
    // Authenticate
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

    console.log('🔍 Fetching PhraseSet via REST API (v1)...');
    console.log(`   URL: ${apiUrl}\n`);
    
    // Make REST API call
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

    console.log('✅ PhraseSet Retrieved Successfully\n');
    console.log('─'.repeat(70));
    console.log('BASIC INFO:');
    console.log('─'.repeat(70));
    console.log(`Name: ${result.name}`);
    console.log(`Phrases Count: ${result.phrases?.length || 0}`);
    console.log(`Boost: ${result.boost || 'not set'}`);
    console.log(`Create Time: ${result.createTime || 'unknown'}`);
    console.log(`Update Time: ${result.updateTime || 'unknown'}`);
    
    if (result.phrases && result.phrases.length > 0) {
      console.log('\n─'.repeat(70));
      console.log('SAMPLE PHRASES (First 5):');
      console.log('─'.repeat(70));
      result.phrases.slice(0, 5).forEach((phrase, i) => {
        console.log(`  ${i + 1}. "${phrase.value}"`);
      });
      
      console.log('\n─'.repeat(70));
      console.log('SAMPLE PHRASES (Last 5):');
      console.log('─'.repeat(70));
      result.phrases.slice(-5).forEach((phrase, i) => {
        const idx = result.phrases.length - 4 + i;
        console.log(`  ${idx}. "${phrase.value}"`);
      });
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('💡 TIP: To view full PhraseSet, use:');
    console.log(`   curl -H "Authorization: Bearer $(gcloud auth print-access-token)" \\`);
    console.log(`     "${apiUrl}" | jq`);
    console.log('='.repeat(70));

  } catch (err) {
    const errorMessage = err.message || String(err);
    const status = err.status;
    
    console.error('\n❌ Error:', errorMessage);
    if (status) {
      console.error(`   Status: ${status}`);
    }
    process.exit(1);
  }
}

viewPhraseSet();

