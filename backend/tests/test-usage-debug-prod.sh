#!/bin/bash
# Test Usage Debug Endpoint (PROD)
# This script authenticates with Supabase PROD and tests the usage recording pipeline

set -e

BASE_URL="http://localhost:3001"
SUPABASE_URL="https://fjkysulfacbgfmsbuyvv.supabase.co"
SUPABASE_ANON_KEY="sb_publishable_l56WVRg0nVRKojDbVEFkwg_v8SxmaRj"
TEST_EMAIL="exbabelapp+1@gmail.com"
TEST_PASSWORD="holyspiritfireA-238"

echo "🔐 Authenticating with Supabase PROD..."

# Get access token
AUTH_RESPONSE=$(curl -s -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${TEST_EMAIL}\",
    \"password\": \"${TEST_PASSWORD}\"
  }")

# Extract access_token using Python
ACCESS_TOKEN=$(echo "$AUTH_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('access_token', ''))")

if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" == "None" ]; then
  echo "❌ Authentication failed!"
  echo "Response: $AUTH_RESPONSE"
  exit 1
fi

echo "✅ Authenticated successfully"
echo ""

# Test 1: Record a usage event
echo "📝 Test 1: Recording usage event (PROD)..."
RECORD_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/debug/usage" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "metric": "transcription_seconds",
    "quantity": 45
  }')

echo "Response: $RECORD_RESPONSE"
echo ""

# Test 2: Read usage
echo "📊 Test 2: Reading usage totals (PROD)..."
READ_RESPONSE=$(curl -s "${BASE_URL}/api/debug/usage" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")

echo "Response: $READ_RESPONSE"
echo ""

# Test 3: Idempotency test
echo "🔁 Test 3: Testing idempotency (PROD)..."
FIXED_KEY="prod-idempotency-test-$(date +%s)"

echo "First call with key: $FIXED_KEY"
FIRST_CALL=$(curl -s -X POST "${BASE_URL}/api/debug/usage" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"metric\": \"tts_characters\",
    \"quantity\": 250,
    \"idempotency_key\": \"${FIXED_KEY}\"
  }")
echo "$FIRST_CALL" | python3 -c "import sys, json; d=json.load(sys.stdin); print(f\"Inserted: {d.get('inserted')}, Event ID: {d.get('event_id', 'N/A')[:8] if d.get('event_id') else 'None'}...\")"

echo ""
echo "Second call with SAME key (should show inserted=false):"
SECOND_CALL=$(curl -s -X POST "${BASE_URL}/api/debug/usage" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"metric\": \"tts_characters\",
    \"quantity\": 250,
    \"idempotency_key\": \"${FIXED_KEY}\"
  }")
echo "$SECOND_CALL" | python3 -c "import sys, json; d=json.load(sys.stdin); print(f\"Inserted: {d.get('inserted')}, Event ID: {d.get('event_id', 'None')}\")"

echo ""
echo "✅ All PROD tests complete!"
