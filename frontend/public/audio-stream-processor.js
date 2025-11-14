/**
 * AudioWorklet Processor - Runs on separate audio rendering thread
 * This keeps audio processing OFF the main thread for smooth React rendering
 * 
 * OPTIMIZATION: Implements overlap buffering to prevent dropped words at chunk boundaries
 * - Chunk size: 250-500ms (6000-12000 samples at 24kHz)
 * - Overlap: 500ms (12000 samples) - keeps last 500ms for next chunk
 */
class StreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sampleRate = 24000; // 24kHz
    
    // Configuration: OPTIMIZED for real-time streaming (100ms chunks for 10x/sec frequency)
    // Smaller chunks ensure Realtime API deltas reach frontend ASAP
    // Tradeoff: Less context per chunk, but streaming feel is more important
    this.CHUNK_MS = 100; // Reduced from 500ms to 100ms (5x more frequent)
    this.OVERLAP_MS = 200; // Reduced from 600ms to 200ms (fast 2x overlap)

    // Pre-buffer: Minimal delay before first chunk
    // This ensures first response arrives faster (critical for UX)
    this.INITIAL_BUFFER_MS = 100; // Reduced from 400ms to 100ms (4x faster first chunk!)
    this.INITIAL_BUFFER_SAMPLES = Math.floor(this.sampleRate * this.INITIAL_BUFFER_MS / 1000);
    this.hasSentFirstChunk = false;
    
    // Calculate buffer sizes in samples
    this.CHUNK_SAMPLES = Math.floor(this.sampleRate * this.CHUNK_MS / 1000); // ~12000 samples (500ms)
    this.OVERLAP_SAMPLES = Math.floor(this.sampleRate * this.OVERLAP_MS / 1000); // ~14400 samples (600ms)
    this.TOTAL_BUFFER_SIZE = this.CHUNK_SAMPLES + this.OVERLAP_SAMPLES; // ~26400 samples
    
    // Ring buffer with overlap
    this.buffer = new Float32Array(this.TOTAL_BUFFER_SIZE);
    this.bufferIndex = 0;
    this.chunkCounter = 0;
    this.startTime = currentTime;
    
    // AUDIO NORMALIZATION: Automatic Gain Control (AGC) to prevent clipping when shouting
    this.peakLevel = 0.0; // Track peak audio level
    this.targetPeak = 0.65; // Target peak level (65% to leave more headroom for shouts)
    this.currentGain = 1.0; // Current gain multiplier
    this.attackTime = 0.95; // Fast attack when volume increases (0.95 = ~50ms)
    this.releaseTime = 0.9995; // Slow release when volume decreases (0.9995 = ~2s)
    this.peakDecayRate = 0.999; // Faster peak decay (0.999 = ~1s) for responsive AGC
  }

  // Soft limiter function (smoother than hard clipping)
  softLimit(sample) {
    // Soft knee compression for values above threshold
    const threshold = 0.7; // Lower threshold (70%) to start compression earlier
    const absValue = Math.abs(sample);
    
    if (absValue <= threshold) {
      return sample;
    }
    
    // Soft clipping using tanh (natural compression)
    // This prevents distortion when shouting - handles peaks up to 3x over threshold
    const overThreshold = absValue - threshold;
    const compressed = Math.tanh(overThreshold * 3.0) * 0.25 + threshold;
    return sample < 0 ? -compressed : compressed;
  }
  
  // Automatic Gain Control (AGC) - adjusts volume dynamically
  applyAGC(sample) {
    const absSample = Math.abs(sample);
    
    // Update peak level with decay
    this.peakLevel = Math.max(absSample, this.peakLevel * this.peakDecayRate);
    
    // Calculate target gain based on peak
    let targetGain = 1.0;
    if (this.peakLevel > 0.01) { // Avoid division by zero and noise gate
      targetGain = this.targetPeak / this.peakLevel;
      targetGain = Math.min(targetGain, 4.0); // Limit max gain to 4x (boost quiet speech)
      targetGain = Math.max(targetGain, 0.05); // Limit min gain to 0.05x (compress loud shouts)
    }
    
    // Fast attack, slow release - respond quickly to loud sounds, recover slowly
    const smoothingFactor = (targetGain < this.currentGain) ? this.attackTime : this.releaseTime;
    this.currentGain = this.currentGain * smoothingFactor + targetGain * (1 - smoothingFactor);
    
    // Apply gain and soft limit
    const gained = sample * this.currentGain;
    return this.softLimit(gained);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    
    if (!input || !input[0]) {
      return true; // Keep processor alive
    }

    const channelData = input[0]; // Mono channel
    
    // Accumulate samples into ring buffer with overlap
    for (let i = 0; i < channelData.length; i++) {
      // Apply AGC and soft limiting to prevent clipping when shouting
      const processedSample = this.applyAGC(channelData[i]);
      this.buffer[this.bufferIndex++] = processedSample;
      
      // For first chunk: Wait for INITIAL_BUFFER_MS to ensure enough context
      // This prevents Google Speech from missing words at sentence start
      if (!this.hasSentFirstChunk && this.bufferIndex >= this.INITIAL_BUFFER_SAMPLES) {
        // First chunk: Send INITIAL_BUFFER samples (not the full CHUNK_SAMPLES yet)
        // This ensures Google Speech has context from the start
        const firstChunkData = new Float32Array(this.INITIAL_BUFFER_SAMPLES);
        for (let j = 0; j < this.INITIAL_BUFFER_SAMPLES; j++) {
          firstChunkData[j] = this.buffer[j];
        }
        
        // Convert Float32 to Int16 PCM format
        const pcmData = new Int16Array(this.INITIAL_BUFFER_SAMPLES);
        for (let j = 0; j < this.INITIAL_BUFFER_SAMPLES; j++) {
          const s = Math.max(-1, Math.min(1, firstChunkData[j]));
          pcmData[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        // Send first chunk with metadata
        this.port.postMessage({
          type: 'audio',
          data: pcmData,
          chunkIndex: this.chunkCounter++,
          startMs: 0,
          endMs: this.INITIAL_BUFFER_MS,
          sampleRate: this.sampleRate,
          overlapMs: 0, // First chunk has no overlap
          isFirstChunk: true
        });
        
        this.hasSentFirstChunk = true;
        
        // Shift buffer: keep remaining samples, start fresh
        const remainingSamples = this.bufferIndex - this.INITIAL_BUFFER_SAMPLES;
        if (remainingSamples > 0) {
          for (let j = 0; j < remainingSamples; j++) {
            this.buffer[j] = this.buffer[this.INITIAL_BUFFER_SAMPLES + j];
          }
          this.bufferIndex = remainingSamples;
        } else {
          this.bufferIndex = 0;
        }
        continue; // Process next samples
      }
      
      // When we've accumulated enough for a chunk (CHUNK_SAMPLES + OVERLAP_SAMPLES already in buffer)
      if (this.bufferIndex >= this.TOTAL_BUFFER_SIZE) {
        // Extract chunk: CHUNK_SAMPLES from the buffer
        // We want samples from position (TOTAL - CHUNK) to TOTAL
        // This ensures we include the overlap from previous chunk
        // Buffer layout: [overlap][chunk][future_overlap]
        // When full, we send: [chunk_start to chunk_end] = [TOTAL-CHUNK to TOTAL]
        const chunkStart = this.TOTAL_BUFFER_SIZE - this.CHUNK_SAMPLES;
        const chunkData = new Float32Array(this.CHUNK_SAMPLES);
        for (let j = 0; j < this.CHUNK_SAMPLES; j++) {
          chunkData[j] = this.buffer[chunkStart + j];
        }
        
        // Convert Float32 to Int16 PCM format
        const pcmData = new Int16Array(this.CHUNK_SAMPLES);
        for (let j = 0; j < this.CHUNK_SAMPLES; j++) {
          const s = Math.max(-1, Math.min(1, chunkData[j]));
          pcmData[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        // Calculate timing metadata
        const chunkStartMs = (this.chunkCounter * this.CHUNK_MS);
        const chunkEndMs = chunkStartMs + this.CHUNK_MS;
        
        // Send chunk to main thread with metadata
        this.port.postMessage({
          type: 'audio',
          data: pcmData,
          chunkIndex: this.chunkCounter++,
          startMs: chunkStartMs,
          endMs: chunkEndMs,
          sampleRate: this.sampleRate,
          overlapMs: this.OVERLAP_MS
        });
        
        // Shift overlap samples to the start of buffer for next chunk
        // Keep last OVERLAP_SAMPLES to overlap with next chunk
        const overlapStart = this.TOTAL_BUFFER_SIZE - this.OVERLAP_SAMPLES;
        for (let j = 0; j < this.OVERLAP_SAMPLES; j++) {
          this.buffer[j] = this.buffer[overlapStart + j];
        }
        
        // Reset buffer index to continue from overlap position
        this.bufferIndex = this.OVERLAP_SAMPLES;
      }
    }
    
    return true; // Keep processor alive
  }
}

registerProcessor('stream-processor', StreamProcessor);

