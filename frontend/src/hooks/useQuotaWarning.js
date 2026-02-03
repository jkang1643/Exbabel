/**
 * useQuotaWarning - Hook for handling quota WebSocket events
 * 
 * Listens for quota_warning and quota_exceeded events
 * and manages modal/toast visibility state.
 */

import { useState, useCallback, useEffect, useRef } from 'react';

export function useQuotaWarning() {
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
        if (quotaEvent?.type === 'quota_exceeded') {
            // For exceeded, dismiss modal but keep blocked state
            setShowModal(false);
            // Recording stays blocked
        } else {
            // For warning, dismiss toast
            setShowToast(false);
        }
    }, [quotaEvent]);

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

        // Derived
        hasWarning: quotaEvent?.type === 'quota_warning',
        hasExceeded: quotaEvent?.type === 'quota_exceeded',
        percentUsed: quotaEvent?.percentUsed || 0
    };
}

export default useQuotaWarning;
