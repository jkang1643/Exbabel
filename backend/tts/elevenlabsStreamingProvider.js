/**
 * ElevenLabs Streaming Provider
 * 
 * True HTTP streaming from ElevenLabs TTS API.
 * Returns an async iterator of audio chunks for real-time playback.
 */

import { TTS_STREAMING_CONFIG } from './ttsStreamingConfig.js';

/**
 * ElevenLabs Streaming Provider
 * 
 * Provides true streaming TTS using ElevenLabs HTTP streaming endpoint.
 */
export class ElevenLabsStreamingProvider {
    constructor(config = {}) {
        this.apiKey = config.apiKey || process.env.ELEVENLABS_API_KEY;
        this.baseUrl = config.baseUrl || 'https://api.elevenlabs.io/v1';
        this.defaultModelId = config.modelId || 'eleven_multilingual_v2';
        this.defaultOutputFormat = config.outputFormat || TTS_STREAMING_CONFIG.outputFormat;
    }

    /**
     * Stream TTS audio for given text
     * 
     * @param {Object} options
     * @param {string} options.text - Text to synthesize
     * @param {string} options.voiceId - ElevenLabs voice ID
     * @param {string} [options.modelId] - Model ID (default: eleven_multilingual_v2)
     * @param {string} [options.outputFormat] - Output format (default: mp3_44100_128)
     * @param {Object} [options.voiceSettings] - Optional voice settings
     * @returns {{ chunks: AsyncIterable<Uint8Array>, cancel: () => void, getTimeToFirstByteMs: () => number|null }}
     */
    streamTts({ text, voiceId, modelId, outputFormat, voiceSettings }) {
        if (!this.apiKey) {
            throw new Error('ELEVENLABS_API_KEY not configured');
        }

        if (!voiceId) {
            throw new Error('voiceId is required');
        }

        if (!text || text.trim().length === 0) {
            throw new Error('text is required');
        }

        const controller = new AbortController();
        let timeToFirstByteMs = null;
        let requestStartTime = null;

        const url = `${this.baseUrl}/text-to-speech/${voiceId}/stream`;
        const model = modelId || this.defaultModelId;

        let format = outputFormat || this.defaultOutputFormat;

        // Force 22.05kHz for Flash/Turbo models to prevent "chipmunk" speed issues
        // The speed parameter failed to fix it, confirming this is a sample rate mismatch.
        // Playing 44.1kHz requested audio that is actually 22kHz results in 2x speed (chipmunk).
        if (model.includes('flash') || model.includes('turbo') || model.includes('v2')) {
            console.log(`[ElevenLabs-Stream] Forcing mp3_22050_32 for model: ${model}`);
            format = 'mp3_22050_32';
        }

        // Build request body
        const body = {
            text: text,
            model_id: model,
            output_format: format
        };

        if (voiceSettings) {
            body.voice_settings = voiceSettings;
        }

        const self = this;

        // Create async iterator for chunks
        async function* iterateStream() {
            requestStartTime = Date.now();

            console.log(`[ElevenLabs-Stream] Starting request: voice=${voiceId}, model=${model}, format=${format}, textLen=${text.length}`);

            let response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'xi-api-key': self.apiKey,
                        'Accept': 'audio/mpeg'
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
            } catch (err) {
                if (err.name === 'AbortError') {
                    console.log('[ElevenLabs-Stream] Request aborted');
                    return;
                }
                throw err;
            }

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unknown error');
                throw new Error(`ElevenLabs API error ${response.status}: ${errorText}`);
            }

            const reader = response.body.getReader();
            let isFirstChunk = true;
            let totalBytes = 0;

            try {
                while (true) {
                    const { done, value } = await reader.read();

                    if (done) {
                        console.log(`[ElevenLabs-Stream] Stream complete: ${totalBytes} bytes, TTFB=${timeToFirstByteMs}ms`);
                        break;
                    }

                    if (isFirstChunk) {
                        timeToFirstByteMs = Date.now() - requestStartTime;
                        console.log(`[ElevenLabs-Stream] Time to first byte: ${timeToFirstByteMs}ms`);
                        isFirstChunk = false;
                    }

                    totalBytes += value.length;
                    yield value;
                }
            } finally {
                reader.releaseLock();
            }
        }

        return {
            chunks: iterateStream(),
            cancel: () => {
                console.log('[ElevenLabs-Stream] Cancelling request');
                controller.abort();
            },
            getTimeToFirstByteMs: () => timeToFirstByteMs
        };
    }

    /**
     * Check if provider is configured
     * @returns {boolean}
     */
    isConfigured() {
        return !!this.apiKey;
    }
}

// Singleton instance
let instance = null;

/**
 * Get singleton ElevenLabs streaming provider instance
 * @returns {ElevenLabsStreamingProvider}
 */
export function getElevenLabsStreamingProvider() {
    if (!instance) {
        instance = new ElevenLabsStreamingProvider();
    }
    return instance;
}
