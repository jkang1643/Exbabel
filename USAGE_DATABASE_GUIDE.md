# Exbabel Usage & Database Infrastructure Guide

This document provides a comprehensive overview of the metering system, database schema, and quota enforcement logic used in Exbabel.

---

## 1. Core Metrics Definitions

We track four primary metrics to manage costs, enforce plan limits, and enable tiered billing.

| Metric | Tracking Mode | Unit | Description |
| :--- | :--- | :--- | :--- |
| **`session_seconds`** | **Host-Based** | Seconds | Total wall-clock time the host is actively recording/streaming. |
| **`listening_seconds`** | **User-Based** | Seconds | Total wall-clock time consumed by all listeners (cumulative). |
| **`stt_seconds`** | **Unit-Based** | Seconds | Duration of audio processed by Speech-to-Text engines. |
| **`tts_characters`** | **Unit-Based** | Chars | Number of characters synthesized by Text-to-Speech engines. |

---

## 2. Metering Modes & Formulas

### A. Precise Session Metering (Host Time)
Tracks exactly how long a church is "live" and providing translation.
- **Trigger**: Starts on the **first audio packet** received by the backend.
- **Precision**: Does not bill for idle time (e.g., host has session open but isn't recording).
- **Formula**: `Usage = Stop Time - Start Time`.

### B. Listening Time Metering (Listener Time)
Tracks the aggregate attention time of the audience.
- **Formula**: `Usage = SUM(Individual Listener Wall-clock Time)`.
- **Example**: 1 host streaming to 10 listeners for 1 hour = 10 hours of `listening_seconds`.

---

## 3. Quota Calculations (The "Live Counter")

To provide real-time feedback in the UI without overloading the database, we use a hybrid formula that combines historical data with "in-flight" active buffers.

### Remaining Quota Formula:
`Remaining = Included - (Historical MTD + Active Live Buffer)`

1. **Included**: The monthly limit defined in the user's `plan` (e.g., 60 minutes).
2. **Historical MTD**: The sum of all **finalized** usage events for the current month (stored in `usage_monthly`).
3. **Active Live Buffer**: The duration of the **currently active** session or listening spans.

### Duration Capping (The "Safety Valve")
To prevent runaway billing if a user leaves a tab open indefinitely, all active spans use a **45-second trailing window**:
- Every 30 seconds, the frontend sends a **heartbeat**.
- If a heartbeat is missed, the backend caps the duration at `last_seen_at + 45 seconds`.
- This ensures that a server crash or network disconnect only results in a maximum of 45s of over-metering.

---

## 4. Database Schema

### Organization & Plans
- **`churches`**: The root tenant record.
- **`plans`**: Definitions of tiers (`starter`, `pro`, `unlimited`). Contains `included_seconds_per_month`.
- **`subscriptions`**: Links a church to a plan and tracks status (`active`, `past_due`, etc.).

### Usage & Metering (The Ledger)
- **`usage_events`**: The immutable log. Every finalized span or unit of work creates a row here.
- **`usage_daily`**: Daily aggregates for high-speed reporting.
- **`usage_monthly`**: Monthly aggregates used for instant quota lookups.
- **`session_spans`**: Tracks in-progress host streaming.
- **`listening_spans`**: Tracks in-progress listener connections.

### Logic & Routing
- **`plan_model_routing`**: Maps plans to specific AI models (e.g., Pro → `gpt-4o`).
- **`church_billing_settings`**: Stores church-specific overrides like PAYG (Pay-As-You-Go) and hard caps.

---

## 5. Technical Implementation Details

### Idempotency
All usage recording is **idempotent**. Every event is submitted with a unique `idempotency_key` (typically `session_id:timestamp_window`).
- If the network retries a request, the database rejects the duplicate.
- This prevents double-billing on shaky connections.

### Atomic Updates (Postgres RPC)
We use a custom Postgres function `public.record_usage_event()` to ensure data integrity:
1. It inserts the raw event.
2. It increments the daily/monthly counters.
3. It performs all these steps in a **single atomic transaction**.

### Quota Routing & Enforcement
The `backend/entitlements/` module acts as the gatekeeper:
- **`assertEntitled`**: Throws an error if a user tries to use a feature/model not in their tier.
- **`resolveModel`**: Interrogates the DB to decide which AI engine to fire for a specific request.

---

## 6. SQL Quick Reference

### Check Monthly Progress
```sql
SELECT metric, total_quantity 
FROM public.usage_monthly 
WHERE church_id = 'YOUR_CHURCH_ID' 
AND month_start = date_trunc('month', now())::DATE;
```

### View Live Counting Logic (RPC)
The "Live Counter" is powered by the `public.get_session_quota_status` RPC, which calculates the historical + active buffer in one O(1) query.

---

## 7. Migration History

The schema is managed via Supabase CLI migrations located in `supabase/migrations/`. 
- **Latest Baseline**: All spans and monthly aggregation tables were formalized in `20260202_add_spans_and_usage_monthly_formalized.sql`.

---

## 8. Session Lifecycle & Reliability

To ensure accurate billing and system stability, we have implemented a canonical session lifecycle managed by `backend/storage/sessionStore.js`.

### A. Canonical `endSession`
We have a single point of truth function `endSession(sessionId, reason)` that:
1.  **Updates DB**: Sets `status='ended'` and `ended_at=now()` (idempotent).
2.  **Cleans Memory**: Removes the session from the in-memory `Map`.
3.  **Notifies Clients**: Broadcasts `session_ended` event to all listeners.
4.  **Closes Sockets**: Forcibly closes all WebSocket connections.

### B. Graceful Disconnects
When a host disconnects (e.g., wifi drop), we do **not** end the session immediately.
-   **Grace Period**: The session enters a "pending end" state for **30 seconds**.
-   **Reconnection**: If the host reconnects within 30s, the timer is cancelled and metering continues seamlessly.
-   **Timeout**: If 30s elapse, the session is formally ended with reason `host_disconnected`.

### C. Safety Nets
-   **Startup Cleanup**: On backend restart, `cleanupAbandonedSessions()` marks all `active` sessions as `ended` to prevent "zombie" billing.
-   **Inactivity Timeout**: A cron job runs every 10 minutes to close sessions with no activity for >1 hour.
