/**
 * TTS Streaming Transport
 * 
 * WebSocket transport layer for real-time audio streaming.
 * Handles client connections, protocol messages, and binary audio frames.
 */

import { TTS_STREAMING_CONFIG } from './ttsStreamingConfig.js';

// ============================================================================
// Session Registry
// ============================================================================

/**
 * Registry of WebSocket clients per session
 * Structure: { sessionId: Set<{ ws, clientId, capabilities, codec, sampleRate, lang }> }
 * 
 * NOTE: `lang` is the listener's subscribed language (e.g. 'es', 'fr').
 * When set, broadcastAudioFrame and broadcastControl will only send to clients
 * whose lang matches. Clients with lang=null receive all frames (backwards compat).
 */
const ttsWsRegistry = new Map();

/**
 * Register a client for TTS streaming
 * @param {string} sessionId 
 * @param {Object} clientInfo - { ws, clientId, capabilities, codec, sampleRate, lang }
 */
export function registerClient(sessionId, clientInfo) {
    if (!ttsWsRegistry.has(sessionId)) {
        ttsWsRegistry.set(sessionId, new Set());
    }
    ttsWsRegistry.get(sessionId).add(clientInfo);
    console.log(`[TTS-WS] Client ${clientInfo.clientId} registered for session ${sessionId} (lang: ${clientInfo.lang || 'all'})`);
}

/**
 * Unregister a client
 * @param {string} sessionId 
 * @param {Object} clientInfo 
 */
export function unregisterClient(sessionId, clientInfo) {
    const clients = ttsWsRegistry.get(sessionId);
    if (clients) {
        clients.delete(clientInfo);
        if (clients.size === 0) {
            ttsWsRegistry.delete(sessionId);
        }
    }
    console.log(`[TTS-WS] Client ${clientInfo.clientId} unregistered from session ${sessionId}`);
}

/**
 * Update the subscribed language for a registered client.
 * Called when a listener switches language mid-session without reconnecting.
 * 
 * @param {string} sessionId
 * @param {string} clientId
 * @param {string} newLang - New language code (e.g. 'fr', 'es')
 * @returns {boolean} true if the client was found and updated
 */
export function updateClientLang(sessionId, clientId, newLang) {
    const clients = ttsWsRegistry.get(sessionId);
    if (!clients) return false;

    for (const client of clients) {
        if (client.clientId === clientId) {
            const oldLang = client.lang;
            client.lang = newLang || null;
            console.log(`[TTS-WS] Client ${clientId} language updated: ${oldLang || 'all'} → ${newLang || 'all'}`);
            return true;
        }
    }
    return false;
}

/**
 * Get all clients for a session
 * @param {string} sessionId 
 * @returns {Set}
 */
export function getClients(sessionId) {
    return ttsWsRegistry.get(sessionId) || new Set();
}

// ============================================================================
// Binary Frame Encoding/Decoding
// ============================================================================

const FRAME_MAGIC = TTS_STREAMING_CONFIG.binaryFrameMagic; // 'EXA1'
const MAGIC_BYTES = new TextEncoder().encode(FRAME_MAGIC);

/**
 * Encode an audio frame with metadata header
 * Binary format: [4 bytes: "EXA1"][1 byte: headerLen][N bytes: JSON meta][audio bytes]
 * 
 * @param {Object} meta - { streamId, segmentId, version, chunkIndex, isLast }
 * @param {Uint8Array} audioBytes - Raw audio data
 * @returns {Uint8Array} - Complete binary frame
 */
export function encodeAudioFrame(meta, audioBytes) {
    const metaJson = JSON.stringify(meta);
    const metaBytes = new TextEncoder().encode(metaJson);

    if (metaBytes.length > 255) {
        throw new Error('Audio frame metadata too large (max 255 bytes)');
    }

    // Total: 4 (magic) + 1 (headerLen) + N (meta) + audioBytes.length
    const frame = new Uint8Array(5 + metaBytes.length + audioBytes.length);

    // Magic bytes
    frame.set(MAGIC_BYTES, 0);

    // Header length
    frame[4] = metaBytes.length;

    // Metadata JSON
    frame.set(metaBytes, 5);

    // Audio data
    frame.set(audioBytes, 5 + metaBytes.length);

    return frame;
}

/**
 * Decode a binary audio frame
 * @param {Uint8Array} frame - Binary frame data
 * @returns {{ meta: Object, audioBytes: Uint8Array }} - Decoded frame
 */
export function decodeAudioFrame(frame) {
    // Validate magic bytes
    const magic = new TextDecoder().decode(frame.slice(0, 4));
    if (magic !== FRAME_MAGIC) {
        throw new Error(`Invalid frame magic: expected ${FRAME_MAGIC}, got ${magic}`);
    }

    // Get header length
    const headerLen = frame[4];

    // Decode metadata
    const metaBytes = frame.slice(5, 5 + headerLen);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes));

    // Extract audio data
    const audioBytes = frame.slice(5 + headerLen);

    return { meta, audioBytes };
}

// ============================================================================
// Control Message Types
// ============================================================================

export const MessageType = {
    // Client → Server
    HELLO: 'audio.hello',
    SET_LANG: 'audio.set_lang',
    ACK: 'audio.ack',

    // Server → Client
    READY: 'audio.ready',
    START: 'audio.start',
    END: 'audio.end',
    CANCEL: 'audio.cancel',
    ERROR: 'audio.error'
};

/**
 * Create audio.ready message
 */
export function createReadyMessage(streamId, codec, sampleRate, channels = 1) {
    return {
        type: MessageType.READY,
        streamId,
        codec,
        sampleRate,
        channels
    };
}

/**
 * Create audio.start message
 */
export function createStartMessage({ streamId, segmentId, version, seqId, lang, voiceId, textPreview, codec }) {
    return {
        type: MessageType.START,
        streamId,
        segmentId,
        version,
        seqId,
        lang,
        voiceId,
        textPreview: textPreview?.substring(0, 50), // Limit preview length
        codec
    };
}

/**
 * Create audio.end message
 */
export function createEndMessage(streamId, segmentId, version) {
    return {
        type: MessageType.END,
        streamId,
        segmentId,
        version
    };
}

/**
 * Create audio.cancel message
 */
export function createCancelMessage(streamId, reason, segmentId = null) {
    return {
        type: MessageType.CANCEL,
        streamId,
        reason,
        segmentId
    };
}

/**
 * Create audio.error message
 */
export function createErrorMessage(streamId, errorCode, message) {
    return {
        type: MessageType.ERROR,
        streamId,
        errorCode,
        message
    };
}

// ============================================================================
// Broadcast Helpers
// ============================================================================

/**
 * Broadcast a JSON control message to clients in a session.
 * If `lang` is provided, only sends to clients subscribed to that language
 * (or clients with no language set, for backwards compatibility).
 * 
 * @param {string} sessionId 
 * @param {Object} message 
 * @param {string|null} [lang] - Optional language filter (e.g. 'es')
 */
export function broadcastControl(sessionId, message, lang = null) {
    const clients = getClients(sessionId);
    const json = JSON.stringify(message);
    let sentCount = 0;

    for (const client of clients) {
        // Send if: no language filter, client has no language, or languages match
        if (!lang || !client.lang || client.lang === lang) {
            if (client.ws.readyState === 1) { // WebSocket.OPEN
                client.ws.send(json);
                sentCount++;
            }
        }
    }

    return sentCount;
}

/**
 * Broadcast a binary audio frame to clients in a session.
 * If `lang` is provided, only sends to clients subscribed to that language
 * (or clients with no language set, for backwards compatibility).
 * 
 * @param {string} sessionId 
 * @param {Uint8Array} frameBytes
 * @param {string|null} [lang] - Optional language filter (e.g. 'es')
 */
export function broadcastAudioFrame(sessionId, frameBytes, lang = null) {
    const clients = getClients(sessionId);
    let sentCount = 0;

    for (const client of clients) {
        // Send if: no language filter, client has no language, or languages match
        if (!lang || !client.lang || client.lang === lang) {
            if (client.ws.readyState === 1) { // WebSocket.OPEN
                client.ws.send(frameBytes);
                sentCount++;
            }
        }
    }

    return sentCount;
}

// ============================================================================
// WebSocket Message Handler
// ============================================================================

/**
 * Handle incoming WebSocket message for TTS streaming
 * @param {WebSocket} ws - WebSocket connection
 * @param {string} sessionId - Session ID
 * @param {Buffer|string} data - Incoming message data
 * @param {Object} handlers - { onAck: (ackData) => void, onSetLang: (clientId, lang) => void }
 * @returns {Object|null} - Parsed message or null if binary
 */
export function handleMessage(ws, sessionId, data, handlers = {}) {
    // Handle string messages (JSON control messages)
    if (typeof data === 'string' || data instanceof Buffer) {
        try {
            const message = JSON.parse(data.toString());

            switch (message.type) {
                case MessageType.HELLO:
                    return handleHello(ws, sessionId, message);

                case MessageType.SET_LANG:
                    if (handlers.onSetLang) {
                        handlers.onSetLang(message.clientId, message.lang);
                    }
                    return message;

                case MessageType.ACK:
                    if (handlers.onAck) {
                        handlers.onAck(message);
                    }
                    return message;

                default:
                    console.warn(`[TTS-WS] Unknown message type: ${message.type}`);
                    return message;
            }
        } catch (err) {
            console.error('[TTS-WS] Failed to parse message:', err);
            return null;
        }
    }

    return null;
}

/**
 * Handle audio.hello message
 */
function handleHello(ws, sessionId, message) {
    const { clientId, capabilities, desiredCodec, desiredSampleRate, targetLang } = message;

    // Choose codec based on capabilities and config
    let codec = TTS_STREAMING_CONFIG.defaultCodec;
    let sampleRate = TTS_STREAMING_CONFIG.defaultSampleRate;

    // If client supports PCM and we want PCM, use it (future enhancement)
    // For now, always use MP3 (Creator plan compatibility)
    if (desiredCodec === 'mp3' || capabilities?.mp3) {
        codec = 'mp3';
        sampleRate = desiredSampleRate || 44100;
    }

    // Register the client, storing their subscribed language
    const clientInfo = {
        ws,
        clientId,
        capabilities,
        codec,
        sampleRate,
        lang: targetLang || null  // null = receive all languages (backwards compat)
    };
    registerClient(sessionId, clientInfo);

    // Generate stream ID
    const streamId = `${sessionId}:${Date.now()}`;

    // Send ready message
    const readyMsg = createReadyMessage(streamId, codec, sampleRate);
    ws.send(JSON.stringify(readyMsg));

    console.log(`[TTS-WS] Client ${clientId} ready: codec=${codec}, sampleRate=${sampleRate}, lang=${targetLang || 'all'}`);

    // Store streamId on client for later reference
    clientInfo.streamId = streamId;

    return { ...message, streamId, codec, sampleRate };
}

// ============================================================================
// Metrics Tracking
// ============================================================================

const metrics = {
    segmentLatencies: [],
    underruns: 0,
    bytesSent: 0
};

/**
 * Record time-to-first-audio for a segment
 */
export function recordFirstAudioLatency(segmentId, latencyMs) {
    metrics.segmentLatencies.push({ segmentId, latencyMs, timestamp: Date.now() });
    // console.log(`[TTS-WS] Time to first audio for ${segmentId}: ${latencyMs}ms`);

    // Keep only last 100 entries
    if (metrics.segmentLatencies.length > 100) {
        metrics.segmentLatencies.shift();
    }
}

/**
 * Record bytes sent
 */
export function recordBytesSent(bytes) {
    metrics.bytesSent += bytes;
}

/**
 * Get current metrics
 */
export function getMetrics() {
    return { ...metrics };
}
