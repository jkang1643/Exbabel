-- Migration: Update get_session_quota_status for mode-specific quotas
-- Purpose: Support separate solo/host quotas with new columns
-- 
-- Changes:
-- - Reads from included_solo_seconds_per_month and included_host_seconds_per_month
-- - Looks up solo_seconds and host_seconds usage separately
-- - Returns detailed breakdown + combined totals for backwards compatibility

-- IMPORTANT: Must drop first because return type is changing
DROP FUNCTION IF EXISTS public.get_session_quota_status(UUID);

CREATE OR REPLACE FUNCTION public.get_session_quota_status(p_church_id UUID)
RETURNS TABLE (
  -- Combined (backwards compatible)
  included_seconds_per_month INT,
  used_seconds_mtd BIGINT,
  active_seconds_now INT,
  remaining_seconds BIGINT,
  -- Solo mode breakdown
  included_solo_seconds INT,
  used_solo_seconds_mtd BIGINT,
  remaining_solo_seconds BIGINT,
  -- Host mode breakdown
  included_host_seconds INT,
  used_host_seconds_mtd BIGINT,
  remaining_host_seconds BIGINT
)
LANGUAGE sql
STABLE
AS $$
WITH plan_limits AS (
  SELECT 
    -- Get separate quotas (new columns)
    COALESCE(p.included_solo_seconds_per_month, p.included_seconds_per_month / 2)::INT AS solo_included,
    COALESCE(p.included_host_seconds_per_month, p.included_seconds_per_month / 2)::INT AS host_included,
    -- Combined for backwards compatibility
    (COALESCE(p.included_solo_seconds_per_month, p.included_seconds_per_month / 2) + 
     COALESCE(p.included_host_seconds_per_month, p.included_seconds_per_month / 2))::INT AS total_included
  FROM public.subscriptions s
  JOIN public.plans p ON p.id = s.plan_id
  WHERE s.church_id = p_church_id
    AND s.status IN ('active', 'trialing')
  LIMIT 1
),
solo_mtd AS (
  -- Solo mode usage (new metric)
  SELECT COALESCE(um.total_quantity, 0)::BIGINT AS used
  FROM public.usage_monthly um
  WHERE um.church_id = p_church_id
    AND um.month_start = date_trunc('month', now())::DATE
    AND um.metric = 'solo_seconds'
),
host_mtd AS (
  -- Host mode usage (new metric)
  SELECT COALESCE(um.total_quantity, 0)::BIGINT AS used
  FROM public.usage_monthly um
  WHERE um.church_id = p_church_id
    AND um.month_start = date_trunc('month', now())::DATE
    AND um.metric = 'host_seconds'
),
legacy_mtd AS (
  -- Legacy session_seconds for backwards compatibility
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
  -- Combined (backwards compatible) - includes legacy session_seconds
  COALESCE(pl.total_included, 0) AS included_seconds_per_month,
  (COALESCE(sm.used, 0) + COALESCE(hm.used, 0) + COALESCE(lm.used, 0)) AS used_seconds_mtd,
  COALESCE(a.active_now, 0) AS active_seconds_now,
  GREATEST(0, 
    COALESCE(pl.total_included, 0)::BIGINT 
    - COALESCE(sm.used, 0) 
    - COALESCE(hm.used, 0) 
    - COALESCE(lm.used, 0) 
    - COALESCE(a.active_now, 0)::BIGINT
  ) AS remaining_seconds,
  -- Solo breakdown
  COALESCE(pl.solo_included, 0) AS included_solo_seconds,
  COALESCE(sm.used, 0) AS used_solo_seconds_mtd,
  GREATEST(0, COALESCE(pl.solo_included, 0)::BIGINT - COALESCE(sm.used, 0)) AS remaining_solo_seconds,
  -- Host breakdown
  COALESCE(pl.host_included, 0) AS included_host_seconds,
  COALESCE(hm.used, 0) AS used_host_seconds_mtd,
  GREATEST(0, COALESCE(pl.host_included, 0)::BIGINT - COALESCE(hm.used, 0)) AS remaining_host_seconds
FROM plan_limits pl
FULL OUTER JOIN solo_mtd sm ON TRUE
FULL OUTER JOIN host_mtd hm ON TRUE
FULL OUTER JOIN legacy_mtd lm ON TRUE
FULL OUTER JOIN active a ON TRUE;
$$;

-- Security: Only service role can call this (backend-only)
ALTER FUNCTION public.get_session_quota_status(UUID) SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.get_session_quota_status(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.get_session_quota_status(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_session_quota_status(UUID) TO service_role;

COMMENT ON FUNCTION public.get_session_quota_status IS 
    'Returns instant quota status with separate solo/host breakdowns. O(1) reads from usage_monthly + active session_spans.';
