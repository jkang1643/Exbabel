# CI/CD Update: PhraseSet Configuration

## What Changed

1. ✅ Added `google-auth-library` package (already in `package.json`)
2. ✅ Added PhraseSet support to Google Speech streaming
3. ✅ **API Version**: Migrated to v1p1beta1 (required for PhraseSet support)
4. ✅ **Model**: Using `latest_long` with PhraseSet enabled
5. ✅ **Boost Value**: 20 (maximum) for best recognition accuracy
6. ✅ New environment variables needed: `GOOGLE_CLOUD_PROJECT_ID` and `GOOGLE_PHRASE_SET_ID`

## Technical Details

**API Version Migration:**
- **From**: v1 API (PhraseSets not supported)
- **To**: v1p1beta1 API (PhraseSets fully supported)
- **Format**: Uses `adaptation.phraseSets` instead of `phraseSetReferences`

**Model Configuration:**
- **Model**: `latest_long` (Google's enhanced Chirp 3)
- **Enhanced Flag**: `useEnhanced: true`
- **PhraseSet Support**: ✅ Fully compatible

**PhraseSet Settings:**
- **Boost Value**: 20 (maximum)
- **Phrase Count**: 6,614 phrases
- **Resource**: `projects/222662040787/locations/global/phraseSets/church-glossary-10k`

See **[PHRASESET_FEATURE.md](PHRASESET_FEATURE.md)** for complete documentation.

## What You Need to Do for CI/CD

### 1. Update EC2 Instance .env File

**SSH into your EC2 instance and add the new environment variables:**

```bash
ssh -i your-key.pem ubuntu@YOUR_EC2_IP
cd /home/ubuntu/realtimetranslationapp/backend
nano .env
```

**Add these lines to your `.env` file:**

```bash
# Google Cloud PhraseSet Configuration (Optional - improves recognition accuracy)
GOOGLE_CLOUD_PROJECT_ID=222662040787
GOOGLE_PHRASE_SET_ID=church-glossary-10k
```

**Save and exit** (Ctrl+X, then Y, then Enter)

### 2. Restart Backend Service

After updating `.env`, restart the backend:

```bash
pm2 restart exbabel-backend
```

Or run the deployment script:

```bash
cd /home/ubuntu/realtimetranslationapp
./deploy-backend.sh
```

### 3. Verify It's Working

Check the logs to see PhraseSet is enabled:

```bash
pm2 logs exbabel-backend --lines 50
```

You should see:
```
[GoogleSpeech] ✅ PhraseSet ENABLED: projects/222662040787/locations/global/phraseSets/church-glossary-10k
[GoogleSpeech]    Glossary terms will be recognized with improved accuracy
```

## What Happens Automatically

✅ **Package Installation**: `npm install` in CI/CD will automatically install `google-auth-library` (it's already in `package.json`)

✅ **Code Deployment**: When you push code, the CI/CD pipeline will:
- Pull latest code
- Run `npm install` (installs google-auth-library automatically)
- Restart the backend

✅ **No GitHub Secrets Needed**: The PhraseSet environment variables are stored in EC2's `.env` file, not in GitHub secrets (they're not sensitive)

## Important Notes

1. **PhraseSet is Optional**: If you don't add these variables, transcription will still work, just without the improved accuracy for glossary terms.

2. **One-Time Setup**: You only need to add these variables once to your EC2 `.env` file. Future deployments won't overwrite your `.env` file.

3. **The PhraseSet Already Exists**: The PhraseSet `church-glossary-10k` with 6,614 phrases is already created and populated in Google Cloud. You just need to reference it.

## Quick Checklist

- [ ] SSH into EC2 instance
- [ ] Edit `/home/ubuntu/realtimetranslationapp/backend/.env`
- [ ] Add `GOOGLE_CLOUD_PROJECT_ID=222662040787`
- [ ] Add `GOOGLE_PHRASE_SET_ID=church-glossary-10k`
- [ ] Save the file
- [ ] Restart backend: `pm2 restart exbabel-backend`
- [ ] Verify logs show PhraseSet enabled

## Troubleshooting

### PhraseSet not showing in logs

1. Check environment variables are set:
   ```bash
   cd /home/ubuntu/realtimetranslationapp/backend
   cat .env | grep GOOGLE_CLOUD_PROJECT_ID
   cat .env | grep GOOGLE_PHRASE_SET_ID
   ```

2. Make sure backend restarted after adding variables:
   ```bash
   pm2 restart exbabel-backend
   ```

3. Check logs:
   ```bash
   pm2 logs exbabel-backend --lines 100
   ```

### Backend won't start

Check for syntax errors in `.env`:
```bash
cd /home/ubuntu/realtimetranslationapp/backend
source .env  # This will show errors if syntax is wrong
```

---

**That's it!** Once you add those two environment variables to your EC2 `.env` file, the PhraseSet will be automatically used for all transcriptions.

