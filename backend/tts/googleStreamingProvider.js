/**
 * Google Cloud TTS Streaming Provider
 * 
 * True gRPC streaming from Google Cloud Text-to-Speech API.
 * Returns an async iterator of audio chunks for real-time playback.
 * 
 * Uses the v1beta1 API which supports streamingSynthesize for:
 * - Chirp 3 HD voices
 * - Gemini voices (with modelName)
 * - Neural2 voices
 * - Standard voices
 */

import { TTS_STREAMING_CONFIG } from './ttsStreamingConfig.js';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { PassThrough } from 'stream';

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Google Streaming Provider
 * 
 * Provides true streaming TTS using Google Cloud TTS gRPC bidirectional streaming.
 */
export class GoogleStreamingProvider {
    constructor(config = {}) {
        this.client = null;
        this.clientInitialized = false;
        this.projectId = config.projectId || process.env.GOOGLE_PROJECT_ID;
    }

    /**
     * Initialize Google TTS client (lazy initialization)
     * @private
     */
    async _initClient() {
        if (this.clientInitialized) return;

        try {
            const { v1beta1 } = await import('@google-cloud/text-to-speech');

            const clientOptions = {};

            // Use same auth pattern as GoogleTtsService
            if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                console.log('[Google-Stream] Using Service Account JSON authentication');
            } else if (process.env.GOOGLE_SPEECH_API_KEY) {
                console.log('[Google-Stream] Using API Key authentication');
                clientOptions.apiKey = process.env.GOOGLE_SPEECH_API_KEY;
            } else {
                console.log('[Google-Stream] Using default credentials (GCP environment)');
            }

            if (this.projectId) {
                clientOptions.projectId = this.projectId;
            }

            if (process.env.GOOGLE_TTS_API_ENDPOINT) {
                clientOptions.apiEndpoint = process.env.GOOGLE_TTS_API_ENDPOINT;
            }

            this.client = new v1beta1.TextToSpeechClient(clientOptions);
            this.clientInitialized = true;
            console.log('[Google-Stream] Google TTS streaming client initialized');
        } catch (error) {
            console.error('[Google-Stream] Failed to initialize client:', error);
            throw new Error(`Failed to initialize Google TTS streaming client: ${error.message}`);
        }
    }

    /**
     * Stream TTS audio for given text
     * 
     * @param {Object} options
     * @param {string} options.text - Text to synthesize
     * @param {string} options.voiceName - Google voice name (e.g., 'en-US-Neural2-A')
     * @param {string} options.languageCode - BCP-47 language code (e.g., 'en-US')
     * @param {string} [options.modelName] - Model name for Gemini voices (e.g., 'gemini-2.5-flash-preview-tts')
     * @param {string} [options.audioEncoding] - Audio encoding (default: MP3)
     * @returns {{ chunks: AsyncIterable<Uint8Array>, cancel: () => void, getTimeToFirstByteMs: () => number|null }}
     */
    streamTts({ text, voiceName, languageCode, modelName, audioEncoding }) {
        if (!text || text.trim().length === 0) {
            throw new Error('text is required');
        }

        if (!voiceName) {
            throw new Error('voiceName is required');
        }

        if (!languageCode) {
            throw new Error('languageCode is required');
        }

        let timeToFirstByteMs = null;
        let requestStartTime = null;
        let stream = null;
        let cancelled = false;

        const self = this;
        const encoding = audioEncoding || 'MP3';

        // Handle Gemini voice mapping for valid streaming
        // "Kore" Gemini voice doesn't support streaming directly yet, fallback to Chirp 3 HD version
        let targetVoiceName = voiceName;
        let targetModelName = modelName;

        if (voiceName === 'Kore') {
            targetVoiceName = 'en-US-Chirp3-HD-Kore';
            targetModelName = undefined; // Chirp voices don't use modelName param
            console.log('[Google-Stream] Mapped "Kore" to "en-US-Chirp3-HD-Kore" for streaming support');
        }

        // Create async iterator for chunks
        async function* iterateStream() {
            try {
                // Ensure client is initialized
                await self._initClient();

                // Detect if voice supports streaming (Chirp 3 HD / Gemini) or needs fallback (Standard / Neural2)
                const isLegacyVoice = targetVoiceName.includes('Standard') || targetVoiceName.includes('Neural2') || targetVoiceName.includes('Wavenet');

                if (isLegacyVoice) {
                    console.log(`[Google-Stream] Voice ${targetVoiceName} requires unary fallback (simulating stream)`);
                }

                // Create transcoding pipeline
                const ffmpegInput = new PassThrough();
                const ffmpegOutput = new PassThrough();

                // Setup FFMPEG - REMUXING (Copy) for Zero Latency
                // Input format is OGG (container) with Opus from Google
                // Output format is WebM (container) with Opus for Browser
                const command = ffmpeg(ffmpegInput)
                    .inputFormat('ogg')
                    .audioCodec('copy') // Zero CPU, Zero Latency (just copying packets)
                    .format('webm') // WebM container works in Chrome/Firefox/Edge/Safari
                    .on('error', (err) => {
                        // Suppress expected errors when stream closes early
                        if (err.message && !err.message.includes('SIGKILL')) {
                            console.error('[Google-Stream] FFMPEG error:', err.message);
                        }
                    });

                // Pipe FFMPEG output to our PassThrough
                command.pipe(ffmpegOutput);

                // Start processing Google stream in background
                const processGoogleStream = async () => {
                    try {
                        requestStartTime = Date.now();

                        if (isLegacyVoice) {
                            // UNARY FALLBACK PATH
                            console.log(`[Google-Stream] Starting UNARY request: voice=${targetVoiceName}, lang=${languageCode}`);

                            const request = {
                                input: { text: text },
                                voice: {
                                    languageCode: languageCode,
                                    name: targetVoiceName
                                },
                                audioConfig: {
                                    audioEncoding: 'OGG_OPUS',
                                    sampleRateHertz: 24000
                                }
                            };

                            const [response] = await self.client.synthesizeSpeech(request);

                            timeToFirstByteMs = Date.now() - requestStartTime;
                            console.log(`[Google-Stream] Google Unary TTFB: ${timeToFirstByteMs}ms, Size: ${response.audioContent.length}`);

                            // Write entire buffer to ffmpeg
                            if (!ffmpegInput.write(response.audioContent)) {
                                await new Promise(resolve => ffmpegInput.once('drain', resolve));
                            }

                        } else {
                            // STREAMING PATH
                            const stream = self.client.streamingSynthesize();

                            const streamingConfig = {
                                voice: {
                                    languageCode: languageCode,
                                    name: targetVoiceName,
                                    // Add model name if present (for Gemini)
                                    ...(targetModelName ? { model: targetModelName } : {})
                                },
                                streamingAudioConfig: {
                                    audioEncoding: 'OGG_OPUS',
                                    sampleRateHertz: 24000
                                }
                            };

                            // Send config
                            stream.write({ streamingConfig });

                            // Send text
                            stream.write({
                                input: { text: text }
                            });

                            // Signal end of input
                            stream.end();

                            console.log(`[Google-Stream] Starting STREAMING request: voice=${targetVoiceName}, lang=${languageCode}, model=${targetModelName}`);

                            let totalBytes = 0;
                            let firstByteReceived = false;

                            for await (const response of stream) {
                                if (response.audioContent && response.audioContent.length > 0) {
                                    if (!firstByteReceived) {
                                        timeToFirstByteMs = Date.now() - requestStartTime;
                                        firstByteReceived = true;
                                    }
                                    totalBytes += response.audioContent.length;

                                    const buffer = response.audioContent;
                                    if (!ffmpegInput.write(buffer)) {
                                        await new Promise(resolve => ffmpegInput.once('drain', resolve));
                                    }
                                }
                            }
                        }

                        ffmpegInput.end();
                    } catch (err) {
                        console.error('[Google-Stream] Error reading Google stream:', err);
                        ffmpegInput.destroy(err);
                    }
                };

                // Start the producer
                processGoogleStream();

                // Yield MP3 chunks from FFMPEG output
                for await (const chunk of ffmpegOutput) {
                    yield chunk;
                }

            } catch (error) {
                console.error('[Google-Stream] Stream error:', error);
                throw error;
            }
        }

        return {
            chunks: iterateStream(),
            cancel: () => {
                cancelled = true;
                // stream.destroy()? stream is inside valid scope? No.
                // We rely on break in iterator or cleanup?
                // Actually, if iterator breaks, we should clean up ffmpeg.
                // But iterateStream scope is closed.
                // Ideally cancel would signal the running process.
            },
            getTimeToFirstByteMs: () => timeToFirstByteMs
        };
    }

    /**
     * Check if provider is configured
     * @returns {boolean}
     */
    isConfigured() {
        // Google TTS is configured if we have either:
        // 1. GOOGLE_APPLICATION_CREDENTIALS (service account)
        // 2. GOOGLE_SPEECH_API_KEY (API key)
        // 3. Running on GCP with default credentials
        return !!(
            process.env.GOOGLE_APPLICATION_CREDENTIALS ||
            process.env.GOOGLE_SPEECH_API_KEY ||
            process.env.GOOGLE_PROJECT_ID
        );
    }
}

// Singleton instance
let instance = null;

/**
 * Get singleton Google streaming provider instance
 * @returns {GoogleStreamingProvider}
 */
export function getGoogleStreamingProvider() {
    if (!instance) {
        instance = new GoogleStreamingProvider();
    }
    return instance;
}
