# Stripe Integration — Full Walkthrough

> **Date:** 2026-02-10  
> **Branch:** `feat/auth-db-billing`  
> **Status:** Implementation complete, ready for end-to-end testing

---

## Overview

Stripe billing integrated into Exbabel: subscription upgrades, one-time top-up credit purchases, Stripe Customer Portal, and webhook-driven state sync. The church is the billing owner (tenant), and all billing actions require admin role.

### Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| `stripe_customer_id` location | `churches` table | Church = billing tenant |
| Credit expiry | Monthly (MTD) | Simple, avoids rollover accounting |
| PAYG at quota 0 | Top-up required | No "bill later" in MVP |
| Webhook body parsing | `express.raw()` before `express.json()` | Required for Stripe signature verification |

---

## Database Migrations (Completed)

### 1. `stripe_customer_id` on `churches`
- Added `stripe_customer_id TEXT` column with partial unique index on non-null values
- Church = billing owner identity for Stripe

### 2. `purchased_credits` table
```sql
-- Columns: church_id, amount_seconds, stripe_payment_intent_id, created_at
-- Unique index on stripe_payment_intent_id (idempotency)
-- Composite index on (church_id, created_at DESC) for monthly sum queries
```

### 3. `stripe_price_id` on `plans`
- Added `stripe_price_id TEXT UNIQUE NULL` to `plans` table
- Seeded values:
  - `starter` → `price_1SzKwL0i9zxoozHUdZeVcJDB`
  - `pro` → `price_1SzL3E0i9zxoozHUSC0F6pCC`
  - `unlimited` → `price_1SzL760i9zxoozHUNjfnT43u`

### 4. `get_session_quota_status` RPC updated
- Added `purchased_seconds_mtd` and `total_available_seconds` output columns
- Credits applied to combined remaining quota: `SUM(amount_seconds) WHERE created_at >= date_trunc('month', now())`
- Backward compatible — all existing columns preserved

---

## Backend Implementation

### New Files

#### `backend/services/stripe.js`
Stripe SDK singleton. Initializes `new Stripe(STRIPE_SECRET_KEY)` once, warns if key is missing. Exports `stripe` instance for use across the app.

#### `backend/routes/webhooks.js`
Webhook handler with Stripe signature verification. No JWT auth — uses `stripe.webhooks.constructEvent()`.

**Handled events:**

| Event | Action |
|---|---|
| `checkout.session.completed` (subscription) | UPDATE `subscriptions` with plan, status, Stripe IDs. Set `churches.stripe_customer_id` |
| `checkout.session.completed` (payment, type=top_up) | INSERT into `purchased_credits` (idempotent via unique constraint) |
| `customer.subscription.updated` | UPDATE subscription status, period dates, plan if price changed |
| `customer.subscription.deleted` | UPDATE `subscriptions.status = 'canceled'` |

Every handler calls `clearEntitlementsCache(churchId)` after DB update for immediate effect.

**Stripe status mapping:**
```
active → active, trialing → trialing, past_due → past_due,
canceled → canceled, paused → paused, unpaid → past_due,
incomplete → past_due, incomplete_expired → canceled
```

#### `backend/routes/billing.js`
All endpoints use `requireAuth` + `requireAdmin` middleware.

| Endpoint | Method | Body | Returns |
|---|---|---|---|
| `/api/billing/subscription-checkout` | POST | `{ planCode }` | `{ url }` → Stripe Checkout |
| `/api/billing/top-up-checkout` | POST | `{ packId }` | `{ url }` → Stripe Checkout |
| `/api/billing/portal` | GET | — | `{ url }` → Customer Portal |
| `/api/billing/status` | GET | — | `{ subscription, plan, usage, purchasedCredits, availablePacks }` |

**Top-up packs (server-side):**
- `1_hour`: 3600s / $9.99
- `5_hours`: 18000s / $39.99
- `10_hours`: 36000s / $69.99

Uses `ensureStripeCustomer(churchId)` helper — lazily creates Stripe customer if missing.

### Modified Files

#### `backend/server.js`
```diff
+// ⚠️ CRITICAL: Stripe webhook MUST be before express.json()
+app.use('/api/webhooks', webhookRouter);
+
 app.use(express.json());
```
- Webhook route at **L70** (before `express.json()` at L72)
- Billing route mounted alongside other API routes at L389
- Added `http://localhost:5173` to CORS origins

#### `backend/routes/churches.js`
- Imported `stripe` from `services/stripe.js`
- Added **Step 5** in church creation: creates Stripe customer and stores `cus_xxx` on `churches.stripe_customer_id`
- Non-blocking — if Stripe is unavailable, church creation still succeeds (lazy fallback in `billing.js`)

#### `backend/usage/quotaEnforcement.js`
- Enabled `upgrade` and `add_hours` action buttons (removed `enabled: false` and `hint: 'Coming Soon'`)

#### `env-template-backend.txt`
- Added Stripe section: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_BASE_URL`

---

## Frontend Implementation

### New Files

#### `frontend/src/components/BillingPage.jsx`
Admin-only billing management page:
- **Current plan** card with status, renewal date, usage progress bar
- **Upgrade** buttons (Pro / Unlimited) — creates Stripe Checkout Session
- **Add Hours** section with 3 pack options — one-time Stripe payment
- **Credits history** — shows purchased credits this month
- **Manage Billing** button — opens Stripe Customer Portal
- Handles Stripe redirect `?success=true` and `?canceled=true` query params

### Modified Files

#### `frontend/src/App.jsx`
- Imported `BillingPage`
- Added `/billing` route wrapped in `ProtectedRoute` with `requireAdmin`

#### `frontend/src/hooks/useQuotaWarning.js`
- Replaced TODO stubs with `window.location.href = '/billing?upgrade=true'` and `/billing?topup=true`

#### `frontend/src/components/home/AdminHome.jsx`
- Added 💳 Billing card to admin dashboard (3-column grid alongside Solo Mode and Join Session)
- Links to `/billing`

---

## Environment Variables Required

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
APP_BASE_URL=http://localhost:5173
```

---

## Testing Checklist

### Webhook Verification
```bash
# Terminal 1: Start backend
npm run dev

# Terminal 2: Forward Stripe events locally
stripe listen --forward-to localhost:3001/api/webhooks/stripe

# Terminal 3: Trigger test event
stripe trigger checkout.session.completed
# Expected: 200 response (not 404)
```

### End-to-End Flows
1. **Subscription upgrade:** Admin → `/billing` → Upgrade to Pro → Stripe Checkout → card `4242 4242 4242 4242` → webhook fires → DB updated → entitlements cache cleared
2. **Top-up purchase:** Admin → `/billing` → Add Hours (1hr) → Stripe Checkout → webhook fires → `purchased_credits` row inserted → quota RPC reflects added seconds
3. **Customer Portal:** Admin → `/billing` → Manage Billing → Stripe Portal → update payment method / view invoices
4. **Quota enforcement:** Exhaust monthly limit → warning at 80% → lock at 100% → "Upgrade Plan" / "Add Hours" buttons navigate to `/billing`

### Key Invariants to Verify
- Webhook returns 200 for all events (even unhandled ones)
- Duplicate `checkout.session.completed` doesn't create duplicate credits (idempotent on `stripe_payment_intent_id`)
- `clearEntitlementsCache` is called after every webhook DB update (no 60s stale cache)
- Billing endpoints return 403 for non-admin users

---

## Role Rewire: Account-First Access Model

**Design:** Admin role is exclusively for paying customers (or those in the 30-day trial). The path to admin is: Sign Up → Create Church → Checkout (Trial) → Admin.

### Role Assignment Rules

| Action | Role Assigned |
|---|---|
| Sign up + join a church | `member` |
| Create a church | `member` (redirects to `/checkout`) |
| Stripe `checkout.session.completed` (subscription) | All church profiles promoted to `admin` |
| Stripe `customer.subscription.deleted` | All church profiles demoted back to `member` |
| Stripe `invoice.payment_failed` | All church profiles demoted back to `member` |

### Files Changed

#### `backend/routes/churches.js`
- `POST /churches/join`: `role: 'member'` (unchanged)
- `POST /churches/create`: `role: 'member'`, `subscription.status: 'inactive'` (redirects to checkout, where webhook upgrades role)

#### `backend/routes/webhooks.js`
- `handleSubscriptionCheckout`: After plan upgrade, promotes all profiles to `role: 'admin'`
- `handleSubscriptionDeleted`: Demotes all profiles back to `role: 'member'`
- `syncRoleFromStatus`: Deterministic source of truth for admin/member based on `active/trialing` vs `past_due/canceled`

#### `frontend/src/components/CheckoutPage.jsx` (NEW)
- Handles the "Account First" flow
- Captures intent (`?plan=starter`)
- Enforces Auth and Church existence before redirecting to Stripe

#### `frontend/src/components/home/VisitorHome.jsx`
- "Start a Ministry" link points to internal `/checkout?plan=starter`

#### `frontend/src/App.jsx`
- Added public `/checkout` route
- Updated Route wrappers (`SignUpRoute`, `LoginRoute`, etc.) to support `?redirect=` parameter persistence

---

## File Summary

| File | Status | Purpose |
|---|---|---|
| `backend/services/stripe.js` | NEW | Stripe SDK singleton |
| `backend/routes/webhooks.js` | NEW | Webhook handler + admin role promotion/demotion |
| `backend/routes/billing.js` | NEW | Billing API (checkout, portal, status) |
| `frontend/src/components/BillingPage.jsx` | NEW | Billing management page |
| `frontend/src/components/CheckoutPage.jsx` | NEW | Acquisition flow entry point |
| `backend/server.js` | MODIFIED | Route mounting (webhook before json parser) |
| `backend/routes/churches.js` | MODIFIED | Default role → member, Stripe customer creation |
| `backend/usage/quotaEnforcement.js` | MODIFIED | Enabled upgrade/add-hours buttons |
| `frontend/src/App.jsx` | MODIFIED | Added /billing and /checkout routes |
| `frontend/src/hooks/useQuotaWarning.js` | MODIFIED | Navigate to /billing |
| `frontend/src/contexts/AuthContext.jsx` | MODIFIED | `signUpWithEmail` supports redirect param |
| `frontend/src/components/home/VisitorHome.jsx` | MODIFIED | "Start a Ministry" links to checkout |
| `env-template-backend.txt` | MODIFIED | Added Stripe env vars |


### Critical Fix: Admin Role Assignment (2026-02-11)

**Issue:** Users were staying as `member` after payment instead of being upgraded to `admin`.
**Root Cause:** Subscriptions were created with `status: 'active'`, preventing the webhook from detecting a status transition to trigger the role upgrade.

**Resolution:**
1. **Initial Status:** Changed `POST /churches/create` to set subscription `status: 'inactive'`.
2. **Database:** Added `'inactive'` as a valid status via migration.
3. **Flow:**
   - Church created → `status: 'inactive'`, `role: 'member'`
   - Payment success → Webhook sets `status: 'trialing/active'`
   - Webhook triggers `syncRoleFromStatus` → `role: 'admin'` ✅

This ensures the webhook is the **single source of truth** for admin access.
