import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * TTS Queue Manager
 * 
 * Ensures exactly one audio plays at a time.
 * Uses Promise-based chaining for sequential playback.
 */

/**
 * useTtsQueue - Manages TTS audio queue with sequential playback
 * 
 * @param {Object} options
 * @param {WebSocket} options.ws - WebSocket connection
 * @param {string} options.languageCode - Target language for TTS
 * @param {string} options.voiceName - Voice to use (optional)
 * @param {string} options.tier - TTS tier (gemini, neural2, etc.)
 * @param {Function} options.onPlayStart - Called when audio starts playing
 * @param {Function} options.onPlayEnd - Called when audio finishes
 * @param {Function} options.onError - Called on TTS error
 */
export function useTtsQueue({
    ws,
    languageCode = 'es',
    voiceName = null,
    tier = 'gemini',
    onPlayStart,
    onPlayEnd,
    onError
} = {}) {
    // Queue state
    const [queue, setQueue] = useState([]);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentSegment, setCurrentSegment] = useState(null);
    const [isStarted, setIsStarted] = useState(false);

    // Audio context and player
    const audioContextRef = useRef(null);
    const currentSourceRef = useRef(null);
    const processingRef = useRef(false);
    const wsRef = useRef(ws);
    const isStartedRef = useRef(false); // Ref for closure-safe check

    // Pending synthesis requests (waiting for audio response)
    const pendingRequestsRef = useRef(new Map());

    // Update ws ref when it changes
    useEffect(() => {
        wsRef.current = ws;
    }, [ws]);

    // Initialize audio context
    const initAudioContext = useCallback(() => {
        if (!audioContextRef.current) {
            audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
        }
        return audioContextRef.current;
    }, []);

    // Start TTS session (sends tts/start to backend)
    const startTts = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            console.warn('[useTtsQueue] Cannot start: WebSocket not connected');
            return;
        }

        wsRef.current.send(JSON.stringify({
            type: 'tts/start',
            languageCode,
            voiceName,
            tier,
            mode: 'unary'
        }));

        setIsStarted(true);
        isStartedRef.current = true; // Update ref for closure-safe access
        console.log('[useTtsQueue] TTS session started');
    }, [languageCode, voiceName, tier]);

    // Stop TTS session
    const stopTts = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            return;
        }

        wsRef.current.send(JSON.stringify({
            type: 'tts/stop'
        }));

        setIsStarted(false);
        isStartedRef.current = false; // Update ref
        setQueue([]);
        setIsPlaying(false);
        setCurrentSegment(null);

        // Stop any current audio
        if (currentSourceRef.current) {
            try {
                currentSourceRef.current.stop();
            } catch (e) {
                // Already stopped
            }
            currentSourceRef.current = null;
        }

        console.log('[useTtsQueue] TTS session stopped');
    }, []);

    // Pause TTS
    const pauseTts = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            return;
        }

        wsRef.current.send(JSON.stringify({
            type: 'tts/pause'
        }));

        // Suspend audio context to pause playback
        if (audioContextRef.current && audioContextRef.current.state === 'running') {
            audioContextRef.current.suspend();
        }

        console.log('[useTtsQueue] TTS paused');
    }, []);

    // Resume TTS
    const resumeTts = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            return;
        }

        wsRef.current.send(JSON.stringify({
            type: 'tts/resume'
        }));

        // Resume audio context
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume();
        }

        console.log('[useTtsQueue] TTS resumed');
    }, []);

    // Enqueue a segment for TTS
    const enqueue = useCallback((segment) => {
        // Use ref for closure-safe check
        if (!isStartedRef.current) {
            console.warn('[useTtsQueue] TTS not started. Call startTts() first. (isStartedRef:', isStartedRef.current, ')');
            return;
        }

        const queueItem = {
            id: segment.id || `tts_${Date.now()}`,
            text: segment.translatedText || segment.text,
            languageCode: segment.languageCode || languageCode,
            status: 'pending', // pending → synthesizing → playing → done
            timestamp: Date.now()
        };

        setQueue(prev => [...prev, queueItem]);
        console.log('[useTtsQueue] Enqueued:', queueItem.text.substring(0, 30) + '...');
    }, [languageCode]);

    // Request synthesis from backend
    const requestSynthesis = useCallback((item) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            onError?.({ code: 'WS_NOT_CONNECTED', message: 'WebSocket not connected' });
            return;
        }

        wsRef.current.send(JSON.stringify({
            type: 'tts/synthesize',
            segmentId: item.id,
            text: item.text,
            languageCode: item.languageCode || languageCode,
            voiceName,
            // CRITICAL: Do NOT send tier here - let backend extract it from voiceId
            // The backend will parse the tier from the voiceId URN (e.g., google_cloud_tts:chirp3_hd:...)
            // tier,  // REMOVED - was overriding voice selection
            mode: 'unary'
        }));

        // Track pending request
        pendingRequestsRef.current.set(item.id, item);

        console.log('[useTtsQueue] Synthesis requested:', item.id);
    }, [languageCode, voiceName, onError]);  // Removed 'tier' from dependencies

    // Play audio from base64
    const playAudio = useCallback(async (audioData, segmentId) => {
        const ctx = initAudioContext();

        try {
            // Decode base64 to ArrayBuffer
            const binaryString = atob(audioData.bytesBase64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // Decode audio
            const audioBuffer = await ctx.decodeAudioData(bytes.buffer);

            // Create source
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);

            currentSourceRef.current = source;

            // Handle completion
            source.onended = () => {
                currentSourceRef.current = null;
                setIsPlaying(false);
                setCurrentSegment(null);

                // Remove from queue
                setQueue(prev => prev.filter(item => item.id !== segmentId));

                // Notify completion
                onPlayEnd?.();

                console.log('[useTtsQueue] Playback complete:', segmentId);
            };

            // Start playback
            source.start(0);
            setIsPlaying(true);
            onPlayStart?.();

            console.log('[useTtsQueue] Playing audio:', segmentId, `(${audioData.durationMs}ms)`);

        } catch (error) {
            console.error('[useTtsQueue] Audio playback error:', error);
            onError?.({ code: 'PLAYBACK_ERROR', message: error.message });

            // Clean up and continue
            setIsPlaying(false);
            setCurrentSegment(null);
            setQueue(prev => prev.filter(item => item.id !== segmentId));
        }
    }, [initAudioContext, onPlayStart, onPlayEnd, onError]);

    // Handle incoming TTS messages
    const handleTtsMessage = useCallback((message) => {
        if (message.type === 'tts/audio') {
            // Audio received - play it
            const { segmentId, audio } = message;

            // Update queue status
            setQueue(prev => prev.map(item =>
                item.id === segmentId
                    ? { ...item, status: 'playing' }
                    : item
            ));

            setCurrentSegment(segmentId);
            playAudio(audio, segmentId);

            // Remove from pending
            pendingRequestsRef.current.delete(segmentId);

        } else if (message.type === 'tts/error') {
            console.error('[useTtsQueue] TTS error:', message);

            // Remove failed item from queue
            if (message.segmentId) {
                setQueue(prev => prev.filter(item => item.id !== message.segmentId));
                pendingRequestsRef.current.delete(message.segmentId);
            }

            onError?.(message);

        } else if (message.type === 'tts/ack') {
            console.log('[useTtsQueue] TTS ack:', message.action);
        }
    }, [playAudio, onError]);

    // Process queue - request synthesis for pending items
    useEffect(() => {
        if (processingRef.current || !isStarted) return;

        // Find first pending item that hasn't been requested
        const pendingItem = queue.find(item =>
            item.status === 'pending' && !pendingRequestsRef.current.has(item.id)
        );

        if (pendingItem && !isPlaying) {
            processingRef.current = true;

            // Update status
            setQueue(prev => prev.map(item =>
                item.id === pendingItem.id
                    ? { ...item, status: 'synthesizing' }
                    : item
            ));

            requestSynthesis(pendingItem);
            processingRef.current = false;
        }
    }, [queue, isPlaying, isStarted, requestSynthesis]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (currentSourceRef.current) {
                try {
                    currentSourceRef.current.stop();
                } catch (e) {
                    // Already stopped
                }
            }
            if (audioContextRef.current) {
                audioContextRef.current.close();
            }
        };
    }, []);

    return {
        // State
        queue,
        isPlaying,
        isStarted,
        currentSegment,
        queueLength: queue.length,

        // Actions
        startTts,
        stopTts,
        pauseTts,
        resumeTts,
        enqueue,

        // Message handler (call from WebSocket)
        handleTtsMessage,

        // Derived
        hasQueue: queue.length > 0
    };
}

export default useTtsQueue;
