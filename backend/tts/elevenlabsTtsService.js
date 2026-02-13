/**
 * ElevenLabs TTS Service
 * 
 * Implements unary TTS synthesis using ElevenLabs API.
 * Uses the existing TtsService interface for drop-in compatibility.
 */

import { TtsService } from './baseTtsService.js';
import { TtsErrorCode, TtsEncoding, getMimeType } from './tts.types.js';
import { getElevenLabsModelCapabilities } from './ttsRouting.js';
import { normalizePunctuation } from '../transcriptionCleanup.js';

/**
 * Build voice_settings object based on model capabilities
 * Only includes supported parameters for the given tier, with proper validation
 * @param {string} tier - ElevenLabs tier (elevenlabs_v3, elevenlabs_turbo, etc.)
 * @param {object} userSettings - User-provided settings
 * @returns {object|undefined} Sanitized voice_settings or undefined if empty
 */
function buildVoiceSettings(tier, userSettings = {}) {
    const caps = getElevenLabsModelCapabilities(tier);
    if (!caps) {
        // Not an ElevenLabs tier, return undefined
        return undefined;
    }

    const out = {};

    // Helper to clamp value to range
    const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

    // Add each supported setting with validation
    if (caps.supports.stability && userSettings.stability != null) {
        const [min, max] = caps.ranges.stability;
        out.stability = clamp(userSettings.stability, min, max);
    }

    if (caps.supports.similarity_boost && userSettings.similarityBoost != null) {
        const [min, max] = caps.ranges.similarity_boost;
        out.similarity_boost = clamp(userSettings.similarityBoost, min, max);
    }

    if (caps.supports.style && userSettings.style != null) {
        const [min, max] = caps.ranges.style;
        out.style = clamp(userSettings.style, min, max);
    }

    if (caps.supports.use_speaker_boost && userSettings.useSpeakerBoost != null) {
        out.use_speaker_boost = !!userSettings.useSpeakerBoost;
    }

    if (caps.supports.speed && userSettings.speed != null) {
        const [min, max] = caps.ranges.speed;
        out.speed = clamp(userSettings.speed, min, max);
    }

    return Object.keys(out).length > 0 ? out : undefined;
}


/**
 * ElevenLabs TTS Service Class
 * 
 * Provides text-to-speech synthesis via ElevenLabs API.
 * Compatible with the existing unary synthesis pipeline.
 */
export class ElevenLabsTtsService extends TtsService {
    constructor({
        apiKey = process.env.ELEVENLABS_API_KEY,
        defaultVoiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID,
        modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
        outputFormat = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128',
        baseUrl = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io'
    } = {}) {
        super();
        this.apiKey = apiKey;
        this.defaultVoiceId = defaultVoiceId;
        this.modelId = modelId;
        this.outputFormat = outputFormat;
        this.baseUrl = baseUrl;
    }

    /**
     * Synthesize speech in unary mode using ElevenLabs API
     * 
     * @param {TtsRequest} request - TTS request with text and profile
     * @param {Object} [preResolvedRoute] - Optional pre-resolved route from resolveTtsRoute
     * @returns {Promise<TtsUnaryResponseWithRoute>}
     */
    async synthesizeUnary(request, preResolvedRoute = null) {
        const startTime = Date.now();

        try {
            // Validate request
            const validationError = this._validateRequest(request);
            if (validationError) {
                throw new Error(JSON.stringify({
                    code: TtsErrorCode.INVALID_REQUEST,
                    message: validationError
                }));
            }

            let text = (request.text || '').trim();
            // Normalize punctuation before synthesis
            text = normalizePunctuation(text);
            if (!text) {
                throw new Error(JSON.stringify({
                    code: TtsErrorCode.INVALID_REQUEST,
                    message: 'Empty text provided for synthesis'
                }));
            }

            // Check API key
            if (!this.apiKey) {
                throw new Error(JSON.stringify({
                    code: 'TTS_ELEVENLABS_CONFIG_ERROR',
                    message: 'Missing ELEVENLABS_API_KEY environment variable'
                }));
            }

            // Resolve voice ID from route or request
            let voiceId = this.defaultVoiceId;
            if (preResolvedRoute && preResolvedRoute.voiceName) {
                // Voice name from routing may be the full voice ID or a prefixed name
                voiceId = this._resolveVoiceId(preResolvedRoute.voiceName);
            } else if (request.profile && request.profile.voiceName) {
                voiceId = this._resolveVoiceId(request.profile.voiceName);
            }

            if (!voiceId) {
                throw new Error(JSON.stringify({
                    code: 'TTS_ELEVENLABS_CONFIG_ERROR',
                    message: 'No voice ID configured. Set ELEVENLABS_DEFAULT_VOICE_ID or provide a voice in the request.'
                }));
            }

            // Build API URL
            const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(this.outputFormat)}`;

            // Build request body
            const modelId = (preResolvedRoute && preResolvedRoute.model) || this.modelId;
            const body = {
                text: text,
                model_id: modelId
            };

            // Optional: Add language code hint if available
            if (request.profile && request.profile.languageCode) {
                body.language_code = this._mapLanguageCode(request.profile.languageCode);
            }

            // Add voice settings based on tier capabilities
            // Only includes supported parameters for this model tier
            let tier = preResolvedRoute?.tier || 'elevenlabs';
            let voiceSettings = buildVoiceSettings(
                tier,
                request.elevenLabsSettings
            );

            // Injected Fix: Default to 0.85x speed for V2/Flash/Turbo tiers if not specified
            // to correct for accelerated native playback ("chipmunk effect")
            const modelIdLower = modelId.toLowerCase();
            if ((modelIdLower.includes('flash') || modelIdLower.includes('turbo') || modelIdLower.includes('v2')) &&
                (!voiceSettings || voiceSettings.speed === undefined)) {
                console.log(`[ElevenLabs TTS] Injecting default speed 0.85 for model: ${modelId}`);
                voiceSettings = voiceSettings || {};
                voiceSettings.speed = 0.85;
            }

            // Only add voice_settings to body if we have any supported settings
            if (voiceSettings) {
                body.voice_settings = voiceSettings;
                console.log(`[ElevenLabs TTS] Using voice_settings for tier ${preResolvedRoute.tier}:`, voiceSettings);
            }

            console.log(`[ElevenLabs TTS] Synthesizing: voiceId=${voiceId}, model=${modelId}, text="${text.substring(0, 50)}..."`);

            // Make API request with retry logic
            let response;
            let lastError;
            const maxRetries = 1;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    response = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'xi-api-key': this.apiKey
                        },
                        body: JSON.stringify(body)
                    });

                    if (response.ok) {
                        break; // Success, exit retry loop
                    }

                    const errorText = await this._safeReadText(response);
                    lastError = {
                        status: response.status,
                        message: errorText || response.statusText
                    };

                    // Only retry on transient errors (5xx, rate limits)
                    if (!this._isRetryableError(response.status) || attempt >= maxRetries) {
                        throw new Error(JSON.stringify({
                            code: 'TTS_ELEVENLABS_API_ERROR',
                            message: `ElevenLabs API error ${response.status}: ${lastError.message}`,
                            details: { status: response.status }
                        }));
                    }

                    console.log(`[ElevenLabs TTS] Retrying after error ${response.status}...`);
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));

                } catch (fetchError) {
                    if (fetchError.message && fetchError.message.startsWith('{')) {
                        throw fetchError; // Re-throw structured errors
                    }

                    lastError = fetchError;
                    if (attempt >= maxRetries) {
                        throw new Error(JSON.stringify({
                            code: 'TTS_ELEVENLABS_API_ERROR',
                            message: `Network error: ${fetchError.message}`,
                            details: { originalError: fetchError.message }
                        }));
                    }

                    console.log(`[ElevenLabs TTS] Retrying after network error: ${fetchError.message}`);
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                }
            }

            // Read audio bytes
            const arrayBuffer = await response.arrayBuffer();
            const audioBase64 = Buffer.from(arrayBuffer).toString('base64');

            // Extract metadata from headers
            const requestId = response.headers.get('request-id') || null;
            const characterCount = response.headers.get('x-character-count') || null;

            const elapsedMs = Date.now() - startTime;
            console.log(`[ElevenLabs TTS] Synthesis complete in ${elapsedMs}ms, chars=${characterCount}, requestId=${requestId}`);

            // Determine MIME type from output format
            const mimeType = this._getMimeTypeFromFormat(this.outputFormat);

            // Build response matching GoogleTtsService format
            return {
                segmentId: request.segmentId,
                audio: {
                    bytesBase64: audioBase64,
                    mimeType: mimeType,
                    durationMs: null, // ElevenLabs doesn't return duration in response
                    sampleRateHz: this._getSampleRateFromFormat(this.outputFormat)
                },
                mode: 'unary',
                route: {
                    provider: 'elevenlabs',
                    ...(preResolvedRoute || {}),
                    tier: preResolvedRoute?.tier || 'elevenlabs',
                    voiceName: voiceId,
                    languageCode: request.profile?.languageCode || 'en-US'
                },
                providerMeta: {
                    requestId,
                    characterCount,
                    elapsedMs
                }
            };

        } catch (error) {
            let message = error.message;
            try {
                // Try to parse if it's already a JSON string from our own checks
                const parsed = JSON.parse(message);
                message = parsed.message || message;
            } catch (e) {
                // Not JSON, use as is
            }
            console.error('[ElevenLabs TTS] Synthesis failed:', message);
            throw error;
        }
    }

    /**
     * Resolve voice ID from various input formats
     * @private
     */
    _resolveVoiceId(voiceName) {
        if (!voiceName) return null;

        // If it has the elevenlabs- prefix, strip it
        if (voiceName.startsWith('elevenlabs-')) {
            return voiceName.substring(11); // Remove 'elevenlabs-' prefix
        }

        // Otherwise use as-is (could be a raw voice ID)
        return voiceName;
    }

    /**
     * Map BCP-47 language code to ElevenLabs supported format
     * @private
     */
    _mapLanguageCode(languageCode) {
        if (!languageCode) return 'en';

        // Normalize to lowercase for mapping
        const code = languageCode.toLowerCase();

        // Specific mappings for known problematic codes
        const manualMap = {
            'cmn-cn': 'zh',
            'zh-cn': 'zh',
            'cmn-tw': 'zh',
            'zh-tw': 'zh',
            'cmn': 'zh',
            'yue-hk': 'zh',
            'yue': 'zh',
            'fil-ph': 'fil',
            'fil': 'fil'
        };

        if (manualMap[code]) {
            return manualMap[code];
        }

        // ElevenLabs generally prefers ISO 639-1 (2-letter) codes
        // But some models like v3 support 3-letter codes
        // For most languages, taking the first 2 letters works (en-US -> en)
        // but we must be careful not to truncate 3-letter codes that are already correct
        if (code.length === 3) {
            return code;
        }

        // Default: strip region and take first 2 letters
        return code.split('-')[0].substring(0, 2);
    }

    /**
     * Get MIME type from ElevenLabs output format
     * @private
     */
    _getMimeTypeFromFormat(format) {
        if (format.startsWith('mp3_')) {
            return 'audio/mpeg';
        } else if (format.startsWith('pcm_')) {
            return 'audio/pcm';
        } else if (format.startsWith('ulaw_')) {
            return 'audio/mulaw';
        } else if (format.startsWith('alaw_')) {
            return 'audio/alaw';
        } else if (format.startsWith('opus_')) {
            return 'audio/ogg';
        }
        return 'audio/mpeg'; // Default to MP3
    }

    /**
     * Get sample rate from ElevenLabs output format
     * @private
     */
    _getSampleRateFromFormat(format) {
        const match = format.match(/_(\d+)/);
        if (match) {
            return parseInt(match[1], 10);
        }
        return 44100; // Default
    }

    /**
     * Check if error status is retryable
     * @private
     */
    _isRetryableError(status) {
        // Retry on 5xx server errors and 429 rate limits
        return status >= 500 || status === 429;
    }

    /**
     * Safely read response text
     * @private
     */
    async _safeReadText(response) {
        try {
            return await response.text();
        } catch {
            return '';
        }
    }
}
