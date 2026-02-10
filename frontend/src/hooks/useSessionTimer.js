/**
 * useSessionTimer - Live elapsed time counter for active sessions
 * 
 * Tracks elapsed time with 1-second resolution.
 * Start/stop controls aligned with recording lifecycle.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

export function useSessionTimer() {
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [isRunning, setIsRunning] = useState(false);
    const intervalRef = useRef(null);
    const startTimeRef = useRef(null);

    const start = useCallback(() => {
        if (intervalRef.current) return; // Already running
        startTimeRef.current = Date.now();
        setIsRunning(true);
        setElapsedSeconds(0);

        intervalRef.current = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
            setElapsedSeconds(elapsed);
        }, 1000);
    }, []);

    const stop = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        setIsRunning(false);
    }, []);

    const reset = useCallback(() => {
        stop();
        setElapsedSeconds(0);
        startTimeRef.current = null;
    }, [stop]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
        };
    }, []);

    // Format elapsed seconds as HH:MM:SS or MM:SS
    const formatTime = (totalSeconds) => {
        const hrs = Math.floor(totalSeconds / 3600);
        const mins = Math.floor((totalSeconds % 3600) / 60);
        const secs = totalSeconds % 60;

        if (hrs > 0) {
            return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    };

    return {
        elapsedSeconds,
        isRunning,
        formattedTime: formatTime(elapsedSeconds),
        start,
        stop,
        reset
    };
}

export default useSessionTimer;
