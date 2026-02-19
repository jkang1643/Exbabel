import { useState, useCallback, useRef, useEffect } from 'react';

// DSP Helper: Soft clipping / Warmth saturation curve
function makeDistortionCurve(amount) {
    const k = typeof amount === 'number' ? amount : 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
        const x = i * 2 / n_samples - 1;
        curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

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
    playbackRate = 1.0,
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
    const gainNodeRef = useRef(null);
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

    // Initialize audio context with gain boost
    const initAudioContext = useCallback(() => {
        if (!audioContextRef.current) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            audioContextRef.current = new AudioContextClass();

            // Vocal Channel Strip: HPF -> Presence EQ -> Saturation -> Gain -> Limiter

            // 1. High-Pass Filter (Remove rumble/mud)
            const hpf = audioContextRef.current.createBiquadFilter();
            hpf.type = 'highpass';
            hpf.frequency.value = 80;

            // 2. Presence EQ (Vocal Clarity)
            const eq = audioContextRef.current.createBiquadFilter();
            eq.type = 'peaking';
            eq.frequency.value = 3000; // 3kHz clarity
            eq.Q.value = 1.0;
            eq.gain.value = 3.0; // +3dB (Restored for clarity)

            // 3. Gentle Saturation (WaveShaper) - DISABLED
            const distortion = audioContextRef.current.createWaveShaper();
            distortion.curve = makeDistortionCurve(0); // No saturation (linear)
            distortion.oversample = 'none';

            // 4. Pre-Gain (450% Boost - MAX LOUDNESS)
            const preGain = audioContextRef.current.createGain();
            preGain.gain.value = 4.5; // Pushing gain hard into the limiter

            // 5. Hard Limiter (Brickwall)
            const limiter = audioContextRef.current.createDynamicsCompressor();
            limiter.threshold.value = -0.5; // Ceiling at -0.5dB
            limiter.knee.value = 0.0;
            limiter.ratio.value = 20.0;
            limiter.attack.value = 0.001;
            limiter.release.value = 0.05; // Faster release for loudness

            // Connect Chain
            hpf.connect(eq);
            eq.connect(distortion);
            distortion.connect(preGain);
            preGain.connect(limiter);
            limiter.connect(audioContextRef.current.destination);

            // Store entry point
            gainNodeRef.current = hpf;

            console.log('[useTtsQueue] Initialized Vocal Channel Strip: HPF(80) -> EQ(3k) -> Sat(100) -> Gain(300%) -> Limiter');
        }
        // Resume if suspended (browser policy)
        if (audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume().catch(err => console.warn('AudioContext resume failed', err));
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

        // IMPORTANT: Initialize/Resume AudioContext HERE (inside user gesture handler)
        // This ensures iOS/mobile browsers don't block audio later
        initAudioContext();

        setIsStarted(true);
        isStartedRef.current = true; // Update ref for closure-safe access
        console.log('[useTtsQueue] TTS session started');
    }, [languageCode, voiceName, tier, initAudioContext]);

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
            voiceId: segment.voiceId, // Capture voiceId
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
            voiceName: voiceName, // Fallback to hook prop
            voiceId: item.voiceId, // Use specific voiceId if available
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
        // Prevent re-entry if already playing (double safeguard)
        if (isStartedRef.current === false) return;

        // CRITICAL: Set playing state synchronously immediately to block the Player Loop
        // from calling this again while we decode.
        setIsPlaying(true);
        setCurrentSegment(segmentId);

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

            // Double check if we should still play (user might have stopped)
            if (!isStartedRef.current) {
                setIsPlaying(false);
                return;
            }

            // Create source and connect to gain node (not destination)
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.playbackRate.value = playbackRate;

            // Connect to gain node if available, otherwise destination
            if (gainNodeRef.current) {
                source.connect(gainNodeRef.current);
            } else {
                source.connect(ctx.destination);
            }

            console.log(`[useTtsQueue] Playing segment ${segmentId} at rate ${playbackRate}x (source.playbackRate.value=${source.playbackRate.value})`);

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
            // Audio received - attach to queue item but DO NOT PLAY yet
            const { segmentId, audio } = message;

            console.log('[useTtsQueue] Audio received for:', segmentId);

            // Update queue item with audio data
            setQueue(prev => prev.map(item =>
                item.id === segmentId
                    ? { ...item, status: 'audio_ready', audioData: audio }
                    : item
            ));

            // Remove from pending requests map
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
    }, [onError]);

    // Player Loop - Watches queue and plays next item if idle
    useEffect(() => {
        // If not started, paused, or already playing, do nothing
        if (!isStarted || isPlaying || queue.length === 0) return;

        const nextItem = queue[0];

        // If 'audio_ready', play it!
        if (nextItem.status === 'audio_ready' && nextItem.audioData) {
            // Update status to prevent double-play triggers
            // (Setting isPlaying=true happens in playAudio, but we also want to mark the item)

            // NOTE: playAudio sets isPlaying=true synchronously
            playAudio(nextItem.audioData, nextItem.id);
        }
    }, [queue, isPlaying, isStarted, playAudio]);

    // Fetcher Loop - Request synthesis for pending items
    // (Runs independently of playback to allow buffering)
    useEffect(() => {
        if (processingRef.current || !isStarted) return;

        // Find first pending item that hasn't been requested
        // Limit concurrency if needed, but for now just fetch everything pending
        const pendingItem = queue.find(item =>
            item.status === 'pending' && !pendingRequestsRef.current.has(item.id)
        );

        if (pendingItem) {
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
    }, [queue, isStarted, requestSynthesis]);

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
                audioContextRef.current.close().catch(() => { });
                audioContextRef.current = null;
                gainNodeRef.current = null;
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
