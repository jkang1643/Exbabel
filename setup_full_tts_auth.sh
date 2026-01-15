#!/bin/bash
# Setup script for full TTS language support (87 Gemini languages)

echo "🔐 Setting up Google Cloud authentication for full TTS language support..."
echo ""

# Check current authentication status
echo "📋 Current authentication status:"
echo "GOOGLE_APPLICATION_CREDENTIALS: ${GOOGLE_APPLICATION_CREDENTIALS:-'Not set'}"
echo "GOOGLE_API_KEY: ${GOOGLE_API_KEY:-'Not set'}"
gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | sed 's/^/gcloud auth: /' || echo "gcloud auth: Not available or not logged in"
echo ""

# Instructions for setup
echo "📝 To get full 87 Gemini languages, choose one method:"
echo ""
echo "METHOD 1: gcloud Application Default Credentials (Recommended)"
echo "  gcloud auth application-default login"
echo "  # Choose the same account you use for Vertex AI"
echo ""
echo "METHOD 2: Service Account Key"
echo "  export GOOGLE_APPLICATION_CREDENTIALS=./backend/your-vertex-ai-key.json"
echo ""
echo "METHOD 3: API Key"
echo "  export GOOGLE_API_KEY=your_google_api_key"
echo ""

# Wait for user to set up authentication
read -p "Have you set up authentication? (y/N): " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🔄 Testing authentication and fetching full TTS data..."

    # Test the authentication
    echo "Testing API access..."
    node scripts/fetchGoogleTtsVoicesSnapshot.js --test-auth 2>&1 | head -5

    # Fetch full snapshot
    echo ""
    echo "Fetching complete TTS snapshot..."
    node scripts/fetchGoogleTtsVoicesSnapshot.js

    # Analyze results
    echo ""
    echo "📊 Analyzing language support..."
    node -e "
    const data = require('./frontend/src/data/google-tts-voices.snapshot.json');
    const tierLanguages = {};

    data.voices.forEach(voice => {
      const tier = voice.tier;
      if (!tierLanguages[tier]) tierLanguages[tier] = new Set();

      voice.languageCodes.forEach(lang => tierLanguages[tier].add(lang));
    });

    console.log('=== TTS Language Support Results ===');
    console.log('Total voices:', data.voiceCount);
    console.log('Total languages:', data.languagesCount);
    console.log('');

    Object.entries(tierLanguages)
      .sort((a, b) => b[1].size - a[1].size)
      .forEach(([tier, langs]) => {
        console.log(\`\${tier}: \${langs.size} languages\`);
        if (tier === 'gemini') {
          console.log('  Languages:', Array.from(langs).sort().join(', '));
          console.log(\`  Status: \${langs.size >= 87 ? '✅ SUCCESS - Full support!' : \`⚠️ Only \${langs.size} languages - expected 87+\`}\`);
        }
      });
    "

    echo ""
    echo "✅ Setup complete! Check the results above."
    echo ""
    echo "Next steps:"
    echo "1. If you got 87+ Gemini languages: Update backend routing"
    echo "2. If still limited: Check your GCP project permissions"
else
    echo "❌ Please set up authentication first, then run this script again."
    exit 1
fi
