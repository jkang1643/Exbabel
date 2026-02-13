/**
 * TEMPORARY DEBUG ROUTE - Check member counts
 * Add this to server.js temporarily to check member counts
 * DELETE AFTER INVESTIGATION
 */

import express from 'express';
import { supabaseAdmin } from '../supabaseAdmin.js';

export const debugRouter = express.Router();

debugRouter.get('/debug/member-counts', async (req, res) => {
    try {
        console.log('🔍 Checking member counts per church...');

        // Get all churches
        const { data: churches, error: churchError } = await supabaseAdmin
            .from('churches')
            .select('id, name, created_at')
            .order('name');

        if (churchError) {
            return res.status(500).json({ error: churchError.message });
        }

        // For each church, count members
        const results = [];
        for (const church of churches) {
            const { count, error: countError } = await supabaseAdmin
                .from('profiles')
                .select('*', { count: 'exact', head: true })
                .eq('church_id', church.id);

            if (countError) {
                console.error(`Error counting for ${church.name}:`, countError);
                continue;
            }

            results.push({
                id: church.id,
                name: church.name,
                member_count: count || 0,
                created_at: church.created_at
            });
        }

        // Sort by member count descending
        results.sort((a, b) => b.member_count - a.member_count);

        // Calculate statistics
        const stats = {
            total_churches: results.length,
            churches_with_zero_members: results.filter(c => c.member_count === 0).length,
            churches_with_members: results.filter(c => c.member_count > 0).length,
            churches_with_exactly_40: results.filter(c => c.member_count === 40).length,
            unique_member_counts: [...new Set(results.map(c => c.member_count))].sort((a, b) => a - b)
        };

        res.json({
            success: true,
            stats,
            churches: results.slice(0, 50), // Top 50
            sample_churches: {
                highest: results.slice(0, 5),
                with_40_members: results.filter(c => c.member_count === 40).slice(0, 5),
                with_zero_members: results.filter(c => c.member_count === 0).slice(0, 5)
            }
        });
    } catch (err) {
        console.error('Debug endpoint error:', err);
        res.status(500).json({ error: err.message });
    }
});
