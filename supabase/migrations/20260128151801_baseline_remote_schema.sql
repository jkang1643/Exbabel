-- Baseline Migration: Remote Schema
-- Generated: 2026-01-28
-- This migration captures the current state of the Supabase database

-- ============================================================================
-- CHURCHES TABLE
-- ============================================================================
-- Organization/church records for multi-tenant architecture
CREATE TABLE IF NOT EXISTS public.churches (
    church_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS on churches
ALTER TABLE public.churches ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only see their own church
CREATE POLICY "Users can view their own church"
    ON public.churches
    FOR SELECT
    USING (
        church_id IN (
            SELECT church_id 
            FROM public.profiles 
            WHERE user_id = auth.uid()
        )
    );

-- ============================================================================
-- PROFILES TABLE
-- ============================================================================
-- User profiles with church association and role
CREATE TABLE IF NOT EXISTS public.profiles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    church_id UUID REFERENCES public.churches(church_id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    
    -- Constraints
    CONSTRAINT valid_role CHECK (role IN ('admin', 'member', 'viewer'))
);

-- Enable RLS on profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only view their own profile
CREATE POLICY "Users can view own profile"
    ON public.profiles
    FOR SELECT
    USING (user_id = auth.uid());

-- RLS Policy: Users can update their own profile
CREATE POLICY "Users can update own profile"
    ON public.profiles
    FOR UPDATE
    USING (user_id = auth.uid());

-- RLS Policy: Users can insert their own profile
CREATE POLICY "Users can insert own profile"
    ON public.profiles
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- INDEXES
-- ============================================================================
-- Index for faster church lookups
CREATE INDEX IF NOT EXISTS idx_profiles_church_id ON public.profiles(church_id);

-- Index for faster user lookups
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON public.profiles(user_id);

-- ============================================================================
-- TRIGGERS
-- ============================================================================
-- Auto-update updated_at timestamp on churches
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_churches_updated_at
    BEFORE UPDATE ON public.churches
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE public.churches IS 'Organization/church records for multi-tenant architecture';
COMMENT ON TABLE public.profiles IS 'User profiles with church association and role-based access';
COMMENT ON COLUMN public.profiles.role IS 'User role: admin, member, or viewer';
COMMENT ON COLUMN public.profiles.church_id IS 'Foreign key to churches table for multi-tenant isolation';
