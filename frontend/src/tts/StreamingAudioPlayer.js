/**
 * Streaming Audio Player
 * 
 * Real-time audio playback using MediaSource Extensions for MP3 streaming.
 * Receives audio chunks over WebSocket and plays them with a jitter buffer.
 */

/**
 * StreamingAudioPlayer class
 * 
 * Manages real-time audio playback of streamed MP3 chunks using MediaSource API.
 */
export class StreamingAudioPlayer {
    constructor(config = {}) {
        this.jitterBufferMs = config.jitterBufferMs || 300;
        this.onBufferUpdate = config.onBufferUpdate || null;
        this.onUnderrun = config.onUnderrun || null;
        this.onError = config.onError || null;

        // State
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.audioElement = null;
        this.queue = [];
        this.isAppending = false;
        this.isStarted = false;
        this.bufferedMs = 0;
        this.underruns = 0;

        // Current stream info
        this.currentStreamId = null;
        this.currentSegmentId = null;

        // Metrics
        this.bytesReceived = 0;
        this.chunksReceived = 0;
    }

    /**
     * Initialize and start playback
     * @param {Object} streamConfig - { streamId, codec, sampleRate, channels }
     */
    async start(streamConfig) {
        console.log('[StreamingPlayer] Starting with config:', streamConfig);

        this.currentStreamId = streamConfig.streamId;

        // Create audio element
        this.audioElement = new Audio();
        this.audioElement.autoplay = true;

        // Check MediaSource support
        if (!window.MediaSource) {
            const error = new Error('MediaSource API not supported');
            console.error('[StreamingPlayer]', error);
            if (this.onError) this.onError(error);
            throw error;
        }

        // Create MediaSource
        this.mediaSource = new MediaSource();
        this.audioElement.src = URL.createObjectURL(this.mediaSource);

        if (window.audioDebug) window.audioDebug('Creating MediaSource');
        // Wait for MediaSource to open — with a safety timeout.
        // On all browsers, if sourceopen never fires (e.g. stale audio context,
        // browser resource limit), this previously hung forever, preventing
        // audio.hello from being sent and silently breaking TTS.
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (window.audioDebug) window.audioDebug('MediaSource sourceopen timed out after 5s');
                reject(new Error('[StreamingPlayer] MediaSource sourceopen timed out after 5s — browser may be resource-limited'));
            }, 5000);
            this.mediaSource.addEventListener('sourceopen', () => {
                if (window.audioDebug) window.audioDebug('MediaSource sourceopen fired!');
                clearTimeout(timer);
                resolve();
            }, { once: true });
            this.mediaSource.addEventListener('error', (e) => {
                clearTimeout(timer);
                reject(e);
            }, { once: true });
        });

        // Create SourceBuffer on demand or use default
        await this._initSourceBuffer(streamConfig.codec || 'mp3');

        // Handle playback events
        this.audioElement.addEventListener('waiting', () => {
            this.underruns++;
            console.warn('[StreamingPlayer] Underrun detected, total:', this.underruns);
            if (this.onUnderrun) this.onUnderrun(this.underruns);
        });

        this.isStarted = true;

        // Apply initial playback rate if provided
        if (streamConfig.playbackRate) {
            this.setPlaybackRate(streamConfig.playbackRate);
        }

        console.log('[StreamingPlayer] Started successfully');
    }

    /**
     * Set playback rate
     * @param {number} rate
     */
    setPlaybackRate(rate) {
        if (this.audioElement) {
            const safeRate = Math.max(0.5, Math.min(4.0, rate));
            this.audioElement.playbackRate = safeRate;
            console.log(`[StreamingPlayer] Set playbackRate to ${safeRate}x`);
        }
    }

    /**
     * Initialize SourceBuffer with correct MIME type
     * @private
     */
    async _initSourceBuffer(codec) {
        if (!this.mediaSource || this.mediaSource.readyState !== 'open') return;

        let mimeType = 'audio/mpeg'; // default mp3
        if (codec === 'opus' || codec === 'ogg_opus') {
            // Robust detection of supported Opus container
            const opusTypes = [
                'audio/webm; codecs="opus"',
                'audio/webm; codecs=opus',
                'audio/ogg; codecs="opus"',
                'audio/ogg; codecs=opus',
                'audio/mp4; codecs="opus"' // Safari might prefer this
            ];

            const supported = opusTypes.find(t => MediaSource.isTypeSupported(t));
            if (supported) {
                mimeType = supported;
                console.log(`[StreamingPlayer] Selected supported Opus format: ${mimeType}`);
            } else {
                console.warn('[StreamingPlayer] No supported Opus format found, defaulting to audio/ogg');
                mimeType = 'audio/ogg; codecs="opus"';
            }
        }

        // Check if current buffer matches and needs switching
        if (this.sourceBuffer && this.currentMimeType !== mimeType) {
            console.log(`[StreamingPlayer] Switching codec from ${this.currentMimeType} to ${mimeType}`);

            // Clear queue to prevent appending wrong format data to new buffer
            this.queue = [];
            this.isAppending = false;

            const oldBuffer = this.sourceBuffer;
            this.sourceBuffer = null; // Prevent use during removal

            try {
                // Abort any pending operations
                if (oldBuffer.updating) {
                    oldBuffer.abort();
                }
                this.mediaSource.removeSourceBuffer(oldBuffer);
                console.log('[StreamingPlayer] Removed old SourceBuffer');
            } catch (e) {
                console.warn('[StreamingPlayer] Error removing source buffer:', e);
            }
        }

        if (!this.sourceBuffer) {
            // Try to add SourceBuffer
            console.log(`[StreamingPlayer] Creating SourceBuffer for ${mimeType}`);
            try {
                this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
            } catch (e) {
                console.error(`[StreamingPlayer] Failed to add SourceBuffer for ${mimeType}:`, e);

                // Retry logic for QuotaExceededError or Limit Error
                if (e.name === 'QuotaExceededError' || e.message.includes('limit')) {
                    console.log('[StreamingPlayer] Quota exceeded, performing full MediaSource reset...');
                    try {
                        await this._resetMediaSource();
                        this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
                        console.log('[StreamingPlayer] Reset and retry successful');
                    } catch (retryErr) {
                        console.error('[StreamingPlayer] Reset retry failed:', retryErr);
                        if (this.onError) this.onError(retryErr);
                        return;
                    }
                } else {
                    if (this.onError) this.onError(e);
                    return;
                }
            }

            this.sourceBuffer.mode = 'sequence';
            this._setupSourceBufferListeners();
        }
    }

    /**
     * Hard reset of MediaSource pipeline to recover from QuotaExceededError
     * @private
     */
    async _resetMediaSource() {
        console.log('[StreamingPlayer] Performing hard reset of MediaSource pipeline...');
        if (this.mediaSource) {
            try {
                if (this.mediaSource.readyState === 'open') {
                    this.mediaSource.endOfStream();
                }
            } catch (ignore) { }
            // Remove old listeners to prevent leaks
            this.mediaSource = null;
        }

        this.mediaSource = new MediaSource();
        // Revoke old object URL if possible? Browser handles it usually.
        this.audioElement.src = URL.createObjectURL(this.mediaSource);

        await new Promise((resolve, reject) => {
            const onOpen = () => {
                this.mediaSource.removeEventListener('error', onError);
                resolve();
            };
            const onError = (e) => {
                this.mediaSource.removeEventListener('sourceopen', onOpen);
                reject(e);
            };
            this.mediaSource.addEventListener('sourceopen', onOpen, { once: true });
            this.mediaSource.addEventListener('error', onError, { once: true });

            // Safety timeout
            setTimeout(() => reject(new Error('MediaSource open timeout')), 5000);
        });
        console.log('[StreamingPlayer] MediaSource reset complete');
    }

    /**
     * Attach listeners to the active SourceBuffer
     * @private
     */
    _setupSourceBufferListeners() {
        if (!this.sourceBuffer) return;

        this.sourceBuffer.addEventListener('updateend', () => {
            this.isAppending = false;
            // Try to start playback after first chunk
            this._checkPlaybackStart();
            this._processQueue();
            this._updateBufferedMs();
        });

        this.sourceBuffer.addEventListener('error', (e) => {
            console.error('[StreamingPlayer] SourceBuffer error:', e);
            if (this.onError) this.onError(e);
        });
    }



    /**
     * Helper to start playback
     * @private
     */
    _checkPlaybackStart() {
        if (this.audioElement && this.audioElement.paused && this.sourceBuffer && this.sourceBuffer.buffered.length > 0) {
            const bufferedMs = this.getBufferedMs();
            // Wait for jitter buffer before starting (default 300ms)
            if (bufferedMs >= (this.jitterBufferMs || 300)) {
                console.log(`[StreamingPlayer] Buffering complete (${bufferedMs.toFixed(0)}ms), starting playback...`);
                this.audioElement.play()
                    .then(() => {
                        console.log('[StreamingPlayer] Playback started successfully');
                    })
                    .catch(err => {
                        console.error('[StreamingPlayer] Failed to start playback:', err);
                    });
            } else {
                console.log(`[StreamingPlayer] Buffering... ${bufferedMs.toFixed(0)}ms / ${this.jitterBufferMs || 300}ms`);
            }
        }
    }

    /**
     * Handle start of new segment/stream
     * @param {Object} message - audio.start message with codec
     */
    handleStartMessage(message) {
        if (message.codec) {
            this._initSourceBuffer(message.codec);
        }
    }

    /**
     * Enqueue audio chunk for playback
     * @param {Object} meta - { streamId, segmentId, version, chunkIndex, isLast }
     * @param {Uint8Array} audioBytes - Raw audio data
     */
    enqueue(meta, audioBytes) {
        if (!this.isStarted) {
            console.warn('[StreamingPlayer] Not started, dropping chunk');
            return;
        }

        // Track current segment
        this.currentSegmentId = meta.segmentId;

        console.log(`[StreamingPlayer] Enqueued chunk ${meta.chunkIndex} for segment ${meta.segmentId}: ${audioBytes.length} bytes, isLast=${meta.isLast}`);

        // Skip empty chunks (end-of-stream markers)
        if (audioBytes.length === 0) {
            console.log('[StreamingPlayer] Skipping empty chunk (end marker)');
            return;
        }

        // Add to queue
        this.queue.push({ meta, audioBytes });
        this.bytesReceived += audioBytes.length;
        this.chunksReceived++;

        // Process queue
        this._processQueue();
    }

    /**
     * Process queued chunks
     * @private
     */
    _processQueue() {
        if (this.isAppending || !this.sourceBuffer || this.queue.length === 0) {
            return;
        }

        // Ensure MediaSource is open
        if (!this.mediaSource || this.mediaSource.readyState !== 'open') {
            return;
        }

        // Check if source buffer is ready
        if (this.sourceBuffer.updating) {
            return;
        }

        const { meta, audioBytes } = this.queue.shift();

        console.log(`[StreamingPlayer] Appending chunk ${meta.chunkIndex} to buffer: ${audioBytes.length} bytes`);

        try {
            this.isAppending = true;
            this.sourceBuffer.appendBuffer(audioBytes);
            console.log(`[StreamingPlayer] Successfully appended chunk ${meta.chunkIndex}`);
        } catch (e) {
            console.error('[StreamingPlayer] Error appending buffer:', e);
            this.isAppending = false;
            if (this.onError) this.onError(e);
        }
    }

    /**
     * Update buffered duration
     * @private
     */
    _updateBufferedMs() {
        if (!this.audioElement || !this.sourceBuffer) {
            this.bufferedMs = 0;
            return;
        }

        try {
            const buffered = this.sourceBuffer.buffered;
            if (buffered.length > 0) {
                const currentTime = this.audioElement.currentTime;

                // Find continuous range containing current time
                let rangeEnd = currentTime;
                let foundRange = false;

                for (let i = 0; i < buffered.length; i++) {
                    const start = buffered.start(i);
                    const end = buffered.end(i);

                    // Allow small tolerance (0.1s) for gaps
                    if (currentTime >= start - 0.1 && currentTime <= end + 0.1) {
                        rangeEnd = end;
                        foundRange = true;
                    }
                }

                if (foundRange) {
                    this.bufferedMs = Math.max(0, (rangeEnd - currentTime) * 1000);
                } else {
                    this.bufferedMs = 0;
                }

                if (buffered.length > 1) {
                    // console.warn(`[StreamingPlayer] Buffer fragmented! ${buffered.length} ranges`);
                }
            } else {
                this.bufferedMs = 0;
            }
        } catch (e) {
            this.bufferedMs = 0;
        }

        if (this.onBufferUpdate) {
            this.onBufferUpdate(this.bufferedMs);
        }
    }

    /**
     * Stop playback and clean up
     * @param {string} reason - Reason for stopping
     */
    stop(reason = 'user') {
        console.log('[StreamingPlayer] Stopping:', reason);

        this.isStarted = false;
        this.queue = [];

        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.src = '';
            this.audioElement = null;
        }

        if (this.mediaSource && this.mediaSource.readyState === 'open') {
            try {
                this.mediaSource.endOfStream();
            } catch (e) {
                // Ignore errors during cleanup
            }
        }

        this.mediaSource = null;
        this.sourceBuffer = null;
        this.currentStreamId = null;
        this.currentSegmentId = null;

        console.log('[StreamingPlayer] Stopped. Stats:', {
            bytesReceived: this.bytesReceived,
            chunksReceived: this.chunksReceived,
            underruns: this.underruns
        });
    }

    /**
     * Get current buffered duration in milliseconds
     * @returns {number}
     */
    getBufferedMs() {
        this._updateBufferedMs();
        return this.bufferedMs;
    }

    /**
     * Get playback statistics
     * @returns {Object}
     */
    getStats() {
        return {
            bytesReceived: this.bytesReceived,
            chunksReceived: this.chunksReceived,
            bufferedMs: this.bufferedMs,
            underruns: this.underruns,
            currentStreamId: this.currentStreamId,
            currentSegmentId: this.currentSegmentId
        };
    }
}

/**
 * Decode a binary audio frame from WebSocket
 * Client-side version of decodeAudioFrame
 * @param {ArrayBuffer} frame - Binary frame data
 * @returns {{ meta: Object, audioBytes: Uint8Array }}
 */
export function decodeAudioFrame(frame) {
    const bytes = new Uint8Array(frame);

    // Validate magic bytes
    const magic = new TextDecoder().decode(bytes.slice(0, 4));
    if (magic !== 'EXA1') {
        throw new Error(`Invalid frame magic: expected EXA1, got ${magic}`);
    }

    // Get header length
    const headerLen = bytes[4];

    // Decode metadata
    const metaBytes = bytes.slice(5, 5 + headerLen);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes));

    // Extract audio data
    const audioBytes = bytes.slice(5 + headerLen);

    return { meta, audioBytes };
}
