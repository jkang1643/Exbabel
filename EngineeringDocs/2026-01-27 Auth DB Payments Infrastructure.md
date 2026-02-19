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
  included_host_seconds, used_host_seconds_mtd, remaining_host_seconds,
  // Purchased credits (NEW)
  purchased_solo_seconds_mtd, purchased_host_seconds_mtd, purchased_seconds_mtd,
  total_available_seconds
}
```
**Note:** `included_solo_seconds` and `included_host_seconds` now automatically include any purchased credits for that mode.


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

## Part 3: Payments & Billing Integration (Implemented Infrastructure)

**Status:** Implementation Complete (2026-02-10)
**Provider:** Stripe (Checkout + Webhooks)

This section outlines the implemented "wiring" that enables self-service upgrades, top-ups, and the critical "Account First" acquisition flow.

### 1. Admin Acquisition Flow (Account First)
**Goal:** Default path for new users to become admins.
**Principle:** "Account before payment". Users must have an authenticated account and a church record *before* Stripe is engaged.

**Flow:**
1.  **Entry:** User visits `/checkout?plan=starter` (e.g., from landing page).
2.  **Auth Gating:**
    *   If not signed in → Redirects to `/signup?redirect=/checkout?plan=starter`.
    *   **Crucial:** The `redirect` query param is preserved through the entire email verification loop (Supabase `emailRedirectTo`).
3.  **Church Creation:**
    *   If signed in but no church → Redirects to `/create-church?redirect=/checkout?plan=starter`.
4.  **Checkout Initialization:**
    *   Once authenticated with a church, `CheckoutPage` calls `POST /api/billing/checkout-session`.
    *   **Body:** `{ plan: 'starter' }` (begins 30-day free trial).
5.  **Stripe Interaction:**
    *   Backend creates a **Stripe Checkout Session** (Mode: `subscription`).
    *   `client_reference_id`: Set to `church_id`.
    *   `metadata`: `{ user_id: '...', church_id: '...' }`.
6.  **Success:**
    *   User returns to `/billing?checkout=success&session_id=...`.
    *   Frontend polls `/api/billing/checkout-status` until webhook confirms role upgrade.

### 2. Deterministic Role Synchronization
**Goal:** Ensure the user's role (`admin` vs `member`) always matches their subscription status, with no race conditions.

**Source of Truth:** `backend/routes/webhooks.js` -> `syncRoleFromStatus(churchId, status)`

**Logic:**
*   **Admin Access Granted:** Status is `active` or `trialing`.
*   **Admin Access Revoked:** Status is `past_due`, `canceled`, `unpaid`, or `paused`.

**Triggers:**
*   `customer.subscription.updated` (Plan changes, trial expiry)
*   `customer.subscription.deleted` (Cancellation)
*   `invoice.payment_succeeded` (Renewal success → ensures `active`)
*   `invoice.payment_failed` (Payment failure → sets `past_due` → demotes to `member`)

### 3. Upgrade Plan Flow (Subscription)
**Goal:** Allow users to switch from Free/Starter to Pro/Unlimited.

1.  **Trigger:** User clicks "Upgrade Plan" in `UsageLimitModal` or `/billing`.
2.  **API Call:** `POST /api/billing/checkout-session`
    *   **Body:** `{ plan: 'pro' }`
3.  **Stripe Interaction:**
    *   Backend creates a **Stripe Checkout Session** (Mode: `subscription`).
    *   Uses `setup_mode` if already on a compatible subscription, or creates a new session.
4.  **Fulfillment (Webhook):** `customer.subscription.updated`
    *   Updates `plan_id` and `stripe_price_id` in `subscriptions` table.
    *   Calls `syncRoleFromStatus` (idempotent).

### 4. "Top Up" Flow (One-Time Add Hours)
**Goal:** Allow users to purchase extra hours (e.g., "5 Hour Pack") when quota is low.

1.  **API Call:** `POST /api/billing/checkout-session` (Shared endpoint handle logic based on payload)
    *   **Body:** `{ topUpPack: '5_hours' }`
3.  **Fulfillment (Webhook):** `checkout.session.completed` (Mode: `payment`)
    *   **Doubling Logic:** Purchasing "X hours" creates **two** records:
        *   X hours for **Solo Mode**
        *   X hours for **Host Mode**
        *   Total: 2X hours available (100% for each mode).
    *   Inserts into `purchased_credits` table with `mode='solo'` and `mode='host'`.
    *   `get_session_quota_status` RPC automatically places these credits on top of the monthly allowance.

### 5. Verified Implementation Details
- **Webhook Security:** Webhook route mounted *before* `express.json()` to allow raw body signature verification.
- **Null Safety:** `updateSubscriptionRow` handles missing `current_period_start/end` fields (common in test clock events).
- **Subscription ID Extraction:** `extractSubscriptionId` helper handles both string IDs and expanded objects in Stripe invoice events.
- **Redirects:** Frontend Auth Context and Route Wrappers (`SignUpRoute`, `LoginRoute`, `CreateChurchRoute`) now universally support the `?redirect=` parameter to preserve user intent.

### 6. Checkout Page Hybrid Routing Pattern (2026-02-11)
**Goal:** Enable `/checkout` to serve dual purposes: plan browsing UI for logged-in users AND smart routing controller for landing page conversions.

**Pattern:** The `/checkout` page acts as a **hybrid controller** based on the presence of the `?plan=` query parameter.

#### Behavior Matrix

| URL | User State | Action |
|-----|-----------|--------|
| `/checkout` (no params) | Any | Shows 3-tier plan selection UI |
| `/checkout?plan=starter` | Not authenticated | Redirects to `/signup?redirect=/checkout?plan=starter` |
| `/checkout?plan=starter` | Authenticated, no church | Redirects to `/create-church?redirect=/checkout?plan=starter` |
| `/checkout?plan=starter` | Authenticated with church | Auto-creates Stripe checkout session → Redirects to Stripe |
| `/checkout?plan=starter` | Already admin | Redirects to `/billing` (for upgrades) |

#### Implementation Details

**File:** `frontend/src/components/CheckoutPage.jsx`

**Smart Router Logic:**
```javascript
useEffect(() => {
  if (loading) return;

  // No plan parameter → show normal UI (browsing mode)
  if (!plan) return;

  // Invalid plan → redirect to checkout without params
  if (!PLANS.find(p => p.code === plan)) {
    navigate('/checkout', { replace: true });
    return;
  }

  // Plan parameter present → act as smart router
  if (isAdmin) {
    navigate('/billing', { replace: true }); // Upgrade flow
  } else if (!isAuthenticated) {
    navigate(`/signup?redirect=/checkout?plan=${plan}`, { replace: true });
  } else if (!hasChurch) {
    navigate(`/create-church?redirect=/checkout?plan=${plan}`, { replace: true });
  } else {
    handleCheckout(plan); // Auto-trigger Stripe
  }
}, [loading, isAuthenticated, isAdmin, hasChurch, plan, navigate]);
```

**Button Click Flow (Manual Selection):**
- User clicks "Get Pro" button on `/checkout` (no params)
- Calls `handleCheckout('pro')`
- Function checks auth state and either redirects to signup/create-church OR creates Stripe session

**Landing Page Integration:**
- Marketing site (`exbabel.com`) routes to `app.exbabel.com/checkout?plan=starter`
- Config file: `exbabel/lib/config.ts`
```typescript
export const appRoutes = {
  pricingStarter: `${getAppUrl()}/checkout?plan=starter`,
  pricingPro: `${getAppUrl()}/checkout?plan=pro`,
  pricingUnlimited: `${getAppUrl()}/checkout?plan=unlimited`,
};
```

**Complete User Journey (From Landing Page):**
1. User clicks "Start Free Trial" on `exbabel.com/pricing`
2. Redirects to `localhost:3000/checkout?plan=starter`
3. Not signed in → Redirects to `/signup?redirect=/checkout?plan=starter`
4. After signup → Redirects to `/create-church?redirect=/checkout?plan=starter`
5. After creating church → Back to `/checkout?plan=starter`
6. Auto-triggers Stripe checkout → Redirects to Stripe payment page
7. After payment → Returns to `/billing?checkout=success`
8. Webhook confirms subscription → Role upgraded to `admin`



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
- `backend/services/stripe.js` - Stripe SDK singleton [NEW]
- `backend/routes/webhooks.js` - Stripe webhook handler [NEW]
- `backend/routes/billing.js` - Billing API routes [NEW]
- `frontend/src/components/BillingPage.jsx` - Billing management page [NEW]
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
│   ├── abandonedSessionReaper.js  [NEW]
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

### Short-Term (Stripe Integration) ✅ COMPLETED
- [x] Connect Stripe account to backend
- [x] Implement webhook handlers for subscription events
- [x] Add Stripe customer creation to church onboarding
- [x] Sync Stripe status to `subscriptions` table

### Medium-Term (Payments) ✅ COMPLETED
- [x] Integrate Stripe SDK
- [x] Create subscription plans
- [x] Implement webhook handlers
- [x] Build billing portal API
- [x] Add usage metering

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

### 6. Checkout Page Hybrid Routing Pattern (2026-02-11)
**Goal:** Enable `/checkout` to serve dual purposes: plan browsing UI for logged-in users AND smart routing controller for landing page conversions.

**Pattern:** The `/checkout` page acts as a **hybrid controller** based on the presence of the `?plan=` query parameter.

[... (Routing details previously added) ...]

---

## Part 10: Critical Fixes & Hardening

### 1. Admin Role Assignment Fix (2026-02-11)

**Severity:** Critical
**Issue:** Users completing the payment flow were assigned `'member'` role instead of `'admin'`, blocking access to paid features.

**Root Cause Analysis:**
- Church creation initialized subscriptions with `status: 'active'`.
- The webhook (`customer.subscription.updated`) relies on status *transitions* or explicit checks to trigger `syncRoleFromStatus`.
- Since the status was already `'active'`, the webhook saw no change/reason to upgrade the role.

**Solution:**
1. **Schema Update:** Added `'inactive'` to the `subscriptions.status` CHECK constraint.
   - Migration: `20260211_add_inactive_status.sql`
2. **Logic Change:** `POST /churches/create` now initializes subscriptions as `'inactive'`.
3. **Flow:**
   - Creation: `status='inactive'`, `role='member'`
   - Payment: Webhook sets `status='trialing'/'active'`
   - Trigger: Webhook detects valid admin status → Upgrades `role='admin'`

**SQL Migration:**
```sql
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
CHECK (status = ANY (ARRAY['inactive', 'trialing', 'active', 'past_due', 'canceled', 'paused']));
```

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
    - **Periodic Reaper**: `abandonedSessionReaper` runs every 5 minutes to clean up stale sessions (last heartbeat > 5 min ago) on long-running servers.
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

### 2026-02-06 - Bug Fix: Solo Mode Session Constraint
- ✅ **Fix: Foreign Key Violation**: Updated `ensureTrackingSession` to await DB insert before allowing `startSessionSpan`, preventing race conditions.
- ✅ **Fix: Silent Failure Retry**: Added `.catch()` block to `ensureSessionActive` to reset `sessionSpanStarted` flag on failure, allowing instant retries.
- ✅ **Fix: Session Code Constraint**: Changed Solo Mode session ID generation from `SOLO-XXXX` (9 chars) to `SXXXXX` (6 chars alphanumeric) to satisfy `sessions_session_code_check1` database constraint.

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

### 2026-02-06 - Abandoned Session Reaper
- ✅ **Periodic Reaper**: Created `backend/usage/abandonedSessionReaper.js` to clean up abandoned sessions on long-running servers
- ✅ **Heartbeat-Based Detection**: Reaper identifies stale spans by checking if `last_seen_at` is older than 5 minutes (300 seconds)
- ✅ **Functions**:
    - `reapAbandonedSessionSpans()` - Finds and stops stale spans via `stopSessionSpan()` with reason `'abandoned_reaper'`
    - `reapAbandonedSessions()` - Ends session records with no in-memory presence or active spans
    - `startPeriodicReaper()` - Starts 5-minute interval, runs immediately on startup
- ✅ **Server Integration**: `server.js` now starts the reaper automatically after `cleanupAbandonedSessions()`
- ✅ **Integration Test**: Added `backend/tests/integration/test-abandoned-reaper.js` covering:
    - Stale span reaping
    - Recent span preservation (active recording is NOT reaped)
    - Abandoned session cleanup
- ✅ **Use Cases**: Handles users who forget to end sessions, close laptops while recording, or experience network drops

### 2026-02-07 - URL Routing & OAuth Fixes
- ✅ **URL-Based Routing**: Migrated from state-based routing to React Router for proper URL navigation
    - **Package**: Installed `react-router-dom` for URL-based routing
    - **Routes**: Created route mappings for all pages (`/signin`, `/signup`, `/solo`, `/host`, `/listener`, etc.)
    - **Protected Routes**: Implemented `ProtectedRoute` component for authentication guards
    - **Navigation**: Replaced all `setMode()` calls with `navigate()` from `useNavigate` hook
    - **Browser Support**: Added support for browser back/forward buttons and direct URL access
- ✅ **OAuth Redirect Fix**: Fixed Google OAuth callback flow
    - **Problem**: After Google OAuth, users stayed on `/signin#` instead of being redirected home
    - **Solution**: Added `useEffect` hooks to `LoginRoute` and `SignUpRoute` to detect authenticated users and auto-redirect to home page
    - **Files Modified**: `frontend/src/App.jsx` (LoginRoute, SignUpRoute)
- ✅ **Session Code Persistence**: Fixed session code display issues in listener page
    - **Fix 1**: Changed session code display from `sessionInfo?.sessionCode` to `sessionCode || sessionInfo?.sessionCode`
    - **Fix 2**: Added `useEffect` to sync `sessionCodeProp` with `sessionCode` state for URL parameters
    - **Result**: Session codes now persist correctly when entered manually or loaded from URL (`/listener?code=ABC123`)
    - **Files Modified**: `frontend/src/components/ListenerPage.jsx`
- ✅ **Auth Context Updates**: Updated OAuth redirect URLs
    - `signInWithGoogle`: Changed redirect from `window.location.origin` to `${window.location.origin}/signin`
    - `signUpWithEmail`: Changed redirect from `window.location.origin` to `${window.location.origin}/signup`
    - **Files Modified**: `frontend/src/contexts/AuthContext.jsx`

### 2026-02-10 - PR 7.7 - Secure Quota Enforcement & Verification
- ✅ **Pre-Connect Gate**: Implemented `GET /api/quota-check` REST endpoint to check quota status before WebSocket connection
- ✅ **Frontend Hard Lock**: Added `checkQuotaOnMount()` to `useQuotaWarning` hook to disable UI immediately if quota exceeded
- ✅ **Simultaneous Quota Testing**: Updated `set_test_usage.js` to manage both Solo and Host quotas in parallel
- ✅ **Last-Minute Verification**: Added `--last-minute` flag to test precise session termination at 0s remaining
- ✅ **Robustness**: Fixed "Dismiss" button responsiveness in `UsageLimitModal` by simplifying state logic

---

## Part 10: Robustness & Verification (PR7.7)

**Context:** To prevent loophole exploitation (e.g., cache clearing, refresh) and ensure strict quota enforcement, we implemented a "Fail-Secure" pre-connect layer and robust verification tools.

### 1. Pre-Connect Enforcement Layer
**Goal:** Block users BEFORE they connect to the WebSocket, preventing "flash of unlocked UI".
- **REST Endpoint**: `GET /api/quota-check` (lightweight, auth-only) returns instant quota status.
- **Frontend Guard**: `useQuotaWarning.checkQuotaOnMount()` calls this API on page load.
- **Behavior**: If quota exceeded, `isRecordingBlocked` is set to `true` immediately, disabling "Start" buttons even if the WebSocket hasn't connected yet.

### 2. Simultaneous Quota Management
**Refinement:** Updated `backend/scripts/set_test_usage.js` to manage **both** Solo and Host quotas in parallel.
- **Why**: Plans now have separate limits (e.g., 4h Solo vs 6h Host).
- **Tool**: The script updates both buckets to the target percentage (e.g., 85%) to ensure consistent testing.

### 3. Last-Minute Verification
**Feature:** Added `--last-minute` flag to the test script.
- **Logic**: Sets usage to exactly `Limit - 60 seconds`.
- **Purpose**: Verifies that the "Approaching Limit" (1 min remaining) warning fires correctly and that the session terminates precisely at 0s.

---

## Part 11: Stripe Billing Integration (2026-02-10)

**Context:** To enable self-service subscription upgrades and credit purchases, we integrated Stripe billing into the Exbabel backend and frontend.

### 1. Database Migrations
- Added `stripe_customer_id TEXT` to `churches` (partial unique index on non-null)
- Created `purchased_credits` table (`church_id`, `amount_seconds`, `stripe_payment_intent_id`, `created_at`, `mode`)
    - Added `mode` column check constraint (`'solo'`, `'host'`)
    - Indexed by `(church_id, mode, created_at)` for RPC performance
- Added `stripe_price_id TEXT UNIQUE NULL` to `plans` and seeded Stripe Price IDs
- Updated `get_session_quota_status` RPC to include `purchased_seconds_mtd` and `total_available_seconds` (monthly-expiring credits)

### 2. Stripe Service (`backend/services/stripe.js`)
- Singleton Stripe SDK initialization with `STRIPE_SECRET_KEY`
- Warns if key is missing; billing features gracefully degrade

### 3. Webhook Handler (`backend/routes/webhooks.js`)
- **Critical:** Mounted BEFORE `express.json()` in `server.js` (requires raw body for signature verification)
- Uses `stripe.webhooks.constructEvent()` for signature verification
- **Events handled:**
  - `checkout.session.completed` (subscription) → UPDATE `subscriptions` with plan, Stripe IDs
  - `checkout.session.completed` (payment, type=top_up) → INSERT into `purchased_credits` (Double-entry: 1x Solo + 1x Host)
  - `customer.subscription.updated` → UPDATE subscription status, period, plan
  - `customer.subscription.deleted` → UPDATE status to `canceled`
- All handlers call `clearEntitlementsCache(churchId)` for immediate effect

### 4. Billing API (`backend/routes/billing.js`)
- All endpoints require `requireAuth` + `requireAdmin` middleware
- `POST /api/billing/subscription-checkout` — Stripe Checkout Session (mode: subscription)
- `POST /api/billing/top-up-checkout` — Stripe Checkout Session (mode: payment)
- `GET /api/billing/portal` — Stripe Billing Portal session
- `GET /api/billing/status` — Current plan, usage, credits, available packs
- Top-up packs: 1hr ($9.99), 5hr ($39.99), 10hr ($69.99)
- Uses `ensureStripeCustomer(churchId)` for lazy customer creation

### 5. Church Onboarding Update (`backend/routes/churches.js`)
- Church creation now includes Step 5: Stripe customer creation (non-blocking)
- Fallback: `ensureStripeCustomer` in billing.js lazily creates customer on first billing action

### 6. Frontend Billing Page (`frontend/src/components/BillingPage.jsx`)
- Current plan card with usage progress bar
- Upgrade buttons (Pro / Unlimited) with Stripe Checkout redirect
- Add Hours section with 3 pack options
- Purchased credits history
- Manage Billing button (Stripe Customer Portal)
- Handles Stripe redirect success/cancel params

### 7. Frontend Wiring
- `/billing` route in `App.jsx` (admin-only `ProtectedRoute`)
- 💳 Billing link in `Header.jsx` user dropdown (admin-only, replaces dashboard card)
- `useQuotaWarning.js` navigates to `/billing?upgrade=true` and `/billing?topup=true`
- `quotaEnforcement.js` — Upgrade/Add Hours buttons now enabled (removed "Coming Soon")

### 8. Server Wiring (`backend/server.js`)
```javascript
// ⚠️ CRITICAL: Webhook MUST be before express.json()
app.use('/api/webhooks', webhookRouter);
app.use(express.json());
// ... later ...
app.use('/api', billingRouter);
```

### 9. Environment Variables
```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
APP_BASE_URL=http://localhost:5173
```

---

### 2026-02-10 - Stripe Billing Integration
- ✅ **Database**: Added `stripe_customer_id` to `churches`, created `purchased_credits` table, added `stripe_price_id` to `plans`, updated quota RPC with credits
- ✅ **Stripe Service**: Created `backend/services/stripe.js` (SDK singleton)
- ✅ **Webhook Handler**: Created `backend/routes/webhooks.js` with signature verification and handlers for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
- ✅ **Billing API**: Created `backend/routes/billing.js` with subscription checkout, top-up checkout, portal, and status endpoints
- ✅ **Church Onboarding**: Added Stripe customer creation to `churches.js` (non-blocking)
- ✅ **Server Wiring**: Webhook route mounted BEFORE `express.json()` in `server.js` (critical for signature verification)
- ✅ **Frontend**: Created `BillingPage.jsx` with plan display, usage bar, upgrade/top-up buttons, and Stripe redirect handling
- ✅ **Route**: Added `/billing` as admin-only ProtectedRoute in `App.jsx`
- ✅ **Dashboard**: Added 💳 Billing card to `AdminHome.jsx`
- ✅ **Quota Actions**: Enabled `useQuotaWarning.js` navigation to `/billing` and removed "Coming Soon" from action buttons
- ✅ **Env Template**: Added Stripe section to `env-template-backend.txt`

### 2026-02-10 - Role Rewire: Member-First Access Model
- ✅ **Default Role**: Changed `churches.js` join and create endpoints from `role: 'admin'` → `role: 'member'`
- ✅ **AuthContext Fix**: Reverted `isAdmin` from `isAuthenticated` (temp hack) to `profile?.role === 'admin'` — admin now requires actual DB role
- ✅ **Stripe-Gated Admin**: Webhook `checkout.session.completed` promotes all church profiles to `role: 'admin'`; `customer.subscription.deleted` demotes back to `role: 'member'`
- ✅ **Post-Signup Redirect**: Authenticated visitors (no church) redirect to `/join-church` instead of showing VisitorHome or CreateChurchPage
- ✅ **Church Creation Paywall**: "Create a Church" card in `VisitorHome.jsx` replaced with "Start a Ministry" linking to `exbabel.com/#pricing`
- ✅ **Header Dropdown**: Replaced flat email + Sign Out with clickable user dropdown (☰ icon) containing Billing (admin-only) and Sign Out
- ✅ **AdminHome Cleanup**: Removed 💳 Billing card from dashboard (moved to Header dropdown), reverted to 2-column grid

### 2026-02-11 - Checkout & Pricing Verification
- ✅ **Pricing Strategy**: Updated base pricing with **50% Launch Discount**:
    - **Starter**: $45/mo → **$22.50/mo** (billed yearly)
    - **Pro**: $100/mo → **$50/mo** (billed yearly)
    - **Unlimited**: $300/mo → **$150/mo** (billed yearly)
- ✅ **Checkout Flow**: Refined "Account First" flow:
    - **Entry**: `/checkout` (shows all plans) is now public
    - **Auth**: Clicking a plan redirects to Signup/Login → then auto-initiated Checkout
- ✅ **Terminology**: Standardized "Practice Mode" → "**Solo Mode**" across all UI/Pricing
- ✅ **Visuals**:
    - Added high-res plan icons (Starter/Pro/Unlimited)
    - Added "30-DAY FREE TRIAL" badge to Starter
    - Added "MOST POPULAR" badge to Pro
- ✅ **Discount Logic**:
    - Server-side comparison of `allow_promotion_codes` vs `discounts` array
    - Implemented auto-application of `STRIPE_50_PERCENT_COUPON_ID`
    - Removed conflicting `allow_promotion_codes: true` setting

### 2026-02-11 - Portal Integration & Robust Webhooks (PR 7.8)
- ✅ **Portal-Based Upgrades**: Switched upgrade flow to use Stripe Customer Portal (`/billing/subscription-checkout` redirect).
    - **Benefit**: Native confirmation screen, prevents duplicate subscriptions, automatic proration handling.
    - **Deep Link**: Uses `flow_data` to automatically navigate users to the "Update Plan" screen.
- ✅ **Robust Webhook Handling**:
    - **Event Coverage**: Added handlers for `invoice.paid` and `invoice_payment.paid` to ensure payment confirmation is never missed.
    - **Safe Plan Updates**: Restored `plan_id` updates in `customer.subscription.updated` but restricted to `status='active'` only. This allows instant Portal upgrades while blocking trial abuse.
- ✅ **Proration Fix**: Improved `extractSubscriptionId` to check invoice line items when the top-level subscription ID is missing (common in proration invoices).
- ✅ **UX Refinement**: "Start a Ministry" link on VisitorHome now directs to the Plans page (`/checkout`) instead of pre-selecting a plan, allowing users to compare options first.

### 2026-02-12 - Purchased Hours Fix (Doubling Logic)
- ✅ **Doubling Logic**: Updated webhook to credit purchased hours to **BOTH** Solo and Host modes (e.g., buying 1 hour = 1hr Solo + 1hr Host).
- ✅ **Schema Update**: Added `mode` column to `purchased_credits` table to track mode-specific top-ups.
- ✅ **RPC Update**: `get_session_quota_status` now calculates purchased credits per mode and includes them in the `included` quota.
- ✅ **Frontend**: Updated Billing Page to show purchased credit breakdown (Solo vs Host).
- ✅ **Backfill**: Migrated existing purchased credits to use the new split/double logic.
### 2026-02-12 - Bug Fix: Listener WebSocket Crash (upgradeReq)
- ✅ **Fix: WebSocket Crash**: Resolved a critical `TypeError: Cannot read properties of undefined (reading 'url')` in `handleListenerConnection`.
- ✅ **Root Cause**: The code was attempting to access `clientWs.upgradeReq.url`, but `upgradeReq` is a deprecated property in recent `ws` versions and was returning `undefined`.
- ✅ **Solution**: Updated `handleListenerConnection` to accept the `req` object directly from the `wss.on('connection', (ws, req) => ...)` handler in `server.js` and use `req.url`.
- ✅ **Impact**: Restored connectivity for anonymous listeners and fixed a blocking regression in voice fetching/loading.
### 2026-02-12 - Investigation: Missing Voices on Listener Page
- 🔍 **Bug Description**: Voices fail to appear in the dropdown on the listener page even when the session is active.
- 🔍 **Root Cause**: Identified a **Race Condition** in `backend/websocketHandler.js` within `handleListenerConnection`.
- 🔍 **Verification**: Restructure `handleListenerConnection` to attach the message listener synchronously to ensure no early client requests are lost.

### 2026-02-19 - Part 12: Hidden Promo Codes & Custom Trials
- ✅ **Backend**: Implemented `PROMO_TRIAL_DAYS` whitelist in `billing.js`.
- ✅ **Security**: Client sends string `promo` code; server resolves to `90` days (prevents client-side tampering).
- ✅ **Frontend**: `CheckoutPage.jsx` reads `?promo=vip`, updates UI labels (e.g., "3-MONTH FREE TRIAL"), and persists code through signup/church-creation redirects.
- ✅ **Compatibility**: Verified that 90-day trials stack correctly with existing 50% coupons in Stripe.

---

## Part 12: Hidden Promo Codes & Custom Trials (2026-02-19)

**Context:** To support targeted acquisition (e.g., church friends, early VIPs), we implemented a way to grant longer free trials (90 days vs default 30) without creating separate Stripe Products or manage complex Coupons.

### 1. Server-Side Whitelist (`backend/routes/billing.js`)
We use a hardcoded whitelist on the server. The client sends a string `promo` code, and the server maps that to a trial length. This ensures a malicious user cannot craft a request for "1000 days free".

```javascript
const PROMO_TRIAL_DAYS = {
    vip: 90, // 3-month exclusive trial for church friends
};
```

### 2. Frontend Persistence
Since our checkout flow is "Account First" (Signup → Create Church → Payment), we must ensure the `promo` code survives multiple redirects.

- **URL Pattern**: `/checkout?plan=starter&promo=vip`
- **Redirect Chain**: 
    1. `CheckoutPage` detects `promo` and embeds it in the `redirect` URL.
    2. `/signup?redirect=/checkout?plan=starter&promo=vip`
    3. `/create-church?redirect=/checkout?plan=starter&promo=vip`
    4. Back to `CheckoutPage`, where it is finally sent in the `POST` body.

### 3. Dynamic UI Labels
To ensure users feel the promo is "active", the `CheckoutPage` adjusts its UI when `promo=vip` is in the URL:
- **Badge**: Changes from "30-DAY FREE TRIAL" to "🎁 3-MONTH FREE TRIAL".
- **Pricing**: Changes "Free for 30 days" to "Free for 3 Months".
- **Features**: Updates the trial feature line item.
- **Trust Bar**: Mentions the 3-month trial.

### 2026-02-19 - Checkout UX & Copy Fixes
- ✅ **UX Fix**: Removed auto-redirect for unauthenticated users on `/checkout?plan=X`. Users now see the plan card first; the CTA button drives the auth redirect. Only already-authenticated users with a church are auto-forwarded to Stripe.
- ✅ **Mobile Layout**: Added `checkout-plans-grid` and `checkout-plan-card` CSS classes with a `@media (max-width: 768px)` rule to stack plan cards in a single column on mobile.
- ✅ **Dynamic Plan Highlight**: Blue highlight border now follows the `?plan=` URL param (e.g., `/checkout?plan=starter` highlights Starter). Falls back to Pro when no param is present.
- ✅ **Badge Decoupling**: "⭐ MOST POPULAR" badge is now hardcoded to `planInfo.highlight` (Pro only), preventing it from firing on Starter when highlighted via the VIP link. Starter correctly shows "🎁 3-MONTH FREE TRIAL".
- ✅ **Copy — Unlimited Voices**: Updated Unlimited plan voice feature to three specific lines: "60 standard voices", "90 premium voices", "75 lifelike studio-grade voices (ElevenLabs)".
- ✅ **Copy — Simultaneous Languages**: Changed Starter ("3 languages at once") and Pro ("5 languages at once") to "Unlimited simultaneous languages" to match Unlimited plan copy.

