/**
 * useAnalytics - Fetch analytics data from backend on mount
 * 
 * Always fetches fresh on mount (no caching).
 * Since AdminHome unmounts during Solo/Host sessions, 
 * re-mounting guarantees fresh data.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';

export function useAnalytics() {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const { session } = useAuth();

    const fetchAnalytics = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

            const token = session?.access_token;
            if (!token) {
                setError('Not authenticated');
                setLoading(false);
                return;
            }

            const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
            const response = await fetch(`${apiUrl}/api/analytics`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                const errBody = await response.json().catch(() => ({}));
                throw new Error(errBody.error || `HTTP ${response.status}`);
            }

            const result = await response.json();
            setData(result);
        } catch (err) {
            console.error('[useAnalytics] Fetch error:', err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [session?.access_token]);

    // Fetch fresh data on every mount
    useEffect(() => {
        fetchAnalytics();
    }, [fetchAnalytics]);

    return {
        data,
        loading,
        error,
        refresh: fetchAnalytics
    };
}

export default useAnalytics;
