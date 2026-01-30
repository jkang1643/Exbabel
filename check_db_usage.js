
import { supabaseAdmin } from './backend/supabaseAdmin.js';

async function checkUsage() {
    console.log('Checking usage_events table...');
    const { data, error } = await supabaseAdmin
        .from('usage_events')
        .select('*')
        .order('occurred_at', { ascending: false })
        .limit(5);

    if (error) {
        console.error('Error fetching usage_events:', error);
    } else {
        console.log(`Found ${data.length} records in usage_events:`);
        console.log(JSON.stringify(data, null, 2));
    }

    console.log('\nChecking usage_daily table...');
    const { data: dailyData, error: dailyError } = await supabaseAdmin
        .from('usage_daily')
        .select('*')
        .order('date', { ascending: false })
        .limit(5);

    if (dailyError) {
        console.error('Error fetching usage_daily:', dailyError);
    } else {
        console.log(`Found ${dailyData.length} records in usage_daily:`);
        console.log(JSON.stringify(dailyData, null, 2));
    }
    process.exit(0);
}

checkUsage();
