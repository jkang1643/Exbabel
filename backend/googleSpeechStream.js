/**
 * Google Cloud Speech-to-Text Streaming Service
 * Provides live streaming transcription with partial results
 *
 * This replaces OpenAI Realtime API with Google's superior streaming transcription
 * which provides true word-by-word partial results with high accuracy.
 *
 * AUTHENTICATION OPTIONS:
 * 1. Service Account JSON (default) - More secure, recommended for production
 * 2. API Key (simpler) - Set GOOGLE_SPEECH_API_KEY env variable
 */

import speech from '@google-cloud/speech';
import { Buffer } from 'buffer';

const LANGUAGE_CODES = {
  'en': 'en-US',
  'es': 'es-ES',
  'fr': 'fr-FR',
  'de': 'de-DE',
  'it': 'it-IT',
  'pt': 'pt-PT',
  'pt-BR': 'pt-BR',
  'ru': 'ru-RU',
  'ja': 'ja-JP',
  'ko': 'ko-KR',
  'zh': 'zh-CN',
  'zh-TW': 'zh-TW',
  'ar': 'ar-SA',
  'hi': 'hi-IN',
  'nl': 'nl-NL',
  'pl': 'pl-PL',
  'tr': 'tr-TR',
  'bn': 'bn-IN',
  'vi': 'vi-VN',
  'th': 'th-TH',
  'id': 'id-ID',
  'sv': 'sv-SE',
  'no': 'no-NO',
  'da': 'da-DK',
  'fi': 'fi-FI',
  'el': 'el-GR',
  'cs': 'cs-CZ',
  'ro': 'ro-RO',
  'hu': 'hu-HU',
  'he': 'he-IL',
  'uk': 'uk-UA',
  'fa': 'fa-IR',
  'ur': 'ur-PK',
  'ta': 'ta-IN',
  'te': 'te-IN',
  'mr': 'mr-IN',
  'gu': 'gu-IN',
  'kn': 'kn-IN',
  'ml': 'ml-IN',
  'sw': 'sw-KE',
  'fil': 'fil-PH',
  'ms': 'ms-MY',
  'ca': 'ca-ES',
  'sk': 'sk-SK',
  'bg': 'bg-BG',
  'hr': 'hr-HR',
  'sr': 'sr-RS',
  'lt': 'lt-LT',
  'lv': 'lv-LV',
  'et': 'et-EE',
  'sl': 'sl-SI',
  'af': 'af-ZA'
};

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

    // Google Speech has a 305 second (5 min) streaming limit
    // We'll restart the stream every 4 minutes to be safe
    this.STREAMING_LIMIT = 240000; // 4 minutes in milliseconds
    this.startTime = Date.now();
    
    // Jitter buffer: Queue audio chunks to handle network jitter (200-400ms, target 300ms)
    this.jitterBuffer = [];
    this.jitterBufferDelay = 250; // 250ms target delay (reduced from 300ms for better responsiveness)
    this.jitterBufferMin = 200; // Minimum 200ms
    this.jitterBufferMax = 400; // Maximum 400ms
    this.jitterBufferTimer = null;
    this.lastJitterRelease = Date.now();
    
    // Chunk retry tracking: Track failed chunks and retry up to 3 times
    this.chunkRetryMap = new Map(); // chunkId -> { attempts: number, chunkData, metadata, lastAttempt }
    this.MAX_CHUNK_RETRIES = 3;
    this.RETRY_BACKOFF_MS = [100, 200, 400]; // Exponential backoff delays
    
    // Per-chunk timeout tracking: Detect stuck chunks
    // Increased timeout to account for jitter buffer (300ms) + processing time
    this.chunkTimeouts = new Map(); // chunkId -> { timeout handle, sendTimestamp }
    this.CHUNK_TIMEOUT_MS = 7000; // 7 seconds (5s + 2s buffer for jitter/processing)
    this.chunkIdCounter = 0;
    
    // Track pending chunks in send order for better timeout clearing
    this.pendingChunks = []; // Array of { chunkId, sendTimestamp }
  }

  /**
   * Initialize the Google Speech client and start streaming
   */
  async initialize(sourceLang) {
    console.log(`[GoogleSpeech] Initializing streaming transcription for ${sourceLang}...`);

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

    this.client = new speech.SpeechClient(clientOptions);

    // Get language code for Google Speech
    this.languageCode = LANGUAGE_CODES[sourceLang] || LANGUAGE_CODES[sourceLang.split('-')[0]] || 'en-US';
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

    const request = {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 24000, // Match frontend audio capture
        languageCode: this.languageCode,
        enableAutomaticPunctuation: true,
        useEnhanced: true,
        model: 'latest_long', // Use latest_long model for best accuracy
        // Enable Chirp 3 model if available
        alternativeLanguageCodes: [],
      },
      interimResults: true, // CRITICAL: Enable partial results
    };

    // Create streaming recognition stream
    this.recognizeStream = this.client
      .streamingRecognize(request)
      .on('error', (error) => {
        console.error('[GoogleSpeech] Stream error:', error);
        
        // Mark as inactive immediately
        this.isActive = false;

        // Handle common errors
        if (error.code === 11) {
          console.log('[GoogleSpeech] Audio timeout - restarting stream...');
          if (!this.isRestarting) {
            this.restartStream();
          }
        } else if (error.code === 3) {
          console.error('[GoogleSpeech] Invalid argument error - check audio format');
        } else {
          console.error('[GoogleSpeech] Unhandled error:', error.message);
        }

        // Notify caller of error if callback exists
        if (this.errorCallback) {
          this.errorCallback(error);
        }
      })
      .on('data', (data) => {
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
    // Prevent multiple simultaneous restarts
    if (this.isRestarting) {
      console.log('[GoogleSpeech] Restart already in progress, skipping...');
      return;
    }

    this.isRestarting = true;
    this.restartCount++;
    console.log(`[GoogleSpeech] 🔄 Restarting stream (restart #${this.restartCount})...`);

    // Mark as inactive during restart
    this.isActive = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Small delay to ensure clean shutdown
    await new Promise(resolve => setTimeout(resolve, 100));

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

    const result = data.results[0];
    if (!result.alternatives || result.alternatives.length === 0) {
      return;
    }

    const transcript = result.alternatives[0].transcript;
    const isFinal = result.isFinal;
    const stability = result.stability || 0;

    // Clear chunk timeouts on successful result
    // Google Speech processes chunks in order, so clear oldest pending chunks
    // Clear multiple timeouts since partial results come frequently and might clear multiple chunks
    const chunksToClear = Math.min(
      isFinal ? 3 : 1, // Final results might correspond to multiple chunks, partials usually 1
      this.pendingChunks.length
    );
    
    for (let i = 0; i < chunksToClear && this.pendingChunks.length > 0; i++) {
      const oldestChunk = this.pendingChunks.shift();
      this.clearChunkTimeout(oldestChunk.chunkId);
      console.log(`[GoogleSpeech] ✅ Cleared timeout for chunk ${oldestChunk.chunkId} (result received)`);
    }

    if (isFinal) {
      // Final result - high confidence
      console.log(`[GoogleSpeech] ✅ FINAL: "${transcript}"`);
      if (this.resultCallback) {
        this.resultCallback(transcript, false); // isPartial = false
      }
    } else {
      // Interim result - partial transcription
      // console.log(`[GoogleSpeech] 🔵 PARTIAL (stability: ${stability.toFixed(2)}): "${transcript}"`);
      if (this.resultCallback) {
        this.resultCallback(transcript, true); // isPartial = true
      }
    }
  }

  /**
   * Check if stream is ready to accept audio
   */
  isStreamReady() {
    return this.recognizeStream && 
           this.recognizeStream.writable && 
           !this.recognizeStream.destroyed && 
           !this.recognizeStream.writableEnded &&
           this.isActive &&
           !this.isRestarting;
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

      // Double-check stream is still ready
      if (this.isStreamReady()) {
        this.recognizeStream.write(audioBuffer);
        
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
   * Set timeout for chunk processing (7s to account for jitter buffer + processing)
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
      
      // Queue for retry
      const retryInfo = this.chunkRetryMap.get(chunkId);
      const attempts = retryInfo ? retryInfo.attempts : 0;
      this.queueChunkForRetry(chunkId, audioData, metadata, attempts);
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
      
      // Release if delay is at least jitterBufferMin (200ms) and past release time
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
   */
  async forceCommit() {
    console.log('[GoogleSpeech] Force commit requested - restarting stream');
    // Restart stream to force finalization
    if (!this.isRestarting) {
      await this.restartStream();
    }
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

    this.audioQueue = [];
    this.resultCallback = null;

    console.log('[GoogleSpeech] Stream destroyed');
  }

  /**
   * Get stream statistics
   */
  getStats() {
    return {
      isActive: this.isActive,
      isRestarting: this.isRestarting,
      restartCount: this.restartCount,
      elapsedTime: Date.now() - this.startTime,
      queuedAudio: this.audioQueue.length,
      languageCode: this.languageCode,
      streamReady: this.isStreamReady()
    };
  }
}