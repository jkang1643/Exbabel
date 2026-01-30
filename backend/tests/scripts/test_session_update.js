
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing env vars');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

async function testUpdate() {
    console.log('Testing Supabase Admin Update...');

    // 1. Create a dummy session
    const id = crypto.randomUUID();
    console.log(`Creating session: ${id}`);

    const { error: insertError } = await supabase.from('sessions').insert({
        id,
        church_id: '71afaace-d9e6-4c94-84ed-b504efe7fa1c', // Use a valid UUID or existing one from logs if known is better
        status: 'active',
        session_code: 'TEST01',
        source_lang: 'en'
    });

    if (insertError) {
        console.error('Insert failed:', insertError);
        // If FK fails, we might need a real church_id. 
        // Trying with null church_id if allowed? 
        // Schema says church_id might be nullable? Let's assume it is based on code using upsert.
        return;
    }

    console.log('Insert successful.');

    // 2. Update it to ended
    console.log('Updating to ended...');
    const { data, error: updateError } = await supabase
        .from('sessions')
        .update({ status: 'ended', ended_at: new Date().toISOString() })
        .eq('id', id)
        .select();

    if (updateError) {
        console.error('Update failed:', updateError);
    } else {
        console.log('Update successful:', data);
    }

    // 3. Cleanup
    await supabase.from('sessions').delete().eq('id', id);
}

testUpdate();
