# Google Cloud Speech-to-Text Setup Guide

This guide will help you set up Google Cloud Speech-to-Text API for live streaming transcription with Chirp 3.

## 🚀 Quick Start (5 minutes)

**Want the simple way?** Use an API key instead of JSON!

👉 See **[QUICKSTART_GOOGLE_APIKEY.md](QUICKSTART_GOOGLE_APIKEY.md)** for the easiest setup (just like OpenAI)

This guide below covers the **service account JSON method** (more secure for production).

---

## Architecture Overview

**Exbabel now uses a dual-service architecture:**

1. **Google Cloud Speech-to-Text** - For live streaming transcription with partial results
   - Model: Chirp 3 (`latest_long`)
   - Features: Word-by-word interim results, high accuracy, multilingual support
   - Streaming limit: 4 minutes per stream (auto-restarts)

2. **OpenAI Chat API** - For translation of final transcripts
   - Model: `gpt-4o`
   - Translates finalized transcripts to target languages

## Prerequisites

- A Google Cloud account
- Node.js and npm installed
- OpenAI API key (for translation)

## Step 1: Create a Google Cloud Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Click on the project dropdown at the top
3. Click "New Project"
4. Enter a project name (e.g., "exbabel-app")
5. Click "Create"

## Step 2: Enable the Speech-to-Text API

1. In the Google Cloud Console, go to **APIs & Services > Library**
2. Search for "Speech-to-Text API"
3. Click on "Cloud Speech-to-Text API"
4. Click "Enable"

## Step 3: Create a Service Account

1. Go to **APIs & Services > Credentials**
2. Click "Create Credentials" > "Service Account"
3. Enter a service account name (e.g., "exbabel-speech")
4. Click "Create and Continue"
5. Grant the role: **"Cloud Speech Client"** or **"Cloud Speech Administrator"**
6. Click "Continue" then "Done"

## Step 4: Generate and Download Credentials

1. In the **Credentials** page, find your service account
2. Click on the service account email
3. Go to the **Keys** tab
4. Click "Add Key" > "Create New Key"
5. Choose **JSON** format
6. Click "Create"
7. The key file will download automatically - **keep this secure!**

## Step 5: Configure Your Application

### Option A: Local Development (Recommended)

1. Move the downloaded JSON key file to your backend directory:
   ```bash
   mv ~/Downloads/your-project-xxxxx.json backend/google-credentials.json
   ```

2. Create or update `backend/.env`:
   ```bash
   # Transcription (Google Cloud)
   GOOGLE_APPLICATION_CREDENTIALS=./google-credentials.json

   # Translation (OpenAI)
   OPENAI_API_KEY=your_openai_api_key_here

   # Server
   PORT=3001
   ```

3. **IMPORTANT:** Add the credentials file to `.gitignore`:
   ```bash
   echo "backend/google-credentials.json" >> .gitignore
   ```

### Option B: Production Deployment

For production on Google Cloud Platform (GCP):

1. Use Google Cloud's default credentials (no file needed)
2. Set up Application Default Credentials:
   ```bash
   gcloud auth application-default login
   ```

3. Or deploy to GCP services (Cloud Run, GKE, etc.) which automatically provide credentials

## Step 6: Install Dependencies

The `@google-cloud/speech` package has already been added to your project:

```bash
cd backend
npm install
```

## Step 7: Test Your Setup

1. Start the backend server:
   ```bash
   cd backend
   npm start
   ```

2. Look for these startup messages:
   ```
   [Backend] ===== TRANSCRIPTION SERVICE =====
   [Backend] Provider: Google Cloud Speech-to-Text
   [Backend] Model: Chirp 3 (latest_long)
   [Backend] Google Cloud: Credentials configured ✓
   ```

3. Check the health endpoint:
   ```bash
   curl http://localhost:3001/health
   ```

   You should see:
   ```json
   {
     "status": "ok",
     "transcriptionProvider": "Google Cloud Speech-to-Text",
     "transcriptionModel": "Chirp 3 (latest_long)",
     "translationProvider": "OpenAI",
     "translationModel": "gpt-4o"
   }
   ```

## Language Support

Google Cloud Speech-to-Text supports **100+ languages** including:

- English (en-US, en-GB, en-AU, etc.)
- Spanish (es-ES, es-MX, es-AR, etc.)
- French (fr-FR, fr-CA)
- German (de-DE)
- Japanese (ja-JP)
- Chinese (zh-CN, zh-TW)
- Korean (ko-KR)
- And many more...

See the full list: https://cloud.google.com/speech-to-text/docs/languages

## Features of the New Architecture

### Live Partial Results
- **Word-by-word streaming**: See transcription appear as you speak
- **High accuracy**: Chirp 3 model provides superior accuracy
- **Low latency**: Partial results delivered in real-time

### Automatic Stream Management
- Auto-restart before 4-minute streaming limit
- Seamless continuation across stream boundaries
- Automatic punctuation and formatting

### PhraseSet Support (Optional)
- **Improved accuracy** for domain-specific terms (e.g., church glossary)
- **6,614 phrases** with maximum boost (20) for better recognition
- **API Version**: v1p1beta1 (required for PhraseSet support)
- **Model**: `latest_long` with PhraseSet enabled
- See **[PHRASESET_FEATURE.md](PHRASESET_FEATURE.md)** for complete documentation

### Translation Pipeline
1. Audio → Google Speech → Live partial transcript (shown immediately)
2. Speech pause detected → Final transcript
3. Final transcript → OpenAI → Translation (to target language)
4. Translation displayed to user

## Pricing

### Google Cloud Speech-to-Text
- **Standard**: $0.006 per 15 seconds (~$1.44 per hour)
- **Enhanced models**: $0.009 per 15 seconds (~$2.16 per hour)
- **First 60 minutes free per month**

See: https://cloud.google.com/speech-to-text/pricing

### OpenAI API
- **GPT-4o**: ~$0.005 per 1K tokens (translation only)
- Much cheaper than previous approach since only final transcripts are translated

## Troubleshooting

### Error: "Could not load the default credentials"
- Make sure `GOOGLE_APPLICATION_CREDENTIALS` points to a valid JSON file
- Check that the path is correct (relative to backend directory)
- Verify the service account has "Cloud Speech Client" role

### Error: "API has not been enabled"
- Go to Google Cloud Console
- Enable the "Cloud Speech-to-Text API"
- Wait a few minutes for propagation

### Error: "Quota exceeded"
- Check your Google Cloud quotas in the console
- Upgrade to a billing-enabled account for higher limits
- Monitor usage in the Google Cloud Console

### No partial results appearing
- Verify `interimResults: true` in the configuration
- Check that audio is being received (check console logs)
- Ensure frontend is handling `isPartial: true` messages

## Security Best Practices

1. **Never commit credentials to git**
   - Always use `.gitignore` for credential files
   - Use environment variables in production

2. **Restrict service account permissions**
   - Only grant "Cloud Speech Client" role
   - Don't use owner/editor roles

3. **Rotate credentials periodically**
   - Create new keys every 90 days
   - Delete old keys after rotation

4. **Monitor API usage**
   - Set up billing alerts
   - Review usage regularly in Cloud Console

## Next Steps

- Test with different languages
- Adjust stream restart timing if needed
- Monitor costs and optimize as needed
- Consider using Google Cloud's VPC for enhanced security

## Support

For issues:
- Google Cloud Speech-to-Text docs: https://cloud.google.com/speech-to-text/docs
- OpenAI API docs: https://platform.openai.com/docs
- Check backend logs for detailed error messages

