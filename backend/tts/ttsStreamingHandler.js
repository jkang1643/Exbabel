/**
 * TTS Streaming WebSocket Handler
 * 
 * Handles WebSocket connections for real-time TTS audio streaming.
 * Integrates with ttsStreamingTransport for protocol and registry management.
 */

import { URL } from 'url';
import {
    registerClient,
    unregisterClient,
    updateClientLang,
    handleMessage,
    MessageType
} from './ttsStreamingTransport.js';
import { isStreamingEnabled } from './ttsStreamingConfig.js';

/**
 * Handle a new TTS streaming WebSocket connection
 * @param {WebSocket} ws - WebSocket connection
 * @param {Request} req - HTTP request
 */
export function handleTtsStreamingConnection(ws, req) {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
        console.error('[TTS-WS] Connection rejected: missing sessionId');
        ws.close(4001, 'Missing sessionId parameter');
        return;
    }

    // Check if streaming is enabled
    if (!isStreamingEnabled()) {
        console.warn('[TTS-WS] Connection rejected: streaming not enabled');
        ws.close(4002, 'TTS streaming is not enabled');
        return;
    }

    console.log(`[TTS-WS] New connection for session ${sessionId}`);

    // Client info placeholder (will be populated on audio.hello)
    let clientInfo = null;

    // Handle incoming messages
    ws.on('message', (data) => {
        try {
            const result = handleMessage(ws, sessionId, data, {
                onAck: (ackData) => {
                    // Log buffer status from client
                    if (ackData.bufferedMs !== undefined) {
                        console.log(`[TTS-WS] Client ack: bufferedMs=${ackData.bufferedMs}, underruns=${ackData.underruns || 0}`);
                    }
                },
                onSetLang: (clientId, newLang) => {
                    // Listener is switching languages mid-session (no reconnect needed)
                    const updated = updateClientLang(sessionId, clientId, newLang);
                    if (updated) {
                        console.log(`[TTS-WS] Language switch: session=${sessionId}, client=${clientId}, newLang=${newLang}`);
                        // Also update local clientInfo ref so close handler has accurate state
                        if (clientInfo && clientInfo.clientId === clientId) {
                            clientInfo.lang = newLang || null;
                        }
                    } else {
                        console.warn(`[TTS-WS] audio.set_lang: client ${clientId} not found in session ${sessionId}`);
                    }
                }
            });

            // If this was a hello message, store client info
            if (result && result.type === MessageType.HELLO) {
                clientInfo = {
                    ws,
                    clientId: result.clientId,
                    capabilities: result.capabilities,
                    codec: result.codec,
                    sampleRate: result.sampleRate,
                    streamId: result.streamId,
                    lang: result.targetLang || null
                };
            }
        } catch (err) {
            console.error('[TTS-WS] Error handling message:', err);
        }
    });

    // Handle connection close
    ws.on('close', (code, reason) => {
        const clientDesc = clientInfo ? `Client ${clientInfo.clientId} (lang: ${clientInfo.lang || 'all'})` : 'Unknown Client (no hello)';
        console.log(`[TTS-WS] Connection closed for session ${sessionId}: ${code} ${reason} [${clientDesc}]`);
        if (clientInfo) {
            unregisterClient(sessionId, clientInfo);
        }
    });

    // Handle errors
    ws.on('error', (err) => {
        console.error(`[TTS-WS] WebSocket error for session ${sessionId}:`, err);
    });
}
