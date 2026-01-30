# Testing Tier Gating via Supabase

This guide explains how to manually change a church's subscription tier in the database to verify that the application correctly updates available features (like TTS voices).

## Prerequisites

- Access to your local Supabase database (or the remote one if testing dev/prod).
- Backend running on `localhost:3001`.
- Frontend running on `localhost:5173`.

## Step 1: Identify Your Church ID

First, find the ID of the church you are logged in as.

**Option A: Checks Logs (Easiest)**
1. Look at your running backend terminal.
2. When you start a session or load the page, you should see logs like:
   ```text
   [Entitlements] ✓ church=123e4567-e89b-12d3... plan=starter ...
   ```
   Copy that UUID.

**Option B: SQL Query**
Run this in your Supabase SQL Editor:
```sql
SELECT id, name FROM public.churches;
```

---

## Step 2: Change Tier via SQL

You can switch your church's plan by updating the `subscriptions` table. The three available tiers are `starter`, `pro`, and `unlimited`.

Use the following SQL queries to switch tiers. Replace `'YOUR_CHURCH_ID'` with the UUID you found in Step 1.

### Switch to **Starter** (Basic Voices)
```sql
UPDATE public.subscriptions
SET plan_id = (SELECT id FROM public.plans WHERE code = 'starter')
WHERE church_id = 'YOUR_CHURCH_ID';
```

### Switch to **Pro** (Chirp 3 HD + Studio)
```sql
UPDATE public.subscriptions
SET plan_id = (SELECT id FROM public.plans WHERE code = 'pro')
WHERE church_id = 'YOUR_CHURCH_ID';
```

### Switch to **Unlimited** (Gemini + ElevenLabs)
```sql
UPDATE public.subscriptions
SET plan_id = (SELECT id FROM public.plans WHERE code = 'unlimited')
WHERE church_id = 'YOUR_CHURCH_ID';
```

> **Note:** The backend caches entitlements for **60 seconds**. After running the SQL, you might need to wait up to a minute or restart the backend to see changes immediately.

---

## Step 3: Verify the Change

### Method A: Check Available Voices (Frontend)
1. Reload the frontend application.
2. Open the **Voice Selector** dropdown.
3. Check available voices:
   - **Starter**: Standard Google voices only. Premium voices (Chirp/ElevenLabs) should be locked/hidden.
   - **Pro**: "Chirp 3 HD" and "Studio" voices should be unlocked.
   - **Unlimited**: "Gemini" and "ElevenLabs" voices should be unlocked.

### Method B: Check Debug Endpoint
You can view the raw entitlement data the backend sees:

1. **Get your Bearer Token** from the browser logs or local storage (key: `supabase.auth.token`).
2. Run this command (or use Postman):
   ```bash
   curl http://localhost:3001/api/debug/entitlements \
     -H "Authorization: Bearer YOUR_TOKEN_HERE"
   ```
3. Check the `planCode` and `ttsTier` in the JSON response:
   ```json
   {
     "planCode": "pro",
     "limits": {
       "ttsTier": "pro"
     }
   }
   ```

### Method C: Watch Backend Logs
Trigger a re-fetch (wait 60s or restart backend) and watch the terminal:
```text
[Entitlements] ✓ church=... plan=unlimited status=active
```
