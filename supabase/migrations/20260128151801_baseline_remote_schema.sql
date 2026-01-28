-- Baseline Migration: Complete Remote Schema
-- Generated: 2026-01-28
-- This migration captures the current state of the Supabase database

-- ============================================================================
-- CHURCHES TABLE
-- ============================================================================
-- Organization/church records for multi-tenant architecture
CREATE TABLE public.churches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT churches_pkey PRIMARY KEY (id)
);

-- Enable RLS on churches
ALTER TABLE public.churches ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only see their own church
CREATE POLICY "Users can view their own church"
    ON public.churches
    FOR SELECT
    USING (
        id IN (
            SELECT church_id 
            FROM public.profiles 
            WHERE user_id = auth.uid()
        )
    );

-- ============================================================================
-- PROFILES TABLE
-- ============================================================================
-- User profiles with church association and role
CREATE TABLE public.profiles (
  user_id uuid NOT NULL,
  church_id uuid NOT NULL,
  role text NOT NULL CHECK (role = ANY (ARRAY['admin'::text, 'member'::text])),
  display_name text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT profiles_pkey PRIMARY KEY (user_id),
  CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT profiles_church_id_fkey FOREIGN KEY (church_id) REFERENCES public.churches(id)
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
-- PLANS TABLE
-- ============================================================================
-- Subscription plan definitions with feature flags and limits
CREATE TABLE public.plans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  included_seconds_per_month integer NOT NULL CHECK (included_seconds_per_month >= 0),
  max_session_seconds integer CHECK (max_session_seconds IS NULL OR max_session_seconds > 0),
  max_simultaneous_languages integer NOT NULL CHECK (max_simultaneous_languages > 0),
  stt_tier text NOT NULL,
  tts_tier text NOT NULL,
  feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT plans_pkey PRIMARY KEY (id)
);

-- Enable RLS on plans (read-only for all authenticated users)
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

-- RLS Policy: All authenticated users can view plans
CREATE POLICY "Authenticated users can view plans"
    ON public.plans
    FOR SELECT
    USING (auth.role() = 'authenticated');

-- ============================================================================
-- SUBSCRIPTIONS TABLE
-- ============================================================================
-- Active subscriptions per church with Stripe integration
CREATE TABLE public.subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  church_id uuid NOT NULL UNIQUE,
  plan_id uuid NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['trialing'::text, 'active'::text, 'past_due'::text, 'canceled'::text, 'paused'::text])),
  current_period_start timestamp with time zone,
  current_period_end timestamp with time zone,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT subscriptions_church_id_fkey FOREIGN KEY (church_id) REFERENCES public.churches(id),
  CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id)
);

-- Enable RLS on subscriptions
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only view their church's subscription
CREATE POLICY "Users can view own church subscription"
    ON public.subscriptions
    FOR SELECT
    USING (
        church_id IN (
            SELECT church_id 
            FROM public.profiles 
            WHERE user_id = auth.uid()
        )
    );

-- ============================================================================
-- CHURCH_BILLING_SETTINGS TABLE
-- ============================================================================
-- Pay-as-you-go billing configuration per church
CREATE TABLE public.church_billing_settings (
  church_id uuid NOT NULL,
  payg_enabled boolean NOT NULL DEFAULT false,
  payg_rate_cents_per_hour integer NOT NULL DEFAULT 0 CHECK (payg_rate_cents_per_hour >= 0),
  payg_hard_cap_seconds integer CHECK (payg_hard_cap_seconds IS NULL OR payg_hard_cap_seconds >= 0),
  allow_overage_while_live boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT church_billing_settings_pkey PRIMARY KEY (church_id),
  CONSTRAINT church_billing_settings_church_id_fkey FOREIGN KEY (church_id) REFERENCES public.churches(id)
);

-- Enable RLS on church_billing_settings
ALTER TABLE public.church_billing_settings ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can only view their church's billing settings
CREATE POLICY "Users can view own church billing settings"
    ON public.church_billing_settings
    FOR SELECT
    USING (
        church_id IN (
            SELECT church_id 
            FROM public.profiles 
            WHERE user_id = auth.uid()
        )
    );

-- RLS Policy: Admins can update their church's billing settings
CREATE POLICY "Admins can update own church billing settings"
    ON public.church_billing_settings
    FOR UPDATE
    USING (
        church_id IN (
            SELECT church_id 
            FROM public.profiles 
            WHERE user_id = auth.uid() AND role = 'admin'
        )
    );

-- ============================================================================
-- PLAN_MODEL_ROUTING TABLE
-- ============================================================================
-- AI model routing configuration per plan (STT/TTS/Grammar providers)
CREATE TABLE public.plan_model_routing (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL,
  capability text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT plan_model_routing_pkey PRIMARY KEY (id),
  CONSTRAINT plan_model_routing_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.plans(id)
);

-- Enable RLS on plan_model_routing
ALTER TABLE public.plan_model_routing ENABLE ROW LEVEL SECURITY;

-- RLS Policy: All authenticated users can view model routing
CREATE POLICY "Authenticated users can view model routing"
    ON public.plan_model_routing
    FOR SELECT
    USING (auth.role() = 'authenticated');

-- ============================================================================
-- INDEXES
-- ============================================================================
-- Performance indexes for common queries
CREATE INDEX IF NOT EXISTS idx_profiles_church_id ON public.profiles(church_id);
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON public.profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_church_id ON public.subscriptions(church_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_id ON public.subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_model_routing_plan_id ON public.plan_model_routing(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_model_routing_capability ON public.plan_model_routing(capability);

-- ============================================================================
-- TRIGGERS
-- ============================================================================
-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_plans_updated_at
    BEFORE UPDATE ON public.plans
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON public.subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_church_billing_settings_updated_at
    BEFORE UPDATE ON public.church_billing_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_plan_model_routing_updated_at
    BEFORE UPDATE ON public.plan_model_routing
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE public.churches IS 'Organization/church records for multi-tenant architecture';
COMMENT ON TABLE public.profiles IS 'User profiles with church association and role-based access';
COMMENT ON TABLE public.plans IS 'Subscription plan definitions with feature flags and usage limits';
COMMENT ON TABLE public.subscriptions IS 'Active subscriptions per church with Stripe integration';
COMMENT ON TABLE public.church_billing_settings IS 'Pay-as-you-go billing configuration per church';
COMMENT ON TABLE public.plan_model_routing IS 'AI model routing configuration per plan (STT/TTS/Grammar)';

COMMENT ON COLUMN public.profiles.role IS 'User role: admin or member';
COMMENT ON COLUMN public.plans.stt_tier IS 'Speech-to-text tier (e.g., standard, enhanced)';
COMMENT ON COLUMN public.plans.tts_tier IS 'Text-to-speech tier (e.g., standard, neural)';
COMMENT ON COLUMN public.plan_model_routing.capability IS 'AI capability: stt, tts, or grammar';
COMMENT ON COLUMN public.church_billing_settings.payg_rate_cents_per_hour IS 'Pay-as-you-go rate in cents per hour';
