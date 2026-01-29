-- Migration: Index usage_events for performance
-- Purpose: Speed up tenant-scoped and time-range queries (billing/reporting)

-- Index for church-scoped lookups
CREATE INDEX IF NOT EXISTS usage_events_church_id_idx ON public.usage_events (church_id);

-- Index for time-range lookups (Month-to-Date reporting)
CREATE INDEX IF NOT EXISTS usage_events_occurred_at_idx ON public.usage_events (occurred_at);

-- Composite index for the most common query: a specific church's usage over time
CREATE INDEX IF NOT EXISTS usage_events_church_time_idx ON public.usage_events (church_id, occurred_at DESC);
