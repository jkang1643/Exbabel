/**
 * Membership Service
 * 
 * Handles automatic profile creation when users join sessions.
 * Implements the "frictionless membership" model:
 * - Visitors can join sessions without account
 * - Signed-in users auto-link to church when they join a session
 */

import { supabaseAdmin } from '../supabaseAdmin.js';

/**
 * Auto-link a signed-in user to a church via session join
 * 
 * If the user has no profile, creates one linked to the session's church.
 * If the user already has a profile, does nothing (idempotent).
 * 
 * @param {string} userId - The authenticated user's UUID
 * @param {string} churchId - The church_id from the session
 * @returns {Promise<{linked: boolean, profile: object|null, error: string|null}>}
 */
export async function autoLinkToChurch(userId, churchId) {
    if (!userId || !churchId) {
        return { linked: false, profile: null, error: 'Missing userId or churchId' };
    }

    try {
        // Check if profile already exists
        const { data: existingProfile, error: checkErr } = await supabaseAdmin
            .from('profiles')
            .select('user_id, church_id, role')
            .eq('user_id', userId)
            .single();

        if (existingProfile) {
            // Profile exists - check if it's the same church
            if (existingProfile.church_id === churchId) {
                console.log(`[Membership] User ${userId} already member of church ${churchId}`);
                return { linked: false, profile: existingProfile, error: null };
            } else {
                // User belongs to a different church - don't overwrite
                console.log(`[Membership] User ${userId} belongs to different church (${existingProfile.church_id}), not ${churchId}`);
                return { linked: false, profile: existingProfile, error: null };
            }
        }

        // No profile exists - create one with the session's church
        const { data: newProfile, error: insertErr } = await supabaseAdmin
            .from('profiles')
            .insert({
                user_id: userId,
                church_id: churchId,
                role: 'member', // Default to member, not admin
            })
            .select('user_id, church_id, role')
            .single();

        if (insertErr) {
            console.error(`[Membership] Failed to create profile for ${userId}:`, insertErr.message);
            return { linked: false, profile: null, error: insertErr.message };
        }

        console.log(`[Membership] ✅ Auto-linked user ${userId} to church ${churchId} as member`);
        return { linked: true, profile: newProfile, error: null };

    } catch (err) {
        console.error(`[Membership] Unexpected error:`, err.message);
        return { linked: false, profile: null, error: err.message };
    }
}

/**
 * Get church details for a session
 * 
 * @param {string} sessionId - The session UUID
 * @returns {Promise<{churchId: string|null, churchName: string|null}>}
 */
export async function getSessionChurch(sessionId) {
    try {
        const { data, error } = await supabaseAdmin
            .from('sessions')
            .select('church_id, churches:church_id(id, name)')
            .eq('id', sessionId)
            .single();

        if (error || !data) {
            return { churchId: null, churchName: null };
        }

        return {
            churchId: data.church_id,
            churchName: data.churches?.name || null
        };
    } catch (err) {
        console.error(`[Membership] Failed to get session church:`, err.message);
        return { churchId: null, churchName: null };
    }
}
