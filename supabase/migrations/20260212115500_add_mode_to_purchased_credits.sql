-- Migration: Add mode column to purchased_credits table
-- Purpose: Split purchased credits between solo and host modes
-- 
-- This allows purchased hours to be tracked separately for each mode,
-- so buying "5 hours" gives you 5 solo + 5 host = 10 total hours

-- Add mode column with check constraint
ALTER TABLE purchased_credits 
ADD COLUMN mode TEXT CHECK (mode IN ('solo', 'host'));

-- Create index for efficient querying by mode
CREATE INDEX idx_purchased_credits_mode 
ON purchased_credits(church_id, mode, created_at DESC);

-- Create index for efficient querying of monthly credits
CREATE INDEX IF NOT EXISTS idx_purchased_credits_monthly 
ON purchased_credits(church_id, created_at DESC);

COMMENT ON COLUMN purchased_credits.mode IS 
    'Mode the purchased credits apply to: solo or host. NULL for legacy records that need backfill.';
