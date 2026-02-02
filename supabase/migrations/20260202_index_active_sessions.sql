-- Migration: Add partial index for active sessions
-- Date: 2026-02-02
-- Purpose: Optimize startup cleanup queries and active session lookups.

CREATE INDEX IF NOT EXISTS idx_sessions_active_status 
ON public.sessions (status) 
WHERE status = 'active';

COMMENT ON INDEX public.idx_sessions_active_status IS 'Optimizes startup recovery and active session lookups';
