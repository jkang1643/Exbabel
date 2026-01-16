/**
 * useImperativePainter Hook
 * 
 * Provides stable, flicker-free rendering for live streaming text.
 * Uses imperative DOM updates (textContent) instead of React state
 * to eliminate reconciliation overhead.
 * 
 * Key features:
 * - Coalesced updates at ~15fps (66ms) via requestAnimationFrame
 * - Shrink-delay: text can grow immediately, shrinking is delayed 200ms
 * - Immediate clear for finals
 */

import { useRef, useEffect, useCallback } from 'react';

/**
 * @param {React.RefObject<HTMLElement>} elementRef - Ref to the DOM element to paint
 * @param {Object} options - Configuration options
 * @param {number} options.shrinkDelayMs - Delay before shrinking text (default: 200ms)
 * @param {number} options.frameIntervalMs - Minimum interval between paints (default: 66ms ~15fps)
 * @returns {{ updateText: (text: string) => void, clearText: () => void, getText: () => string }}
 */
export function useImperativePainter(elementRef, options = {}) {
    const {
        shrinkDelayMs = 200,
        frameIntervalMs = 66, // ~15fps
    } = options;

    // Internal state refs (not React state - no re-renders)
    const latestTextRef = useRef('');
    const displayedTextRef = useRef('');
    const shrinkTimerRef = useRef(null);
    const rafIdRef = useRef(null);
    const lastPaintTimeRef = useRef(0);
    const pendingPaintRef = useRef(false);

    /**
     * Actually paint the text to the DOM element
     */
    const paintNow = useCallback((text) => {
        if (elementRef.current) {
            elementRef.current.textContent = text;
            displayedTextRef.current = text;
            lastPaintTimeRef.current = performance.now();
        }
    }, [elementRef]);

    /**
     * Schedule a paint using requestAnimationFrame with throttling
     */
    const schedulePaint = useCallback(() => {
        if (pendingPaintRef.current) return;

        pendingPaintRef.current = true;
        rafIdRef.current = requestAnimationFrame(() => {
            pendingPaintRef.current = false;

            const now = performance.now();
            const elapsed = now - lastPaintTimeRef.current;

            // Throttle to ~15fps
            if (elapsed >= frameIntervalMs) {
                paintNow(latestTextRef.current);
            } else {
                // Schedule for next frame if we're too fast
                const delay = frameIntervalMs - elapsed;
                setTimeout(() => {
                    paintNow(latestTextRef.current);
                }, delay);
            }
        });
    }, [frameIntervalMs, paintNow]);

    /**
     * Update the live text with shrink-delay logic
     * - Growth: applies immediately
     * - Shrink: delayed by shrinkDelayMs (unless new growth arrives)
     */
    const updateText = useCallback((newText) => {
        if (typeof newText !== 'string') {
            console.warn('[useImperativePainter] updateText called with non-string:', typeof newText);
            return;
        }

        const currentDisplayed = displayedTextRef.current;
        latestTextRef.current = newText;

        // Cancel any pending shrink timer
        if (shrinkTimerRef.current) {
            clearTimeout(shrinkTimerRef.current);
            shrinkTimerRef.current = null;
        }

        // Growth: apply immediately
        if (newText.length >= currentDisplayed.length) {
            schedulePaint();
        }
        // Shrink: delay to avoid visual jitter from ASR revisions
        else {
            shrinkTimerRef.current = setTimeout(() => {
                shrinkTimerRef.current = null;
                // Only paint if this is still the latest text (no new updates arrived)
                if (latestTextRef.current === newText) {
                    paintNow(newText);
                }
            }, shrinkDelayMs);
        }
    }, [shrinkDelayMs, schedulePaint, paintNow]);

    /**
     * Clear the text immediately (used for finals)
     */
    const clearText = useCallback(() => {
        // Cancel any pending operations
        if (shrinkTimerRef.current) {
            clearTimeout(shrinkTimerRef.current);
            shrinkTimerRef.current = null;
        }
        if (rafIdRef.current) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
        pendingPaintRef.current = false;

        latestTextRef.current = '';
        displayedTextRef.current = '';

        if (elementRef.current) {
            elementRef.current.textContent = '';
        }
    }, [elementRef]);

    /**
     * Get the current displayed text
     */
    const getText = useCallback(() => {
        return displayedTextRef.current;
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (shrinkTimerRef.current) {
                clearTimeout(shrinkTimerRef.current);
            }
            if (rafIdRef.current) {
                cancelAnimationFrame(rafIdRef.current);
            }
        };
    }, []);

    return { updateText, clearText, getText };
}

export default useImperativePainter;
