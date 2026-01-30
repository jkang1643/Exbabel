/**
 * AudioBufferManager - Production-grade rolling audio buffer
 *
 * PURPOSE:
 * Maintains a continuous rolling buffer of the last 1500ms of raw PCM audio.
 * Intercepts EVERY audio chunk flowing through the pipeline to enable:
 * - Audio replay for recovery after forced commits
 * - Resubmission to STT when text extension detects missing words
 * - Flush operations (send last 600ms on natural finals)
 * - Debugging and quality analysis
 *
 * ARCHITECTURE:
 * - Circular ring buffer for memory efficiency
 * - Timestamp-based chunk tracking
 * - Automatic expiration of old chunks (> 1500ms)
 * - Thread-safe operations for concurrent access
 *
 * INTEGRATION:
 * Every audio chunk passes through addChunk() BEFORE being sent to Google Speech.
 * This creates a continuous window of recent audio always available for recovery.
 */

import { EventEmitter } from 'events';

export class AudioBufferManager extends EventEmitter {
  constructor(options = {}) {
    super();

    // Configuration (tunable)
    this.bufferDurationMs = options.bufferDurationMs || 1500; // Rolling window duration
    this.flushDurationMs = options.flushDurationMs || 600;    // Duration to flush on natural final
    this.maxChunks = options.maxChunks || 200;                // Safety limit: max chunks in buffer
    this.enableMetrics = options.enableMetrics !== false;     // Enable metrics collection
    this.logger = options.logger || console;                  // Logger instance

    // Circular ring buffer: stores {chunk, timestamp, metadata}
    this.buffer = [];
    this.bufferIndex = 0; // Current write position in circular buffer
    this.totalChunksReceived = 0;
    this.totalBytesReceived = 0;

    // Chunk tracking
    this.oldestChunkTimestamp = null;
    this.newestChunkTimestamp = null;

    // Metrics
    this.metrics = {
      chunksAdded: 0,
      chunksExpired: 0,
      chunksExtracted: 0,
      flushOperations: 0,
      averageChunkSize: 0,
      bufferUtilization: 0, // Percentage of buffer capacity used
    };

    // Cleanup timer for expired chunks
    this.cleanupInterval = setInterval(() => this._cleanupExpiredChunks(), 500); // Clean every 500ms

    this.logger.info('[AudioBuffer] 🎵 AudioBufferManager initialized', {
      bufferDurationMs: this.bufferDurationMs,
      flushDurationMs: this.flushDurationMs,
      maxChunks: this.maxChunks,
    });
  }

  /**
   * Add audio chunk to rolling buffer
   * CRITICAL: Call this for EVERY audio chunk before sending to STT
   *
   * @param {Buffer} audioChunk - Raw PCM audio data
   * @param {Object} metadata - Optional metadata {chunkId, source, sampleRate, etc.}
   */
  addChunk(audioChunk, metadata = {}) {
    if (!audioChunk || audioChunk.length === 0) {
      this.logger.warn('[AudioBuffer] ⚠️ Received empty audio chunk, skipping');
      return;
    }

    const timestamp = Date.now();
    const chunkSize = audioChunk.length;

    // Create chunk entry
    const entry = {
      chunk: Buffer.from(audioChunk), // Copy to prevent external modification
      timestamp,
      metadata: {
        ...metadata,
        chunkId: metadata.chunkId || `chunk_${this.totalChunksReceived}`,
        size: chunkSize,
      },
    };

    // Add to circular buffer
    if (this.buffer.length < this.maxChunks) {
      // Buffer not full yet - append
      this.buffer.push(entry);
    } else {
      // Buffer full - overwrite oldest (circular)
      this.buffer[this.bufferIndex] = entry;
      this.bufferIndex = (this.bufferIndex + 1) % this.maxChunks;
    }

    // Update tracking
    this.totalChunksReceived++;
    this.totalBytesReceived += chunkSize;
    this.newestChunkTimestamp = timestamp;

    if (this.oldestChunkTimestamp === null) {
      this.oldestChunkTimestamp = timestamp;
    }

    // Update metrics
    if (this.enableMetrics) {
      this.metrics.chunksAdded++;
      this.metrics.averageChunkSize = this.totalBytesReceived / this.totalChunksReceived;
      this.metrics.bufferUtilization = (this.buffer.length / this.maxChunks) * 100;
    }

    // Emit event for monitoring
    this.emit('chunk_added', {
      chunkId: entry.metadata.chunkId,
      size: chunkSize,
      timestamp,
      bufferSize: this.buffer.length,
    });

    // Debug logging (throttled)
    if (this.totalChunksReceived % 100 === 0) {
      this.logger.debug('[AudioBuffer] 📊 Buffer status', {
        chunks: this.buffer.length,
        totalReceived: this.totalChunksReceived,
        bufferDurationMs: this.getBufferDurationMs(),
        utilizationPercent: this.metrics.bufferUtilization.toFixed(1),
      });
    }
  }

  /**
   * Get audio chunks from the last N milliseconds
   * Used for recovery operations and flush
   *
   * @param {number} durationMs - Duration to extract (e.g., 600ms for flush)
   * @param {number} endTimestamp - Optional end timestamp (defaults to now)
   * @returns {Buffer[]} Array of audio chunks
   */
  getRecentAudio(durationMs, endTimestamp = null) {
    const now = endTimestamp || Date.now();
    const startTimestamp = now - durationMs;

    const chunks = this.buffer
      .filter(entry => entry.timestamp >= startTimestamp && entry.timestamp <= now)
      .sort((a, b) => a.timestamp - b.timestamp) // Ensure chronological order
      .map(entry => entry.chunk);

    if (this.enableMetrics) {
      this.metrics.chunksExtracted += chunks.length;
    }

    this.logger.info('[AudioBuffer] 🎵 Extracted recent audio', {
      durationMs,
      chunksExtracted: chunks.length,
      totalBytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      startTime: new Date(startTimestamp).toISOString(),
      endTime: new Date(now).toISOString(),
    });

    this.emit('audio_extracted', {
      durationMs,
      chunksExtracted: chunks.length,
      startTimestamp,
      endTimestamp: now,
    });

    return chunks;
  }

  /**
   * Flush operation: Get last N ms of audio for resubmission
   * Typically used on natural finals to send last 600ms
   *
   * @returns {Buffer} Concatenated audio buffer
   */
  flush() {
    const chunks = this.getRecentAudio(this.flushDurationMs);

    if (chunks.length === 0) {
      this.logger.warn('[AudioBuffer] ⚠️ Flush operation found no audio chunks');
      return Buffer.alloc(0);
    }

    const flushedAudio = Buffer.concat(chunks);

    if (this.enableMetrics) {
      this.metrics.flushOperations++;
    }

    this.logger.info('[AudioBuffer] 🚀 Flush operation completed', {
      chunksFlush: chunks.length,
      totalBytes: flushedAudio.length,
      durationMs: this.flushDurationMs,
    });

    this.emit('flush', {
      chunks: chunks.length,
      bytes: flushedAudio.length,
      durationMs: this.flushDurationMs,
    });

    return flushedAudio;
  }

  /**
   * Get audio for a specific time range
   * Used for targeted recovery operations
   *
   * @param {number} startTimestamp - Start time (ms)
   * @param {number} endTimestamp - End time (ms)
   * @returns {Buffer} Concatenated audio buffer
   */
  getAudioRange(startTimestamp, endTimestamp) {
    const chunks = this.buffer
      .filter(entry => entry.timestamp >= startTimestamp && entry.timestamp <= endTimestamp)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(entry => entry.chunk);

    if (chunks.length === 0) {
      this.logger.warn('[AudioBuffer] ⚠️ No audio found in range', {
        start: new Date(startTimestamp).toISOString(),
        end: new Date(endTimestamp).toISOString(),
      });
      return Buffer.alloc(0);
    }

    return Buffer.concat(chunks);
  }

  /**
   * Get current buffer status
   * Useful for monitoring and debugging
   */
  getStatus() {
    const durationMs = this.getBufferDurationMs();

    return {
      chunks: this.buffer.length,
      maxChunks: this.maxChunks,
      utilizationPercent: (this.buffer.length / this.maxChunks) * 100,
      durationMs,
      targetDurationMs: this.bufferDurationMs,
      oldestChunkAge: this.oldestChunkTimestamp ? Date.now() - this.oldestChunkTimestamp : 0,
      newestChunkAge: this.newestChunkTimestamp ? Date.now() - this.newestChunkTimestamp : 0,
      totalBytesStored: this.buffer.reduce((sum, entry) => sum + entry.chunk.length, 0),
      metrics: { ...this.metrics },
    };
  }

  /**
   * Get actual duration covered by current buffer
   */
  getBufferDurationMs() {
    if (this.buffer.length === 0) return 0;

    const timestamps = this.buffer.map(entry => entry.timestamp);
    const oldest = Math.min(...timestamps);
    const newest = Math.max(...timestamps);

    return newest - oldest;
  }

  /**
   * Cleanup expired chunks (older than bufferDurationMs)
   * Runs automatically via interval timer
   */
  _cleanupExpiredChunks() {
    if (this.buffer.length === 0) return;

    const now = Date.now();
    const expirationThreshold = now - this.bufferDurationMs;

    const originalLength = this.buffer.length;
    this.buffer = this.buffer.filter(entry => entry.timestamp > expirationThreshold);
    const removed = originalLength - this.buffer.length;

    if (removed > 0) {
      if (this.enableMetrics) {
        this.metrics.chunksExpired += removed;
      }

      // Update oldest timestamp
      if (this.buffer.length > 0) {
        const timestamps = this.buffer.map(entry => entry.timestamp);
        this.oldestChunkTimestamp = Math.min(...timestamps);
      } else {
        this.oldestChunkTimestamp = null;
      }

      // Too noisy for standard debug
      // this.logger.debug('[AudioBuffer] 🧹 Cleaned up expired chunks', {
      //   removed,
      //   remaining: this.buffer.length,
      // });

      this.emit('chunks_expired', { count: removed });
    }
  }

  /**
   * Clear entire buffer
   * Use when resetting stream or ending session
   */
  clear() {
    const previousSize = this.buffer.length;

    this.buffer = [];
    this.bufferIndex = 0;
    this.oldestChunkTimestamp = null;
    this.newestChunkTimestamp = null;

    this.logger.info('[AudioBuffer] 🗑️ Buffer cleared', {
      chunksCleared: previousSize,
    });

    this.emit('buffer_cleared', { chunksCleared: previousSize });
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      chunksAdded: 0,
      chunksExpired: 0,
      chunksExtracted: 0,
      flushOperations: 0,
      averageChunkSize: 0,
      bufferUtilization: 0,
    };

    this.logger.info('[AudioBuffer] 📊 Metrics reset');
  }

  /**
   * Cleanup and destroy buffer manager
   * Call when session ends
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.clear();
    this.removeAllListeners();

    this.logger.info('[AudioBuffer] 🛑 AudioBufferManager destroyed', {
      totalChunksProcessed: this.totalChunksReceived,
      totalBytesProcessed: this.totalBytesReceived,
    });
  }

  /**
   * Get detailed metrics for monitoring/debugging
   */
  getMetrics() {
    return {
      ...this.metrics,
      totalChunksReceived: this.totalChunksReceived,
      totalBytesReceived: this.totalBytesReceived,
      currentBufferSize: this.buffer.length,
      bufferDurationMs: this.getBufferDurationMs(),
      targetDurationMs: this.bufferDurationMs,
    };
  }
}

export default AudioBufferManager;
