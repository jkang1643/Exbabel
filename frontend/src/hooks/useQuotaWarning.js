/**
 * useQuotaWarning - Hook for handling quota WebSocket events
 * 
 * Listens for quota_warning and quota_exceeded events
 * and manages modal/toast visibility state.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';

export function useQuotaWarning() {
    // Auth context for pre-connect quota check
    const { getAccessToken } = useAuth();

    // Current quota event from server
    const [quotaEvent, setQuotaEvent] = useState(null);

    // UI visibility state
    const [showModal, setShowModal] = useState(false);
    const [showToast, setShowToast] = useState(false);

    // Track if recording should be blocked
    const [isRecordingBlocked, setIsRecordingBlocked] = useState(false);

    /**
     * Handle incoming WebSocket message
     * Call this from your WebSocket message handler
     */
    const handleMessage = useCallback((message) => {
        if (!message || !message.type) return false;

        if (message.type === 'quota_exceeded') {
            console.log('[useQuotaWarning] 🚫 Quota exceeded:', message);
            setQuotaEvent(message);
            setShowModal(true);
            setShowToast(false);
            setIsRecordingBlocked(true);
            return true; // Handled
        }

        if (message.type === 'quota_warning') {
            console.log('[useQuotaWarning] ⚠️ Quota warning:', message);
            setQuotaEvent(message);
            setShowToast(true);
            // Don't show modal for warning, just toast
            return true; // Handled
        }

        return false; // Not a quota event
    }, []);

    /**
     * Dismiss the warning toast or modal
     */
    const dismiss = useCallback(() => {
        console.log('[useQuotaWarning] Dismissing UI');
        setShowModal(false);
        setShowToast(false);
    }, []);

    /**
     * Show the modal (e.g., from toast "Details" button)
     */
    const openModal = useCallback(() => {
        setShowModal(true);
        setShowToast(false);
    }, []);

    /**
     * Handle action button clicks
     */
    const handleAction = useCallback((actionId) => {
        console.log('[useQuotaWarning] Action clicked:', actionId);

        if (actionId === 'upgrade') {
            // TODO: Navigate to upgrade page
            console.log('[useQuotaWarning] Upgrade clicked - Coming Soon');
        } else if (actionId === 'add_hours') {
            // TODO: Show add hours flow
            console.log('[useQuotaWarning] Add Hours clicked - Coming Soon');
        }
    }, []);

    /**
     * Reset quota state (e.g., on session end or new month)
     */
    const reset = useCallback(() => {
        setQuotaEvent(null);
        setShowModal(false);
        setShowToast(false);
        setIsRecordingBlocked(false);
    }, []);

    /**
     * Pre-connect quota check
     * Calls the REST API on mount to check quota status BEFORE WebSocket connection.
     * This prevents bypassing by refreshing the page or clearing browser cache.
     * 
     * @param {'solo' | 'host'} mode - Which mode to check quota for
     */
    const checkQuotaOnMount = useCallback(async (mode = 'solo') => {
        try {
            const apiUrl = import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:3001`;
            const token = getAccessToken();
            if (!token) return; // Not authenticated yet

            const res = await fetch(`${apiUrl}/api/quota-check`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!res.ok) return; // Fail-open

            const data = await res.json();
            if (!data.hasQuota) return; // No quota defined, allow access

            const modeData = data[mode];
            const combinedData = data.combined;

            // Check both mode-specific and combined quotas
            if (modeData?.isExceeded || combinedData?.isExceeded) {
                console.log(`[useQuotaWarning] 🚫 Pre-connect check: quota exceeded for ${mode} mode`);
                setIsRecordingBlocked(true);
                setQuotaEvent({
                    type: 'quota_exceeded',
                    percentUsed: combinedData?.percentUsed || modeData?.percentUsed || 100,
                    message: `You've used ${combinedData?.percentUsed || modeData?.percentUsed || 100}% of your monthly quota.`,
                    actions: [
                        { id: 'upgrade', label: 'Upgrade Plan', enabled: false, hint: 'Coming Soon' },
                        { id: 'add_hours', label: 'Add Hours', enabled: false, hint: 'Coming Soon' },
                        { id: 'dismiss', label: 'OK', enabled: true }
                    ]
                });
                setShowModal(true);
            } else if (modeData?.isWarning || combinedData?.isWarning) {
                console.log(`[useQuotaWarning] ⚠️ Pre-connect check: quota warning for ${mode} mode`);
                setQuotaEvent({
                    type: 'quota_warning',
                    percentUsed: combinedData?.percentUsed || modeData?.percentUsed || 80,
                    message: `You've used ${combinedData?.percentUsed || modeData?.percentUsed || 80}% of your monthly quota.`,
                    actions: [
                        { id: 'upgrade', label: 'Upgrade Plan', enabled: false, hint: 'Coming Soon' },
                        { id: 'dismiss', label: 'OK', enabled: true }
                    ]
                });
                setShowToast(true);
            }
        } catch (err) {
            console.warn('[useQuotaWarning] Pre-connect quota check failed (allowing session):', err.message);
            // Fail-open: let the backend enforce on WS init
        }
    }, [getAccessToken]);

    return {
        // State
        quotaEvent,
        showModal,
        showToast,
        isRecordingBlocked,

        // Actions
        handleMessage,
        dismiss,
        openModal,
        handleAction,
        reset,
        checkQuotaOnMount,

        // Derived
        hasWarning: quotaEvent?.type === 'quota_warning',
        hasExceeded: quotaEvent?.type === 'quota_exceeded',
        percentUsed: quotaEvent?.percentUsed || 0
    };
}

export default useQuotaWarning;
