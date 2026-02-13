-- Migration: Backfill mode for existing purchased_credits
-- Purpose: Convert legacy purchased_credits rows to new split-mode system
-- 
-- Strategy: For each existing credit without a mode:
--   1. Set mode='solo' on the existing row (50% of purchased hours)
--   2. Create a duplicate row with mode='host' (remaining 50%)
-- 
-- This ensures existing purchased credits are doubled (as intended)

DO $$
DECLARE
    credit_record RECORD;
    new_id UUID;
BEGIN
    -- Process each purchased_credit row that doesn't have a mode set
    FOR credit_record IN 
        SELECT id, church_id, amount_seconds, stripe_payment_intent_id, created_at
        FROM purchased_credits
        WHERE mode IS NULL
    LOOP
        -- Update existing row to be 'solo' mode with 50% of seconds
        UPDATE purchased_credits
        SET 
            mode = 'solo',
            amount_seconds = credit_record.amount_seconds / 2
        WHERE id = credit_record.id;
        
        -- Create duplicate row for 'host' mode with remaining 50%
        INSERT INTO purchased_credits (
            church_id, 
            amount_seconds, 
            mode,
            stripe_payment_intent_id,
            created_at
        )
        VALUES (
            credit_record.church_id,
            credit_record.amount_seconds / 2,
            'host',
            credit_record.stripe_payment_intent_id || '_host_split',  -- Avoid unique constraint violation
            credit_record.created_at
        );
        
        RAISE NOTICE 'Backfilled credit % for church % (% seconds split into solo + host)', 
            credit_record.id, credit_record.church_id, credit_record.amount_seconds;
    END LOOP;
    
    RAISE NOTICE 'Backfill complete';
END $$;
