#!/bin/bash
# Test Usage Debug Endpoint (DEV)
# This script authenticates with Supabase and tests the usage recording pipeline

set -e

BASE_URL="http://localhost:3001"
SUPABASE_URL="https://pmxfuofokccifbiqxhpp.supabase.co"
SUPABASE_ANON_KEY="sb_publishable_h07M6ukm5Sa1kWZV6EiTuA_Ot07_zwI"
TEST_EMAIL="exbabelapp+1@gmail.com"
TEST_PASSWORD="holyspiritfireA-238"

echo "🔐 Authenticating with Supabase DEV..."

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
echo "📝 Test 1: Recording usage event..."
RECORD_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/debug/usage" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "metric": "transcription_seconds",
    "quantity": 30
  }')

echo "Response: $RECORD_RESPONSE"
echo ""

# Test 2: Read usage
echo "📊 Test 2: Reading usage totals..."
READ_RESPONSE=$(curl -s "${BASE_URL}/api/debug/usage" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")

echo "Response: $READ_RESPONSE"
echo ""

# Test 3: Record with explicit idempotency key (should dedupe on retry)
echo "🔁 Test 3: Testing idempotency (same key twice)..."
IDEMPOTENCY_KEY="debug-usage-$(date +%s)"

echo "First call with key: $IDEMPOTENCY_KEY"
FIRST_CALL=$(curl -s -X POST "${BASE_URL}/api/debug/usage" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"metric\": \"tts_characters\",
    \"quantity\": 100,
    \"idempotency_key\": \"${IDEMPOTENCY_KEY}\"
  }")
echo "Response: $FIRST_CALL"

echo ""
echo "Second call with SAME key (should be duplicate):"
SECOND_CALL=$(curl -s -X POST "${BASE_URL}/api/debug/usage" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"metric\": \"tts_characters\",
    \"quantity\": 100,
    \"idempotency_key\": \"${IDEMPOTENCY_KEY}\"
  }")
echo "Response: $SECOND_CALL"

echo ""
echo "✅ All tests complete!"

