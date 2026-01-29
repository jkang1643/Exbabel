-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

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
CREATE TABLE public.churches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT churches_pkey PRIMARY KEY (id)
);
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
CREATE TABLE public.usage_daily (
  church_id uuid NOT NULL,
  date date NOT NULL,
  metric text NOT NULL,
  quantity bigint NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT usage_daily_pkey PRIMARY KEY (church_id, date, metric),
  CONSTRAINT usage_daily_church_id_fkey FOREIGN KEY (church_id) REFERENCES public.churches(id)
);
CREATE TABLE public.usage_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  church_id uuid NOT NULL,
  session_id uuid,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  metric text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity >= 0),
  idempotency_key text NOT NULL UNIQUE,
  provider text,
  model text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT usage_events_pkey PRIMARY KEY (id),
  CONSTRAINT usage_events_church_id_fkey FOREIGN KEY (church_id) REFERENCES public.churches(id)
);
