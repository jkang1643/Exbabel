/**
 * Check member counts per church
 * Run: node check_member_counts.js
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://fjkysulfacbgfmsbuyvv.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function checkMemberCounts() {
    console.log('🔍 Checking member counts per church...\n');

    // Query to get member counts
    const { data: churches, error: churchError } = await supabase
        .from('churches')
        .select('id, name, created_at');

    if (churchError) {
        console.error('❌ Error fetching churches:', churchError);
        return;
    }

    console.log(`Found ${churches.length} churches\n`);

    // For each church, count members
    const results = [];
    for (const church of churches) {
        const { count, error: countError } = await supabase
            .from('profiles')
            .select('*', { count: 'exact', head: true })
            .eq('church_id', church.id);

        if (countError) {
            console.error(`❌ Error counting members for ${church.name}:`, countError);
            continue;
        }

        results.push({
            id: church.id,
            name: church.name,
            member_count: count,
            created_at: church.created_at
        });
    }

    // Sort by member count descending
    results.sort((a, b) => b.member_count - a.member_count);

    // Display results
    console.log('📊 Member Counts by Church:');
    console.log('─'.repeat(100));
    console.log('Church Name'.padEnd(40), 'Members'.padEnd(10), 'UUID'.padEnd(36), 'Created');
    console.log('─'.repeat(100));

    for (const church of results.slice(0, 20)) {
        console.log(
            church.name.padEnd(40),
            church.member_count.toString().padEnd(10),
            church.id.padEnd(36),
            new Date(church.created_at).toLocaleDateString()
        );
    }

    console.log('─'.repeat(100));
    console.log(`\nTotal churches: ${results.length}`);
    console.log(`Churches with 0 members: ${results.filter(c => c.member_count === 0).length}`);
    console.log(`Churches with 1+ members: ${results.filter(c => c.member_count > 0).length}`);
    console.log(`Churches with exactly 40 members: ${results.filter(c => c.member_count === 40).length}`);

    // Check if there's a pattern
    const memberCounts = results.map(c => c.member_count);
    const uniqueCounts = [...new Set(memberCounts)];
    console.log(`\nUnique member counts: ${uniqueCounts.sort((a, b) => a - b).join(', ')}`);
}

checkMemberCounts().catch(console.error);
