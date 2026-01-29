-- Grant admin role to test user in PROD
-- Run this in Supabase SQL Editor for PROD database

UPDATE public.profiles
SET role = 'admin'
WHERE email = 'exbabelapp+1@gmail.com';

-- Verify the update
SELECT id, email, role, church_id
FROM public.profiles
WHERE email = 'exbabelapp+1@gmail.com';
