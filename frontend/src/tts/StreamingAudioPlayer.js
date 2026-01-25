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

        // Wait for MediaSource to open
        await new Promise((resolve, reject) => {
            this.mediaSource.addEventListener('sourceopen', resolve, { once: true });
            this.mediaSource.addEventListener('error', reject, { once: true });
        });

        // Create SourceBuffer for MP3
        const mimeType = 'audio/mpeg';
        if (!MediaSource.isTypeSupported(mimeType)) {
            const error = new Error(`MIME type ${mimeType} not supported`);
            console.error('[StreamingPlayer]', error);
            if (this.onError) this.onError(error);
            throw error;
        }

        this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
        this.sourceBuffer.mode = 'sequence';

        // Handle buffer updates
        this.sourceBuffer.addEventListener('updateend', () => {
            this.isAppending = false;
            this._processQueue();
            this._updateBufferedMs();
        });

        this.sourceBuffer.addEventListener('error', (e) => {
            console.error('[StreamingPlayer] SourceBuffer error:', e);
            if (this.onError) this.onError(e);
        });

        // Handle playback events
        this.audioElement.addEventListener('waiting', () => {
            this.underruns++;
            console.warn('[StreamingPlayer] Underrun detected, total:', this.underruns);
            if (this.onUnderrun) this.onUnderrun(this.underruns);
        });

        this.isStarted = true;
        console.log('[StreamingPlayer] Started successfully');
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

        // Check if source buffer is ready
        if (this.sourceBuffer.updating) {
            return;
        }

        const { meta, audioBytes } = this.queue.shift();

        try {
            this.isAppending = true;
            this.sourceBuffer.appendBuffer(audioBytes);
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
                const bufferedEnd = buffered.end(buffered.length - 1);
                this.bufferedMs = Math.max(0, (bufferedEnd - currentTime) * 1000);
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
