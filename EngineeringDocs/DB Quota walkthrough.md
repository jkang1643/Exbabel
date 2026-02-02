# Listening Time Metering - Verification Walkthrough

## ✅ Code ↔ DB Alignment Verified

| Aspect | Expected | Actual | Status |
|--------|----------|--------|--------|
| Idempotency Key | `listen:{session}:{user}:{started_epoch}` | Line 157: `listen:${sessionId}:${userId}:${Math.floor(startedAt.getTime() / 1000)}` | ✅ |
| Duration Formula | [min(now, last_seen_at + 45s) - started_at](file:///home/jkang1643/projects/realtimetranslationapp/backend/websocketHandler.js#231-264) | Lines 130-138 | ✅ |
| Metric Name | `listening_seconds` | Line 162 | ✅ |
| Metadata Fields | session_id, user_id, reason, span_id | Lines 166-171 | ✅ |
| Church ID Source | From span (session's church) | Line 161: `span.church_id` | ✅ |

---

## 📍 Quota Enforcement Points

| Location | File:Line | Enforcement Action |
|----------|-----------|-------------------|
| **Listener Join** | `websocketHandler.js:388` → [startListeningSpan()](file:///home/jkang1643/projects/realtimetranslationapp/backend/websocketHandler.js#480-495) | Check `remaining_seconds > 0` before allowing |
| **Session Join (WS upgrade)** | `server.js:282` | Block connection if quota exhausted |
| **Heartbeat (30s)** | `websocketHandler.js:508` | Optional: warn if quota < 5 min remaining |

**Recommended Pattern:**
```javascript
// Before starting span
const quota = await getListeningQuotaStatus(churchId);
if (quota.remaining_seconds <= 0) {
  ws.send(JSON.stringify({ type: 'quota_exceeded' }));
  ws.close(1008, 'Listening quota exceeded');
  return;
}
```

---

## 🔍 Manual Verification SQL Queries

### 1. Check listening_spans table
```sql
SELECT id, session_id, user_id, church_id, 
       started_at, last_seen_at, ended_at, ended_reason
FROM listening_spans
WHERE church_id = '<YOUR_CHURCH_ID>'
ORDER BY started_at DESC
LIMIT 10;
```

### 2. Check usage_events for listening_seconds
```sql
SELECT id, church_id, metric, quantity, occurred_at, idempotency_key, metadata
FROM usage_events
WHERE church_id = '<YOUR_CHURCH_ID>'
  AND metric = 'listening_seconds'
ORDER BY occurred_at DESC
LIMIT 10;
```

### 3. Check monthly aggregates
```sql
SELECT church_id, month_start, metric, total_quantity, updated_at
FROM usage_monthly
WHERE church_id = '<YOUR_CHURCH_ID>'
  AND metric = 'listening_seconds';
```

### 4. Test quota RPC (after deploying migration)
```sql
SELECT * FROM get_listening_quota_status('<YOUR_CHURCH_ID>');
```

---

## ✅ Files Created/Modified

| File | Status |
|------|--------|
| [listeningSpans.js](file:///home/jkang1643/projects/realtimetranslationapp/backend/usage/listeningSpans.js) | ✅ Verified |
| [getListeningQuota.js](file:///home/jkang1643/projects/realtimetranslationapp/backend/usage/getListeningQuota.js) | ✅ Created |
| [20260130_update_record_usage_event.sql](file:///home/jkang1643/projects/realtimetranslationapp/supabase/migrations/20260130_update_record_usage_event.sql) | ✅ Created |
| [20260130_get_listening_quota_status.sql](file:///home/jkang1643/projects/realtimetranslationapp/supabase/migrations/20260130_get_listening_quota_status.sql) | ✅ Created |
| [websocketHandler.js](file:///home/jkang1643/projects/realtimetranslationapp/backend/websocketHandler.js) | ✅ Integrated |

---

## 🚀 Deploy Steps

1. **Apply RPC migration:**
   ```bash
   npx supabase db push --linked
   ```

2. **Run integration test:**
   ```bash
   node backend/tests/integration/test-listening-spans.js
   ```

3. **Verify in Supabase Dashboard:**
   - Check `listening_spans` table has rows
   - Check `usage_monthly` updates on span end
   - Run quota RPC and verify returns

Session-Based Metering Walkthrough
✅ Implementation Complete
Changed from listener-based to session/host-based metering:

Before: 10 listeners × 1 hour = 10 hours billed
After: 10 listeners × 1 hour = 1 hour billed
Files Created/Modified
File	Purpose
sessionSpans.js
Start/heartbeat/stop lifecycle
getSessionQuota.js
Quota RPC wrapper
adapter.js
Integrated span lifecycle
20260130_get_session_quota_status.sql
Quota RPC
Test Results
Integration test: 7/7 PASS

✓ Session span created
✓ Idempotency check passed
✓ Heartbeat updated last_seen_at
✓ Session span stopped: 2s
✓ DB verified: ended_at, reason
✓ Gracefully handled nonexistent span
✓ Monthly aggregates: 2s total
How It Works
DB
Backend
Host
DB
Backend
Host
loop
[Every 30s]
WebSocket connect
startSessionSpan()
heartbeatSessionSpan()
End session / disconnect
stopSessionSpan()
record_usage_event (session_seconds)
Update usage_monthly
Manual Testing
# Run full test
node backend/tests/manual-test-session-quota.js all
# Or individually:
node backend/tests/manual-test-session-quota.js start   # Start span
node backend/tests/manual-test-session-quota.js status  # Check quota
node backend/tests/manual-test-session-quota.js stop    # Stop span
node backend/tests/manual-test-session-quota.js events  # Show events
node backend/tests/manual-test-session-quota.js monthly # Show aggregates
Deploy RPC (Required)
Run in Supabase SQL Editor:

-- Copy contents of:
-- supabase/migrations/20260130_get_session_quota_status.sql
Verification SQL
-- Check active spans
SELECT id, session_id, church_id, started_at, last_seen_at
FROM session_spans
WHERE ended_at IS NULL;
-- Check usage events
SELECT quantity, occurred_at, idempotency_key
FROM usage_events
WHERE metric = 'session_seconds'
ORDER BY occurred_at DESC LIMIT 5;
-- Check monthly totals
SELECT month_start, total_quantity
FROM usage_monthly
WHERE metric = 'session_seconds';
-- Test quota RPC (after deploy)
SELECT * FROM get_session_quota_status('<church_id>');

Comment
Ctrl+Alt+M
