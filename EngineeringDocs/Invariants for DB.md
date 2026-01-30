Here are the **invariants you should enforce as of now (through PR6 readiness)** — i.e., everything required for: **auth → tenant isolation → tiers/routing truth → usage truth → entitlement enforcement**.


## A) Identity + tenant invariants (AUTH spine)

1. **Every authenticated user has exactly one profile**

* **DB:** `profiles.user_id` is PK, FK → `auth.users(id)`
* **Code:** after signup, create profile immediately; deny access if missing

2. **Every profile belongs to exactly one church**

* **DB:** `profiles.church_id NOT NULL`, FK → `churches(id)`
* **Code:** tenant resolution always comes from profile, not client input

3. **Tenant context is resolved server-side**

* **Code invariant:** every request that touches app data must have `{ user_id, church_id, role }` from middleware
* **Never:** infer `church_id` from JWT claims or request params

4. **Admins vs members is authoritative**

* **DB:** `profiles.role` constrained to allowed values (admin/member)
* **Code:** “billable actions” require `role = admin`

---

## B) Row-level security invariants (isolation)

5. **All church-owned rows have `church_id` and are isolated by RLS**

* **DB:** any church-owned table must include `church_id NOT NULL`
* **DB:** RLS predicate must enforce `row.church_id = current_user_church_id()`
* **Code:** backend guards are defense-in-depth, not the only line

6. **No unauthenticated DB access**

* **DB:** revoke `anon` access broadly (you did this)
* Optional (your current posture for truth tables): also revoke `authenticated` when you want backend-only

---

## C) Entitlements (tiers) invariants (PR4)

7. **Plans are global and uniquely identified**

* **DB:** `plans.code UNIQUE NOT NULL`
* **DB:** plan limit fields are non-negative and sensible (`included_seconds_per_month >= 0`, `max_languages > 0`, etc.)

8. **Every church has exactly one subscription snapshot**

* **DB:** `subscriptions.church_id UNIQUE NOT NULL`
* **DB:** `subscriptions.plan_id NOT NULL` FK → `plans`
* **Operational invariant:** no church exists without a subscription row

9. **Every church has exactly one billing settings row**

* **DB:** `church_billing_settings.church_id` is PK (one row per church)
* **Operational invariant:** created on church creation, never missing

10. **Subscription status is one of the allowed states**

* **DB:** check constraint on `subscriptions.status`
* **Code:** `active`/`trialing` are allowed; others deny entitlement

---

## D) Routing invariants (tiers define models)

11. **Routing is deterministic per plan + capability**

* **DB:** `plan_model_routing UNIQUE(plan_id, capability)`
* **Code:** no silent defaults; missing capability is a hard error when used

12. **No hardcoded model decisions in feature code**

* **Code invariant:** model/provider is chosen only via `resolveModel(entitlements, capability)` (or equivalent)

---

## E) Usage truth invariants (PR5)

13. **Usage events are append-only and idempotent**

* **DB:** `usage_events.idempotency_key UNIQUE NOT NULL`
* **DB:** `quantity >= 0`
* **Code (later):** every metering write must supply a stable idempotency key

14. **Aggregates are keyed and non-negative**

* **DB:** `usage_daily` PK `(church_id, date, metric)`
* **DB:** `quantity >= 0`

15. **Usage is attributed to a church**

* **DB:** `usage_events.church_id NOT NULL` FK → churches
* **Never:** usage tied only to user_id; billing owner is the church

---

## F) PR6 (code enforcement) invariants

16. **Entitlements lookup is the only source for gating**

* **Code:** `getEntitlements(church_id)` is canonical; no scattered “plan logic”
* **Code:** missing subscription is treated as “not entitled” (I recommend status = `none/missing`, not `canceled`)

17. **Requests fail closed**

* **Code:** if entitlement cannot be resolved (missing plan/settings), return 500 and alert
* **Code:** if not entitled (status not active/trialing), return 403/402 consistently

18. **Billable actions are admin-only**

* **Code invariant:** `role = admin` required on routes that will incur usage (even before usage tracking is wired)

---

## The “minimum set” you must enforce immediately (top 6)

If you want the tight shortlist that prevents most disasters:

1. profile exists for every user
2. profile has exactly one church
3. server-side tenant resolution (never client)
4. one subscription per church + never missing
5. one billing_settings row per church + never missing
6. usage_events idempotency_key unique (no double counting)

The invariant you want
✅ Single source of truth

For any live session:

session_id → church_id is server-owned and persisted (or at least stored in an authoritative in-memory session store).

All entitlements / routing decisions for everyone in that session come from:

church_id → subscription → plan → entitlements + model routing

❌ What to avoid (because it breaks later)

Listeners derive church from .env

Listeners derive church from “their own profile” (they might not have one)

Listener flow uses a fallback like 'default'

Client sends churchId and server trusts it