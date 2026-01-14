/**
 * TTS Service Abstraction
 * 
 * Provides unified interface for TTS synthesis supporting both unary (batch)
 * and streaming modes. Actual Google TTS integration in PR2.
 * 
 * PR1: Stub implementation with correct signatures
 * PR2: Google TTS API integration
 * PR4: SSML support for Chirp 3 HD voices
 */

import { TtsErrorCode, TtsMode, TtsEngine, TtsEncoding, validateTtsProfile } from './tts.types.js';
import { resolveTtsRoute, validateResolvedRoute } from './ttsRouting.js';
import { generateTtsInput, supportsSSML } from './ssmlBuilder.js';

/**
 * TTS Service Class
 * 
 * Handles text-to-speech synthesis with support for both unary and streaming modes.
 */
export class TtsService {
    constructor(config = {}) {
        this.config = {
            provider: config.provider || process.env.TTS_PROVIDER || 'google',
            playingLeaseSeconds: parseInt(config.playingLeaseSeconds || process.env.TTS_PLAYING_LEASE_SECONDS || '30', 10)
        };
    }

    /**
     * Synthesize speech in unary mode (batch)
     * Returns one complete audio file for the entire text.
     *
     * @param {TtsRequest} request - TTS request
     * @returns {Promise<TtsUnaryResponseWithRoute>}
     * @throws {Error} If synthesis fails or is not implemented
     */
    async synthesizeUnary(request) {
        // Validate request
        this._validateRequest(request);
        validateTtsProfile(request.profile);

        console.log(`[TtsService] Synthesizing unary: ${request.text.length} chars, engine: ${request.profile.engine}, lang: ${request.profile.languageCode}`);

        // This is the base class - should be overridden by GoogleTtsService
        throw new Error(JSON.stringify({
            code: TtsErrorCode.NOT_IMPLEMENTED,
            message: 'TTS unary synthesis not implemented in base class',
            details: {
                request: {
                    sessionId: request.sessionId,
                    engine: request.profile.engine,
                    languageCode: request.profile.languageCode,
                    voiceName: request.profile.voiceName,
                    textLength: request.text?.length || 0
                }
            }
        }));
    }

    /**
     * Synthesize speech in streaming mode
     * Calls onChunk callback for each audio chunk as it becomes available.
     * 
     * @param {TtsRequest} request - TTS request
     * @param {Function} onChunk - Callback function(chunk: TtsStreamChunk)
     * @returns {Promise<void>}
     * @throws {Error} If synthesis fails or is not implemented
     */
    async synthesizeStream(request, onChunk) {
        // Validate request
        this._validateRequest(request);
        validateTtsProfile(request.profile);

        // PR1: Stub implementation
        throw new Error(JSON.stringify({
            code: TtsErrorCode.NOT_IMPLEMENTED,
            message: 'TTS streaming synthesis not implemented yet (PR2)',
            details: {
                request: {
                    sessionId: request.sessionId,
                    engine: request.profile.engine,
                    languageCode: request.profile.languageCode,
                    voiceName: request.profile.voiceName,
                    textLength: request.text?.length || 0
                }
            }
        }));
    }

    /**
     * Validate basic request fields
     * @private
     */
    _validateRequest(request) {
        if (!request.text || request.text.length === 0) {
            throw new Error(JSON.stringify({
                code: TtsErrorCode.INVALID_REQUEST,
                message: 'Text is required and must not be empty',
                details: { request }
            }));
        }
    }

    /**
     * Get MIME type for audio format
     * @protected
     */
    _getMimeType(encoding) {
        const mimeTypes = {
            [TtsEncoding.MP3]: 'audio/mpeg',
            [TtsEncoding.OGG_OPUS]: 'audio/ogg',
            [TtsEncoding.LINEAR16]: 'audio/wav',
            [TtsEncoding.ALAW]: 'audio/alaw',
            [TtsEncoding.MULAW]: 'audio/mulaw',
            [TtsEncoding.PCM]: 'audio/pcm'
        };
        return mimeTypes[encoding] || 'application/octet-stream';
    }
}

/**
 * Google TTS Service (extends TtsService)
 */
export class GoogleTtsService extends TtsService {
    constructor(config = {}) {
        super(config);
        this.client = null;
        this.clientInitialized = false;
        this.voicesCache = null;
        this.voicesCacheTimestamp = null;
        this.voicesCacheExpiryMs = 24 * 60 * 60 * 1000; // 24 hours
    }

    /**
     * Initialize Google TTS client
     * @private
     */
    async _initClient() {
        if (this.clientInitialized) return;

        try {
            const { v1beta1 } = await import('@google-cloud/text-to-speech');

            const clientOptions = {};

            // Prioritize Service Account JSON for advanced voice support (Gemini/Chirp/Studio)
            if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                console.log('[GoogleTtsService] Using Service Account JSON authentication');
                // The client library automatically picks up the path from process.env.GOOGLE_APPLICATION_CREDENTIALS
            } else if (process.env.GOOGLE_SPEECH_API_KEY) {
                console.log('[GoogleTtsService] Using API Key authentication (Note: Advanced voices may fail)');
                clientOptions.apiKey = process.env.GOOGLE_SPEECH_API_KEY;
            } else {
                console.log('[GoogleTtsService] Using default credentials (GCP environment)');
            }

            // Support explicit project ID and API endpoint for advanced voices/Vertex AI
            if (process.env.GOOGLE_PROJECT_ID) {
                clientOptions.projectId = process.env.GOOGLE_PROJECT_ID;
                console.log(`[GoogleTtsService] Using explicit Project ID: ${process.env.GOOGLE_PROJECT_ID}`);
            }
            if (process.env.GOOGLE_TTS_API_ENDPOINT) {
                clientOptions.apiEndpoint = process.env.GOOGLE_TTS_API_ENDPOINT;
                console.log(`[GoogleTtsService] Using explicit API Endpoint: ${process.env.GOOGLE_TTS_API_ENDPOINT}`);
            }

            this.client = new v1beta1.TextToSpeechClient(clientOptions);
            this.clientInitialized = true;
            console.log('[GoogleTtsService] Google TTS client initialized');
        } catch (error) {
            console.error('[GoogleTtsService] Failed to initialize Google TTS client:', error);
            throw new Error(`Failed to initialize Google TTS client: ${error.message}`);
        }
    }

    /**
     * List all available voices from Google TTS API
     * @returns {Promise<Array>} Array of voice objects
     */
    async listVoices() {
        await this._initClient();

        try {
            const [result] = await this.client.listVoices({});
            return result.voices || [];
        } catch (error) {
            console.error('[GoogleTtsService] Failed to list voices:', error);
            throw new Error(`Failed to list voices: ${error.message}`);
        }
    }

    /**
     * Get cached voices or fetch from API
     * @returns {Promise<Array>} Array of voice objects
     */
    async getVoices() {
        // Check if cache is valid
        if (this.voicesCache &&
            this.voicesCacheTimestamp &&
            (Date.now() - this.voicesCacheTimestamp) < this.voicesCacheExpiryMs) {
            return this.voicesCache;
        }

        console.log('[GoogleTtsService] Fetching voices from Google TTS API...');
        const voices = await this.listVoices();

        // Cache the results
        this.voicesCache = voices;
        this.voicesCacheTimestamp = Date.now();

        console.log(`[GoogleTtsService] Cached ${voices.length} voices from Google TTS API`);
        return voices;
    }

    /**
     * Find available voices for a language and tier
     * @param {string} languageCode - BCP-47 language code
     * @param {string} tier - Tier to filter by (neural2, standard, gemini, chirp3_hd)
     * @returns {Promise<Array>} Array of matching voice names
     */
    async findVoicesForLanguageAndTier(languageCode, tier) {
        try {
            const allVoices = await this.getVoices();

            const filteredVoices = allVoices
                .filter(voice => {
                    // Filter by language
                    if (voice.languageCodes && !voice.languageCodes.includes(languageCode)) {
                        return false;
                    }

                    // Filter by tier - use voice name patterns
                    const voiceName = voice.name || '';

                    switch (tier) {
                        case 'gemini':
                            // Gemini voices have special names (Kore, Puck, Charon, Leda, etc.)
                            // These are typically just the voice name without locale prefix
                            return !voiceName.includes('-') && (
                                voiceName.includes('Kore') ||
                                voiceName.includes('Puck') ||
                                voiceName.includes('Charon') ||
                                voiceName.includes('Leda') ||
                                voiceName.includes('Aoede') ||
                                voiceName.includes('Fenrir')
                            );

                        case 'chirp3_hd':
                            // Chirp 3 HD voices contain "Chirp3", "Chirp_3", or "Chirp-3"
                            return voiceName.includes('Chirp3') ||
                                voiceName.includes('Chirp_3') ||
                                voiceName.includes('Chirp-3');

                        case 'neural2':
                            // Neural2 voices contain "Neural2" but not Chirp (to avoid overlap)
                            return voiceName.includes('Neural2') &&
                                !voiceName.includes('Chirp');

                        case 'standard':
                            // Standard voices contain "Standard" and don't contain Neural2/Chirp/Wavenet
                            return voiceName.includes('Standard') &&
                                !voiceName.includes('Neural2') &&
                                !voiceName.includes('Chirp') &&
                                !voiceName.includes('Wavenet');

                        default:
                            return true;
                    }
                })
                .map(voice => voice.name)
                .sort();

            if (filteredVoices.length > 0) {
                console.log(`[GoogleTtsService] Found ${filteredVoices.length} ${tier} voices for ${languageCode}:`, filteredVoices.slice(0, 3), filteredVoices.length > 3 ? '...' : '');
                return filteredVoices;
            }
        } catch (error) {
            console.warn(`[GoogleTtsService] Failed to discover voices for ${languageCode}:${tier}:`, error.message);
        }

        // Fallback: return empty array so routing uses hardcoded fallbacks
        console.log(`[GoogleTtsService] No ${tier} voices found for ${languageCode}, using fallbacks`);
        return [];
    }

    /**
     * Convert engine enum to tier string
     * @private
     */
    _tierFromEngine(engine) {
        switch (engine) {
            case TtsEngine.GEMINI_TTS: return 'gemini';
            case TtsEngine.CHIRP3_HD: return 'chirp3_hd';
            default: return 'neural2';
        }
    }

    /**
     * Build Google TTS request from resolved route
     * @private
     */
    async _buildGoogleRequestFromRoute(request, route) {
        const { text, ssmlOptions, ttsPrompt, promptPresetId, intensity } = request;

        // Import prompt resolver (dynamic to avoid circular deps)
        const { resolvePrompt } = await import('./promptResolver.js');

        // Determine if this is a Gemini-TTS request
        const isGeminiTts = route.engine === TtsEngine.GEMINI_TTS ||
            (route.model && route.model.startsWith('gemini-'));

        // Generate SSML input if applicable
        let inputContent = text;
        let inputType = 'text';
        let stylePrompt = null;

        if (ssmlOptions && ssmlOptions.enabled && supportsSSML(route.voiceName, route.tier)) {
            console.log('[GoogleTtsService] Generating SSML for Chirp 3 HD voice');

            // DEBUG: Check tier and pitch logic
            const targetPitch = ssmlOptions.pitch;
            console.log(`[GoogleTtsService] DEBUG: tier='${route.tier}', originalPitch='${ssmlOptions.pitch}', targetPitch=${targetPitch}`);

            const ssmlResult = generateTtsInput(text, {
                voiceName: route.voiceName,
                tier: route.tier,
                languageCode: route.languageCode,
                deliveryStyle: ssmlOptions.deliveryStyle || 'standard_preaching',
                ssmlOptions: {
                    rate: ssmlOptions.rate ? `${ssmlOptions.rate * 100}%` : undefined,
                    pitch: ssmlOptions.pitch,
                    pauseIntensity: ssmlOptions.pauseIntensity,
                    emphasizePowerWords: ssmlOptions.emphasizePowerWords,
                    customEmphasisWords: ssmlOptions.customEmphasisWords,
                    emphasisLevel: ssmlOptions.emphasisLevel
                }
            });

            inputContent = ssmlResult.content;
            inputType = ssmlResult.inputType;
            stylePrompt = ssmlResult.prompt;

            console.log(`[GoogleTtsService] ✅ SSML Generated:\n${inputContent}`);
            console.log(`[GoogleTtsService] type=${inputType}, length=${inputContent.length}`);
            if (stylePrompt) {
                console.log(`[GoogleTtsService] 📜 Style Prompt Generated: "${stylePrompt.substring(0, 50)}..."`);
            } else {
                console.log(`[GoogleTtsService] ⚠️ No Style Prompt Generated`);
            }
        }

        // For Gemini-TTS: Extract plain text from SSML and resolve prompt
        let resolvedPromptResult = null;
        let finalText = text;

        if (isGeminiTts) {
            // Extract plain text from SSML if needed
            if (inputType === 'ssml') {
                // Best-effort SSML tag stripping
                finalText = inputContent
                    .replace(/<speak>/gi, '')
                    .replace(/<\/speak>/gi, '')
                    .replace(/<[^>]+>/g, '') // Remove all tags
                    .replace(/\s+/g, ' ') // Normalize whitespace
                    .trim();

                console.log(`[GoogleTtsService] Extracted plain text from SSML: ${finalText.length} chars`);
            }

            // Resolve Gemini-TTS prompt if preset, custom prompt, or non-normal rate is provided
            if (promptPresetId || ttsPrompt || (ssmlOptions?.rate && ssmlOptions.rate !== 1.0)) {
                resolvedPromptResult = resolvePrompt({
                    promptPresetId,
                    customPrompt: ttsPrompt,
                    intensity,
                    text: finalText,
                    rate: ssmlOptions?.rate
                });

                // Use truncated text if needed
                if (resolvedPromptResult.text !== finalText) {
                    finalText = resolvedPromptResult.text;
                }
            }
        }

        // Build base Google TTS request
        const googleRequest = {
            voice: {
                languageCode: route.languageCode,
                name: route.voiceName
            },
            audioConfig: {
                audioEncoding: this._getAudioEncoding(route.audioEncoding)
            }
        };

        // Standard speed control (supported by all engines via audioConfig)
        // CRITICAL: We only apply this to audioConfig if:
        // 1. It's Gemini-TTS (which doesn't use SSML prosody)
        // 2. It's any other engine using 'text' input (not SSML)
        if (ssmlOptions && ssmlOptions.rate && (isGeminiTts || inputType === 'text' || route.tier === 'chirp3_hd')) {
            googleRequest.audioConfig.speaking_rate = ssmlOptions.rate;
            console.log(`[GoogleTtsService] Applied to audioConfig: speaking_rate=${ssmlOptions.rate}`);
        }

        // Handle engine-specific configuration
        if (isGeminiTts) {
            // Gemini-TTS: Use input.text + input.prompt
            googleRequest.input = {
                text: finalText
            };

            // Add prompt if resolved
            if (resolvedPromptResult && resolvedPromptResult.prompt) {
                googleRequest.input.prompt = resolvedPromptResult.prompt;
            }

            // Gemini-TTS requires model name
            googleRequest.voice.modelName = route.model;

            console.log(`[GoogleTtsService] 🔷 Gemini-TTS Request Built (input.prompt + v1beta1):`);
            console.log(`  - Model: ${route.model}`);
            console.log(`  - Text length: ${finalText.length}`);
            console.log(`  - Text start: "${finalText.substring(0, 50)}..."`);
            console.log(`  - Prompt: ${googleRequest.input.prompt ? 'yes' : 'no'}`);

            // SAFETY CHECK: Ensure the text to be spoken is NOT the prompt itself
            if (googleRequest.input.prompt &&
                typeof googleRequest.input.text === 'string' &&
                googleRequest.input.text.includes(googleRequest.input.prompt.substring(0, 30))) {

                console.error('[GoogleTtsService] 🚨 CRITICAL: Prompt leak detected! The text to be spoken contains the prompt. Overwriting with original text.');
                googleRequest.input.text = request.text; // Revert to original text
            }

        } else {
            // Chirp 3 HD / Neural2 / Standard: Use SSML or plain text
            googleRequest.input = inputType === 'ssml' ? { ssml: inputContent } : { text: inputContent };

            // Apply pitch adjustment (NOT supported by Chirp 3 HD in audioConfig)
            if (ssmlOptions && ssmlOptions.pitch && route.tier !== 'chirp3_hd') {
                // Parse semitone string (e.g., '+1st', '-2st', '0st')
                let pitchValue = 0;
                const match = ssmlOptions.pitch.match(/^([+-]?\d+)(?:st)?$/);
                if (match) {
                    pitchValue = parseFloat(match[1]);
                    googleRequest.audioConfig.pitch = pitchValue;
                    console.log(`[GoogleTtsService] Applied pitch: ${pitchValue} (from ${ssmlOptions.pitch})`);
                }
            }

            // For Chirp3 HD voices, include model name if provided in route
            if (route.engine === TtsEngine.CHIRP3_HD && route.model) {
                googleRequest.voice.modelName = route.model;
            }

            console.log(`[GoogleTtsService] 🔶 Chirp 3 HD / Standard Request Built`);
        }

        // Store prompt metadata for logging (will be used in synthesizeUnary)
        googleRequest._promptMetadata = resolvedPromptResult;

        return googleRequest;
    }

    /**
     * Build Google TTS request from TtsProfile (legacy method, kept for compatibility)
     * @private
     * @deprecated Use _buildGoogleRequestFromRoute instead
     */
    _buildGoogleRequest(request) {
        const { profile, text } = request;
        const { engine, languageCode, voiceName, modelName, encoding, streaming, prompt } = profile;

        // Normalize language code to full locale format (e.g., 'es' -> 'es-ES')
        const normalizedLanguageCode = this._normalizeLanguageCode(languageCode);

        // Resolve voice configuration (handles tier-to-voice mapping and language fallbacks)
        const resolvedVoiceName = this._resolveVoiceConfig(engine, normalizedLanguageCode, voiceName);

        const googleRequest = {
            input: { text },
            voice: {
                languageCode: normalizedLanguageCode,
                name: resolvedVoiceName
            },
            audioConfig: {
                audioEncoding: this._getAudioEncoding(encoding)
            }
        };

        if (engine === TtsEngine.GEMINI_TTS) {
            // Gemini-TTS requires modelName
            googleRequest.voice.modelName = modelName;

            // Streaming-specific Gemini config
            if (streaming) {
                googleRequest.streamingConfig = {
                    voice: googleRequest.voice,
                    audioConfig: googleRequest.audioConfig
                };
                // Prompt is supported for Gemini-TTS
                if (prompt) {
                    googleRequest.streamingConfig.prompt = prompt;
                }
            }
        }

        // Future: custom voice handling
        if (profile.customVoice?.voiceId) {
            // This would be populated differently based on Google's requirements for custom voices
            // googleRequest.voice.customVoice = { ... }
        }

        return googleRequest;
    }

    /**
     * Normalize language code to full locale format
     * @private
     */
    _normalizeLanguageCode(languageCode) {
        // If already in full format (e.g., 'es-ES'), return as-is
        if (languageCode && languageCode.includes('-')) {
            return languageCode;
        }

        // Map short codes to full locale codes
        const languageMap = {
            'es': 'es-ES',
            'en': 'en-US',
            'fr': 'fr-FR',
            'de': 'de-DE',
            'it': 'it-IT',
            'pt': 'pt-BR',
            'ja': 'ja-JP',
            'ko': 'ko-KR',
            'zh': 'cmn-CN',
            'ar': 'ar-XA',
            'hi': 'hi-IN',
            'ru': 'ru-RU'
        };

        return languageMap[languageCode] || `${languageCode}-${languageCode.toUpperCase()}`;
    }

    /**
     * Resolves voice name based on engine, language, and persona
     * Implements intelligent fallback for languages not supported by specific models
     * @private
     */
    _resolveVoiceConfig(engine, languageCode, voiceName) {
        // Default mappings for the "Kore" persona across different engines/languages
        const IS_SPANISH = languageCode && languageCode.startsWith('es');

        // --- PRE-RESOLUTION NORMALIZATION ---
        let resolvedName = voiceName;
        if (resolvedName && resolvedName.includes('-')) {
            // Fix for common shorthand: es-Neural2-A -> es-ES-Neural2-A
            if (resolvedName.startsWith('es-') && !resolvedName.startsWith('es-ES-') && !resolvedName.startsWith('es-US-')) {
                resolvedName = resolvedName.replace('es-', 'es-ES-');
            }
        }

        // 1. CHIRP 3 HD Resolution
        if (engine === TtsEngine.CHIRP3_HD) {
            if (resolvedName && (resolvedName.includes('-Chirp3-') || resolvedName.includes('-Neural2-') || resolvedName.includes('-Standard-'))) {
                return resolvedName; // Already a full name
            }
            // Default Chirp 3 HD voices
            if (IS_SPANISH) return 'es-ES-Chirp3-HD-Kore';
            return 'en-US-Chirp3-HD-Kore';
        }

        // 2. GEMINI TTS Resolution
        if (engine === TtsEngine.GEMINI_TTS) {
            // If it's a full Google voice name, use it as is
            if (resolvedName && resolvedName.includes('-')) {
                return resolvedName;
            }

            // If it's the "Kore" persona in Spanish, fall back to Neural2 since Studio/Gemini voices
            // are primarily English-optimized at this time.
            if (IS_SPANISH && (resolvedName === 'Kore' || !resolvedName)) {
                return 'es-ES-Neural2-A';
            }

            // Default Gemini voice
            return resolvedName || 'Kore';
        }

        return resolvedName;
    }

    /**
     * Get Google audio encoding from TtsEncoding enum
     * @private
     */
    _getAudioEncoding(encoding) {
        const encodings = {
            [TtsEncoding.MP3]: 'MP3',
            [TtsEncoding.OGG_OPUS]: 'OGG_OPUS',
            [TtsEncoding.LINEAR16]: 'LINEAR16',
            [TtsEncoding.ALAW]: 'ALAW',
            [TtsEncoding.MULAW]: 'MULAW',
            [TtsEncoding.PCM]: 'LINEAR16' // PCM maps to LINEAR16 in Google TTS
        };

        return encodings[encoding] || 'MP3';
    }

    /**
     * Synthesize speech in unary mode using Google TTS
     * @override
     * @param {TtsRequest} request - TTS request
     * @param {Object} [preResolvedRoute] - Optional pre-resolved route from resolveTtsRoute
     */
    async synthesizeUnary(request, preResolvedRoute = null) {
        await this._initClient();
        this._validateRequest(request);

        let route = preResolvedRoute;

        // Resolve TTS routing if not provided (fallback for backward compatibility)
        if (!route) {
            validateTtsProfile(request.profile);
            route = await resolveTtsRoute({
                requestedTier: request.profile.requestedTier || this._tierFromEngine(request.profile.engine),
                requestedVoice: request.profile.voiceName,
                languageCode: request.profile.languageCode,
                mode: 'unary',
                orgConfig: {}, // TODO: Pass actual org config
                userSubscription: {} // TODO: Pass actual subscription
            });
        }

        console.log(`[GoogleTtsService] Synthesizing unary: ${request.text.length} chars, tier: ${route.tier}, voice: ${route.voiceName}`);

        // Validate resolved route
        validateResolvedRoute(route);

        // Log resolved routing for debugging
        console.log(`[GoogleTtsService] Resolved route:`, JSON.stringify({
            provider: route.provider,
            tier: route.tier,
            engine: route.engine,
            languageCode: route.languageCode,
            voiceName: route.voiceName,
            audioEncoding: route.audioEncoding,
            reason: route.reason
        }, null, 2));

        const googleRequest = await this._buildGoogleRequestFromRoute(request, route);

        console.log(`[GoogleTtsService] FINAL PAYLOAD for synthesizeSpeech:`, JSON.stringify({
            input: googleRequest.input,
            voice: googleRequest.voice,
            audioConfig: googleRequest.audioConfig,
            prompt: googleRequest.prompt
        }, null, 2));

        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const [response] = await this.client.synthesizeSpeech(googleRequest);
                const audioContentBase64 = response.audioContent.toString('base64');
                const mimeType = this._getMimeType(route.audioEncoding);
                const audioSize = response.audioContent.length;

                console.log(`[GoogleTtsService] Synthesis successful: ${audioSize} bytes of ${mimeType}`);

                return {
                    audioContentBase64,
                    mimeType,
                    sampleRateHz: response.sampleRateHz || undefined,
                    durationMs: undefined,
                    route, // Include resolved routing in response
                    promptMetadata: googleRequest._promptMetadata || null // Include prompt metadata for logging
                };
            } catch (error) {
                lastError = error;
                const errorMessage = error.message || '';
                console.error(`[GoogleTtsService] Synthesis attempt ${attempt + 1} failed:`, errorMessage);

                // Handle errors that should trigger immediate fallback to a safe tier (Neural2)
                const isPermissionError = errorMessage.includes('PERMISSION_DENIED') || error.code === 7;
                const isInvalidArgument = errorMessage.includes('INVALID_ARGUMENT') || error.code === 3;
                const isVertexError = errorMessage.includes('Vertex AI') || errorMessage.includes('aiplatform.googleapis.com');
                const isStudioError = errorMessage.includes('Studio voice') || errorMessage.includes('Studio');
                const isUnsupportedVoice = errorMessage.includes('not found') || errorMessage.includes('no voice');

                // Trigger fallback for permission issues or invalid voice/tier combinations
                if (isPermissionError || isInvalidArgument || isUnsupportedVoice) {
                    // Force fallback to neural2 for high-end engines, or to the language's default fallback for the current tier
                    const forceNeural2Fallback = (route.tier === 'gemini' || route.tier === 'chirp3_hd');
                    const targetTier = forceNeural2Fallback ? 'neural2' : route.tier;

                    console.warn(`[GoogleTtsService] ${route.tier.toUpperCase()} voice error ("${route.voiceName}"). Falling back to ${targetTier}. Error: ${errorMessage}`);

                    try {
                        // Re-resolve route with forced fallback (requestedVoice=null will trigger the default language mapping)
                        const fallbackRoute = await resolveTtsRoute({
                            requestedTier: targetTier,
                            requestedVoice: null,
                            languageCode: route.languageCode,
                            mode: 'unary'
                        });

                        // Log the original route that failed for troubleshooting
                        const originalRoute = { ...route };

                        // Update request for the next attempt
                        const newGoogleRequest = await this._buildGoogleRequestFromRoute(request, fallbackRoute);

                        // Update tracking variables to use the fallback for next attempts and response
                        Object.assign(googleRequest, newGoogleRequest);
                        Object.assign(route, fallbackRoute);

                        // Set the reason to explicitly mention why we fell back
                        // Set the reason to explicitly mention why we fell back
                        if (isPermissionError || isVertexError) {
                            route.reason = `vertex_ai_not_enabled_fallback_from_${originalRoute.tier}_to_${route.tier}`;
                            route.fallbackFrom = {
                                tier: originalRoute.tier,
                                voiceName: originalRoute.voiceName,
                                reason: 'vertex_ai_permission_denied'
                            };
                        } else if (isInvalidArgument || isUnsupportedVoice) {
                            route.reason = `unsupported_voice_config_fallback_from_${originalRoute.tier}_to_${route.tier}`;
                            route.fallbackFrom = {
                                tier: originalRoute.tier,
                                voiceName: originalRoute.voiceName,
                                reason: errorMessage.includes('pitch') ? 'pitch_not_supported' : 'invalid_argument'
                            };
                        }

                        // Reset attempt counter or just continue - if attempt was 0, it will try again with fallback
                        continue;
                    } catch (fallbackError) {
                        console.error('[GoogleTtsService] Failed to resolve fallback route:', fallbackError.message);
                    }
                }

                if (!this._isRetryableError(error) || attempt === 1) break;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        throw new Error(JSON.stringify({
            code: TtsErrorCode.SYNTHESIS_FAILED,
            message: `Google TTS synthesis failed: ${lastError.message}`,
            details: {
                route,
                textLength: request.text.length,
                error: lastError.message
            }
        }));
    }

    /**
     * Check if error is retryable
     * @private
     */
    _isRetryableError(error) {
        const retryableCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
        if (retryableCodes.includes(error.code)) return true;
        if (error.code >= 500 && error.code < 600) return true;
        if (error.code === 429) return true;
        return false;
    }

    // Streaming implementation will be added in PR3
}
