-- Migration: Populate Plan Tiers and Model Routing
-- Date: 2026-01-29
-- PR: Align Database and Backend for Starter/Pro/Unlimited tiers

-- 1. Ensure Starter plan has correct code if it was manually inserted with different ID
-- (The ID eb4c7361-c077-4272-9b11-f7f923f0c800 was seen in DB, using code for consistency)

-- 2. Insert Pro and Unlimited plans
INSERT INTO public.plans (code, name, included_seconds_per_month, max_session_seconds, max_simultaneous_languages, stt_tier, tts_tier)
VALUES 
  ('pro', 'Pro', 180000, 14400, 5, 'pro', 'pro'),
  ('unlimited', 'Unlimited', 1800000, NULL, 99, 'unlimited', 'unlimited')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  included_seconds_per_month = EXCLUDED.included_seconds_per_month,
  max_session_seconds = EXCLUDED.max_session_seconds,
  max_simultaneous_languages = EXCLUDED.max_simultaneous_languages,
  stt_tier = EXCLUDED.stt_tier,
  tts_tier = EXCLUDED.tts_tier;

-- 3. Populate Model Routing for Starter Tier
-- Capabilities: translate, stt, tts, grammar
INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'translate', 'openai', 'gpt-4o-mini', '{}' FROM public.plans WHERE code = 'starter'
ON CONFLICT DO NOTHING;

INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'stt', 'google', 'v1p1beta1', '{"model": "latest_long", "useEnhanced": true}' FROM public.plans WHERE code = 'starter'
ON CONFLICT DO NOTHING;

INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'grammar', 'openai', 'gpt-4o-mini', '{"temperature": 0}' FROM public.plans WHERE code = 'starter'
ON CONFLICT DO NOTHING;

-- 4. Populate Model Routing for Pro Tier
INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'translate', 'openai', 'gpt-4o', '{}' FROM public.plans WHERE code = 'pro'
ON CONFLICT DO NOTHING;

INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'stt', 'google', 'v1p1beta1', '{"model": "latest_long", "useEnhanced": true, "enableAutomaticPunctuation": true}' FROM public.plans WHERE code = 'pro'
ON CONFLICT DO NOTHING;

INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'grammar', 'deepseek', 'deepseek-chat', '{"temperature": 0}' FROM public.plans WHERE code = 'pro'
ON CONFLICT DO NOTHING;

-- 5. Populate Model Routing for Unlimited Tier
INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'translate', 'openai', 'gpt-realtime-mini', '{}' FROM public.plans WHERE code = 'unlimited'
ON CONFLICT DO NOTHING;

-- Note: Unlimited uses STT 2.0 parameters (latest_long + phrase sets)
INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'stt', 'google', 'v1p1beta1', '{"model": "latest_long", "useEnhanced": true, "enableAutomaticPunctuation": true, "profanityFilter": false}' FROM public.plans WHERE code = 'unlimited'
ON CONFLICT DO NOTHING;

INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'grammar', 'deepseek', 'deepseek-chat', '{"temperature": 0}' FROM public.plans WHERE code = 'unlimited'
ON CONFLICT DO NOTHING;

-- Update existing Starter TTS routing if it exists
INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'tts', 'google', 'neural2', '{}' FROM public.plans WHERE code = 'starter'
ON CONFLICT DO NOTHING;

INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'tts', 'google', 'studio', '{}' FROM public.plans WHERE code = 'pro'
ON CONFLICT DO NOTHING;

INSERT INTO public.plan_model_routing (plan_id, capability, provider, model, params)
SELECT id, 'tts', 'elevenlabs', 'elevenlabs_flash', '{}' FROM public.plans WHERE code = 'unlimited'
ON CONFLICT DO NOTHING;
