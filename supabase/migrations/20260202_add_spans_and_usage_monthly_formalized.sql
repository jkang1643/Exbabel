-- Migration: Formalize Spans and Monthly Usage Tables
-- Date: 2026-02-02
-- Purpose: Add missing tables for tracking host sessions, listener sessions, and monthly aggregates.

-- 1. Create usage_monthly table
CREATE TABLE IF NOT EXISTS public.usage_monthly (
  church_id uuid NOT NULL,
  month_start date NOT NULL,
  metric text NOT NULL,
  total_quantity numeric NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT usage_monthly_pkey PRIMARY KEY (church_id, month_start, metric),
  CONSTRAINT usage_monthly_church_id_fkey FOREIGN KEY (church_id) REFERENCES public.churches(id)
);

-- 2. Create session_spans table (Host active streaming time)
CREATE TABLE IF NOT EXISTS public.session_spans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  church_id uuid NOT NULL,
  session_id uuid NOT NULL,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone,
  ended_at timestamp with time zone,
  ended_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT session_spans_pkey PRIMARY KEY (id),
  CONSTRAINT session_spans_church_id_fkey FOREIGN KEY (church_id) REFERENCES public.churches(id),
  CONSTRAINT session_spans_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id)
);

-- 3. Create listening_spans table (Listener consumption time)
CREATE TABLE IF NOT EXISTS public.listening_spans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  church_id uuid NOT NULL,
  session_id uuid NOT NULL,
  user_id uuid NOT NULL,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone,
  ended_at timestamp with time zone,
  ended_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT listening_spans_pkey PRIMARY KEY (id),
  CONSTRAINT listening_spans_church_id_fkey FOREIGN KEY (church_id) REFERENCES public.churches(id),
  CONSTRAINT listening_spans_session_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id)
);

-- Indexing for performance
CREATE INDEX IF NOT EXISTS idx_session_spans_session_id ON public.session_spans(session_id);
CREATE INDEX IF NOT EXISTS idx_session_spans_church_id ON public.session_spans(church_id);
CREATE INDEX IF NOT EXISTS idx_listening_spans_session_id ON public.listening_spans(session_id);
CREATE INDEX IF NOT EXISTS idx_listening_spans_church_id ON public.listening_spans(church_id);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_church_id ON public.usage_monthly(church_id);

-- Enable RLS
ALTER TABLE public.usage_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_spans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listening_spans ENABLE ROW LEVEL SECURITY;

-- Note: RLS policies for these tables are generally restricted to service_role 
-- or admin viewing, handled at the RPC level.
