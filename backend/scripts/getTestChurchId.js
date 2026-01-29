/**
 * Get Test Church ID for Development
 * 
 * Queries the database to find a church on the starter plan for testing tier gating.
 */

import dotenv from 'dotenv';
dotenv.config();

import { supabaseAdmin } from '../supabaseAdmin.js';

async function getTestChurchId() {
    try {
        const { data, error } = await supabaseAdmin
            .from('churches')
            .select(`
                id,
                name,
                subscriptions!inner (
                    id,
                    plans!inner (
                        code,
                        name
                    )
                )
            `)
            .eq('subscriptions.plans.code', 'starter')
            .limit(1)
            .single();

        if (error) {
            console.error('Error fetching test church:', error);
            process.exit(1);
        }

        if (!data) {
            console.error('No churches found on starter plan');
            process.exit(1);
        }

        console.log('\n=== Test Church Found ===');
        console.log(`Church ID: ${data.id}`);
        console.log(`Church Name: ${data.name}`);
        console.log(`Plan: ${data.subscriptions.plans.code} (${data.subscriptions.plans.name})`);
        console.log('\nAdd this to backend/.env:');
        console.log(`TEST_CHURCH_ID=${data.id}`);
        console.log('');

    } catch (err) {
        console.error('Unexpected error:', err);
        process.exit(1);
    }
}

getTestChurchId();
