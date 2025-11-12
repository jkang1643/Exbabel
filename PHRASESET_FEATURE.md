# PhraseSet Feature Documentation

## Overview

PhraseSet is a Google Cloud Speech-to-Text feature that improves recognition accuracy for specific terms, phrases, and vocabulary. This is especially useful for domain-specific content like church sermons, technical presentations, or any scenario where certain terms must be recognized accurately.

## What is PhraseSet?

PhraseSet allows you to:
- **Boost recognition probability** for specific terms (up to 20x boost)
- **Improve accuracy** for rare or domain-specific words
- **Handle multi-word phrases** and proper nouns
- **Support large vocabularies** (we use 6,614 phrases)

## Current Configuration

### API Version: v1p1beta1

**Why v1p1beta1?**
- ✅ **v1 API**: Does NOT support PhraseSets (they are silently ignored)
- ✅ **v1p1beta1 API**: DOES support PhraseSets via `adaptation.phraseSets`
- ❌ **v2 API**: Requires a Recognizer resource (adds complexity)

**Decision**: We use **v1p1beta1** because it supports PhraseSets without requiring additional resources.

### Model: `latest_long`

**Model Configuration:**
- **Model**: `latest_long` (Google's enhanced Chirp 3 model)
- **Enhanced Flag**: `useEnhanced: true`
- **Purpose**: Optimized for long-form audio (sermons, lectures, podcasts)
- **PhraseSet Support**: ✅ Fully supported

**Why `latest_long`?**
- Best accuracy for long-form content
- Supports PhraseSets
- Better than default model for sermons

### PhraseSet Settings

**Current PhraseSet:**
- **Name**: `church-glossary-10k`
- **Project**: `222662040787` (gen-lang-client-0417618073)
- **Location**: `global`
- **Full Resource Name**: `projects/222662040787/locations/global/phraseSets/church-glossary-10k`

**Boost Value: 20 (Maximum)**
- Range: 0-20
- Current: 20 (maximum boost)
- Effect: Maximum recognition probability for glossary terms
- Trade-off: Higher boost = better recognition but may increase false positives

**Phrase Count: 6,614 phrases**
- Includes Bible books, theological terms, proper nouns, and phrases
- Examples: "Genesis", "Ephesia/Ephesus", "hallelujah", "the blood of Jesus"

## How It Works

### Request Format (v1p1beta1)

```javascript
{
  config: {
    encoding: 'LINEAR16',
    sampleRateHertz: 24000,
    languageCode: 'en-US',
    useEnhanced: true,
    model: 'latest_long',
    adaptation: {
      phraseSets: [
        {
          name: 'projects/222662040787/locations/global/phraseSets/church-glossary-10k'
        }
      ]
    }
  }
}
```

### Recognition Flow

1. **Audio Input** → Google Speech-to-Text API
2. **PhraseSet Applied** → All 6,614 phrases checked with boost value 20
3. **Recognition** → Terms matching PhraseSet get higher probability
4. **Result** → Improved accuracy for glossary terms

### Detection & Logging

The system automatically detects when PhraseSet terms are recognized:

```
[GoogleSpeech] 🎯✅ PHRASESET TERM RECOGNIZED: "Kush/Cush" in transcript "Kush."
```

This confirms that:
- PhraseSet is active
- The term was in the glossary
- Recognition was successful

## Setup Instructions

### Prerequisites

1. **Google Cloud Project** with Speech-to-Text API enabled
2. **PhraseSet Created** in Google Cloud Console
3. **Environment Variables** configured

### Step 1: Create PhraseSet in Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to **Speech-to-Text > Adaptation**
3. Click **"Create Phrase Set"**
4. Enter:
   - **Name**: `church-glossary-10k` (or your preferred name)
   - **Default Boost**: `20` (maximum)
   - **Location**: `global`
5. Click **"Create"**

**Note**: You'll populate phrases programmatically (see Step 2).

### Step 2: Populate PhraseSet

Use the provided script to populate your PhraseSet:

```bash
# Set up authentication (one-time)
export GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
export GOOGLE_CLOUD_PROJECT_ID=222662040787
export GOOGLE_PHRASE_SET_ID=church-glossary-10k

# Populate PhraseSet from glossary.json
node backend/scripts/populatePhraseSet.js
```

**What this does:**
- Loads phrases from `glossary.json`
- Updates PhraseSet via REST API
- Sets boost value to 20 (maximum)
- Verifies all phrases are loaded

### Step 3: Configure Environment Variables

Add to `backend/.env`:

```bash
# Google Cloud PhraseSet Configuration
GOOGLE_CLOUD_PROJECT_ID=222662040787
GOOGLE_PHRASE_SET_ID=church-glossary-10k
```

**Note**: These are NOT sensitive values (just resource identifiers).

### Step 4: Restart Backend

```bash
# Development
npm run backend:dev

# Production
pm2 restart exbabel-backend
```

### Step 5: Verify It's Working

Check backend logs for:

```
[GoogleSpeech] ✅ PhraseSet ENABLED (v1p1beta1 API): projects/222662040787/locations/global/phraseSets/church-glossary-10k
[GoogleSpeech]    Using adaptation.phraseSets format for PhraseSet support
[GoogleSpeech]    Glossary terms will be recognized with improved accuracy
[GoogleSpeech] ✅ Using latest_long model WITH PhraseSet (v1p1beta1 API - recommended configuration)
```

When you speak a glossary term, you'll see:

```
[GoogleSpeech] 🎯✅ PHRASESET TERM RECOGNIZED: "Term" in transcript "..."
```

## Verification Scripts

### Check PhraseSet Details

```bash
node backend/scripts/verifyPhraseSetDetailed.js
```

Shows:
- Total phrases
- Boost value
- Sample phrases
- Statistics

### Test Specific Term

```bash
node backend/scripts/testSpecificPhrase.js "Ephesia"
```

Tests if a specific term is in the PhraseSet.

## API Version History

### Initial Implementation: v1 API
- ❌ **Problem**: PhraseSets were silently ignored
- ❌ **Result**: No improvement in recognition accuracy

### Attempted Migration: v2 API
- ❌ **Problem**: Requires Recognizer resource
- ❌ **Error**: `RESOURCE_PROJECT_INVALID`
- ❌ **Result**: Too complex for current setup

### Final Solution: v1p1beta1 API
- ✅ **Solution**: Supports PhraseSets without additional resources
- ✅ **Format**: Uses `adaptation.phraseSets` instead of `phraseSetReferences`
- ✅ **Result**: PhraseSets work correctly

## Boost Value Guidelines

### Current: 20 (Maximum)

**When to use maximum boost (20):**
- Rare terms that are frequently misrecognized
- Domain-specific vocabulary
- Proper nouns (names, places)
- Multi-word phrases

**When to reduce boost:**
- Common words (may cause false positives)
- Terms that sound similar to common words
- If you notice over-recognition

**How to adjust:**

```bash
# Set custom boost value
export PHRASESET_BOOST=15
node backend/scripts/populatePhraseSet.js
```

**Recommended values:**
- **20**: Maximum (current) - for rare terms
- **15**: High - for important terms
- **10**: Medium - balanced approach
- **5**: Low - subtle improvement

## Troubleshooting

### PhraseSet Not Appearing in Logs

**Check environment variables:**
```bash
cd backend
cat .env | grep GOOGLE_CLOUD_PROJECT_ID
cat .env | grep GOOGLE_PHRASE_SET_ID
```

**Verify PhraseSet exists:**
```bash
node backend/scripts/verifyPhraseSet.js
```

### Terms Not Being Recognized

1. **Check if term is in glossary:**
   ```bash
   grep -i "term" glossary.json
   ```

2. **Verify PhraseSet is populated:**
   ```bash
   node backend/scripts/verifyPhraseSetDetailed.js
   ```

3. **Check boost value:**
   - Should be 20 for maximum recognition
   - Lower values = less aggressive matching

4. **Test with verbose logging:**
   ```bash
   DEBUG_PHRASESET=true npm run backend:dev
   ```

### API Version Errors

**If you see `RESOURCE_PROJECT_INVALID`:**
- You're likely using v2 API
- Switch to v1p1beta1 (already configured)

**If you see `adaptation not supported`:**
- You're using v1 API
- Switch to v1p1beta1 (already configured)

### Boost Value Not Applied

**Check PhraseSet boost:**
```bash
node backend/scripts/verifyPhraseSetDetailed.js
```

**Re-populate with correct boost:**
```bash
export PHRASESET_BOOST=20
node backend/scripts/populatePhraseSet.js
```

## Performance Considerations

### PhraseSet Size
- **Current**: 6,614 phrases
- **Limit**: ~10,000 phrases (recommended)
- **Impact**: Minimal - PhraseSet is applied server-side

### Recognition Accuracy
- **Improvement**: Significant for glossary terms
- **Trade-off**: Slight increase in processing time (negligible)
- **False Positives**: Possible with high boost values

### Cost Impact
- **No additional cost** for PhraseSet usage
- Same pricing as standard Speech-to-Text API
- Boost value doesn't affect pricing

## Best Practices

1. **Keep glossary updated**: Add new terms as needed
2. **Monitor recognition**: Watch for false positives
3. **Adjust boost**: Lower if too aggressive, higher if missing terms
4. **Test regularly**: Verify terms are being recognized
5. **Document terms**: Keep track of what's in your glossary

## Future Enhancements

Potential improvements:
- **Custom boost per phrase**: Different boost values for different terms
- **Dynamic PhraseSet**: Update phrases without restarting
- **Multiple PhraseSets**: Use different PhraseSets for different contexts
- **Analytics**: Track which terms are recognized most often

## Related Files

- **Code**: `backend/googleSpeechStream.js` (PhraseSet integration)
- **Scripts**: `backend/scripts/populatePhraseSet.js` (populate PhraseSet)
- **Glossary**: `glossary.json` (source of phrases)
- **Config**: `env-template-backend.txt` (environment variables)

## References

- [Google Cloud Speech-to-Text Adaptation](https://cloud.google.com/speech-to-text/docs/adaptation-model)
- [PhraseSet Documentation](https://cloud.google.com/speech-to-text/docs/adaptation-model#phrase-sets)
- [API v1p1beta1 Reference](https://cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v1p1beta1)

---

**Last Updated**: 2024-11-11  
**API Version**: v1p1beta1  
**Model**: latest_long  
**Boost Value**: 20 (maximum)  
**Phrase Count**: 6,614

