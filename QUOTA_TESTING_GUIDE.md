# Quota & Usage Limits Testing Guide

This guide covers testing the usage limits and quota enforcement feature for church plans.

---

## Quick Reference

| Command | Description |
|---------|-------------|
| `npm run test:quota:status` | Show current quota status for default church |
| `npm run test:quota:warning` | Set usage to 85% (triggers warning UI) |
| `npm run test:quota:exceeded` | Set usage to 105% (triggers exceeded modal + blocks start) |
| `npm run test:quota:reset` | Clear all usage for current month |
| `npm run dev:debug-quota` | Start app with 60-second quota for fast testing |

---

## Architecture Overview

### How Quota Enforcement Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Backend (30-second heartbeat)                │
├─────────────────────────────────────────────────────────────────────┤
│  Session Span Heartbeat → checkQuotaLimit() → createQuotaEvent()    │
│                                                   ↓                  │
│                                        WebSocket: quota_warning      │
│                                              or: quota_exceeded      │
└─────────────────────────────────────────────────────────────────────┘
                                        ↓
┌─────────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                             │
├─────────────────────────────────────────────────────────────────────┤
│  useQuotaWarning hook → handleMessage() → setState                   │
│                                              ↓                       │
│                                   QuotaWarningToast (80%+)           │
│                                   UsageLimitModal (100%)             │
│                                   Start Button Blocked               │
└─────────────────────────────────────────────────────────────────────┘
```

### Quota Thresholds

| Threshold | Percent Used | Action |
|-----------|--------------|--------|
| Normal | 0-79% | No UI shown |
| Warning | 80-99% | Toast appears, can dismiss |
| Exceeded | 100%+ | Modal shown, Start button blocked |

---

## Test Script Commands

### Check Current Status

```bash
npm run test:quota:status
```

Shows detailed quota breakdown:
- Combined quota (solo + host)
- Solo mode quota and usage
- Host mode quota and usage
- Warning/exceeded status
- Actions that would be taken

### Set Warning State (85%)

```bash
npm run test:quota:warning
```

Sets usage to 85% of quota for **both** solo and host modes.

**Expected behavior:**
- Backend logs: `warning=true, exceeded=false`
- After 30 seconds of session: toast appears
- Start button remains enabled

### Set Exceeded State (105%)

```bash
npm run test:quota:exceeded
```

Sets usage to 105% of quota (over limit).

**Expected behavior:**
- Backend logs: `warning=true, exceeded=true`
- After 30 seconds of session: modal appears
- Start button shows "Quota Exceeded" and is disabled

### Reset Usage

```bash
npm run test:quota:reset
```

Clears all usage records for the current month, returning to 0%.

---

## Debug Mode: Quick Quota Testing

For faster iteration, use the debug quota mode:

```bash
npm run dev:debug-quota
```

This starts the app with `DEBUG_QUOTA_SECONDS=60`, meaning:
- Total quota is 60 seconds (instead of hours)
- Usage accumulates normally
- After ~48 seconds of recording, warning appears
- After ~60 seconds, exceeded modal appears

This is useful for testing the full flow without manipulating database records.

---

## Step-by-Step Testing Flow

### Test 1: Warning Toast (Host Mode)

1. Reset usage:
   ```bash
   npm run test:quota:reset
   ```

2. Set to warning state:
   ```bash
   npm run test:quota:warning
   ```

3. Start the app:
   ```bash
   npm run dev
   ```

4. Go to **Admin Dashboard** → **Start Broadcasting**

5. Start broadcasting and **wait 30 seconds** (for heartbeat)

6. **Expected:** Warning toast appears at bottom right

7. Click "Details" on toast → Modal opens

8. Click "Dismiss" → Modal closes, toast dismissed

### Test 2: Exceeded Modal (Host Mode)

1. Set to exceeded state:
   ```bash
   npm run test:quota:exceeded
   ```

2. Restart the app (`Ctrl+C` then `npm run dev`)

3. Start a Host session and wait 30 seconds

4. **Expected:**
   - Red modal appears saying "Monthly Limit Reached"
   - "Upgrade Plan" and "Add Hours" buttons shown (Coming Soon)
   - OK button dismisses modal

### Test 3: Blocked Start Button (Solo Mode)

1. Set to exceeded state:
   ```bash
   npm run test:quota:exceeded
   ```

2. Restart the app

3. Navigate to **Solo Mode**

4. **Expected:**
   - Start button shows "Quota Exceeded"
   - Button is disabled (cannot click)
   - After starting and waiting 30s, exceeded modal appears

### Test 4: Debug Quota Mode

1. Reset usage:
   ```bash
   npm run test:quota:reset
   ```

2. Start in debug mode:
   ```bash
   npm run dev:debug-quota
   ```

3. Start Host or Solo session

4. Record continuously for ~50 seconds

5. **Expected:** Warning toast should appear naturally

6. Continue for ~15 more seconds

7. **Expected:** Exceeded modal appears, blocking further recording

---

## Troubleshooting

### Warning not appearing after 30 seconds

**Cause:** `quotaWarningSent` variable is `true` from previous session.

**Fix:** Restart the app to get a fresh WebSocket connection:
```bash
# Ctrl+C to stop
npm run dev  # Restart
```

### Backend shows warning=true but no log "Quota warning sent"

**Cause:** Warning was already sent in this session (only sends once per session).

**Fix:** 
1. Stop current session (stop recording)
2. Start a new session
3. Or restart the entire app

### Frontend doesn't show toast/modal

**Check:**
1. Verify HostPage or SoloPage has `useQuotaWarning` hook imported
2. Check browser console for `[Host] Quota event:` or `[Solo] Quota event:` logs
3. Ensure WebSocket is connected (`connectionState === 'open'`)

### Test script fails with Supabase error

**Check:**
1. Verify `backend/.env` has valid `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
2. Ensure church exists in database (use your actual church ID)

---

## Database Schema Reference

### usage_monthly Table

| Column | Type | Description |
|--------|------|-------------|
| church_id | UUID | Church identifier |
| year_month | TEXT | Format: "YYYY-MM" |
| session_seconds | INT | Legacy combined seconds |
| solo_seconds | INT | Solo mode usage |
| host_seconds | INT | Host mode usage |
| tts_characters | INT | TTS usage |

### plans Table

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Plan identifier |
| included_seconds_per_month | INT | Legacy combined quota |
| included_solo_seconds_per_month | INT | Solo mode quota (seconds) |
| included_host_seconds_per_month | INT | Host mode quota (seconds) |

---

## Backend Files

| File | Purpose |
|------|---------|
| `backend/usage/quotaEnforcement.js` | Core quota checking logic |
| `backend/soloModeHandler.js` | Solo mode heartbeat integration |
| `backend/host/adapter.js` | Host mode heartbeat integration |

## Frontend Files

| File | Purpose |
|------|---------|
| `frontend/src/hooks/useQuotaWarning.js` | Hook for managing quota UI state |
| `frontend/src/components/ui/UsageLimitModal.jsx` | Modal and Toast components |
| `frontend/src/components/ui/UsageLimitModal.css` | Styling for quota UI |
| `frontend/src/components/solo/SoloPage.jsx` | Solo mode quota integration |
| `frontend/src/components/HostPage.jsx` | Host mode quota integration |

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DEBUG_QUOTA_SECONDS` | Override all quotas to this value (seconds) | Not set |
| `TEST_CHURCH_ID` | Default church ID for test script | `71afaace-d9e6-4c94-84ed-b504efe7fa1c` |

---

## Future Work

- [ ] **Upgrade Plan button** - Link to Stripe checkout
- [ ] **Add Hours button** - One-time hour pack purchase
- [ ] **Real-time quota display** - Show usage in UI
- [ ] **Email notifications** - Warn admins before quota exceeded
- [ ] **Grace period** - Allow finish current session when quota hit
