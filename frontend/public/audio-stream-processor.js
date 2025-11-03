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
    
    // Configuration: Larger chunks (500ms) with more overlap (600ms) to prevent word loss
    // Larger chunks give Google Speech more context, especially at sentence starts
    this.CHUNK_MS = 500; // Increased from 300ms for better context
    this.OVERLAP_MS = 600; // Increased from 500ms for more overlap protection
    
    // Pre-buffer: Wait for this much audio before sending first chunk
    // This ensures first chunk has enough context for accurate recognition
    this.INITIAL_BUFFER_MS = 400; // Buffer 400ms before first chunk
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
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    
    if (!input || !input[0]) {
      return true; // Keep processor alive
    }

    const channelData = input[0]; // Mono channel
    
    // Accumulate samples into ring buffer with overlap
    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];
      
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

