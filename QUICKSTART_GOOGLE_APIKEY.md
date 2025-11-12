# Quick Start: Google Speech with API Key (Simple Method)

**Much simpler than service account JSON!** ✨

## Why This is Better

- ❌ **No JSON files** to download and manage
- ❌ **No service accounts** to create
- ✅ **Just an API key** like OpenAI
- ✅ **5 minutes setup** instead of 30

## Step 1: Create Google Cloud Project (2 minutes)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Create Project" or select existing project
3. Note your **Project ID** (you'll need this)

## Step 2: Enable Speech-to-Text API (1 minute)

1. Go to [Speech-to-Text API](https://console.cloud.google.com/apis/library/speech.googleapis.com)
2. Click **"Enable"**
3. Wait for it to activate (~30 seconds)

## Step 3: Create API Key (2 minutes)

1. Go to [Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **"Create Credentials"** → **"API Key"**
3. Copy your API key (looks like: `AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)
4. **IMPORTANT**: Click "Edit API Key" and:
   - Under "API restrictions" → Select "Restrict key"
   - Check **"Cloud Speech-to-Text API"**
   - Click "Save"

## Step 4: Configure Your App

Create or edit `backend/.env`:

```bash
# Google Speech (just the API key!)
GOOGLE_SPEECH_API_KEY=AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# OpenAI for translation
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Google Cloud PhraseSet (Optional - improves recognition accuracy)
# See PHRASESET_FEATURE.md for setup instructions
# GOOGLE_CLOUD_PROJECT_ID=your-project-id
# GOOGLE_PHRASE_SET_ID=your-phrase-set-id

# Server
PORT=3001
```

**That's it!** No JSON files, no service accounts! 🎉

## Step 5: Test

```bash
cd backend
npm start
```

Look for:
```
[Backend] Google Cloud: API Key configured ✓ (simple mode)
```

## API Key vs Service Account JSON

### API Key (This Method)
✅ Simple - just one string  
✅ Easy to rotate  
✅ Works everywhere  
⚠️ Less secure for production  
⚠️ Can't restrict by IP (without additional setup)  

### Service Account JSON (Alternative)
✅ More secure  
✅ Granular permissions  
✅ Best for production  
❌ More complex setup  
❌ File management required  

## Security Best Practices

1. **Restrict your API key** to Speech-to-Text only (step 3 above)
2. **Add to .gitignore** (already done):
   ```bash
   # .env is already in .gitignore
   ```
3. **Rotate periodically** (every 90 days)
4. **For production**: Consider using service account JSON instead

## Troubleshooting

### "API key not valid"
- Make sure you enabled Speech-to-Text API
- Check that API key is restricted to Speech-to-Text
- Verify no typos in .env file

### "Permission denied"
- Enable Speech-to-Text API in your project
- Wait 1-2 minutes after enabling
- Check billing is enabled (required for API usage)

### Still not working?
- Try the service account JSON method (see `GOOGLE_CLOUD_SETUP.md`)
- Check backend logs for detailed error messages

## Pricing

Same as service account method:
- **Standard**: $0.006 per 15 seconds
- **Enhanced models**: $0.009 per 15 seconds  
- **First 60 minutes free per month**

## Comparison to OpenAI

```
OpenAI Realtime API: 
- $0.06/minute input + $0.24/minute output
- No true partial results

Google Speech + OpenAI Translation:
- ~$0.024/minute transcription
- ~$0.005 per translation (finals only)
- TRUE word-by-word partials ✨
```

## Optional: Enable PhraseSet for Better Accuracy

PhraseSet improves recognition for specific terms (e.g., church glossary, technical terms):

1. Create PhraseSet in Google Cloud Console
2. Populate with: `node backend/scripts/populatePhraseSet.js`
3. Add to `.env`:
   ```bash
   GOOGLE_CLOUD_PROJECT_ID=your-project-id
   GOOGLE_PHRASE_SET_ID=your-phrase-set-id
   ```

See **[PHRASESET_FEATURE.md](PHRASESET_FEATURE.md)** for complete setup guide.

## Next Steps

Once it's working:
- Try different languages
- Test the live partial results
- Monitor your API usage in Google Cloud Console
- Consider enabling PhraseSet for domain-specific terms

## Switch to Service Account Later

If you need more security, you can switch to service account JSON later:

1. Follow `GOOGLE_CLOUD_SETUP.md`
2. Change `.env` from:
   ```bash
   GOOGLE_SPEECH_API_KEY=xxx
   ```
   to:
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=./google-credentials.json
   ```

That's it! The code supports both methods automatically. 🚀

