
import { supabaseAdmin } from '../supabaseAdmin.js';

const SESSION_ID = '866a1d89-06f8-4e19-b146-e82230bdacbf';

async function debugSession() {
    console.log(`Checking DB for session: ${SESSION_ID}`);

    // 1. Check Sessions Table
    const { data: session, error: sessionError } = await supabaseAdmin
        .from('sessions')
        .select('*')
        .eq('id', SESSION_ID)
        .single();

    if (sessionError) {
        console.log(`[Sessions] Error or Not Found:`, sessionError.message);
    } else {
        console.log(`[Sessions] Found:`, session);
    }

    // 2. Check Session Spans Table
    const { data: spans, error: spansError } = await supabaseAdmin
        .from('session_spans')
        .select('*')
        .eq('session_id', SESSION_ID);

    if (spansError) {
        console.log(`[SessionSpans] Error:`, spansError.message);
    } else {
        console.log(`[SessionSpans] Found ${spans.length} spans:`);
        spans.forEach(s => console.log(s));
    }
}

debugSession();
