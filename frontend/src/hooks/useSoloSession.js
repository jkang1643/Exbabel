import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Solo Session State Machine
 * 
 * States: idle → listening → finalizing → speaking → listening (loop)
 * Modes: preaching (one-way), conversation (two-way auto-swap), textOnly (no TTS)
 */

// State machine states
export const SessionState = {
    IDLE: 'idle',
    LISTENING: 'listening',
    FINALIZING: 'finalizing',
    SPEAKING: 'speaking'
};

// Solo modes
export const SoloMode = {
    PREACHING: 'preaching',       // One-way: speaker continues, TTS queues
    CONVERSATION: 'conversation', // Two-way: auto-swap after each turn
    TEXT_ONLY: 'textOnly'         // No TTS output, just transcription
};

/**
 * useSoloSession - Core state machine for Solo Mode
 * 
 * @param {Object} options
 * @param {WebSocket} options.ws - WebSocket connection
 * @param {string} options.sourceLang - Source language code
 * @param {string} options.targetLang - Target language code
 * @param {Function} options.onPartial - Callback for partial transcripts
 * @param {Function} options.onFinal - Callback for finalized transcripts
 * @param {Function} options.onTranslation - Callback for translations
 * @param {Function} options.onStateChange - Callback for state changes
 * @param {Function} options.onError - Callback for errors
 */
export function useSoloSession({
    ws,
    sourceLang = 'en',
    targetLang = 'es',
    onPartial,
    onFinal,
    onTranslation,
    onStateChange,
    onError
} = {}) {
    // Core state
    const [state, setState] = useState(SessionState.IDLE);
    const [mode, setMode] = useState(SoloMode.PREACHING);
    const [isConnected, setIsConnected] = useState(false);

    // Conversation mode: tracks current direction
    // REMOVED: conversationDirection - now using bi-directional auto-detection

    // Transcript accumulator
    const [partialText, setPartialText] = useState('');
    const [finalizedSegments, setFinalizedSegments] = useState([]);

    // Queue for TTS (managed externally by useTtsQueue)
    const [pendingSpeakQueue, setPendingSpeakQueue] = useState([]);

    // Silence detection config
    const silenceTimeoutRef = useRef(null);
    const lastAudioTimeRef = useRef(null);
    const stateRef = useRef(state); // Ref for closure-safe state check
    const finalizedSegmentsRef = useRef([]); // Ref for synchronous access to segments


    // Keep stateRef in sync
    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    // Config
    const SILENCE_THRESHOLD_MS = 800; // 800ms of silence = finalize

    // State change handler
    const updateState = useCallback((newState) => {
        setState(newState);
        onStateChange?.(newState);
    }, [onStateChange]);

    // Start listening (auto-mode)
    const start = useCallback(() => {
        if (state !== SessionState.IDLE) {
            console.warn('[useSoloSession] Cannot start: not in IDLE state');
            return;
        }

        updateState(SessionState.LISTENING);
        console.log('[useSoloSession] Started listening');
    }, [state, updateState]);

    // Stop listening
    const stop = useCallback(() => {
        updateState(SessionState.IDLE);
        setPartialText('');

        // Clear silence timeout
        if (silenceTimeoutRef.current) {
            clearTimeout(silenceTimeoutRef.current);
            silenceTimeoutRef.current = null;
        }

        console.log('[useSoloSession] Stopped');
    }, [updateState]);

    // Handle incoming partial transcript
    const handlePartial = useCallback((text) => {
        // Use ref for closure-safe state check
        if (stateRef.current !== SessionState.LISTENING) {
            console.log('[useSoloSession] Ignoring partial - state:', stateRef.current);
            return;
        }

        setPartialText(text);
        lastAudioTimeRef.current = Date.now();
        onPartial?.(text);

        // Reset silence timer
        if (silenceTimeoutRef.current) {
            clearTimeout(silenceTimeoutRef.current);
        }

        silenceTimeoutRef.current = setTimeout(() => {
            // Silence detected - check if we should finalize
            if (stateRef.current === SessionState.LISTENING) {
                console.log('[useSoloSession] Silence detected, waiting for server final');
            }
        }, SILENCE_THRESHOLD_MS);
    }, [onPartial]);

    // Handle finalized transcript from server
    const handleFinal = useCallback((text, translatedText, seqId) => {
        // Clear silence timer
        if (silenceTimeoutRef.current) {
            clearTimeout(silenceTimeoutRef.current);
            silenceTimeoutRef.current = null;
        }

        // Use provided seqId or generate one if missing (fallback)
        const segmentId = seqId ? `seg_${seqId}` : `seg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Use ref for synchronous check (avoid stale state issues)
        const currentSegments = finalizedSegmentsRef.current;
        const existingSegmentIndex = seqId ? currentSegments.findIndex(s => s.seqId === seqId) : -1;

        let isUpdate = false;
        let isTranslationArrival = false;
        let newSegments = [...currentSegments];

        if (existingSegmentIndex !== -1) {
            isUpdate = true;
            const existingSegment = currentSegments[existingSegmentIndex];

            // DETECT LATE ARRIVING TRANSLATIONS
            // If the previous version was a fallback (translatedText == originalText)
            // AND the new version has a real translation (translatedText != text)
            // THEN we treat this as a "Translation Arrival" which should trigger TTS.
            const wasFallback = existingSegment.translatedText === existingSegment.originalText;
            const isNowTranslated = translatedText && translatedText !== text;

            if (wasFallback && isNowTranslated) {
                isTranslationArrival = true;
                console.log('[useSoloSession] 📢 Translation arrived for existing segment:', seqId);
            }

            // Update existing segment in new list
            newSegments[existingSegmentIndex] = {
                ...existingSegment,
                originalText: text,
                translatedText: translatedText || text,
                // Keep original timestamp
            };
        } else {
            // Add new segment
            const newSegment = {
                id: segmentId,
                seqId: seqId, // Store the backend sequence ID
                originalText: text,
                translatedText: translatedText || text,
                timestamp: Date.now()
            };
            newSegments.push(newSegment);
        }

        // Update Ref immediately
        finalizedSegmentsRef.current = newSegments;

        // Update State
        setFinalizedSegments(newSegments);
        setPartialText('');

        // Notify callbacks
        onFinal?.(text);

        // Determine if TTS should trigger
        // Trigger if: It's NEW (not update) OR It's a Translation Arrival
        const shouldTriggerTts = !isUpdate || isTranslationArrival;

        // BUG FIX: Pass isUpdate as FALSE if we want to trigger TTS (e.g. translation arrival)
        onTranslation?.(text, translatedText, !shouldTriggerTts);

        // If not text-only mode, queue for TTS
        // CRITICAL FIX: Only queue if it's a NEW segment OR a translation arrival
        if (mode !== SoloMode.TEXT_ONLY && translatedText) {
            if (shouldTriggerTts) {
                const segment = {
                    id: segmentId,
                    originalText: text,
                    translatedText: translatedText || text,
                    timestamp: Date.now()
                };
                setPendingSpeakQueue(prev => [...prev, segment]);

                // Transition to speaking state if not in preaching mode
                // In preaching mode, we continue listening while TTS plays
                if (mode === SoloMode.CONVERSATION) {
                    updateState(SessionState.SPEAKING);
                }
            } else {
                console.log('[useSoloSession] 🔄 Updated existing segment, skipping TTS queue');
            }
        }

        console.log(`[useSoloSession] Finalized (${isUpdate ? (isTranslationArrival ? 'TRANS-ARRIVAL' : 'UPDATE') : 'NEW'}):`, text.substring(0, 50) + '...');
    }, [mode, onFinal, onTranslation, updateState]);

    // Called when TTS finishes speaking
    const onSpeakComplete = useCallback(() => {
        // Remove from pending queue
        setPendingSpeakQueue(prev => prev.slice(1));

        if (mode === SoloMode.CONVERSATION) {
            // Just resume listening (bi-directional)
            updateState(SessionState.LISTENING);
            console.log('[useSoloSession] Conversation: TTS done, resuming listening');
        } else if (state === SessionState.SPEAKING) {
            // Preaching mode: if queue is empty, keep listening
            updateState(SessionState.LISTENING);
        }
    }, [mode, state, updateState]);



    // Clear all segments
    const clearSegments = useCallback(() => {
        setFinalizedSegments([]);
        setPartialText('');
    }, []);

    // Pop next segment from speak queue
    const popSpeakQueue = useCallback(() => {
        if (pendingSpeakQueue.length === 0) return null;
        const next = pendingSpeakQueue[0];
        return next;
    }, [pendingSpeakQueue]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (silenceTimeoutRef.current) {
                clearTimeout(silenceTimeoutRef.current);
            }
        };
    }, []);

    return {
        // State
        state,
        mode,
        isConnected,
        partialText,
        finalizedSegments,
        pendingSpeakQueue,

        // Actions
        start,
        stop,
        setMode,
        clearSegments,

        // Handlers (call these from WebSocket message handler)
        handlePartial,
        handleFinal,
        onSpeakComplete,
        popSpeakQueue,


        // Derived state
        isListening: state === SessionState.LISTENING,
        isSpeaking: state === SessionState.SPEAKING,
        isIdle: state === SessionState.IDLE,
        queueLength: pendingSpeakQueue.length
    };
}

export default useSoloSession;
