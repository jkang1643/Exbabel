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

## Part 7: Listening Time Metering (PR7.4)

**Context:** To enable quota enforcement and billing for listener usage, we implemented wall-clock listening time tracking with accurate span management.

### 1. Enhanced Usage Recording RPC

**Migration:** `supabase/migrations/20260130_update_record_usage_event.sql`

- **Addition**: Upserts into `usage_monthly` table alongside `usage_daily`
- **Benefit**: O(1) quota remaining lookups without scanning `usage_events`

### 2. Listening Spans Service

**Module:** `backend/usage/listeningSpans.js`

**Functions:**
- `startListening(sessionId, userId, churchId)` - Creates span row, idempotent (unique constraint)
- `heartbeat(sessionId, userId)` - Updates `last_seen_at` timestamp (30s interval)
- `stopListening(sessionId, userId, reason)` - Computes duration, records usage event
- `stopAllListeningForSession(sessionId)` - Bulk cleanup when session ends

**Duration Calculation:**
```javascript
// ended_at_effective = min(now, last_seen_at + 45s)
// Prevents "left tab open all day" from counting toward usage
const maxEndTime = new Date(lastSeen.getTime() + 45000);
const endedAtEffective = now < maxEndTime ? now : maxEndTime;
```

### 3. Quota Status Wrapper

**Module:** `backend/usage/getListeningQuota.js`

- `getListeningQuotaStatus(churchId)` - RPC wrapper for instant quota remaining
- Includes month-to-date usage AND active listening spans (in-flight)

### 4. WebSocket Integration

**File:** `backend/websocketHandler.js`

**Changes:**
- Listener connection starts a listening span automatically
- 30-second heartbeat interval keeps span active while connected
- Disconnect triggers `stopListening` with reason `'ws_disconnect'`
- UUID generated per listener connection for `listening_spans.user_id`

### 5. Integration Test

**File:** `backend/tests/integration/test-listening-spans.js`

**Coverage:**
- ✅ Start listening (span creation, idempotency)
- ✅ Heartbeat (timestamp updates)
- ✅ Stop listening (duration calculation, event recording)
- ✅ Nonexistent span handling (graceful no-op)
- ✅ Quota status (Verified on PROD)

---

## Part 8: Session-Based Metering (Host Time) (PR7.5)

**Context:** While listening time tracks individual listener consumption, we needed a way to meter the **host's active streaming time** for organization-level quotas (e.g., 60 minutes of translation per month).

### 1. Session Spans Service

**Module:** `backend/usage/sessionSpans.js`

**Logic:** Similar to listening spans, but tracked at the session level rather than per-user.
- **Trigger**: Starts on the **first audio packet** (precise metering).
- **Heartbeat**: Updates `last_seen_at` every 30s during active streaming.
- **Stop**: Ends when host stops recording (`audio_end`) or session ends.

### 2. Precise Triggering (adapter.js)

**File:** `backend/host/adapter.js`

We moved the metering trigger from the session `init` to the first `audio` message. This ensures churches are only billed for seconds they are **actually recording audio**, not just for holding the session open.

### 3. Session Quota RPC

**Migration:** `supabase/migrations/20260130_get_session_quota_status.sql`

Implemented `get_session_quota_status(church_id)` which provides **O(1) live counting**:
- **Historical**: Sums `usage_monthly` (completed sessions).
- **Live**: Sums the duration of any **currently active** session spans.
- **Total**: Provides an instant "Running Counter" for the UI.

### 4. Verification (PROD)
- ✅ **Aggregation**: Verified that multiple 10-15s segments correctly aggregate into the monthly total.
- ✅ **Live Counter**: Verified that the RPC correctly includes "in-flight" seconds before the span is finalized.
- ✅ **Foreign Key Safety**: Verified that spans correctly link to the `sessions` table ID.

---

## Part 9: Usage Limits & Quota Enforcement (PR7.6)

**Context:** To enable plan-based restrictions and provide warnings before users exhaust their monthly quota, we implemented a complete quota enforcement system with separate tracking for solo and host modes.

### 1. Mode-Specific Quotas (Database)

**Migration:** `supabase/migrations/20260203_add_solo_host_quotas.sql`

Added separate quota columns to the `plans` table:
- `included_solo_seconds_per_month` - Quota for solo mode usage
- `included_host_seconds_per_month` - Quota for host mode usage

This enables different quotas per mode (e.g., Pro: 3hr solo + 3hr host vs. combined 6hr).

### 2. Updated Quota RPC

**Migration:** `supabase/migrations/20260203_update_quota_rpc_with_modes.sql`

Updated `get_session_quota_status(church_id)` to return mode-specific breakdown:
```javascript
{
  // Combined (backwards compatible)
  included_seconds_per_month,
  used_seconds_mtd,
  remaining_seconds,
  // Solo breakdown
  included_solo_seconds, used_solo_seconds_mtd, remaining_solo_seconds,
  // Host breakdown
  included_host_seconds, used_host_seconds_mtd, remaining_host_seconds
}
```

### 3. Quota Enforcement Module

**Module:** `backend/usage/quotaEnforcement.js`

**Functions:**
- `getQuotaStatus(churchId)` - Returns comprehensive quota status with mode-specific and combined breakdowns
- `checkQuotaLimit(churchId, mode)` - Returns action: `allow`, `warn` (80%), or `lock` (100%)
- `createQuotaEvent(checkResult)` - Generates WebSocket payload for frontend

**Warning Threshold Logic:**
```javascript
const WARNING_THRESHOLD = 0.80;  // 80% = show warning
const EXCEEDED_THRESHOLD = 1.0; // 100% = lock session
```

### 4. Backend Integration (Solo & Host)

**Files Modified:**
- `backend/soloModeHandler.js` - Added quota check on heartbeat interval
- `backend/host/adapter.js` - Added quota check on heartbeat interval

**Behavior:**
- **Every 30s heartbeat**: Calls `checkQuotaLimit(churchId, mode)` alongside duration tracking
- **At 80%**: Sends `quota_warning` WebSocket event (once per session)
- **At 100%**: Sends `quota_exceeded` event, sets `quotaExceeded = true` to block further audio

### 5. Frontend Components

**New Files:**
- `frontend/src/components/ui/UsageLimitModal.jsx` - Modal for exceeded/warning display
- `frontend/src/components/ui/UsageLimitModal.css` - Modern dark theme styling
- `frontend/src/hooks/useQuotaWarning.js` - Hook for handling quota WebSocket events

**UI Features:**
- **Warning Toast**: Dismissible toast at 80% usage with "Details" button
- **Exceeded Modal**: Full-screen modal with usage bar, "Upgrade Plan" and "Add Hours" buttons ("Coming Soon")
- **Blocked Start**: Start button disabled and shows "Quota Exceeded" when limit reached

**SoloPage Integration:**
- Added `useQuotaWarning()` hook
- WebSocket message handler calls `quotaWarning.handleMessage(message)`
- Modal/Toast rendered conditionally based on hook state
- Start button respects `quotaWarning.isRecordingBlocked`

### 6. Files Created

| File | Purpose |
|------|---------|
| `backend/usage/quotaEnforcement.js` | Quota checking and event generation |
| `frontend/src/hooks/useQuotaWarning.js` | WebSocket quota event handling |
| `frontend/src/components/ui/UsageLimitModal.jsx` | Modal/Toast components |
| `frontend/src/components/ui/UsageLimitModal.css` | Styling for quota UI |
| `supabase/migrations/20260203_add_solo_host_quotas.sql` | Schema migration |
| `supabase/migrations/20260203_update_quota_rpc_with_modes.sql` | RPC migration |

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

### 4. 3-Tier Plan Structure
We have finalized three distinct business tiers with specific model routing:

| Tier | Code | STT Engine | Chat Engine | TTS Engine |
| :--- | :--- | :--- | :--- | :--- |
| **Starter** | `starter` | Standard Google | `gpt-4o-mini` | Standard, Neural2, Studio |
| **Pro** | `pro` | Enhanced Google | `gpt-4o` | **Chirp 3 HD** (+ Starter) |
| **Unlimited** | `unlimited` | **STT 2.0** (`latest_long`) | **GPT Realtime** | **Gemini**, **ElevenLabs** (+ Pro) |

### 5. TTS Technical Tier Mapping
The mapping between business tiers (in the database `plans.tts_tier`) and technical voice families (in the `voiceCatalog`) is enforced in `backend/entitlements/assertEntitled.js`.

| Technical Tier | Included In | Provider | Notes |
| :--- | :--- | :--- | :--- |
| `standard` | Starter | Google | Basic concatenative voices |
| `neural2` | Starter | Google | High-quality neural voices |
| `studio` | Starter | Google | Premium studio-quality voices |
| `chirp3_hd` | Pro | Google | STT 2.0-aligned high-fidelity voices |
| `gemini` | Unlimited | Google/Gemini | Advanced LLM-based speech synthesis |
| `elevenlabs` | Unlimited | ElevenLabs | Realistic, cloneable AI voices |

This structure ensures that while the database manages the "what" (Business Plan), the code manages the "how" (Technical Capabilities).

This structure is enforced at the backend level by the `entitlements` module, which resolves the provider/model/params dynamically for every session.

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
- `backend/usage/index.js` - Usage service entry
- `backend/usage/recordUsage.js` - Idempotent recorder
- `backend/usage/getUsage.js` - Usage reporting
- `backend/usage/listeningSpans.js` - Listener span tracking
- `backend/usage/getListeningQuota.js` - Quota status RPC wrapper
- `backend/usage/sessionSpans.js` - Host session span tracking [NEW]
- `backend/usage/getSessionQuota.js` - Session quota status wrapper [NEW]
- `backend/routes/me.js` - User context endpoint
- `backend/routes/entitlements.js` - Entitlements debug endpoint
- `backend/routes/usage.js` - Usage debug endpoint
- `backend/tests/manual/entitlements.test.js` - Unit tests (12 pass)
- `backend/tests/integration/test-listening-spans.js` - Listening span tests
- `backend/tests/manual-test-session-quota.js` - End-to-end session quota verification [NEW]
- `backend/AUTH_TESTING.md` - Testing guide
- `supabase/migrations/20260128_record_usage_event.sql` - Usage RPC
- `supabase/migrations/20260130_update_record_usage_event.sql` - Adds usage_monthly upsert
- `supabase/migrations/20260130_get_session_quota_status.sql` - Session quota live counter RPC [NEW]

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
├── usage/
│   ├── recordUsage.js
│   ├── getUsage.js
│   ├── listeningSpans.js
│   ├── getListeningQuota.js
│   ├── sessionSpans.js            [NEW]
│   ├── getSessionQuota.js         [NEW]
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
- [x] Wire usage recording into real routes (minutes, characters) (PR7.3)
- [x] Implement TTS tier gating (simple catalog filtering) (PR7.2)
- [x] Align Dev and Production database configurations (IDs & Routing) (PR7.3)

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
5. **Database Indexing** - Added indices on `usage_events(church_id, occurred_at)` to optimize usage reporting and billing lookups.

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

### 2026-01-29 - PR 7.2 & 7.3 - Tier Gating & Usage Completion
- ✅ Implemented TTS Tier Gating based on `tts_tier` (Starter/Pro/Unlimited)
- ✅ Wired real-time usage recording for STT (seconds) and TTS (characters)
- ✅ Implemented GPT Realtime (Premium) gating in `soloModeHandler`
- ✅ Resolved dynamic STT parameters (`latest_long`, auto-punctuation) from DB routing
- ✅ **Database Alignment**: Synchronized Dev and Production environments to match IDs and Plan UUIDs 1:1 using `surgical-sync.js`
- ✅ **Bug Fix: Profile Lookup**: Corrected `server.js` to look up profiles via `user_id` instead of `id`, ensuring entitlements load correctly.
- ✅ **Bug Fix: TTS Usage**: Wired `churchId` into `TtsStreamingOrchestrator` to enable `tts_characters` usage recording.
- ✅ **Performance**: Applied migration to add indices to `usage_events` table on `church_id` and `occurred_at`.
- ✅ **Enhancement: Tier-Aware Voice Defaults**: Updated `getDefaultVoice` to select tier-appropriate defaults (Starter→standard, Pro→chirp3_hd, Unlimited→elevenlabs_flash).
### 2026-01-29 - Session Fixes - Host Mode & Stability
- ✅ **Fix: Host Mode Audio Race Condition**: Implemented message queuing in `hostModeHandler.js` to buffer audio packets received before the Google Speech stream is fully initialized.
- ✅ **Fix: Profile Lookup Bug**: Updated `server.js` to query profiles by `user_id` instead of `id`, fixing entitlement loading for users.
- ✅ **Fix: Entitlements Fetch**: Resolved a `SyntaxError` in `websocketHandler.js` related to dynamic imports, ensuring reliable plan fetching.
- ✅ **Enhancement: Tier Gating Backend**: Updated `ttsRouting.js` to properly enforce tier limits (Starter/Pro/Unlimited) and fallback strategies.
- ✅ **Enhancement: Database Indices**: Added indices to `usage_events` for performance optimization.
- ✅ **Solo Mode: Tier Gating & Usage**: Implemented full feature parity for Solo Mode, including:
    - Real-time plan enforcement (Starter/Pro/Unlimited) using `getAllowedTtsTiers`
    - Dynamic voice dropdown with lock indicators for premium voices
    - Accurate usage tracking for STT (seconds) and TTS (characters)
    - Fixed race condition in initial voice list fetching
### 2026-01-30 - Session Lifecycle & Persistence
- ✅ **Database Persistence**: Updated `sessionStore.js` to persist sessions to Supabase `sessions` table (create/upsert/end).
- ✅ **Session Lifecycle**: Implemented robust session ending:
    - **Explicit End**: "End Session" button in Host UI triggers `end_session` message.
    - **Graceful End**: Host disconnect triggers 30s grace timer (`scheduleSessionEnd`) before closing.
    - **Startup Cleanup**: `cleanupAbandonedSessions` runs on server start to mark zombie sessions as ended.
- ✅ **Frontend**: Added distinct "End Session" button with confirmation dialog in `HostPage.jsx`.
- ✅ **Host Adapter**: Wired `end_session` and grace timer logic into the active `adapter.js`.

### 2026-02-02 - PR 7.5 - Session-Based Metering (Host Time)
- ✅ **Host Spans**: Implemented `sessionSpans.js` to track active streaming duration.
- ✅ **Precise Metering Trigger**: Refactored `adapter.js` to start metering on **first audio**, not session start.
- ✅ **Live Counter RPC**: Deployed `get_session_quota_status` to PROD for O(1) running total calculation.
- ✅ **Manual Verification**: Created `manual-test-session-quota.js` and verified full flow (start → heartbeat → stop → aggregate) on PROD.
- ✅ **Final Result**: February MTD and Live Counter verified working with plan-aware subtraction.

### 2026-02-02 - PR Next-1: Frontend Auth + Session Entry
- ✅ **Frontend Auth**: Implemented Supabase Auth (Email + Google) via `AuthContext.jsx`.
- ✅ **UI Components**: Setup shadcn/ui and created modern `LoginPage` and `NoProfilePage`.
- ✅ **App Shell Gating**: Secured `App.jsx` to block unauthorized access to Host/Solo modes.
- ✅ **Host Token Injection**: Updated `HostPage.jsx` to pass JWT via `sec-websocket-protocol` (header) or query param for `ws` connection.
- ✅ **Session API**: Secured `/api/session/start` with Bearer token authentication from frontend.

### 2026-02-02 - PR2: Auth + Membership UX Rewrite
- ✅ **Middleware Refactor**: Split `requireAuthContext.js` into:
    - `requireAuth`: Verifies JWT but allows `profile: null` (visitors)
    - `requireChurchMember`: Requires profile with `church_id`
    - `requireAdmin`: Requires `role: 'admin'`
- ✅ **Visitor-First Flow**: 
    - New `JoinPage.jsx` as default entry point for all users
    - Users can join sessions without logging in
    - `/api/me` returns `{ profile: null, isVisitor: true }` for profileless users
- ✅ **Auth Context Updates**: Added computed props `isVisitor`, `isMember`, `isAdmin`, `hasChurch`
- ✅ **Auto-Link on Session Join**:
    - Created `backend/membership/autoLink.js` with `autoLinkToChurch()` function
    - `/session/join` now auto-creates profile when signed-in visitor joins
    - Returns `autoLinked: true, churchName: "..."` for frontend toast
    - `ListenerPage.jsx` shows welcome message after auto-link
- ✅ **Build Verification**: Frontend builds successfully (1.1 MB bundle)

### 2026-02-02 - PR3: State-Based Home Pages
- ✅ **VisitorHome**: New home page for visitors (anonymous + signed-in without profile):
    - Primary: Join session by code
    - Secondary: Join a church, Create a church (placeholders for PR4)
- ✅ **MemberHome**: Home page for church members:
    - Solo mode access
    - Join session by code
- ✅ **AdminHome**: Home page for church administrators:
    - Host session (primary, prominent)
    - Solo mode, Join session
    - Future: Analytics placeholder
- ✅ **App.jsx Routing**: Routes to appropriate home based on `isAdmin`, `isMember`, `isVisitor`
- ✅ **Build Verification**: Frontend builds successfully (776 KB, 7.2s)

### 2026-02-02 - PR4: Church Search/Join
- ✅ **Backend Routes** (`backend/routes/churches.js`):
    - `GET /api/churches/search` - Search churches by name (public)
    - `POST /api/churches/join` - Join a church (requires auth)
    - `GET /api/churches/:id` - Get church details
- ✅ **Frontend Component** (`frontend/src/components/JoinChurchPage.jsx`):
    - Debounced search with live results
    - Join button with loading state
    - Success message and profile reload after joining
- ✅ **App Integration**: Wired `join-church` mode into `App.jsx` navigation
- ✅ **Build Verification**: Frontend builds successfully (780 KB, 56s)

### 2026-02-02 - Bug Fix: Solo Mode Init Race Condition
- ✅ **Root Cause**: `init` message sent in WebSocket `onopen` was arriving at backend BEFORE message handler was fully attached by `handleSoloMode()`. This caused audio to be received before `speechStream` was initialized.
- ✅ **Symptoms**:
    - `[SoloMode] Received audio before stream initialization` flooding backend logs
    - No transcription events in Solo Mode
    - Backend never logged `RAW MSG RECEIVED: init`
- ✅ **Fix Applied** (`frontend/src/components/solo/SoloPage.jsx`):
    - Moved `init` message sending from `socket.onopen` to after receiving `info` message from backend
    - This ensures the backend's message handler is fully attached before sending `init`
    - The `info` message ("Connected to Google Speech + OpenAI Translation") now acts as a handshake confirmation
- ✅ **Code Change**:
    ```javascript
    // BEFORE: Sent init immediately on open (race condition)
    socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'init', ... }));
    };
    
    // AFTER: Wait for 'info' from backend (ensures handler ready)
    case 'info':
        if (!isServerReady && socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'init', ... }));
            setIsServerReady(true);
        }
        break;
    ```
- ✅ **Verification**: Backend now correctly receives `init`, initializes `speechStream`, and transcription works as expected.
- ✅ **Env Fix**: Also corrected `.env.local` ports from `3000` to `3001` (`VITE_API_URL`, `VITE_WS_URL`)

### 2026-02-02 - Bug Fix: TTS Tier Gating Regression
- ✅ **Root Cause 1**: `getVoicesFor()` in `websocketHandler.js` was called without `allowedTiers` parameter, causing crash on `allowedTiers.includes()`.
- ✅ **Root Cause 2**: `TtsPlayerController.js` was not passing `isAllowed` flag when mapping voices to frontend.
- ✅ **Root Cause 3**: `ListenerPage.jsx` had hardcoded tier logic instead of using server's `isAllowed` flag.
- ✅ **Fixes Applied**:
    - **Backend** (`websocketHandler.js`): Pass `ALL_TIERS` to `getVoicesFor()` to fetch all voices, then mark each voice with `isAllowed: true/false` based on user's plan entitlements.
    - **Frontend** (`TtsPlayerController.js`): Added `isAllowed: v.isAllowed` to voice mapping.
    - **Frontend** (`ListenerPage.jsx`): Removed hardcoded `STARTER_TIERS`/`PRO_TIERS` logic; now uses server-provided `isAllowed` flag.
- ✅ **Result**: Voice dropdown now correctly shows locked/unlocked voices based on user's subscription tier:
    - **Starter**: `standard`, `neural2`, `studio` unlocked
    - **Pro**: Above + `chirp3_hd` unlocked
    - **Unlimited**: All voices unlocked (including `gemini`, `elevenlabs_*`)

### 2026-02-03 - PR 7.6: Usage Limits & Quota Enforcement
- ✅ **Schema Update**: Added `included_solo_seconds_per_month` and `included_host_seconds_per_month` columns to `plans` table
- ✅ **RPC Update**: Modified `get_session_quota_status` to return mode-specific quotas (solo/host) with backwards compatibility
- ✅ **Quota Enforcement Module**: Created `backend/usage/quotaEnforcement.js` with:
    - `getQuotaStatus()` - Fetches detailed quota breakdown
    - `checkQuotaLimit()` - Returns action (`allow`, `warn`, `lock`) based on thresholds
    - `createQuotaEvent()` - Generates WebSocket payload for frontend
- ✅ **Backend Integration**: Both `soloModeHandler.js` and `host/adapter.js` now:
    - Track mode-specific usage (`solo_seconds`, `host_seconds`)
    - Send `quota_warning` event at 80% usage
    - Send `quota_exceeded` event at 100% and block audio processing
- ✅ **Frontend Components**: 
    - `UsageLimitModal.jsx` - Modal with usage bar and action buttons (Upgrade Plan, Add Hours = "Coming Soon")
    - `useQuotaWarning.js` - Hook for handling WebSocket quota events
    - Toast variant for 80% warning, full modal for 100% exceeded
    - Start button disabled when quota exceeded

