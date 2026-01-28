# Quick Start: Testing Auth Middleware

## ✅ AUTH Step 3: COMPLETE

All authentication middleware tests have passed successfully.

---

## 1. Add Service Role Key

Edit `backend/.env` and replace the placeholder:

```bash
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Get this from: **Supabase Dashboard → Settings → API → service_role**

---

## 2. Start Backend

```bash
cd backend
npm run dev
```

---

## 3. Test Endpoints

### Test 1: Missing Token ✅
```bash
curl -i http://localhost:3001/api/me
```
**Expected**: `401 Unauthorized` with `{"error":"Missing bearer token"}`

### Test 2: Invalid Token ✅
```bash
curl -i http://localhost:3001/api/me \
  -H "Authorization: Bearer fake_token"
```
**Expected**: `401 Unauthorized` with `{"error":"Invalid token"}`

### Test 3: Valid Token ✅
```bash
# Get a real token from testRLS.js
node backend/scripts/testRLS.js

# Copy the ACCESS_TOKEN from output, then:
curl -i http://localhost:3001/api/me \
  -H "Authorization: Bearer <ACCESS_TOKEN>"
```

**Expected**: `200 OK` with user context:
```json
{
  "user_id": "0f62b0ca-5f83-4a81-871f-ab06bc1cb954",
  "church_id": "71afaace-d9e6-4c94-84ed-b504efe7fa1c",
  "role": "admin"
}
```

**Backend logs should show**:
```
[Auth] ✓ user=0f62b0ca-5f83-4a81-871f-ab06bc1cb954 church=71afaace-d9e6-4c94-84ed-b504efe7fa1c role=admin
```

---

## Test Results Summary

| Test Case | Expected | Actual | Status |
|-----------|----------|--------|--------|
| Missing Token | 401 | 401 | ✅ PASS |
| Invalid Token | 401 | 401 | ✅ PASS |
| Valid Token | 200 + context | 200 + context | ✅ PASS |

---

## Files Created

- ✅ `backend/supabaseAdmin.js` - Admin client
- ✅ `backend/middleware/requireAuthContext.js` - Auth middleware
- ✅ `backend/routes/me.js` - `/api/me` endpoint
- ✅ Updated `backend/server.js` - Wired routes
- ✅ Updated `backend/.env` - Added service role key

---

## Next: Build Protected Endpoints

Use this pattern for any protected route:

```javascript
import { requireAuthContext } from "../middleware/requireAuthContext.js";

router.get("/protected", requireAuthContext, (req, res) => {
  const { user_id, church_id, role } = req.auth;
  // Your logic here - req.auth is guaranteed to exist
});
```

---

## Next Steps

Now that authentication is complete, you can implement:
1. **Database Schema** - Plans, subscriptions, church_billing_settings tables
2. **Stripe Integration** - Payment processing and webhooks
3. **Billing Portal** - Customer self-service UI
