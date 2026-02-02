-- Migration: Add get_session_quota_status RPC function
-- Purpose: O(1) quota remaining lookup using session-based metering
-- 
-- Key difference from get_listening_quota_status:
-- - Uses session_spans (host time) instead of listening_spans (listener time)
-- - Metric is 'session_seconds' not 'listening_seconds'
-- - One session of 1 hour = 1 hour billed (regardless of listener count)

CREATE OR REPLACE FUNCTION public.get_session_quota_status(p_church_id UUID)
RETURNS TABLE (
  included_seconds_per_month INT,
  used_seconds_mtd BIGINT,
  active_seconds_now INT,
  remaining_seconds BIGINT
)
LANGUAGE sql
STABLE
AS $$
WITH plan_limits AS (
  SELECT p.included_seconds_per_month::INT AS included
  FROM public.subscriptions s
  JOIN public.plans p ON p.id = s.plan_id
  WHERE s.church_id = p_church_id
    AND s.status IN ('active', 'trialing')
  LIMIT 1
),
mtd AS (
  SELECT COALESCE(um.total_quantity, 0)::BIGINT AS used
  FROM public.usage_monthly um
  WHERE um.church_id = p_church_id
    AND um.month_start = date_trunc('month', now())::DATE
    AND um.metric = 'session_seconds'
),
active AS (
  -- Calculate effective seconds for active SESSION spans
  -- capped at last_seen_at + 45s to prevent runaway counts
  SELECT COALESCE(SUM(
    GREATEST(
      0,
      FLOOR(EXTRACT(EPOCH FROM (
        LEAST(now(), COALESCE(last_seen_at, started_at) + interval '45 seconds')
        - started_at
      )))::INT
    )
  ), 0)::INT AS active_now
  FROM public.session_spans
  WHERE church_id = p_church_id
    AND ended_at IS NULL
)
SELECT
  COALESCE(pl.included, 0) AS included_seconds_per_month,
  COALESCE(m.used, 0) AS used_seconds_mtd,
  COALESCE(a.active_now, 0) AS active_seconds_now,
  GREATEST(0, COALESCE(pl.included, 0)::BIGINT - COALESCE(m.used, 0) - COALESCE(a.active_now, 0)::BIGINT) AS remaining_seconds
FROM plan_limits pl
FULL OUTER JOIN mtd m ON TRUE
FULL OUTER JOIN active a ON TRUE;
$$;

-- Security: Only service role can call this (backend-only)
ALTER FUNCTION public.get_session_quota_status(UUID) SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.get_session_quota_status(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.get_session_quota_status(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_session_quota_status(UUID) TO service_role;

COMMENT ON FUNCTION public.get_session_quota_status IS 
    'Returns instant quota status for session-based metering. O(1) reads from usage_monthly + active session_spans.';
