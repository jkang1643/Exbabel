#!/bin/bash
# Generate curl command to view PhraseSet using Service Account
# 
# Usage:
#   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
#   export GOOGLE_CLOUD_PROJECT_ID=222662040787
#   bash backend/scripts/getPhraseSetCurl.sh

# Get access token using Service Account
if [ -z "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
    echo "❌ Error: GOOGLE_APPLICATION_CREDENTIALS not set"
    exit 1
fi

PROJECT_ID=${GOOGLE_CLOUD_PROJECT_ID:-222662040787}
PHRASE_SET_ID=${GOOGLE_PHRASE_SET_ID:-church-glossary-10k}

# Get access token using gcloud (if available) or node
if command -v gcloud &> /dev/null; then
    ACCESS_TOKEN=$(gcloud auth print-access-token)
elif command -v node &> /dev/null; then
    # Use Node.js to get token
    ACCESS_TOKEN=$(node -e "
        const { GoogleAuth } = require('google-auth-library');
        const auth = new GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        auth.getClient().then(client => client.getAccessToken()).then(token => {
            console.log(token.token || token);
        });
    ")
else
    echo "❌ Error: Need either gcloud CLI or Node.js installed"
    exit 1
fi

API_URL="https://speech.googleapis.com/v1/projects/${PROJECT_ID}/locations/global/phraseSets/${PHRASE_SET_ID}"

echo "🔍 Fetching PhraseSet via curl..."
echo ""
echo "Command:"
echo "curl -H \"Authorization: Bearer \$ACCESS_TOKEN\" \\"
echo "  \"${API_URL}\" | jq"
echo ""
echo "Running..."
echo ""

curl -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${API_URL}" | jq '.' 2>/dev/null || curl -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${API_URL}"

