-- Add 'inactive' to the subscription status enum
-- This allows new churches to start with 'inactive' status until Stripe webhook
-- confirms the subscription (sets to 'trialing' or 'active'), which triggers admin promotion

ALTER TABLE subscriptions
DROP CONSTRAINT IF EXISTS subscriptions_status_check;

ALTER TABLE subscriptions
ADD CONSTRAINT subscriptions_status_check
CHECK (status = ANY (ARRAY['inactive'::text, 'trialing'::text, 'active'::text, 'past_due'::text, 'canceled'::text, 'paused'::text]));
