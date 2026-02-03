-- Migration: Add separate solo/host hour quotas to plans table
-- Date: 2026-02-03
-- Purpose: Allow separate quota limits for solo mode vs host mode streaming

-- Add new columns for separate quotas
ALTER TABLE public.plans 
ADD COLUMN IF NOT EXISTS included_solo_seconds_per_month integer NOT NULL DEFAULT 0 CHECK (included_solo_seconds_per_month >= 0),
ADD COLUMN IF NOT EXISTS included_host_seconds_per_month integer NOT NULL DEFAULT 0 CHECK (included_host_seconds_per_month >= 0);

-- Migrate existing data: split current quota 50/50 between solo and host
-- (These can be adjusted later via admin)
UPDATE public.plans SET
  included_solo_seconds_per_month = CASE 
    WHEN code = 'starter' THEN 14400    -- 4 hours solo
    WHEN code = 'pro' THEN 86400        -- 24 hours solo  
    WHEN code = 'unlimited' THEN 900000 -- 250 hours solo
    ELSE included_seconds_per_month / 2
  END,
  included_host_seconds_per_month = CASE
    WHEN code = 'starter' THEN 21600    -- 6 hours host
    WHEN code = 'pro' THEN 93600        -- 26 hours host
    WHEN code = 'unlimited' THEN 900000 -- 250 hours host
    ELSE included_seconds_per_month / 2
  END;

-- Add index on session_spans mode metadata for quota calculations
CREATE INDEX IF NOT EXISTS idx_session_spans_mode ON public.session_spans((metadata->>'mode'));

-- Comment on new columns
COMMENT ON COLUMN public.plans.included_solo_seconds_per_month IS 'Monthly quota for solo mode (individual practice)';
COMMENT ON COLUMN public.plans.included_host_seconds_per_month IS 'Monthly quota for host mode (church broadcasts)';
