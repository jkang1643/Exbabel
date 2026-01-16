/**
 * Google Cloud Speech-to-Text Streaming Service
 * Provides live streaming transcription with partial results
 *
 * CRITICAL: Using v1p1beta1 API for PhraseSet support
 * - v1 API does NOT support PhraseSets (they are silently ignored)
 * - v1p1beta1 API DOES support PhraseSets via adaptation.phraseSets
 * - v2 API requires a Recognizer resource which adds complexity
 * 
 * AUTHENTICATION OPTIONS:
 * 1. Service Account JSON (default) - More secure, recommended for production
 * 2. API Key (simpler) - Set GOOGLE_SPEECH_API_KEY env variable
 */

import speech from '@google-cloud/speech';
// Use v1p1beta1 for PhraseSet support (v1 doesn't support PhraseSets, v2 requires Recognizer resource)
const speechClient = speech.v1p1beta1;
import { Buffer } from 'buffer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TRANSCRIPTION_LANGUAGES, getTranscriptionLanguageCode, isTranscriptionSupported } from './languageConfig.js';
import AudioBufferManager from './audioBufferManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class GoogleSpeechStream {
  constructor() {
    this.client = null;
    this.stream = null;
    this.recognizeStream = null;
    this.resultCallback = null;
    this.errorCallback = null;
    this.isActive = false;
    this.isRestarting = false;
    this.languageCode = 'en-US';
    this.restartTimer = null;
    this.restartCount = 0;
    this.audioQueue = [];
    this.isSending = false;
    this.shouldAutoRestart = true;
    this.lastAudioTime = null;
    this.useEnhancedModel = true; // Track if we should use enhanced model (fallback to default if not supported)
    this.hasTriedEnhancedModel = false; // Track if we've already tried enhanced model for this language

    // Unique ID for debugging which stream results come from
    this.streamId = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`[GoogleSpeech] Created new stream instance: ${this.streamId}`);

    // Pipeline marker: "normal" for regular streaming, "recovery" for recovery streams
    this.pipeline = 'normal';

    // AUDIO BUFFER MANAGER: Captures EVERY audio chunk for recovery operations
    // This rolling buffer maintains the last 2500ms of audio for text extension window
    this.audioBufferManager = new AudioBufferManager({
      bufferDurationMs: 2500,  // 2.5 second rolling window (extended to capture complete phrases after forced finals)
      flushDurationMs: 600,     // Flush last 600ms on natural finals
      maxChunks: 200,           // Safety limit
      enableMetrics: true,
      logger: console
    });

    // Listen to audio buffer events for monitoring
    this.audioBufferManager.on('chunk_added', (data) => {
      // Optional: emit events for external monitoring
    });

    this.audioBufferManager.on('flush', (data) => {
      console.log(`[GoogleSpeech] 🎵 Audio buffer flushed: ${data.chunks} chunks, ${data.bytes} bytes`);
    });

    // Google Speech has a 305 second (5 min) streaming limit
    // We'll restart the stream every 4 minutes to be safe
    this.STREAMING_LIMIT = 240000; // 4 minutes in milliseconds

    // CRITICAL: Auto-restart at 25 seconds to prevent VAD cutoff
    // Google's VAD becomes aggressive after ~30 seconds, causing premature finalization
    this.VAD_CUTOFF_LIMIT = 25000; // 25 seconds - restart before VAD cutoff
    this.cumulativeAudioTime = 0; // Track total audio sent in current session
    this.lastAudioChunkTime = Date.now();

    this.startTime = Date.now();

    // Speech context: Track last transcript for context carry-forward between sessions
    this.lastTranscriptContext = ''; // Last 50 chars of transcript for context

    // Audio batching: Batch chunks into 100-150ms groups for optimal flow
    // Balance between smooth flow (prevent VAD gaps) and responsiveness
    this.jitterBuffer = [];
    this.jitterBufferDelay = 100; // 100ms batching (sweet spot: smooth but responsive)
    this.jitterBufferMin = 80; // Minimum 80ms
    this.jitterBufferMax = 150; // Maximum 150ms
    this.jitterBufferTimer = null;
    this.lastJitterRelease = Date.now();

    // Chunk retry tracking: Track failed chunks and retry up to 3 times
    this.chunkRetryMap = new Map(); // chunkId -> { attempts: number, chunkData, metadata, lastAttempt }
    this.MAX_CHUNK_RETRIES = 3;
    this.RETRY_BACKOFF_MS = [100, 200, 400]; // Exponential backoff delays

    // Per-chunk timeout tracking: Detect stuck chunks
    // Timeout accounts for audio batching (100ms) + processing time
    this.chunkTimeouts = new Map(); // chunkId -> { timeout handle, sendTimestamp }
    this.CHUNK_TIMEOUT_MS = 7000; // 7 seconds (5s + 2s buffer for processing)
    this.chunkIdCounter = 0;
    this.chunkTimeoutTimestamps = [];
    this.CHUNK_TIMEOUT_RESET_THRESHOLD = 6; // If 6+ timeouts happen within a short window, treat stream as stuck
    this.CHUNK_TIMEOUT_WINDOW_MS = 2500; // 2.5s window for timeout burst detection

    // Track pending chunks in send order for better timeout clearing
    this.pendingChunks = []; // Array of { chunkId, sendTimestamp }

    // Track the latest partial transcript so we can force-commit it if the
    // stream restarts before a FINAL result arrives.
    this.lastPartialTranscript = '';
  }

  /**
   * Initialize the Google Speech client and start streaming
   * NOTE: Using API V1 for now. V2 migration pending (requires gRPC streaming implementation).
   */
  async initialize(sourceLang, options = {}) {
    console.log(`[GoogleSpeech] Initializing streaming transcription for ${sourceLang}...`);
    console.log(`[GoogleSpeech] ✅ Using API v1p1beta1 for PhraseSet support`);

    // Store initialization options for startStream
    this.initOptions = options;

    // Create Speech client with authentication options
    const clientOptions = {};

    // Option 1: API Key (simpler, if provided)
    if (process.env.GOOGLE_SPEECH_API_KEY) {
      console.log('[GoogleSpeech] Using API Key authentication');
      clientOptions.apiKey = process.env.GOOGLE_SPEECH_API_KEY;
    }
    // Option 2: Service Account JSON (via GOOGLE_APPLICATION_CREDENTIALS env var)
    else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.log('[GoogleSpeech] Using Service Account JSON authentication');
      // Default behavior - uses credentials file path from env var
    }
    // Option 3: Default credentials (for GCP environments)
    else {
      console.log('[GoogleSpeech] Using default credentials (GCP environment)');
    }

    // Use v1p1beta1 client for PhraseSet support (v1 doesn't support PhraseSets, v2 requires Recognizer resource)
    this.client = new speechClient.SpeechClient(clientOptions);

    // Get language code for Google Speech (only supports transcription languages)
    // If language is not supported for transcription, fall back to English
    const newLanguageCode = isTranscriptionSupported(sourceLang)
      ? getTranscriptionLanguageCode(sourceLang)
      : 'en-US';

    if (!isTranscriptionSupported(sourceLang)) {
      console.warn(`[GoogleSpeech] Language ${sourceLang} not supported for transcription, falling back to English`);
    }

    // Reset enhanced model flags if language changed
    if (this.languageCode !== newLanguageCode) {
      console.log(`[GoogleSpeech] Language changed from ${this.languageCode} to ${newLanguageCode}, resetting enhanced model flags`);
      this.hasTriedEnhancedModel = false;
      this.useEnhancedModel = true;
    }

    this.languageCode = newLanguageCode;
    console.log(`[GoogleSpeech] Using language code: ${this.languageCode}`);

    // Start the streaming session
    await this.startStream();

    console.log(`[GoogleSpeech] ✅ Streaming initialized and ready`);
  }

  /**
   * Start a new streaming recognition session
   */
  async startStream() {
    if (this.recognizeStream) {
      console.log('[GoogleSpeech] Closing existing stream before restart...');
      try {
        this.recognizeStream.removeAllListeners();
        this.recognizeStream.end();
      } catch (err) {
        console.warn('[GoogleSpeech] Error closing old stream:', err.message);
      }
      this.recognizeStream = null;
    }

    console.log(`[GoogleSpeech] Starting stream #${this.restartCount}...`);
    this.startTime = Date.now();
    this.isActive = true;
    this.isRestarting = false;

    // Reset cumulative audio time for new session
    this.cumulativeAudioTime = 0;
    console.log(`[GoogleSpeech] Reset cumulative audio time. Context: "${this.lastTranscriptContext || 'none'}"`);

    // Build request config - conditionally include model based on language support
    const requestConfig = {
      encoding: this.initOptions?.encoding || 'LINEAR16',
      sampleRateHertz: this.initOptions?.sampleRateHertz || 24000, // Default to 24kHz (frontend)
      languageCode: this.languageCode,
      enableAutomaticPunctuation: this.initOptions?.disablePunctuation ? false : true, // Allow disabling for recovery streams
      alternativeLanguageCodes: [],
    };

    // Log if punctuation is disabled (for recovery streams)
    if (this.initOptions?.disablePunctuation) {
      console.log('[GoogleSpeech] ⚠️ Automatic punctuation DISABLED for recovery stream');
    }

    // Check if PhraseSet is configured
    const currentProjectId = process.env.GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
    const hasPhraseSet = !!(process.env.GOOGLE_PHRASE_SET_ID && currentProjectId);

    // Use enhanced model with PhraseSets for best accuracy
    // Check for forceEnhanced option (used by recovery streams for maximum accuracy)
    const forceEnhanced = this.initOptions?.forceEnhanced === true;

    if (forceEnhanced || (this.useEnhancedModel && !this.hasTriedEnhancedModel)) {
      requestConfig.useEnhanced = true;
      requestConfig.model = 'latest_long'; // Enhanced model for long-form audio
      if (forceEnhanced) {
        console.log(`[GoogleSpeech] ✅ FORCING enhanced model (latest_long) for recovery stream - maximum accuracy`);
      }
      if (hasPhraseSet) {
        console.log(`[GoogleSpeech] ✅ Using latest_long model WITH PhraseSet (v1p1beta1 API - recommended configuration)`);
        console.log(`[GoogleSpeech]    latest_long supports PhraseSets and provides best accuracy for sermons`);
      } else {
        console.log(`[GoogleSpeech] Using enhanced model (latest_long) for ${this.languageCode}`);
      }
    } else {
      // Use default model (no model parameter) - fallback if enhanced model failed
      if (hasPhraseSet) {
        console.log(`[GoogleSpeech] Using default model for ${this.languageCode} (enhanced model failed, PhraseSet still active)`);
      } else {
        console.log(`[GoogleSpeech] Using default model for ${this.languageCode} (enhanced model not supported or disabled)`);
      }
    }

    // Add PhraseSet reference if configured (for improved recognition of glossary terms)
    // CRITICAL: v1p1beta1 API uses adaptation.phraseSets format
    if (hasPhraseSet) {
      const phraseSetRef = `projects/${currentProjectId}/locations/global/phraseSets/${process.env.GOOGLE_PHRASE_SET_ID}`;
      // v1p1beta1 API uses adaptation.phraseSets format
      requestConfig.adaptation = {
        phraseSets: [
          {
            name: phraseSetRef
          }
        ]
      };
      console.log(`[GoogleSpeech] ✅ PhraseSet ENABLED (v1p1beta1 API): ${phraseSetRef}`);
      console.log(`[GoogleSpeech]    Using adaptation.phraseSets format for PhraseSet support`);
      console.log(`[GoogleSpeech]    Glossary terms will be recognized with improved accuracy`);
      console.log(`[GoogleSpeech]    Request config includes adaptation: ${JSON.stringify(requestConfig.adaptation)}`);
    } else {
      console.log(`[GoogleSpeech] ⚠️  PhraseSet NOT configured - set GOOGLE_PHRASE_SET_ID and GOOGLE_PROJECT_ID to enable`);
    }

    const request = {
      config: requestConfig,
      interimResults: true, // CRITICAL: Enable partial results
    };

    // Always log PhraseSet status for verification
    if (requestConfig.adaptation && requestConfig.adaptation.phraseSets && requestConfig.adaptation.phraseSets.length > 0) {
      console.log(`[GoogleSpeech] 🔍 VERIFICATION: PhraseSet will be sent in API request (v1p1beta1 API)`);
      console.log(`[GoogleSpeech]    adaptation.phraseSets: ${JSON.stringify(requestConfig.adaptation.phraseSets)}`);
      console.log(`[GoogleSpeech]    Model: ${requestConfig.model || 'default'} (enhanced: ${requestConfig.useEnhanced || false})`);
    } else {
      console.log(`[GoogleSpeech] ⚠️  WARNING: No adaptation.phraseSets in request config!`);
    }

    // Log the full request config for debugging (without sensitive data)
    if (process.env.DEBUG_PHRASESET === 'true') {
      console.log(`[GoogleSpeech] DEBUG - Full request config:`, JSON.stringify({
        encoding: requestConfig.encoding,
        sampleRateHertz: requestConfig.sampleRateHertz,
        languageCode: requestConfig.languageCode,
        adaptation: requestConfig.adaptation,
        useEnhanced: requestConfig.useEnhanced,
        model: requestConfig.model
      }, null, 2));
    }

    // Log the actual request being sent (for debugging PhraseSet)
    if (requestConfig.adaptation && requestConfig.adaptation.phraseSets && requestConfig.adaptation.phraseSets.length > 0) {
      console.log(`[GoogleSpeech] 📤 SENDING REQUEST WITH PHRASESET (v1p1beta1 API):`);
      console.log(`[GoogleSpeech]    Config: ${JSON.stringify({
        languageCode: requestConfig.languageCode,
        adaptation: requestConfig.adaptation,
        model: requestConfig.model || 'default',
        useEnhanced: requestConfig.useEnhanced || false
      })}`);
    }

    // Create streaming recognition stream
    this.recognizeStream = this.client
      .streamingRecognize(request)
      .on('error', (error) => {
        // Prevent unhandled error crashes - wrap entire handler in try-catch
        try {
          console.error('[GoogleSpeech] Stream error:', error);
          console.error('[GoogleSpeech] Error code:', error.code, 'Details:', error.details);

          // Check specifically for PhraseSet errors
          if (error.message && (
            error.message.includes('phraseSet') ||
            error.message.includes('phrase_set') ||
            error.message.includes('adaptation') ||
            error.message.includes('PhraseSet')
          )) {
            console.error(`[GoogleSpeech] ❌ PHRASESET ERROR: ${error.message}`);
            console.error(`[GoogleSpeech]    This means Google rejected the PhraseSet reference`);
          }

          // Mark as inactive immediately
          this.isActive = false;

          // Handle common errors
          if (error.code === 11) {
            console.log('[GoogleSpeech] Audio timeout (code 11) - restarting stream...');
            if (!this.isRestarting) {
              this.restartStream();
            }
          } else if (error.code === 14 || (error.details && error.details.includes('ECONNRESET'))) {
            // Handle UNAVAILABLE (code 14) and connection reset errors
            console.log('[GoogleSpeech] Connection reset/unavailable (code 14) - cleaning up and restarting stream...');
            console.log('[GoogleSpeech] Error details:', error.details || error.message);

            // Clean up the stream immediately
            this.isActive = false;
            if (this.recognizeStream) {
              try {
                this.recognizeStream.removeAllListeners();
                this.recognizeStream.destroy();
              } catch (cleanupError) {
                console.warn('[GoogleSpeech] Error during stream cleanup:', cleanupError);
              }
              this.recognizeStream = null;
            }

            // Restart after a brief delay to allow cleanup
            if (!this.isRestarting && this.shouldAutoRestart) {
              setTimeout(() => {
                if (!this.isRestarting) {
                  console.log('[GoogleSpeech] Restarting stream after connection reset...');
                  this.restartStream();
                }
              }, 1000);
            }
          } else if (error.code === 2 || (error.details && (error.details.includes('408') || error.details.includes('Request Timeout')))) {
            // Handle 408 Request Timeout (code 2 UNKNOWN with 408 details)
            console.log('[GoogleSpeech] Request timeout (408) detected - restarting stream...');
            console.log('[GoogleSpeech] Error details:', error.details);
            if (!this.isRestarting) {
              // Small delay before restart to allow cleanup
              setTimeout(() => {
                if (!this.isRestarting) {
                  this.restartStream();
                }
              }, 500);
            }
          } else if (error.code === 3) {
            console.error('[GoogleSpeech] Invalid argument error - check audio format');
            console.error('[GoogleSpeech] Full error message:', error.message);

            // Check if error is about model not being supported for this language
            if (error.message && error.message.includes('model is currently not supported for language')) {
              console.log(`[GoogleSpeech] ⚠️ Enhanced model not supported for ${this.languageCode}, falling back to default model...`);

              // Mark that we've tried enhanced model and it failed
              this.hasTriedEnhancedModel = true;
              this.useEnhancedModel = false;

              // Retry with default model (no model parameter)
              if (!this.isRestarting) {
                setTimeout(() => {
                  if (!this.isRestarting) {
                    console.log(`[GoogleSpeech] Retrying with default model for ${this.languageCode}...`);
                    this.restartStream();
                  }
                }, 500);
              }
              return; // Don't notify error callback yet - we're retrying
            }

            // Check if error is about PhraseSet not being supported with enhanced model
            const hasPhraseSet = !!(process.env.GOOGLE_PHRASE_SET_ID && process.env.GOOGLE_CLOUD_PROJECT_ID);
            if (hasPhraseSet && this.useEnhancedModel && error.message && (
              error.message.includes('phraseSet') ||
              error.message.includes('phrase_set') ||
              error.message.includes('adaptation') ||
              error.message.toLowerCase().includes('phrase')
            )) {
              console.error(`[GoogleSpeech] ❌ CONFIRMED: Enhanced model does NOT support PhraseSets!`);
              console.error(`[GoogleSpeech]    Error: ${error.message}`);
              console.error(`[GoogleSpeech]    Falling back to default model with PhraseSet...`);

              // Disable enhanced model and retry
              this.hasTriedEnhancedModel = true;
              this.useEnhancedModel = false;

              if (!this.isRestarting) {
                setTimeout(() => {
                  if (!this.isRestarting) {
                    console.log(`[GoogleSpeech] Retrying with default model (PhraseSet compatible)...`);
                    this.restartStream();
                  }
                }, 500);
              }
              return; // Don't notify error callback yet - we're retrying
            }

            // Check if error is about PhraseSet configuration
            if (error.message && (error.message.includes('phraseSet') || error.message.includes('phrase_set') || error.message.includes('adaptation'))) {
              console.error(`[GoogleSpeech] ❌ PhraseSet error detected: ${error.message}`);
              console.error(`[GoogleSpeech]    Check PhraseSet configuration and permissions`);
            }

            // Don't restart on other invalid argument errors
          } else {
            console.error('[GoogleSpeech] Unhandled error:', error.message, 'Code:', error.code);
            // For other errors, attempt restart if auto-restart is enabled
            if (this.shouldAutoRestart && !this.isRestarting) {
              console.log('[GoogleSpeech] Attempting restart for unhandled error...');
              setTimeout(() => {
                if (!this.isRestarting) {
                  this.restartStream();
                }
              }, 1000);
            }
          }

          // Notify caller of error if callback exists
          if (this.errorCallback) {
            try {
              this.errorCallback(error);
            } catch (callbackError) {
              console.error('[GoogleSpeech] Error in error callback:', callbackError);
            }
          }
        } catch (handlerError) {
          // Catch any errors in the error handler itself to prevent crashes
          console.error('[GoogleSpeech] ❌ Error in error handler:', handlerError);
          console.error('[GoogleSpeech] Original error:', error);
          this.isActive = false;
          if (!this.isRestarting && this.shouldAutoRestart) {
            setTimeout(() => {
              if (!this.isRestarting) {
                this.restartStream();
              }
            }, 1000);
          }
        }
      })
      .on('data', (data) => {
        // Log for recovery streams to debug
        if (this.initOptions?.disablePunctuation) {
          console.log('[GoogleSpeech-RECOVERY] 🎤 Received data event from Google');
        }
        this.handleStreamingResponse(data);
      })
      .on('end', () => {
        console.log('[GoogleSpeech] Stream ended');
        this.isActive = false;

        // Auto-restart if ended unexpectedly
        if (this.shouldAutoRestart && !this.isRestarting) {
          console.log('[GoogleSpeech] Stream ended unexpectedly, restarting...');
          setTimeout(() => this.restartStream(), 1000);
        }
      });

    // Set up automatic restart before hitting the time limit
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }

    this.restartTimer = setTimeout(() => {
      console.log('[GoogleSpeech] Approaching time limit, restarting stream...');
      this.restartStream();
    }, this.STREAMING_LIMIT);

    console.log('[GoogleSpeech] Stream started successfully');
  }

  /**
   * Restart the stream (for long sessions)
   */
  async restartStream() {
    // Prevent multiple simultaneous restarts
    if (this.isRestarting) {
      console.log('[GoogleSpeech] Restart already in progress, skipping...');
      return;
    }

    this.isRestarting = true;
    this.restartCount++;
    console.log(`[GoogleSpeech] 🔄 Restarting stream (restart #${this.restartCount})...`);

    // CRITICAL: If Google never emitted a FINAL for the most recent partial, force-emit it
    // This ensures recovery system is triggered for forced finals
    if (this.lastPartialTranscript && this.lastPartialTranscript.trim().length > 0) {
      console.warn(`[GoogleSpeech] ⚠️ Forcing FINAL of latest partial before restart (${this.lastPartialTranscript.length} chars)`);
      if (this.resultCallback) {
        try {
          this.resultCallback(this.lastPartialTranscript, false, { forced: true });
        } catch (err) {
          console.error('[GoogleSpeech] ⚠️ Error forcing final transcript before restart:', err.message);
        }
      }
      this.lastPartialTranscript = '';
    }

    // Mark as inactive during restart
    this.isActive = false;

    // Clean up old stream first to prevent unhandled errors
    if (this.recognizeStream) {
      try {
        // Remove all listeners to prevent error propagation
        this.recognizeStream.removeAllListeners('error');
        this.recognizeStream.removeAllListeners('data');
        this.recognizeStream.removeAllListeners('end');

        // Try to destroy the stream gracefully
        if (typeof this.recognizeStream.destroy === 'function') {
          this.recognizeStream.destroy();
        } else if (typeof this.recognizeStream.end === 'function') {
          this.recognizeStream.end();
        }
      } catch (cleanupError) {
        console.warn('[GoogleSpeech] Error cleaning up old stream:', cleanupError.message);
      }
      this.recognizeStream = null;
    }

    // Clear jitter buffer and retry tracking on restart
    this.clearJitterBuffer();

    // Clear all retry timers
    for (const [chunkId, retryInfo] of this.chunkRetryMap.entries()) {
      if (retryInfo.retryTimer) {
        clearTimeout(retryInfo.retryTimer);
      }
    }
    this.chunkRetryMap.clear();

    // Clear all chunk timeouts
    for (const [chunkId, timeoutInfo] of this.chunkTimeouts.entries()) {
      clearTimeout(timeoutInfo.timeout);
    }
    this.chunkTimeouts.clear();
    this.pendingChunks = [];

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Small delay to ensure clean shutdown
    await new Promise(resolve => setTimeout(resolve, 200));

    try {
      await this.startStream();

      // Process any queued audio after restart
      if (this.audioQueue.length > 0) {
        console.log(`[GoogleSpeech] Processing ${this.audioQueue.length} queued audio chunks...`);
        const queuedAudio = [...this.audioQueue];
        this.audioQueue = [];

        for (const audioData of queuedAudio) {
          await this.processAudio(audioData);
        }
      }
    } catch (error) {
      console.error('[GoogleSpeech] Failed to restart stream:', error);
      this.isRestarting = false;

      // Notify error callback
      if (this.errorCallback) {
        this.errorCallback(error);
      }
    }
  }

  /**
   * Handle streaming response from Google Speech
   */
  handleStreamingResponse(data) {
    if (!data.results || data.results.length === 0) {
      return;
    }

    // CRITICAL FIX: Google Speech can send multiple results in one response
    // For long phrases, we need to accumulate ALL results, not just the first one
    let allTranscripts = [];
    let hasFinal = false;

    for (const result of data.results) {
      if (!result.alternatives || result.alternatives.length === 0) {
        continue;
      }

      const transcript = result.alternatives[0].transcript;
      if (transcript && transcript.trim()) {
        allTranscripts.push(transcript.trim());
        if (result.isFinal) {
          hasFinal = true;
        }
      }
    }

    if (allTranscripts.length === 0) {
      return;
    }

    // Combine all transcripts (Google may split long phrases across multiple results)
    const combinedTranscript = allTranscripts.join(' ');
    const isFinal = hasFinal;
    const stability = data.results[0].stability || 0;

    // Check if recognized text matches PhraseSet entries (for verification)
    // Log when PhraseSet terms are recognized to confirm it's working
    if (combinedTranscript && process.env.GOOGLE_PHRASE_SET_ID) {
      try {
        const glossaryPath = path.resolve(__dirname, '../glossary.json');
        if (fs.existsSync(glossaryPath)) {
          const glossary = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
          if (glossary.phrases && Array.isArray(glossary.phrases)) {
            // Strip punctuation and normalize transcript for matching
            const transcriptClean = combinedTranscript.toLowerCase().replace(/[.,!?;:]/g, '').trim();

            // Check if transcript contains any PhraseSet term
            const matched = glossary.phrases.find(phrase => {
              const phraseValue = phrase.value.toLowerCase();

              // Handle entries with "/" separator (e.g., "Ephesia/Ephesus")
              const phraseVariants = phraseValue.includes('/')
                ? phraseValue.split('/').map(v => v.trim())
                : [phraseValue];

              // Check each variant
              return phraseVariants.some(variant => {
                const variantClean = variant.replace(/[.,!?;:]/g, '').trim();
                // Check for exact match or phrase contained in transcript
                // CRITICAL: Only check if transcript contains phrase (not vice versa)
                // Checking if phrase contains transcript causes false positives (e.g., "stand your ground" contains "you")
                return transcriptClean === variantClean ||
                  transcriptClean.includes(variantClean);
              });
            });

            if (matched) {
              console.log(`[GoogleSpeech] 🎯✅ PHRASESET TERM RECOGNIZED: "${matched.value}" in transcript "${combinedTranscript}"`);
            }
          }
        }
      } catch (err) {
        // Silently fail - don't break transcription if glossary check fails
        // Only log errors if DEBUG_PHRASESET is enabled
        if (process.env.DEBUG_PHRASESET === 'true') {
          console.error(`[GoogleSpeech] ⚠️ Error checking PhraseSet recognition:`, err.message);
        }
      }
    }

    // Update speech context when we get a final result
    if (isFinal && combinedTranscript.length > 20) {
      // Store last 50 characters for context carry-forward
      this.lastTranscriptContext = combinedTranscript.slice(-50).trim();
      console.log(`[GoogleSpeech] 📝 Updated context: "${this.lastTranscriptContext}"`);
    }

    // Clear chunk timeouts on successful result
    // Google Speech processes chunks in order, so clear oldest pending chunks
    // Clear multiple timeouts since partial results come frequently and might clear multiple chunks
    const chunksToClear = Math.min(
      isFinal ? this.pendingChunks.length : 1, // FINAL: clear ALL chunks to prevent spurious partials. Partial: clear 1
      this.pendingChunks.length
    );

    for (let i = 0; i < chunksToClear && this.pendingChunks.length > 0; i++) {
      const oldestChunk = this.pendingChunks.shift();
      this.clearChunkTimeout(oldestChunk.chunkId);
      console.log(`[GoogleSpeech] ✅ Cleared timeout for chunk ${oldestChunk.chunkId} (result received)`);
    }

    if (isFinal) {
      // Final result - high confidence
      // CRITICAL: Clear ALL remaining chunks to prevent them from generating spurious partials
      console.log(`[GoogleSpeech] ✅ FINAL (${data.results.length} result(s)): "${combinedTranscript}"`);

      // Aggressively clear all remaining pending chunks
      if (this.pendingChunks.length > 0) {
        console.log(`[GoogleSpeech] 🧹 Clearing ${this.pendingChunks.length} remaining pending chunks after FINAL`);
        for (const chunk of this.pendingChunks) {
          this.clearChunkTimeout(chunk.chunkId);
        }
        this.pendingChunks = [];
      }

      if (this.resultCallback) {
        // Log which stream is sending results
        if (this.initOptions?.disablePunctuation) {
          console.log(`[GoogleSpeech-RECOVERY ${this.streamId}] 🔔 Calling resultCallback with FINAL: "${combinedTranscript}"`);
        }
        this.resultCallback(combinedTranscript, false, { pipeline: this.pipeline }); // isPartial = false, pass pipeline in meta
      }

      // Clear cached partial since we emitted a real final
      this.lastPartialTranscript = '';
    } else {
      // Interim result - partial transcription
      // console.log(`[GoogleSpeech] 🔵 PARTIAL (stability: ${stability.toFixed(2)}): "${combinedTranscript}"`);
      if (this.resultCallback) {
        // Log which stream is sending results
        if (this.initOptions?.disablePunctuation) {
          console.log(`[GoogleSpeech-RECOVERY ${this.streamId}] 🔔 Calling resultCallback with PARTIAL: "${combinedTranscript}"`);
        }
        this.resultCallback(combinedTranscript, true, { pipeline: this.pipeline }); // isPartial = true, pass pipeline in meta
      }

      // Cache the latest partial so we can force-commit if the stream restarts
      this.lastPartialTranscript = combinedTranscript;
    }
  }

  /**
   * Check if stream is ready to accept audio
   */
  isStreamReady() {
    const ready = this.recognizeStream &&
      this.recognizeStream.writable &&
      !this.recognizeStream.destroyed &&
      !this.recognizeStream.writableEnded &&
      this.isActive &&
      !this.isRestarting;

    // Debug logging for recovery streams
    if (this.initOptions?.disablePunctuation && !ready) {
      console.log('[GoogleSpeech-RECOVERY] ❌ Stream NOT ready:');
      console.log(`  recognizeStream exists: ${!!this.recognizeStream}`);
      console.log(`  writable: ${this.recognizeStream?.writable}`);
      console.log(`  destroyed: ${this.recognizeStream?.destroyed}`);
      console.log(`  writableEnded: ${this.recognizeStream?.writableEnded}`);
      console.log(`  isActive: ${this.isActive}`);
      console.log(`  isRestarting: ${this.isRestarting}`);
    }

    return ready;
  }

  /**
   * Release chunk from jitter buffer to Google Speech
   * @param {string} chunkId - Unique chunk identifier
   * @param {string} audioData - Base64 encoded PCM audio
   * @param {object} metadata - Optional metadata
   */
  async releaseChunkFromBuffer(chunkId, audioData, metadata = {}) {
    try {
      // Track chunk send time for timeout detection
      const sendTimestamp = Date.now();

      // Check if stream is ready
      if (!this.isStreamReady()) {
        // If stream not ready, check if we should retry or give up
        const existingRetry = this.chunkRetryMap.get(chunkId);
        const attempts = existingRetry ? existingRetry.attempts : 0;

        // Only retry if we haven't exceeded max attempts and stream is just restarting (not inactive)
        if (attempts < this.MAX_CHUNK_RETRIES && !this.isRestarting && this.lastAudioTime && (Date.now() - this.lastAudioTime < 3000)) {
          this.queueChunkForRetry(chunkId, audioData, metadata, attempts);
        } else {
          // Give up - stream inactive or too many attempts
          console.log(`[GoogleSpeech] ⚠️ Giving up on chunk ${chunkId} - stream not ready and conditions not met for retry`);
          this.chunkRetryMap.delete(chunkId);
          this.clearChunkTimeout(chunkId);
        }
        return;
      }

      // Track cumulative audio time (assume ~20ms per chunk based on 24kHz sampling)
      const chunkDurationMs = 20; // Approximate duration of each audio chunk
      this.cumulativeAudioTime += chunkDurationMs;

      // CRITICAL: Check for VAD cutoff limit (25 seconds)
      // Restart proactively BEFORE Google's VAD becomes aggressive
      // DISABLED FOR NOW - causing timeout issues
      // if (this.cumulativeAudioTime >= this.VAD_CUTOFF_LIMIT) {
      //   console.log(`[GoogleSpeech] ⚠️ VAD cutoff approaching (${this.cumulativeAudioTime}ms) - proactive restart to prevent word loss...`);
      //   this.queueChunkForRetry(chunkId, audioData, metadata, 0);
      //   await this.restartStream();
      //   return;
      // }

      // Check if we need to restart due to time limit
      const elapsedTime = Date.now() - this.startTime;
      if (elapsedTime >= this.STREAMING_LIMIT) {
        console.log('[GoogleSpeech] Time limit reached, queuing chunk for retry after restart...');
        this.queueChunkForRetry(chunkId, audioData, metadata, 0);
        await this.restartStream();
        return;
      }

      // Convert base64 to Buffer
      const audioBuffer = Buffer.from(audioData, 'base64');

      // ⭐ CRITICAL: Add audio chunk to rolling buffer BEFORE sending to Google
      // This captures EVERY audio chunk for text extension window recovery
      this.audioBufferManager.addChunk(audioBuffer, {
        chunkId,
        timestamp: sendTimestamp,
        source: 'client',
        ...metadata
      });

      // Double-check stream is still ready
      if (this.isStreamReady()) {
        this.recognizeStream.write(audioBuffer);

        // Log for recovery streams
        if (this.initOptions?.disablePunctuation) {
          console.log(`[GoogleSpeech-RECOVERY] 📤 Wrote ${audioBuffer.length} bytes to recognition stream`);
        }

        // Set per-chunk timeout (5s)
        this.setChunkTimeout(chunkId, sendTimestamp, audioData, metadata);

        // Track last audio time
        this.lastAudioTime = Date.now();
      } else {
        console.warn('[GoogleSpeech] Stream became unavailable, checking if retry is needed...');
        const existingRetry = this.chunkRetryMap.get(chunkId);
        const attempts = existingRetry ? existingRetry.attempts : 0;

        // Only retry if conditions are met
        if (attempts < this.MAX_CHUNK_RETRIES && this.lastAudioTime && (Date.now() - this.lastAudioTime < 3000)) {
          this.queueChunkForRetry(chunkId, audioData, metadata, attempts);
        } else {
          // Give up - too many attempts or audio stopped
          console.log(`[GoogleSpeech] ⚠️ Giving up on chunk ${chunkId} - too many attempts or audio stopped`);
          this.chunkRetryMap.delete(chunkId);
          this.clearChunkTimeout(chunkId);
        }

        if (!this.isRestarting) {
          await this.restartStream();
        }
      }
    } catch (error) {
      console.error('[GoogleSpeech] Error releasing chunk:', error.message);
      const existingRetry = this.chunkRetryMap.get(chunkId);
      const attempts = existingRetry ? existingRetry.attempts : 0;

      // Only retry on error if conditions are met
      if (attempts < this.MAX_CHUNK_RETRIES && this.lastAudioTime && (Date.now() - this.lastAudioTime < 3000)) {
        this.queueChunkForRetry(chunkId, audioData, metadata, attempts);
      } else {
        this.chunkRetryMap.delete(chunkId);
        this.clearChunkTimeout(chunkId);
      }
    }
  }

  /**
   * Set timeout for chunk processing (7s to account for processing + network delays)
   */
  setChunkTimeout(chunkId, sendTimestamp, audioData, metadata) {
    // Clear any existing timeout for this chunk
    if (this.chunkTimeouts.has(chunkId)) {
      clearTimeout(this.chunkTimeouts.get(chunkId).timeout);
    }

    // Remove from pending chunks if already there (avoid duplicates)
    this.pendingChunks = this.pendingChunks.filter(c => c.chunkId !== chunkId);

    // Add to pending chunks queue (FIFO)
    this.pendingChunks.push({ chunkId, sendTimestamp });

    const timeoutHandle = setTimeout(() => {
      const elapsed = Date.now() - sendTimestamp;
      console.warn(`[GoogleSpeech] ⚠️ Chunk ${chunkId} timeout after ${elapsed}ms (${this.CHUNK_TIMEOUT_MS}ms limit)`);

      // Remove from timeout tracking and pending chunks
      this.chunkTimeouts.delete(chunkId);
      this.pendingChunks = this.pendingChunks.filter(c => c.chunkId !== chunkId);
      this.chunkRetryMap.delete(chunkId);

      this.recordChunkTimeout();
      if (this.shouldForceRestartAfterTimeoutBurst()) {
        this.handleChunkTimeoutBurst();
      }
    }, this.CHUNK_TIMEOUT_MS);

    this.chunkTimeouts.set(chunkId, { timeout: timeoutHandle, sendTimestamp });
  }

  /**
   * Clear chunk timeout (called when result received)
   */
  clearChunkTimeout(chunkId) {
    if (this.chunkTimeouts.has(chunkId)) {
      const timeoutInfo = this.chunkTimeouts.get(chunkId);
      clearTimeout(timeoutInfo.timeout);
      this.chunkTimeouts.delete(chunkId);
    }

    // Also remove from pending chunks
    this.pendingChunks = this.pendingChunks.filter(c => c.chunkId !== chunkId);
  }

  recordChunkTimeout() {
    const now = Date.now();
    this.chunkTimeoutTimestamps.push(now);
    this.chunkTimeoutTimestamps = this.chunkTimeoutTimestamps.filter(ts => now - ts <= this.CHUNK_TIMEOUT_WINDOW_MS);
  }

  shouldForceRestartAfterTimeoutBurst() {
    return this.chunkTimeoutTimestamps.length >= this.CHUNK_TIMEOUT_RESET_THRESHOLD;
  }

  handleChunkTimeoutBurst() {
    console.error(`[GoogleSpeech] ❌ ${this.chunkTimeoutTimestamps.length} chunk timeouts in ${this.CHUNK_TIMEOUT_WINDOW_MS}ms - forcing stream restart to prevent transcript freeze`);

    // If Google never emitted a FINAL for the most recent partial, force-emit it
    if (this.lastPartialTranscript && this.lastPartialTranscript.trim().length > 0) {
      console.warn(`[GoogleSpeech] ⚠️ Forcing FINAL of latest partial before restart (${this.lastPartialTranscript.length} chars)`);
      if (this.resultCallback) {
        try {
          this.resultCallback(this.lastPartialTranscript, false, { forced: true });
        } catch (err) {
          console.error('[GoogleSpeech] ⚠️ Error forcing final transcript before restart:', err.message);
        }
      }
      this.lastPartialTranscript = '';
    }

    this.resetAudioPipelinesDueToTimeout();
    this.chunkTimeoutTimestamps = [];
    if (!this.isRestarting) {
      this.restartStream();
    }
  }

  resetAudioPipelinesDueToTimeout() {
    this.clearAllChunkTimeouts();
    for (const retryInfo of this.chunkRetryMap.values()) {
      if (retryInfo.retryTimer) {
        clearTimeout(retryInfo.retryTimer);
      }
    }
    this.chunkRetryMap.clear();
    this.jitterBuffer = [];
    this.audioQueue = [];
    this.isSending = false;
    this.pendingChunks = [];
  }

  clearAllChunkTimeouts() {
    for (const { timeout } of this.chunkTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.chunkTimeouts.clear();
  }

  /**
   * Queue chunk for retry with exponential backoff
   */
  queueChunkForRetry(chunkId, audioData, metadata, currentAttempts) {
    // Prevent infinite retry loops - check if already retrying
    const existingRetry = this.chunkRetryMap.get(chunkId);
    if (existingRetry && existingRetry.retryTimer) {
      // Already scheduled for retry, don't schedule another
      console.log(`[GoogleSpeech] ⚠️ Chunk ${chunkId} already has retry scheduled, skipping duplicate`);
      return;
    }

    if (currentAttempts >= this.MAX_CHUNK_RETRIES) {
      console.error(`[GoogleSpeech] ❌ Chunk ${chunkId} failed after ${this.MAX_CHUNK_RETRIES} retries, giving up`);
      this.chunkRetryMap.delete(chunkId);
      return;
    }

    // Don't retry if stream is restarting or if audio has been stopped for a while
    // Check if audio stopped more than 2 seconds ago (likely user paused)
    const audioStopped = this.lastAudioTime && (Date.now() - this.lastAudioTime > 2000);
    if (this.isRestarting || audioStopped) {
      console.log(`[GoogleSpeech] ⚠️ Skipping retry for chunk ${chunkId} - stream restarting or audio stopped`);
      this.chunkRetryMap.delete(chunkId);
      return;
    }

    const nextAttempt = currentAttempts + 1;
    const backoffDelay = this.RETRY_BACKOFF_MS[Math.min(currentAttempts, this.RETRY_BACKOFF_MS.length - 1)];

    const retryInfo = {
      attempts: nextAttempt,
      chunkData: audioData,
      metadata: metadata,
      lastAttempt: Date.now(),
      retryTimer: null // Will be set below
    };

    this.chunkRetryMap.set(chunkId, retryInfo);

    console.log(`[GoogleSpeech] 🔄 Scheduling retry ${nextAttempt}/${this.MAX_CHUNK_RETRIES} for chunk ${chunkId} in ${backoffDelay}ms`);

    const retryTimer = setTimeout(async () => {
      // Remove timer reference
      const currentRetry = this.chunkRetryMap.get(chunkId);
      if (currentRetry) {
        currentRetry.retryTimer = null;
      }

      // Check if chunk still needs retry and stream is ready
      const stillPending = this.chunkRetryMap.get(chunkId);
      if (stillPending && stillPending.attempts === nextAttempt) {
        // Only retry if stream is ready and audio is still active
        if (this.isStreamReady() && this.lastAudioTime && (Date.now() - this.lastAudioTime < 3000)) {
          await this.releaseChunkFromBuffer(chunkId, audioData, metadata);
        } else {
          // Stream not ready or audio stopped - give up
          console.log(`[GoogleSpeech] ⚠️ Abandoning retry for chunk ${chunkId} - stream not ready or audio stopped`);
          this.chunkRetryMap.delete(chunkId);
        }
      }
    }, backoffDelay);

    // Store timer reference so we can cancel it if needed
    retryInfo.retryTimer = retryTimer;
  }

  /**
   * Process audio chunk - add to jitter buffer and release after delay
   * @param {string} audioData - Base64 encoded PCM audio
   * @param {object} metadata - Optional metadata (chunkIndex, startMs, endMs, clientTimestamp)
   */
  async processAudio(audioData, metadata = {}) {
    // Generate unique chunk ID
    const chunkId = `chunk_${this.chunkIdCounter++}_${Date.now()}`;

    // Add to jitter buffer with timestamp
    const now = Date.now();
    this.jitterBuffer.push({
      chunkId,
      audioData,
      metadata,
      receivedAt: now,
      shouldReleaseAt: now + this.jitterBufferDelay
    });

    // Sort buffer by receive time to handle out-of-order chunks
    this.jitterBuffer.sort((a, b) => a.receivedAt - b.receivedAt);

    // Process jitter buffer - release chunks that are ready
    this.processJitterBuffer();
  }

  /**
   * Process jitter buffer - release chunks that are ready based on delay
   */
  processJitterBuffer() {
    const now = Date.now();

    // Clear any existing timer
    if (this.jitterBufferTimer) {
      clearTimeout(this.jitterBufferTimer);
    }

    // Release all chunks that are ready (past their release time)
    while (this.jitterBuffer.length > 0) {
      const chunk = this.jitterBuffer[0];
      const delay = now - chunk.receivedAt;

      // Release if delay is at least jitterBufferMin (80ms) and past release time
      if (delay >= this.jitterBufferMin && now >= chunk.shouldReleaseAt) {
        const released = this.jitterBuffer.shift();
        this.releaseChunkFromBuffer(released.chunkId, released.audioData, released.metadata);
        this.lastJitterRelease = now;
      } else {
        // Calculate when next chunk should be released
        const timeUntilRelease = chunk.shouldReleaseAt - now;
        if (timeUntilRelease > 0) {
          this.jitterBufferTimer = setTimeout(() => {
            this.processJitterBuffer();
          }, Math.min(timeUntilRelease, 50)); // Check at least every 50ms
        }
        break;
      }
    }

    // If buffer still has items but no timer set, set one
    if (this.jitterBuffer.length > 0 && !this.jitterBufferTimer) {
      const nextChunk = this.jitterBuffer[0];
      const timeUntilRelease = nextChunk.shouldReleaseAt - now;
      if (timeUntilRelease > 0) {
        this.jitterBufferTimer = setTimeout(() => {
          this.processJitterBuffer();
        }, Math.min(timeUntilRelease, 50));
      }
    }
  }

  /**
   * Clear chunk retry (cancel retry timer and remove from map)
   */
  clearChunkRetry(chunkId) {
    const retryInfo = this.chunkRetryMap.get(chunkId);
    if (retryInfo) {
      if (retryInfo.retryTimer) {
        clearTimeout(retryInfo.retryTimer);
        retryInfo.retryTimer = null;
      }
      this.chunkRetryMap.delete(chunkId);
    }
  }

  clearJitterBuffer() {
    // Release all pending chunks immediately before clearing
    while (this.jitterBuffer.length > 0) {
      const chunk = this.jitterBuffer.shift();
      // Clear retry tracking for chunks being cleared
      this.clearChunkRetry(chunk.chunkId);
      this.clearChunkTimeout(chunk.chunkId);
    }

    if (this.jitterBufferTimer) {
      clearTimeout(this.jitterBufferTimer);
      this.jitterBufferTimer = null;
    }

    // Also clear any pending chunks that were sent but not yet timed out
    for (const pending of this.pendingChunks) {
      this.clearChunkTimeout(pending.chunkId);
      this.clearChunkRetry(pending.chunkId);
    }
  }

  /**
   * Set callback for results (partial and final)
   * @param {Function} callback - (transcript, isPartial) => void
   */
  onResult(callback) {
    this.resultCallback = callback;
  }

  /**
   * Set callback for errors
   * @param {Function} callback - (error) => void
   */
  onError(callback) {
    this.errorCallback = callback;
  }

  /**
   * End the current audio stream (pause/stop speaking)
   */
  async endAudio() {
    console.log('[GoogleSpeech] Audio stream ended by client');
    // Don't close the stream, just wait for next audio
    // Google Speech will automatically finalize the current utterance
  }

  /**
   * Force commit current audio (simulate pause)
   * CRITICAL: Do NOT restart stream - this causes loss of audio in flight
   * 
   * Google Speech will NATURALLY send FINALs when it detects:
   * - Natural pauses in speech
   * - Sentence boundaries  
   * - VAD (Voice Activity Detection) silence
   * - End of utterances
   * 
   * These FINALs will still:
   * - Be processed by processFinalText()
   * - Be sent to frontend
   * - Be committed to history via commitFinalToHistoryRef
   * 
   * Restarting the stream was cutting off audio that's still being processed,
   * causing words to be lost between artificial line breaks. By NOT restarting,
   * Google Speech continues processing all audio and sends FINALs naturally.
   */
  async forceCommit() {
    console.log('[GoogleSpeech] Force commit requested - NOT restarting stream to preserve audio in flight');
    console.log('[GoogleSpeech] ✅ Google Speech will still send FINALs naturally when it detects pauses/boundaries');
    console.log('[GoogleSpeech] ✅ All FINALs will still be processed and committed to history');
    // DO NOT restart stream - this causes loss of words between artificial line breaks
    // Google Speech will naturally finalize when it detects a pause or completes processing
    // If we restart here, we lose audio that's still being processed
    return;
  }

  /**
   * Clean up and close the stream
   */
  destroy() {
    console.log('[GoogleSpeech] Destroying stream...');

    this.isActive = false;
    this.shouldAutoRestart = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.recognizeStream) {
      try {
        this.recognizeStream.removeAllListeners();
        this.recognizeStream.end();
      } catch (err) {
        console.warn('[GoogleSpeech] Error destroying stream:', err.message);
      }
      this.recognizeStream = null;
    }

    // Clean up audio buffer manager
    if (this.audioBufferManager) {
      this.audioBufferManager.destroy();
      console.log('[GoogleSpeech] Audio buffer manager destroyed');
    }

    this.audioQueue = [];
    this.resultCallback = null;

    console.log('[GoogleSpeech] Stream destroyed');
  }

  /**
   * Get recent audio from buffer for recovery operations
   * @param {number} durationMs - Duration in milliseconds to retrieve
   * @returns {Buffer} Concatenated audio buffer
   */
  getRecentAudio(durationMs = 600) {
    if (!this.audioBufferManager) {
      console.warn('[GoogleSpeech] AudioBufferManager not initialized');
      return Buffer.alloc(0);
    }
    return Buffer.concat(this.audioBufferManager.getRecentAudio(durationMs));
  }

  /**
   * Flush audio buffer (get last N ms of audio)
   * Typically used on natural finals to send last 600ms
   * @returns {Buffer} Flushed audio
   */
  flushAudioBuffer() {
    if (!this.audioBufferManager) {
      console.warn('[GoogleSpeech] AudioBufferManager not initialized');
      return Buffer.alloc(0);
    }
    return this.audioBufferManager.flush();
  }

  /**
   * Get audio buffer status for monitoring
   * @returns {Object} Buffer status
   */
  getAudioBufferStatus() {
    if (!this.audioBufferManager) {
      return { error: 'AudioBufferManager not initialized' };
    }
    return this.audioBufferManager.getStatus();
  }

  /**
   * Get stream statistics
   */
  getStats() {
    const audioBufferStatus = this.getAudioBufferStatus();

    return {
      isActive: this.isActive,
      isRestarting: this.isRestarting,
      restartCount: this.restartCount,
      elapsedTime: Date.now() - this.startTime,
      queuedAudio: this.audioQueue.length,
      languageCode: this.languageCode,
      streamReady: this.isStreamReady(),
      audioBuffer: {
        chunks: audioBufferStatus.chunks || 0,
        durationMs: audioBufferStatus.durationMs || 0,
        utilizationPercent: audioBufferStatus.utilizationPercent || 0
      }
    };
  }
}