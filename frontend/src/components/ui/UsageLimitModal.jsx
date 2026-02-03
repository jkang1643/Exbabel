/**
 * UsageLimitModal - Shows when usage quota is exceeded or warning threshold reached
 * 
 * Displays:
 * - Warning message at 80% usage
 * - Lock modal at 100% usage
 * - Action buttons: Upgrade Plan (Coming Soon), Add Hours (Coming Soon), OK/Dismiss
 */

import { useState, useEffect } from 'react';
import './UsageLimitModal.css';

/**
 * @param {Object} props
 * @param {Object|null} props.quotaEvent - Quota event from WebSocket (null = hidden)
 * @param {Function} props.onDismiss - Called when user dismisses the modal
 * @param {Function} props.onAction - Called when user clicks an action (upgrade, add_hours)
 */
export function UsageLimitModal({ quotaEvent, onDismiss, onAction }) {
    if (!quotaEvent) return null;

    const isExceeded = quotaEvent.type === 'quota_exceeded';
    const isWarning = quotaEvent.type === 'quota_warning';

    // Don't render if not a quota event
    if (!isExceeded && !isWarning) return null;

    const handleAction = (actionId) => {
        if (actionId === 'dismiss') {
            onDismiss?.();
        } else {
            onAction?.(actionId);
        }
    };

    return (
        <div className="usage-limit-modal-overlay">
            <div className={`usage-limit-modal ${isExceeded ? 'exceeded' : 'warning'}`}>
                {/* Icon */}
                <div className="usage-limit-icon">
                    {isExceeded ? '🚫' : '⚠️'}
                </div>

                {/* Title */}
                <h2 className="usage-limit-title">
                    {isExceeded
                        ? "You've reached your monthly limit"
                        : "You're approaching your limit"}
                </h2>

                {/* Message */}
                <p className="usage-limit-message">
                    {quotaEvent.message}
                </p>

                {/* Usage Bar */}
                <div className="usage-limit-bar-container">
                    <div
                        className={`usage-limit-bar ${isExceeded ? 'exceeded' : 'warning'}`}
                        style={{ width: `${Math.min(quotaEvent.percentUsed, 100)}%` }}
                    />
                </div>
                <p className="usage-limit-percent">
                    {quotaEvent.percentUsed}% of quota used
                </p>

                {/* Action Buttons */}
                <div className="usage-limit-actions">
                    {quotaEvent.actions?.map((action) => (
                        <button
                            key={action.id}
                            className={`usage-limit-btn ${action.id === 'dismiss' ? 'primary' : 'secondary'}`}
                            onClick={() => handleAction(action.id)}
                            disabled={!action.enabled}
                            title={action.enabled ? undefined : action.hint}
                        >
                            {action.label}
                            {!action.enabled && action.hint && (
                                <span className="coming-soon-badge">{action.hint}</span>
                            )}
                        </button>
                    ))}
                </div>

                {/* Info for exceeded state */}
                {isExceeded && (
                    <p className="usage-limit-info">
                        Recording has been paused until next month or you add more hours.
                    </p>
                )}
            </div>
        </div>
    );
}

/**
 * QuotaWarningToast - A less intrusive toast for the warning state
 */
export function QuotaWarningToast({ quotaEvent, onDismiss, onShowModal }) {
    if (!quotaEvent || quotaEvent.type !== 'quota_warning') return null;

    return (
        <div className="quota-warning-toast">
            <span className="quota-warning-icon">⚠️</span>
            <span className="quota-warning-text">
                {quotaEvent.percentUsed}% of monthly quota used
            </span>
            <button
                className="quota-warning-details"
                onClick={onShowModal}
            >
                Details
            </button>
            <button
                className="quota-warning-close"
                onClick={onDismiss}
            >
                ×
            </button>
        </div>
    );
}

export default UsageLimitModal;
