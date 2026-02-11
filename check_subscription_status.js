/**
 * Quick script to check subscription status for debugging
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: './backend/.env' });

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const churchId = '28d565b7-1a4b-475f-9f30-71fd7c0239bc';

async function checkStatus() {
    console.log('Checking subscription and profile status...\n');

    // Check subscription
    const { data: sub, error: subErr } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('church_id', churchId)
        .single();

    console.log('Subscription:', JSON.stringify(sub, null, 2));
    if (subErr) console.error('Subscription error:', subErr);

    // Check profile
    const { data: profile, error: profErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('church_id', churchId)
        .single();

    console.log('\nProfile:', JSON.stringify(profile, null, 2));
    if (profErr) console.error('Profile error:', profErr);
}

checkStatus().then(() => process.exit(0));
