-- Migration: 20260218_add_church_settings.sql
-- Adds permanent QR code and conference mode to churches table

-- 1. Add permanent_code (nullable, generated lazily on first host session)
ALTER TABLE public.churches
  ADD COLUMN IF NOT EXISTS permanent_code VARCHAR(6) UNIQUE;

-- 2. Add conference_mode (false = use permanent code, true = fresh code each session)
ALTER TABLE public.churches
  ADD COLUMN IF NOT EXISTS conference_mode BOOLEAN NOT NULL DEFAULT false;

-- 3. RLS: Admins can update their own church row
--    (churches table previously had no UPDATE policy)
CREATE POLICY "Admins can update own church"
  ON public.churches
  FOR UPDATE
  USING (
    id IN (
      SELECT church_id
      FROM public.profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  )
  WITH CHECK (
    id IN (
      SELECT church_id
      FROM public.profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );
