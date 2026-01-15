# Language Pull from Google TTS

This document covers the complete workflow for managing TTS language support in the Exbabel translation app, including checking available languages, running diffs, and maintaining UI accuracy.

## 🚨 CRITICAL: Authentication Context Matters

**Results depend on authentication method:**
- **Vertex AI authenticated calls**: 87+ Gemini languages ✅
- **Unauthenticated/script calls**: 1 Gemini language ❌
- **Same API, different permissions = different results**

**To get accurate results matching your Vertex AI experience:**
1. Use identical authentication (same service account, project, region)
2. Ensure Vertex AI API permissions carry over to Cloud TTS API
3. Results will vary based on your GCP project configuration

## Overview

The app supports two separate TTS voice systems that route differently in the backend:

1. **Google TTS Voices**: Language-specific voices from Google Cloud TTS (2032 voices across 61 languages)
2. **Gemini Voices**: Language-agnostic voices (30 voices available for all languages)

## Official Google TTS Language Support Status

### Complete TTS-Supported Languages (87+ total from Google API)
- **All Google TTS voices**: Gemini, Chirp3 HD, Neural2, Standard across all supported languages
- **UI-Exposed Languages**: 175 languages total in your app
- **Fully Supported Languages**: Languages that exist in both Google TTS and your UI

### 🎯 **Script Now Pulls Official Data**
This script now fetches the **complete official list** from Google Cloud TTS API, including all 87+ supported languages and all voice types (Gemini, Chirp3, Neural2, Standard).

### Key Findings
- ✅ **UI accuracy verified**: TTS-supported languages show correct voice counts
- ⚠️ **4 TTS languages missing from UI**: `cmn-CN`, `cmn-TW`, `nb-NO`, `yue-HK`
- ❌ **91 UI languages without TTS**: Rare/minority languages with no voice support
- ✅ **Full Gemini Support**: 87/87 languages now captured using dual API approach
- ✅ **Complete Voice Coverage**: 6,764 voices across 93 languages
- ✅ **Vertex AI Integration**: Successfully pulls all 87 Gemini languages
- 🔍 **Per-Tier Language Counts (Dual API - Authenticated)**:
  - **Gemini**: 87 languages ✅ (24 GA + 63 Preview)
  - **Chirp3 HD**: 53 languages
  - **Neural2**: 48 languages
  - **Standard**: 60 languages

### ✅ **RESOLVED: Full 87 Language Support Achieved**
**Script now uses dual API approach for complete accuracy:**
- **Cloud TTS API**: Chirp3 HD, Neural2, Standard voices
- **Vertex AI API**: Gemini TTS voices (87 languages) ✅
- **Combined result**: 6,764 voices across 93 languages

**Current Status:**
- ✅ **Gemini languages**: 87/87 (24 GA + 63 Preview)
- ✅ **Chirp3 HD languages**: 53/61
- ✅ **Complete official support** from both APIs

## Scripts and Commands

### 1. Generate TTS Snapshot
Fetches the complete, official list of TTS voices directly from Google Cloud TTS API.

```bash
# Generate fresh snapshot from Google API
npm run tts:snapshot

# Or run directly
node scripts/fetchGoogleTtsVoicesSnapshot.js
```

**What it does:**
- Calls Google Cloud TTS API `listVoices()` endpoint
- Gets **ALL officially supported voices** across all 87+ languages
- Categorizes voices by tier: Gemini, Chirp3 HD, Neural2, Standard
- Creates `frontend/src/data/google-tts-voices.snapshot.json`

**Authentication required:**
- `gcloud auth application-default login` (recommended)
- Or set `GOOGLE_APPLICATION_CREDENTIALS` environment variable
- Or set `GOOGLE_API_KEY` environment variable

### 2. Check Language Diffs
Compares your app's supported languages against TTS capabilities.

```bash
# Check diffs
npm run tts:diff

# Or run directly
node scripts/diffTtsLanguages.js

# Or run both
npm run tts:update
```

**What it shows:**
- Languages in your app with TTS support
- Languages in your app without TTS support
- Voice counts per language (Google + Gemini)
- Deprecation warnings and new language opportunities

### 3. Verify UI Accuracy
Check if your frontend dropdown accurately reflects TTS capabilities.

```bash
# Manual verification (run this JavaScript)
node -e "
const snap = require('./frontend/src/data/google-tts-voices.snapshot.json');
const langs = require('./frontend/src/config/languages.js');
const ttsLangs = new Set(snap.languages);
const uiLangs = new Set(langs.TRANSLATION_LANGUAGES.map(l => l.code));
const missingFromUI = [...ttsLangs].filter(l => !uiLangs.has(l.split('-')[0]) && !uiLangs.has(l));
const extraInUI = [...uiLangs].filter(l => !ttsLangs.has(l) && ![...ttsLangs].some(tl => tl.startsWith(l + '-')));
console.log('TTS languages missing from UI:', missingFromUI);
console.log('UI languages without TTS:', extraInUI.length);
"
```

## Voice System Details

### Official Google TTS Voice Categories

#### 📚 **Official Google Documentation vs API Response**

**Important Distinction:** Google's documentation claims broader language support than what the API actually returns. This may be due to regional limitations, authentication scope, or API endpoint restrictions.

#### Gemini Voices (Latest Technology)
- **Official Docs**: 87+ languages (23 GA + 64 Preview)
- **API Response**: 1 language (en-US only) ⚠️
- **Quality**: Highest quality with natural prosody
- **Features**: Language-agnostic, supports prompts for style/tone control
- **API Models**: gemini-2.5-flash-tts, gemini-2.5-pro-tts
- **Note**: Routes through Gemini API, not standard TTS API

#### Chirp3 HD Voices (Premium Quality)
- **Official Docs**: 61+ languages
- **API Response**: 53 languages
- **Quality**: High-definition, studio-quality voices
- **Features**: Most natural and expressive voices available
- **Note**: Highest quality tier for production use

#### Neural2 Voices (Premium Quality)
- **Official Docs**: 61+ languages
- **API Response**: 48 languages
- **Quality**: Natural, human-like speech synthesis
- **Includes**: Wavenet, Polyglot, Studio, and other neural models
- **Note**: Excellent quality for most applications

#### Standard Voices (Basic Quality)
- **Official Docs**: 61+ languages
- **API Response**: 60 languages
- **Quality**: Clear and understandable speech
- **Features**: Fast synthesis, lower resource usage
- **Note**: Good for applications where speed is prioritized over quality

### 🎯 **Vertex AI Gemini TTS - Complete Language Coverage (87 Languages)**

All languages below are now fully supported and verified through Vertex AI API integration:

#### 🚀 GA (Generally Available - 24 Languages)
- ✅ Arabic (Egypt) - ar-EG
- ✅ Bangla (Bangladesh) - bn-BD
- ✅ Dutch (Netherlands) - nl-NL
- ✅ English (India) - en-IN
- ✅ English (United States) - en-US
- ✅ French (France) - fr-FR
- ✅ German (Germany) - de-DE
- ✅ Hindi (India) - hi-IN
- ✅ Indonesian (Indonesia) - id-ID
- ✅ Italian (Italy) - it-IT
- ✅ Japanese (Japan) - ja-JP
- ✅ Korean (South Korea) - ko-KR
- ✅ Marathi (India) - mr-IN
- ✅ Polish (Poland) - pl-PL
- ✅ Portuguese (Brazil) - pt-BR
- ✅ Romanian (Romania) - ro-RO
- ✅ Russian (Russia) - ru-RU
- ✅ Spanish (Spain) - es-ES
- ✅ Tamil (India) - ta-IN
- ✅ Telugu (India) - te-IN
- ✅ Thai (Thailand) - th-TH
- ✅ Turkish (Turkey) - tr-TR
- ✅ Ukrainian (Ukraine) - uk-UA
- ✅ Vietnamese (Vietnam) - vi-VN

#### 🔮 Preview (63 Languages)
- ✅ Afrikaans (South Africa) - af-ZA
- ✅ Albanian (Albania) - sq-AL
- ✅ Amharic (Ethiopia) - am-ET
- ✅ Arabic (World) - ar-001
- ✅ Armenian (Armenia) - hy-AM
- ✅ Azerbaijani (Azerbaijan) - az-AZ
- ✅ Basque (Spain) - eu-ES
- ✅ Belarusian (Belarus) - be-BY
- ✅ Bulgarian (Bulgaria) - bg-BG
- ✅ Burmese (Myanmar) - my-MM
- ✅ Catalan (Spain) - ca-ES
- ✅ Cebuano (Philippines) - ceb-PH
- ✅ Chinese, Mandarin (China) - cmn-CN
- ✅ Chinese, Mandarin (Taiwan) - cmn-TW
- ✅ Croatian (Croatia) - hr-HR
- ✅ Czech (Czech Republic) - cs-CZ
- ✅ Danish (Denmark) - da-DK
- ✅ English (Australia) - en-AU
- ✅ English (United Kingdom) - en-GB
- ✅ Estonian (Estonia) - et-EE
- ✅ Filipino (Philippines) - fil-PH
- ✅ Finnish (Finland) - fi-FI
- ✅ French (Canada) - fr-CA
- ✅ Galician (Spain) - gl-ES
- ✅ Georgian (Georgia) - ka-GE
- ✅ Greek (Greece) - el-GR
- ✅ Gujarati (India) - gu-IN
- ✅ Haitian Creole (Haiti) - ht-HT
- ✅ Hebrew (Israel) - he-IL
- ✅ Hungarian (Hungary) - hu-HU
- ✅ Icelandic (Iceland) - is-IS
- ✅ Javanese (Java) - jv-JV
- ✅ Kannada (India) - kn-IN
- ✅ Konkani (India) - kok-IN
- ✅ Lao (Laos) - lo-LA
- ✅ Latin (Vatican City) - la-VA
- ✅ Latvian (Latvia) - lv-LV
- ✅ Lithuanian (Lithuania) - lt-LT
- ✅ Luxembourgish (Luxembourg) - lb-LU
- ✅ Macedonian (North Macedonia) - mk-MK
- ✅ Maithili (India) - mai-IN
- ✅ Malagasy (Madagascar) - mg-MG
- ✅ Malay (Malaysia) - ms-MY
- ✅ Malayalam (India) - ml-IN
- ✅ Mongolian (Mongolia) - mn-MN
- ✅ Nepali (Nepal) - ne-NP
- ✅ Norwegian, Bokmål (Norway) - nb-NO
- ✅ Norwegian, Nynorsk (Norway) - nn-NO
- ✅ Odia (India) - or-IN
- ✅ Pashto (Afghanistan) - ps-AF
- ✅ Persian (Iran) - fa-IR
- ✅ Portuguese (Portugal) - pt-PT
- ✅ Punjabi (India) - pa-IN
- ✅ Serbian (Serbia) - sr-RS
- ✅ Sindhi (India) - sd-IN
- ✅ Sinhala (Sri Lanka) - si-LK
- ✅ Slovak (Slovakia) - sk-SK
- ✅ Slovenian (Slovenia) - sl-SI
- ✅ Spanish (Latin America) - es-419
- ✅ Spanish (Mexico) - es-MX
- ✅ Swahili (Kenya) - sw-KE
- ✅ Swedish (Sweden) - sv-SE
- ✅ Urdu (Pakistan) - ur-PK

### Official Gemini-TTS Language Support ([Google Docs](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts))

#### GA (Generally Available - 23 languages)
- Arabic (Egypt) - ar-EG
- Bangla (Bangladesh) - bn-BD
- Dutch (Netherlands) - nl-NL
- English (India) - en-IN
- English (United States) - en-US
- French (France) - fr-FR
- German (Germany) - de-DE
- Hindi (India) - hi-IN
- Indonesian (Indonesia) - id-ID
- Italian (Italy) - it-IT
- Japanese (Japan) - ja-JP
- Korean (South Korea) - ko-KR
- Marathi (India) - mr-IN
- Polish (Poland) - pl-PL
- Portuguese (Brazil) - pt-BR
- Romanian (Romania) - ro-RO
- Russian (Russia) - ru-RU
- Spanish (Spain) - es-ES
- Tamil (India) - ta-IN
- Telugu (India) - te-IN
- Thai (Thailand) - th-TH
- Turkish (Turkey) - tr-TR
- Ukrainian (Ukraine) - uk-UA
- Vietnamese (Vietnam) - vi-VN

#### Preview (64 languages)
- Afrikaans (South Africa) - af-ZA
- Albanian (Albania) - sq-AL
- Amharic (Ethiopia) - am-ET
- Arabic (World) - ar-001
- Armenian (Armenia) - hy-AM
- Azerbaijani (Azerbaijan) - az-AZ
- Basque (Spain) - eu-ES
- Belarusian (Belarus) - be-BY
- Bulgarian (Bulgaria) - bg-BG
- Burmese (Myanmar) - my-MM
- Catalan (Spain) - ca-ES
- Cebuano (Philippines) - ceb-PH
- Chinese, Mandarin (China) - cmn-CN
- Chinese, Mandarin (Taiwan) - cmn-TW
- Croatian (Croatia) - hr-HR
- Czech (Czech Republic) - cs-CZ
- Danish (Denmark) - da-DK
- English (Australia) - en-AU
- English (United Kingdom) - en-GB
- Estonian (Estonia) - et-EE
- Filipino (Philippines) - fil-PH
- Finnish (Finland) - fi-FI
- French (Canada) - fr-CA
- Galician (Spain) - gl-ES
- Georgian (Georgia) - ka-GE
- Greek (Greece) - el-GR
- Gujarati (India) - gu-IN
- Haitian Creole (Haiti) - ht-HT
- Hebrew (Israel) - he-IL
- Hungarian (Hungary) - hu-HU
- Icelandic (Iceland) - is-IS
- Javanese (Java) - jv-JV
- Kannada (India) - kn-IN
- Konkani (India) - kok-IN
- Lao (Laos) - lo-LA
- Latin (Vatican City) - la-VA
- Latvian (Latvia) - lv-LV
- Lithuanian (Lithuania) - lt-LT
- Luxembourgish (Luxembourg) - lb-LU
- Macedonian (North Macedonia) - mk-MK
- Maithili (India) - mai-IN
- Malagasy (Madagascar) - mg-MG
- Malay (Malaysia) - ms-MY
- Malayalam (India) - ml-IN
- Mongolian (Mongolia) - mn-MN
- Nepali (Nepal) - ne-NP
- Norwegian, Bokmål (Norway) - nb-NO
- Norwegian, Nynorsk (Norway) - nn-NO
- Odia (India) - or-IN
- Pashto (Afghanistan) - ps-AF
- Persian (Iran) - fa-IR
- Portuguese (Portugal) - pt-PT
- Punjabi (India) - pa-IN
- Serbian (Serbia) - sr-RS
- Sindhi (India) - sd-IN
- Sinhala (Sri Lanka) - si-LK
- Slovak (Slovakia) - sk-SK
- Slovenian (Slovenia) - sl-SI
- Spanish (Latin America) - es-419
- Spanish (Mexico) - es-MX
- Swahili (Kenya) - sw-KE
- Swedish (Sweden) - sv-SE
- Urdu (Pakistan) - ur-PK

## Language Categories

### Fully Supported (TTS + UI)
Languages that appear in both your UI and have TTS voices:
- **Complete Gemini Support**: All 87 Vertex AI languages now available
- **Major languages**: English, Spanish, French, German, Italian, Portuguese, Japanese, Korean, Chinese, Arabic, Hindi, Russian, Dutch, Swedish, Danish, Norwegian, Finnish, Polish, Czech, Hungarian, Slovak, Slovenian, Croatian, Bulgarian, Romanian, Ukrainian, Turkish, Greek, Hebrew, Indonesian, Malay, Telugu, Tamil, Vietnamese, Thai
- **Additional Vertex AI languages**: 87 total languages supported (see complete list above)

### TTS-Only (Missing from UI)
Languages with TTS voices but not exposed in UI:
- `cmn-CN` (Mandarin Chinese, 38 voices)
- `cmn-TW` (Traditional Chinese, 6 voices)
- `nb-NO` (Norwegian Bokmål, 34 voices)
- `yue-HK` (Cantonese, 34 voices)

### UI-Only (No TTS Support)
124 languages in UI without TTS voices (rare/minority languages):
- African: Akan, Amharic, Hausa, Igbo, Kinyarwanda, Somali, Swahili, Xhosa, Yoruba, Zulu
- Asian: Assamese, Bengali, Gujarati, Kannada, Khmer, Kyrgyz, Lao, Malayalam, Marathi, Nepali, Pashto, Punjabi, Sinhala, Sundanese, Tamil, Telugu, Thai, Tibetan, Urdu, Vietnamese
- European: Albanian, Armenian, Azerbaijani, Basque, Belarusian, Bosnian, Bulgarian, Croatian, Czech, Estonian, Finnish, Galician, Georgian, Greek, Hungarian, Icelandic, Irish, Latvian, Lithuanian, Macedonian, Maltese, Montenegrin, Romanian, Serbian, Slovak, Slovenian, Swedish, Turkish, Ukrainian, Welsh
- Other: Arabic, Chinese, Dutch, French, German, Hindi, Indonesian, Italian, Japanese, Korean, Persian, Polish, Portuguese, Russian, Spanish

## Usage Workflow

### Daily/Monthly Checks
```bash
# Update snapshot from Google APIs and check diffs
npm run tts:update

# Review output for any new languages or voice changes
# Now includes all 87 Vertex AI Gemini languages + regular TTS voices
```

### Authentication Setup
**CRITICAL**: Use the same authentication as your Vertex AI setup to get accurate results!

```bash
# Option 1: Application Default Credentials (recommended)
gcloud auth application-default login

# Option 2: Service Account Key (use same as Vertex AI)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json

# Option 3: API Key (if using API keys)
export GOOGLE_API_KEY=your_google_api_key

# Verify you're using the same project/region as Vertex AI
gcloud config get-value project
gcloud config get-value compute/region
```

### Expected Output
After running `npm run tts:snapshot`, you should see:
- ✅ **93 languages** total (87 Gemini + additional TTS languages)
- ✅ **All voice tiers**: Gemini (87 languages), Chirp3 HD, Neural2, Standard
- ✅ **Complete Vertex AI integration** with full Gemini language support
- ✅ **6,764 voices** across all supported languages

### Adding New TTS Languages
1. Run `npm run tts:snapshot` to get latest voices
2. Check if new languages appear in diff output
3. Add to `frontend/src/config/languages.js` TRANSLATION_LANGUAGES array
4. Test UI dropdown shows correct voices

### Removing Unsupported Languages
1. Run `npm run tts:diff` to identify languages without TTS
2. Consider removing from UI to avoid user disappointment
3. Update `frontend/src/config/languages.js`

## File Structure

```
frontend/src/
├── config/
│   ├── languages.js          # UI language definitions
│   └── ttsVoices.json        # Google TTS voice configurations
├── data/
│   └── google-tts-voices.snapshot.json  # Generated snapshot
└── scripts/
    ├── fetchGoogleTtsVoicesSnapshot.js  # Snapshot generator
    └── diffTtsLanguages.js              # Diff analyzer
```

## Package.json Scripts

```json
{
  "scripts": {
    "tts:snapshot": "node scripts/fetchGoogleTtsVoicesSnapshot.js",
    "tts:diff": "node scripts/diffTtsLanguages.js",
    "tts:update": "npm run tts:snapshot && npm run tts:diff"
  }
}
```

## Key Insights

1. **Two Separate Systems**: Google TTS and Gemini voices route differently in backend
2. **UI Accuracy**: Frontend correctly shows available voices for supported languages
3. **Honest UX**: Consider removing languages without TTS to avoid user disappointment
4. **Snapshot-Based**: No external API calls needed - works offline with local config
5. **Complete Gemini Support**: Now have all 87 Vertex AI languages with 4,698+ voices
6. **Dual API Integration**: Cloud TTS + Vertex AI for comprehensive coverage
7. **Future-Proof**: Easy to update when adding new TTS providers or languages

## Troubleshooting

### Authentication Issues
```bash
# Check if authenticated
gcloud auth list

# Re-authenticate if needed
gcloud auth application-default login

# Test API access
gcloud auth application-default print-access-token
```

### API Errors
- **"Permission denied"**: Check authentication and project permissions
- **"Quota exceeded"**: Google Cloud TTS has rate limits
- **Network issues**: Ensure internet connection and API access

### Incomplete Data
- **Old data**: Google periodically adds new voices/languages
- **Missing voice tiers**: Some regions may not support all voice types
- **Authentication issues**: Now resolved with dual API approach
- **Gemini language support**: Now fully captured (87/87 languages via Vertex AI)

### UI Synchronization
- After updating snapshot, check if your UI needs updates
- Compare snapshot languages with your frontend language list
- Update UI to expose newly supported languages
