# 2026-01-27 Auth, Database & Payments Infrastructure

**Date:** January 27, 2026  
**Component:** Backend (Supabase Integration, Authentication Middleware, Database Schema)  
**Impact:** Foundation for multi-tenant billing, subscriptions, and church management features.

## Overview

This document tracks the implementation of authentication, database, and payment infrastructure for Exbabel. This is the foundational "electrical wiring" that enables:
1. **Authentication**: JWT-based user authentication with Supabase
2. **Database**: Multi-tenant database schema with Row Level Security (RLS)
3. **Payments**: Stripe integration for subscription billing (planned)

---

## Part 1: Authentication Middleware Infrastructure

**Context:** Before implementing billing and subscription features, we needed a robust authentication system that verifies user identity and loads tenant context (church_id, role) for every protected API request.

### 1. Supabase Admin Client

**File:** `backend/supabaseAdmin.js`

**Purpose:** Server-side Supabase client with service role privileges that bypasses Row Level Security (RLS) for authorized backend operations.

**Implementation:**
```javascript
import { createClient } from "@supabase/supabase-js";

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
```

**Key Features:**
- Uses `SUPABASE_SERVICE_ROLE_KEY` (never exposed to frontend)
- Stateless configuration (no session persistence)
- Validates environment variables on startup
- Singleton pattern for consistent usage across backend

**Security Notes:**
- Service role key bypasses RLS - only used after JWT verification
- Never exposed to frontend or client-side code
- Used exclusively for server-side profile loading

---

### 2. Authentication Middleware

**File:** `backend/middleware/requireAuthContext.js`

**Purpose:** Express middleware that verifies JWT tokens and loads user profile context for protected routes.

**Authentication Flow:**
1. **Extract** Bearer token from `Authorization` header
2. **Verify** JWT using `supabaseAdmin.auth.getUser(token)`
3. **Load** user profile from `profiles` table (includes `church_id`, `role`)
4. **Attach** context to `req.auth = { user_id, church_id, role }`
5. **Handle** errors with appropriate HTTP status codes

**Error Handling:**
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Valid token but no profile (incomplete onboarding)
- `500 Internal Server Error` - Unexpected errors

**Implementation:**
```javascript
export async function requireAuthContext(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Missing bearer token" });
    }

    // Verify JWT
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // Load profile (tenant context)
    const { data: profile, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("user_id, church_id, role")
      .eq("user_id", user_id)
      .single();

    if (profErr || !profile) {
      return res.status(403).json({ error: "Profile not created" });
    }

    req.auth = profile; // { user_id, church_id, role }
    return next();
  } catch (e) {
    console.error("[Auth] Unexpected error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
}
```

**Usage Pattern:**
```javascript
import { requireAuthContext } from "../middleware/requireAuthContext.js";

router.get("/protected-endpoint", requireAuthContext, (req, res) => {
  const { user_id, church_id, role } = req.auth;
  // Protected logic here
});
```

---

### 3. User Context Endpoint

**File:** `backend/routes/me.js`

**Purpose:** Health check endpoint that returns authenticated user's context.

**Endpoint:** `GET /api/me`

**Response:**
```json
{
  "user_id": "uuid-here",
  "church_id": "uuid-here",
  "role": "admin"
}
```

**Implementation:**
```javascript
import express from "express";
import { requireAuthContext } from "../middleware/requireAuthContext.js";

export const meRouter = express.Router();

meRouter.get("/me", requireAuthContext, (req, res) => {
  res.json(req.auth);
});
```

**Server Integration:**
```javascript
// server.js
import { meRouter } from './routes/me.js';

app.use('/api', meRouter);
```

---

## Part 4: Entitlement Enforcement Infrastructure (PR6)

**Context:** After establishing the DB baseline, we implemented the logic to enforce plan limits, billing settings, and model routing for every request.

#### 1. Entitlements Module

**Directory:** `backend/entitlements/`

**Components:**
- `getEntitlements.js`: Fetches normalized entitlements with a 60-second in-memory TTL cache.
- `resolveModel.js`: Resolves provider/model/params by capability (throws if missing).
- `assertEntitled.js`: Enforcement helpers for status, language limits, and feature flags.

**Data Model (Normalized):**
```typescript
{
  churchId: string,
  subscription: { status, planCode, planId, ... },
  limits: { maxSimultaneousLanguages, sttTier, ttsTier, featureFlags },
  billing: { paygEnabled, paygRateCentsPerHour, ... },
  routing: { capability: { provider, model, params } }
}
```

#### 2. Entitlements Middleware & WS Handshake

**Middleware:** `backend/middleware/requireEntitlements.js`
- `requireEntitlements`: Builds on `requireAuthContext` and attaches `req.entitlements`.
- `requireActiveSubscription`: Enforces `active` or `trialing` status (blocks `past_due`, `canceled`, etc.).

**WebSocket Handshake:** `backend/server.js`
- On connection, extracts `token` from URL and verifies with Supabase.
- Fetches entitlements via `getEntitlements(church_id)` and attaches to `ws.entitlements`.
- Enables downstream handlers (like `soloModeHandler`) to access user-specific tier data.

#### 3. Model Parameterization (Wiring)

**Workers:** `backend/translationWorkers.js`
- Removed hardcoded model strings (e.g., `'gpt-4o-mini'`).
- Added per-call model override via `options.model` parameter.

**Resolution:** `backend/soloModeHandler.js`
- Calls `resolveModel(entitlements, 'translate')` to determine the correct LLM for the church's plan.
- Passes the resolved model to translation workers, ensuring cost-alignment with the business plan.

#### 4. Debug Endpoint

**Endpoint:** `GET /api/debug/entitlements`
**Protection:** Requires admin role (production) or development mode.
**Purpose:** Verification tool to inspect a church's current entitlements and routing map.

---

## Part 5: Usage Metering Infrastructure (PR7)

**Context:** To enforce plan quotas and enable tiered billing, we implemented a reliable usage recording system that tracks consumption (minutes, characters) with strict idempotency.

### 1. Atomic Recording (Postgres RPC)

**Migration:** `supabase/migrations/20260128_record_usage_event.sql`

**Function:** `record_usage_event(p_church_id, p_metric, p_quantity, p_idempotency_key, p_metadata)`
- **Atomicity**: Increments `usage_daily` and inserts into `usage_events` in a single transaction.
- **Idempotency**: Uses a non-serial `idempotency_key` UNIQUE constraint to prevent double-counting on network retries.
- **Deduplication**: If an `idempotency_key` is reused, the daily total is NOT incremented twice.

### 2. Backend Usage Service

**Module:** `backend/usage/`
- `recordUsage.js`: Implementation of the recording logic using `supabaseAdmin.rpc`.
- `generateIdempotencyKey()`: Creates keys based on 30-second windows (e.g., `ws:session:metric:windowStart`).
- `getUsage.js`: Helpers for retrieving Month-to-Date (MTD) and daily usage totals for reporting and UI.

### 3. Usage Debug Endpoints

**File:** `backend/routes/usage.js`
- `POST /api/debug/usage`: Manually trigger a usage event to verify the recording pipeline.
- `GET /api/debug/usage`: Inspect current usage totals for the authenticated church.

---

### 4. Environment Configuration

**File:** `backend/.env`

**Added Configuration:**
```env
# Supabase Configuration
SUPABASE_URL=https://fjkysulfacbgfmsbuyvv.supabase.co
SUPABASE_KEY=sb_publishable_...  # Anon/Public Key (frontend-safe)
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...  # Service Role (BACKEND ONLY)
```

**Security:**
- `SUPABASE_KEY` (anon key) - Safe for frontend, respects RLS
- `SUPABASE_SERVICE_ROLE_KEY` - Backend only, bypasses RLS

---

## Part 6: PR 7.1 - Verification & Enforcement Refinements

**Context:** Following the initial PR7 implementation, we performed end-to-end verification on both DEV and PROD environments. This phase included bug fixes for environment loading and refinement of admin enforcement logic.

### 1. Supabase Admin Lazy Initialization
**Issue:** ES modules hoist imports, causing `supabaseAdmin.js` to evaluate and check for `SUPABASE_URL` before `dotenv.config()` could run in `server.js`.

**Solution:** Converted `supabaseAdmin` to a **lazy-initialized Proxy**.
- **Deferred execution**: The Supabase client is only instantiated on first access.
- **Safety**: Ensures `process.env` is fully populated before validation.
- **Compatibility**: Maintains the existing `supabaseAdmin.from()` API syntax.

### 2. Admin Role Enforcement Fix
**Issue:** The usage debug endpoint check was inconsistently referencing `req.profile` vs `req.auth`.

**Solution:** Standardized all admin checks to use `req.auth.role` (set by the `requireAuthContext` middleware).

### 3. Verification Results (PROD)
Total test coverage for the usage pipeline:
- ✅ **Authentication**: Verified JWT validation against PROD keys.
- ✅ **Atomicity**: Verified that one RPC call results in exactly one event insert and one daily aggregate update.
- ✅ **Idempotency**: Verified that resubmitting the same `idempotency_key` returns `inserted: false` and does not increment usage.
- ✅ **Authorization**: Verified that non-admin users are blocked from manual usage triggers in production.

---

### 5. Testing & Verification

**Test Results:** All tests passed ✅

**Test 1: Missing Token**
```bash
curl -i http://localhost:3001/api/me
# Response: 401 Unauthorized
# Body: {"error":"Missing bearer token"}
```

**Test 2: Invalid Token**
```bash
curl -i http://localhost:3001/api/me -H "Authorization: Bearer fake_token"
# Response: 401 Unauthorized
# Body: {"error":"Invalid token"}
```

**Test 3: Valid Token** (requires real access token from Supabase Auth)
```bash
curl -i http://localhost:3001/api/me -H "Authorization: Bearer <VALID_TOKEN>"
# Response: 200 OK
# Body: {"user_id":"...","church_id":"...","role":"admin"}
```

**Verification Logs:**
```
[Auth] ✓ Authenticated: user=..., church=..., role=admin
```

---

## Part 2: Database Schema

**Status:** Implementation baseline complete ✅

**Baseline Migration:** `supabase/migrations/20260128151801_baseline_remote_schema.sql`

We have implemented a comprehensive 6-table schema that covers multitenancy, subscriptions, billing, and AI model routing.

### 1. Schema Overview

| Table | Purpose | RLS Policy |
|-------|---------|------------|
| `churches` | Organization/tenant records | Users view own church |
| `profiles` | User identity & church links | Users view/edit own profile |
| `plans` | Subscription tier definitions | Publicly readable |
| `subscriptions` | Active plans per church | Users view own church sub |
| `church_billing_settings` | PAYG & Overage settings | Admins can update |
| `plan_model_routing` | Model config per plan | Publicly readable |

### 2. Multi-Tenant Strategy
- **Church-Level Isolation**: All sensitive tables include `church_id`.
- **Auth Integration**: RLS policies use `auth.uid()` to verify user access via the `profiles` table.
- **Admin Roles**: Specific policies (like billing updates) are restricted to users with the `admin` role.

### 3. Migration Management
We use the Supabase CLI for version-controlled migrations:
- **Baseline**: Captured from the remote schema on 2026-01-28.
- **Workflow**: `supabase migration new` -> edit SQL -> `supabase db push`.

---

## Part 3: Payments Integration (Planned)

**Status:** Not yet implemented

**Planned Features:**
1. **Stripe Integration** - Subscription billing and payment processing
2. **Plan Management** - Create and manage subscription tiers
3. **Usage Metering** - Track translation minutes and TTS usage
4. **Billing Portal** - Customer self-service for payment methods

**Dependencies:**
- ✅ Authentication middleware (completed)
- ⏳ Database schema (in progress)
- ⏳ Stripe webhook handlers (planned)
- ⏳ Frontend billing UI (planned)

---

## Files Created

### New Files
- `backend/supabaseAdmin.js` - Supabase admin client
- `backend/middleware/requireAuthContext.js` - Auth middleware
- `backend/middleware/requireEntitlements.js` - Entitlements middleware
- `backend/entitlements/index.js` - Entitlements module entry
- `backend/entitlements/getEntitlements.js` - Fetcher & Cache
- `backend/entitlements/resolveModel.js` - Model resolver
- `backend/entitlements/assertEntitled.js` - Enforcement helpers
- `backend/usage/index.js` - Usage service entry [NEW]
- `backend/usage/recordUsage.js` - Idempotent recorder [NEW]
- `backend/usage/getUsage.js` - Usage reporting [NEW]
- `backend/routes/me.js` - User context endpoint
- `backend/routes/entitlements.js` - Entitlements debug endpoint
- `backend/routes/usage.js` - Usage debug endpoint [NEW]
- `backend/tests/manual/entitlements.test.js` - Unit tests (12 pass)
- `backend/AUTH_TESTING.md` - Testing guide
- `supabase/migrations/20260128_record_usage_event.sql` - Usage RPC [NEW]

### Modified Files
- `backend/.env` - Added `SUPABASE_SERVICE_ROLE_KEY`
- `backend/server.js` - Mounted `/api` routes, added WS entitlements
- `backend/translationWorkers.js` - Parameterized models
- `backend/soloModeHandler.js` - Wired resolved models

### Directory Structure
```
backend/
├── entitlements/
│   ├── getEntitlements.js
│   ├── resolveModel.js
│   ├── assertEntitled.js
│   └── index.js
├── usage/                    [NEW]
│   ├── recordUsage.js
│   ├── getUsage.js
│   └── index.js
├── middleware/
│   ├── requireAuthContext.js
│   └── requireEntitlements.js
├── routes/
│   ├── me.js
│   ├── entitlements.js
│   └── usage.js               [NEW]
├── supabaseAdmin.js
├── .env                          [MODIFIED]
├── server.js                     [MODIFIED]
├── translationWorkers.js         [MODIFIED]
└── soloModeHandler.js           [MODIFIED]
```

---

## Next Steps

### Immediate (PR6 & PR7 Complete ✅)
- [x] Implement deterministic entitlements fetcher
- [x] Implement model routing resolver
- [x] Implement enforcement helpers (status, limits)
- [x] Parameterize translation workers with model config
- [x] Load entitlements during WebSocket handshake
- [x] Wire `resolveModel` into solo mode translation calls
- [x] Create atomic usage recording RPC (`record_usage_event`)
- [x] Implement idempotent usage recording service
- [x] Add `/api/debug/usage` endpoints
- [ ] Wire usage recording into real routes (minutes, characters)
- [ ] Implement TTS tier gating (simple catalog filtering)

### Short-Term (Stripe Integration)
- [ ] Connect Stripe account to backend
- [ ] Implement webhook handlers for subscription events
- [ ] Add Stripe customer creation to church onboarding
- [ ] Sync Stripe status to `subscriptions` table

### Medium-Term (Payments)
- [ ] Integrate Stripe SDK
- [ ] Create subscription plans
- [ ] Implement webhook handlers
- [ ] Build billing portal API
- [ ] Add usage metering

### Long-Term (Features)
- [ ] Church management dashboard
- [ ] User role management
- [ ] Billing analytics
- [ ] Invoice generation
- [ ] Payment method management

---

## Technical Decisions

### Why Supabase?
- **Built-in Auth** - JWT-based authentication out of the box
- **PostgreSQL** - Robust relational database with RLS
- **Real-time** - WebSocket support for live updates
- **Scalability** - Managed infrastructure with auto-scaling

### Why Service Role Key?
- **Server-Side Operations** - Needed for profile loading after JWT verification
- **RLS Bypass** - Required for admin operations and cross-tenant queries
- **Security** - Never exposed to frontend, only used in trusted backend code

### Why Middleware Pattern?
- **Reusability** - Single middleware protects all endpoints
- **Consistency** - Uniform auth context across all routes
- **Maintainability** - Auth logic centralized in one place
- **Testability** - Easy to mock and test independently

---

## Performance Considerations

### Current Performance
- **JWT Verification** - ~50-100ms (Supabase API call)
- **Profile Loading** - ~20-50ms (Database query)
- **Total Overhead** - ~70-150ms per authenticated request

### Optimization Opportunities
1. **Caching** - Cache profiles in Redis (reduce DB queries)
2. **Connection Pooling** - Reuse Supabase connections
3. **JWT Validation** - Validate JWT locally (skip Supabase API call)
4. **Batch Loading** - Load multiple profiles in single query

**Note:** Current performance is acceptable for MVP. Optimizations can be implemented as traffic scales.

---

## Security Audit Checklist

- [x] Service role key stored in `.env` (not committed to git)
- [x] Service role key never exposed to frontend
- [x] JWT verification before profile loading
- [x] Proper error handling (no information leakage)
- [x] CORS configured correctly
- [x] HTTPS enforced in production (via CloudFront)
- [ ] Rate limiting on auth endpoints (TODO)
- [ ] Audit logging for auth events (TODO)

---

## References

- [Supabase Auth Documentation](https://supabase.com/docs/guides/auth)
- [Supabase RLS Guide](https://supabase.com/docs/guides/auth/row-level-security)
- [Express Middleware Guide](https://expressjs.com/en/guide/using-middleware.html)
- [JWT Best Practices](https://tools.ietf.org/html/rfc8725)

---

## Changelog

### 2026-01-27 - Initial Implementation
- ✅ Created Supabase admin client
- ✅ Implemented authentication middleware
- ✅ Added `/api/me` endpoint
- ✅ Configured environment variables
- ✅ Tested authentication flow
- ✅ Documented implementation

### 2026-01-28 - Entitlement Enforcement & Usage Metering (PR6 & PR7)
- ✅ Implemented `getEntitlements` with 60s TTL cache (PR6)
- ✅ Parameterized translation workers and wired `resolveModel` (PR6 Wiring)
- ✅ Added entitlements loading to WebSocket handshake (PR6 Wiring)
- ✅ Created atomic, idempotent `record_usage_event` Postgres RPC (PR7)
- ✅ Implemented usage recording service with idempotency keys (PR7)
- ✅ Added `/api/debug/usage` for pipeline verification (PR7)
- ✅ Applied migrations to PROD DB
- ✅ Updated engineering documentation

### 2026-01-28 - PR 7.1 - Verification & Final Refinements
- ✅ Verified idempotency and atomicity on DEV and PROD
- ✅ Implemented lazy-initialization Proxy for `supabaseAdmin` to fix ES module timing issues
- ✅ Standardized admin role enforcement using `req.auth.role`
- ✅ Verified admin role-gating on production debug endpoints

