import { useState, useCallback, useRef, useEffect } from 'react';
import { StreamingAudioPlayer, decodeAudioFrame } from '../tts/StreamingAudioPlayer';

/**
 * useTtsStreaming - React hook for real-time TTS audio streaming
 * 
 * Manages WebSocket connection to /ws/tts and StreamingAudioPlayer.
 * 
 * @param {Object} options
 * @param {string} options.sessionId - Session ID for this connection
 * @param {boolean} options.enabled - Whether streaming is enabled
 * @param {Function} options.onBufferUpdate - Called with buffered duration
 * @param {Function} options.onUnderrun - Called on audio underrun
 * @param {Function} options.onError - Called on error
 */
export function useTtsStreaming({
    sessionId,
    enabled = false,
    targetLang = null,
    playbackRate = 1.0,
    onBufferUpdate,
    onUnderrun,
    onError
} = {}) {
    // Use refs for callbacks to avoid re-triggering effects when functions change
    const onBufferUpdateRef = useRef(onBufferUpdate);
    const onUnderrunRef = useRef(onUnderrun);
    const onErrorRef = useRef(onError);
    const playbackRateRef = useRef(playbackRate);

    const [isConnected, setIsConnected] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [bufferedMs, setBufferedMs] = useState(0);
    const [stats, setStats] = useState({
        bytesReceived: 0,
        chunksReceived: 0,
        underruns: 0
    });

    // Update refs when props change
    useEffect(() => {
        onBufferUpdateRef.current = onBufferUpdate;
        onUnderrunRef.current = onUnderrun;
        onErrorRef.current = onError;
        playbackRateRef.current = playbackRate;

        // Update live player rate if already playing
        if (playerRef.current && isPlaying) {
            playerRef.current.setPlaybackRate(playbackRate);
        }
    }, [onBufferUpdate, onUnderrun, onError, playbackRate, isPlaying]);

    const wsRef = useRef(null);
    const playerRef = useRef(null);
    const reconnectTimeoutRef = useRef(null);
    const clientIdRef = useRef(`client_${Date.now()}_${Math.random().toString(36).substring(7)}`);
    // Track the lang the server knows about so we only send set_lang when it actually changes
    const serverKnownLangRef = useRef(null);

    // Get WebSocket URL
    const getWebSocketUrl = useCallback(() => {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = import.meta.env.VITE_WS_URL || `${wsProtocol}//${window.location.hostname}:3001`;
        return `${host}/ws/tts?sessionId=${sessionId}`;
    }, [sessionId]);

    // Connect to streaming WebSocket
    const connect = useCallback(() => {
        if (!enabled || !sessionId) {
            console.log('[useTtsStreaming] Not connecting: enabled=', enabled, 'sessionId=', sessionId);
            return;
        }

        if (wsRef.current) {
            console.log('[useTtsStreaming] Already connected or connecting');
            return;
        }

        const wsUrl = getWebSocketUrl();
        console.log('[useTtsStreaming] Connecting to:', wsUrl);

        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        ws.onopen = async () => {
            console.log('[useTtsStreaming] Connected');
            setIsConnected(true);

            // Initialize player — wrapped in try/catch so that any failure
            // (MediaSource timeout, QuotaExceededError, Safari quirk, etc.)
            // surfaces loudly and triggers a clean reconnect instead of
            // silently leaving the client unregistered on the backend.
            if (!playerRef.current) {
                const player = new StreamingAudioPlayer({
                    jitterBufferMs: 500, // Increased for Host Mode broadcast architecture (was 150ms)
                    onBufferUpdate: (ms) => {
                        setBufferedMs(ms);
                        onBufferUpdateRef.current?.(ms);
                    },
                    onUnderrun: (count) => {
                        setStats(prev => ({ ...prev, underruns: count }));
                        onUnderrunRef.current?.(count);
                    },
                    onError: (err) => {
                        console.error('[useTtsStreaming] Player error:', err);
                        onErrorRef.current?.(err);
                    }
                });

                try {
                    await player.start({
                        streamId: `stream_${sessionId}_${Date.now()}`,
                        codec: 'mp3',
                        sampleRate: 44100,
                        channels: 1,
                        playbackRate: playbackRateRef.current
                    });
                    playerRef.current = player;
                } catch (startErr) {
                    // StreamingAudioPlayer failed to initialize (e.g. MediaSource timeout,
                    // QuotaExceededError, unsupported format). Close and reconnect cleanly.
                    console.error('[useTtsStreaming] ❌ StreamingAudioPlayer.start() failed — will reconnect:', startErr);
                    onErrorRef.current?.(startErr);
                    // Null out the broken player so the next connection starts fresh
                    playerRef.current = null;
                    // Remove listeners to prevent zombie events on this dead socket
                    ws.onopen = null;
                    ws.onmessage = null;
                    ws.onclose = null;
                    ws.onerror = null;
                    ws.close();
                    wsRef.current = null;
                    setIsConnected(false);
                    // Trigger reconnect after a short delay
                    reconnectTimeoutRef.current = setTimeout(() => {
                        console.log('[useTtsStreaming] Reconnecting after player init failure...');
                        connect();
                    }, 1500);
                    return;
                }
            }

            // Send hello message with explicit clientId and subscribed language
            ws.send(JSON.stringify({
                type: 'audio.hello',
                clientId: clientIdRef.current,
                capabilities: ['mp3'],
                codec: 'mp3',
                sampleRate: 44100,
                targetLang: targetLang || null   // Tell server which language to filter to
            }));
            serverKnownLangRef.current = targetLang || null;
        };

        ws.onmessage = (event) => {
            try {
                // Check if binary frame
                if (event.data instanceof ArrayBuffer) {
                    // Decode binary audio frame
                    const { meta, audioBytes } = decodeAudioFrame(event.data);

                    if (meta && audioBytes) {
                        playerRef.current?.enqueue(meta, audioBytes);
                        setStats(prev => ({
                            ...prev,
                            bytesReceived: prev.bytesReceived + audioBytes.length,
                            chunksReceived: prev.chunksReceived + 1
                        }));

                        if (!isPlaying && audioBytes.length > 0) {
                            setIsPlaying(true);
                        }
                    }
                } else {
                    // JSON control message
                    const message = JSON.parse(event.data);

                    switch (message.type) {
                        case 'audio.ready':
                            console.log('[useTtsStreaming] Server ready:', message.streamId);
                            break;
                        case 'audio.start':
                            console.log('[useTtsStreaming] Stream starting:', message.segmentId);
                            playerRef.current?.handleStartMessage(message);
                            break;
                        case 'audio.end':
                            console.log('[useTtsStreaming] Stream ended:', message.segmentId);
                            setIsPlaying(false);
                            break;
                        case 'audio.cancel':
                            console.log('[useTtsStreaming] Stream cancelled:', message.reason);
                            setIsPlaying(false);
                            break;
                        case 'audio.error':
                            console.error('[useTtsStreaming] Stream error:', message.error);
                            onErrorRef.current?.(new Error(message.error));
                            break;
                        case 'tts/routing':
                        case 'tts/ack':
                            // Internal routing/stats messages, ignore
                            break;
                        default:
                            console.log('[useTtsStreaming] Unknown message:', message.type);
                    }
                }
            } catch (err) {
                console.error('[useTtsStreaming] Message error:', err);
            }
        };

        ws.onclose = (event) => {
            console.log(`[useTtsStreaming] Disconnected: code=${event.code}, reason=${event.reason}, wasClean=${event.wasClean}`);
            setIsConnected(false);
            wsRef.current = null;

            // Auto-reconnect if still enabled and not a normal closure
            if (enabled && event.code !== 1000) {
                reconnectTimeoutRef.current = setTimeout(() => {
                    console.log('[useTtsStreaming] Reconnecting...');
                    connect();
                }, 2000);
            }
        };

        ws.onerror = (err) => {
            // Note: WebSocket 'error' event gives very little info
            console.error('[useTtsStreaming] WebSocket error event');
            onErrorRef.current?.(err);
        };
    }, [enabled, sessionId, getWebSocketUrl]);

    // Disconnect
    const disconnect = useCallback(() => {
        console.log('[useTtsStreaming] Disconnecting');

        // Clear reconnect timeout
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }

        // Close WebSocket
        if (wsRef.current) {
            // Remove listeners to prevent zombie events
            wsRef.current.onopen = null;
            wsRef.current.onmessage = null;
            wsRef.current.onclose = null;
            wsRef.current.onerror = null;

            wsRef.current.close();
            wsRef.current = null;
        }

        // Stop player
        if (playerRef.current) {
            playerRef.current.stop('user_disconnect');
            playerRef.current = null;
        }

        setIsConnected(false);
        setIsPlaying(false);
        setBufferedMs(0);
    }, []);

    // Send acknowledgment
    const sendAck = useCallback((bufferedMs, underruns) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                type: 'audio.ack',
                bufferedMs,
                underruns
            }));
        }
    }, []);

    // Auto-connect/disconnect based on enabled state
    useEffect(() => {
        if (enabled) {
            connect();
        } else {
            disconnect();
        }

        return () => {
            disconnect();
        };
    }, [enabled, connect, disconnect]);

    // Mid-session language switch — send audio.set_lang without reconnecting
    // When a listener switches their target language while already connected,
    // we notify the server so it updates the registry filter immediately.
    useEffect(() => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (targetLang === serverKnownLangRef.current) return; // No change

        console.log(`[useTtsStreaming] Language switch: ${serverKnownLangRef.current} → ${targetLang}`);
        ws.send(JSON.stringify({
            type: 'audio.set_lang',
            clientId: clientIdRef.current,
            lang: targetLang || null
        }));
        serverKnownLangRef.current = targetLang || null;
    }, [targetLang]);

    // Periodic ACK sending
    useEffect(() => {
        if (!isConnected) return;

        const interval = setInterval(() => {
            const currentStats = playerRef.current?.getStats();
            if (currentStats) {
                sendAck(currentStats.bufferedMs, currentStats.underruns);
            }
        }, 1000);

        return () => clearInterval(interval);
    }, [isConnected, sendAck]);

    return {
        isConnected,
        isPlaying,
        bufferedMs,
        stats,
        connect,
        disconnect
    };
}

export default useTtsStreaming;
