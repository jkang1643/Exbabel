-- Migration: Update record_usage_event to also upsert usage_monthly
-- Purpose: Maintain instant month-to-date counter for O(1) quota lookups
-- 
-- This function:
-- 1. Inserts into usage_events (ignores duplicates via idempotency_key)
-- 2. Updates usage_daily only if the insert succeeded (no double-counting)
-- 3. Updates usage_monthly only if the insert succeeded (instant MTD counter)
-- 4. Returns whether a new event was recorded

CREATE OR REPLACE FUNCTION public.record_usage_event(
    p_church_id UUID,
    p_metric TEXT,
    p_quantity NUMERIC,
    p_occurred_at TIMESTAMPTZ DEFAULT NOW(),
    p_idempotency_key TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL
)
RETURNS TABLE (
    inserted BOOLEAN,
    event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER -- Runs with owner privileges (bypasses RLS)
SET search_path = public
AS $$
DECLARE
    v_event_id UUID;
    v_date DATE;
    v_month_start DATE;
BEGIN
    -- Derive date from occurred_at for daily aggregation
    v_date := (p_occurred_at AT TIME ZONE 'UTC')::DATE;
    -- Derive month start for monthly aggregation
    v_month_start := date_trunc('month', p_occurred_at)::DATE;

    -- CTE approach: Insert into usage_events, only proceed if insert succeeds
    -- ON CONFLICT DO NOTHING means duplicate idempotency_key = no insert
    INSERT INTO public.usage_events (
        church_id,
        metric,
        quantity,
        occurred_at,
        idempotency_key,
        metadata
    )
    VALUES (
        p_church_id,
        p_metric,
        p_quantity,
        p_occurred_at,
        p_idempotency_key,
        p_metadata
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_event_id;

    -- If insert succeeded (not a duplicate), update daily AND monthly aggregation
    IF v_event_id IS NOT NULL THEN
        -- Update daily aggregation
        INSERT INTO public.usage_daily (
            church_id,
            date,
            metric,
            quantity
        )
        VALUES (
            p_church_id,
            v_date,
            p_metric,
            p_quantity
        )
        ON CONFLICT (church_id, date, metric)
        DO UPDATE SET
            quantity = usage_daily.quantity + EXCLUDED.quantity,
            updated_at = NOW();

        -- Update monthly aggregation (instant quota remaining)
        INSERT INTO public.usage_monthly (
            church_id,
            month_start,
            metric,
            total_quantity
        )
        VALUES (
            p_church_id,
            v_month_start,
            p_metric,
            p_quantity
        )
        ON CONFLICT (church_id, month_start, metric)
        DO UPDATE SET
            total_quantity = usage_monthly.total_quantity + EXCLUDED.total_quantity,
            updated_at = NOW();

        RETURN QUERY SELECT TRUE, v_event_id;
    ELSE
        -- Duplicate event - no insert, no daily/monthly update
        RETURN QUERY SELECT FALSE, NULL::UUID;
    END IF;
END;
$$;

-- Grant execute to service role (for backend calls)
GRANT EXECUTE ON FUNCTION public.record_usage_event TO service_role;

COMMENT ON FUNCTION public.record_usage_event IS 
    'Atomically records a usage event and updates daily + monthly aggregation. Idempotent via idempotency_key.';
