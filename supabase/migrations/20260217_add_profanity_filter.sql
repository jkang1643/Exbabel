-- Migration: Add profanity filter setting to churches table
-- Created: 2026-02-17

ALTER TABLE churches
ADD COLUMN IF NOT EXISTS profanity_filter_enabled BOOLEAN DEFAULT true NOT NULL;

COMMENT ON COLUMN churches.profanity_filter_enabled IS 'Enable profanity filtering in speech-to-text transcription. When enabled, inappropriate language is censored (e.g., "f***")';
