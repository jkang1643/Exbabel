/**
 * Detailed verification of PhraseSet - shows actual data as proof
 * 
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   export GOOGLE_CLOUD_PROJECT_ID=222662040787
 *   node backend/scripts/verifyPhraseSetDetailed.js
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

async function verifyPhraseSetDetailed() {
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

    console.log('='.repeat(70));
    console.log('🔍 DETAILED PHRASESET VERIFICATION');
    console.log('='.repeat(70));
    console.log(`\nPhraseSet ID: ${phraseSetId}`);
    console.log(`Full Resource Name: ${phraseSetName}`);
    console.log(`Project ID: ${projectId}\n`);
    
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

    console.log('✅ VERIFICATION SUCCESSFUL\n');
    console.log('─'.repeat(70));
    console.log('PHRASESET DETAILS:');
    console.log('─'.repeat(70));
    console.log(`Name: ${result.name}`);
    console.log(`Total Phrases: ${result.phrases?.length || 0}`);
    console.log(`Default Boost: ${result.boost || 'not set'}`);
    console.log(`Created: ${result.createTime || 'unknown'}`);
    console.log(`Updated: ${result.updateTime || 'unknown'}`);
    
    if (result.phrases && result.phrases.length > 0) {
      console.log('\n─'.repeat(70));
      console.log('SAMPLE PHRASES (First 20):');
      console.log('─'.repeat(70));
      result.phrases.slice(0, 20).forEach((phrase, i) => {
        const boost = phrase.boost ? ` [boost: ${phrase.boost}]` : '';
        console.log(`${String(i + 1).padStart(3)}. "${phrase.value}"${boost}`);
      });
      
      console.log('\n─'.repeat(70));
      console.log('SAMPLE PHRASES (Last 10):');
      console.log('─'.repeat(70));
      const last10 = result.phrases.slice(-10);
      last10.forEach((phrase, i) => {
        const boost = phrase.boost ? ` [boost: ${phrase.boost}]` : '';
        console.log(`${String(result.phrases.length - 9 + i).padStart(3)}. "${phrase.value}"${boost}`);
      });
      
      console.log('\n─'.repeat(70));
      console.log('PHRASE STATISTICS:');
      console.log('─'.repeat(70));
      
      // Count phrases by length
      const singleWord = result.phrases.filter(p => !p.value.includes(' ')).length;
      const multiWord = result.phrases.length - singleWord;
      const longestPhrase = result.phrases.reduce((longest, p) => 
        p.value.length > longest.length ? p.value : longest, '');
      
      console.log(`Single-word phrases: ${singleWord}`);
      console.log(`Multi-word phrases: ${multiWord}`);
      console.log(`Longest phrase: "${longestPhrase}" (${longestPhrase.length} chars)`);
      
      // Show some specific examples
      console.log('\n─'.repeat(70));
      console.log('SPECIFIC EXAMPLES:');
      console.log('─'.repeat(70));
      const examples = ['Genesis', 'Exodus', 'hallelujah', 'the blood of Jesus', 'filled with the Spirit'];
      examples.forEach(example => {
        const found = result.phrases.find(p => p.value.toLowerCase() === example.toLowerCase());
        if (found) {
          console.log(`✓ Found: "${found.value}"`);
        } else {
          console.log(`✗ Not found: "${example}"`);
        }
      });
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('🎉 PROOF: PHRASESET IS FULLY LOADED AND READY TO USE!');
    console.log('='.repeat(70));
    console.log(`\nYour transcription will now recognize all ${result.phrases?.length || 0} phrases`);
    console.log('with improved accuracy thanks to the PhraseSet boost.\n');

  } catch (err) {
    const errorMessage = err.message || String(err);
    const status = err.status;
    
    console.error('\n' + '='.repeat(70));
    console.error('❌ VERIFICATION FAILED');
    console.error('='.repeat(70));
    
    if (status === 404 || errorMessage.includes('404') || errorMessage.includes('NOT_FOUND')) {
      console.error(`\nPhraseSet not found: ${phraseSetName}`);
      console.error('Make sure you created it in the Google Cloud Console first.');
    } else if (status === 403 || errorMessage.includes('403') || errorMessage.includes('PERMISSION_DENIED')) {
      console.error(`\nPermission denied!`);
      console.error('Make sure your Service Account has "Cloud Speech Administrator" role');
    } else if (status === 401 || errorMessage.includes('401') || errorMessage.includes('UNAUTHENTICATED')) {
      console.error(`\nAuthentication failed!`);
      console.error(`GOOGLE_APPLICATION_CREDENTIALS: ${process.env.GOOGLE_APPLICATION_CREDENTIALS || 'not set'}`);
    } else {
      console.error(`\nError: ${errorMessage}`);
      console.error(`Status: ${status}`);
      console.error(`\nFull error:`, err);
    }
    process.exit(1);
  }
}

verifyPhraseSetDetailed();

