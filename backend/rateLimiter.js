/**
 * Rate Limiter - Attack-Focused, Permissive for Legitimate Use
 * 
 * Designed to protect against DoS attacks without interfering with normal usage.
 * Limits are set 20-100x above typical usage patterns and only enforced when
 * sustained abuse is detected.
 */

class RateLimiter {
  constructor() {
    // Permissive defaults - way above normal usage
    this.maxConnectionsPerIP = parseInt(process.env.WS_API_RATE_LIMIT_CONNECTIONS) || 50;
    this.maxMessagesPerSecond = parseInt(process.env.WS_API_RATE_LIMIT_MESSAGES) || 1000;
    this.maxAudioBytesPerSecond = parseInt(process.env.WS_API_RATE_LIMIT_AUDIO) || 1048576; // 1MB
    this.adaptiveThreshold = parseInt(process.env.WS_API_RATE_LIMIT_ADAPTIVE_THRESHOLD) || 5; // seconds
    
    // Per-IP connection tracking
    this.connectionsByIP = new Map(); // IP -> Set of connection IDs
    
    // Per-connection rate tracking
    this.connectionRates = new Map(); // connectionId -> { messages: [], audioBytes: [], lastCheck: timestamp }
    
    // Attack detection tracking
    this.abusePatterns = new Map(); // IP -> { startTime, duration, count }
    
    // Cleanup interval - remove old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check if IP can create new connection
   * @param {string} ip - Client IP address
   * @returns {boolean} - True if connection allowed
   */
  canConnect(ip) {
    const connections = this.connectionsByIP.get(ip) || new Set();
    
    if (connections.size >= this.maxConnectionsPerIP) {
      console.warn(`[RateLimiter] Connection limit exceeded for IP ${ip}: ${connections.size}/${this.maxConnectionsPerIP}`);
      return false;
    }
    
    return true;
  }

  /**
   * Register a new connection
   * @param {string} ip - Client IP address
   * @param {string} connectionId - Unique connection identifier
   */
  registerConnection(ip, connectionId) {
    if (!this.connectionsByIP.has(ip)) {
      this.connectionsByIP.set(ip, new Set());
    }
    this.connectionsByIP.get(ip).add(connectionId);
    
    // Initialize rate tracking for this connection
    this.connectionRates.set(connectionId, {
      messages: [],
      audioBytes: [],
      lastCheck: Date.now(),
      ip: ip
    });
  }

  /**
   * Unregister a connection
   * @param {string} connectionId - Connection identifier
   */
  unregisterConnection(connectionId) {
    const rateData = this.connectionRates.get(connectionId);
    if (rateData) {
      const ip = rateData.ip;
      const connections = this.connectionsByIP.get(ip);
      if (connections) {
        connections.delete(connectionId);
        if (connections.size === 0) {
          this.connectionsByIP.delete(ip);
        }
      }
      this.connectionRates.delete(connectionId);
    }
  }

  /**
   * Check if message rate is within limits (token bucket algorithm)
   * @param {string} connectionId - Connection identifier
   * @returns {{allowed: boolean, retryAfter?: number}} - Result with optional retry time
   */
  checkMessageRate(connectionId) {
    const now = Date.now();
    const rateData = this.connectionRates.get(connectionId);
    
    if (!rateData) {
      return { allowed: true };
    }

    // Token bucket: remove messages older than 1 second
    rateData.messages = rateData.messages.filter(timestamp => now - timestamp < 1000);
    
    // Check if we're at the limit
    if (rateData.messages.length >= this.maxMessagesPerSecond) {
      // Check if this is sustained abuse (adaptive enforcement)
      const sustainedHighRate = this.detectSustainedAbuse(rateData.ip, 'messages');
      
      if (sustainedHighRate) {
        const oldestMessage = rateData.messages[0];
        const retryAfter = Math.ceil((1000 - (now - oldestMessage)) / 1000);
        console.warn(`[RateLimiter] Message rate limit exceeded for connection ${connectionId}: ${rateData.messages.length}/${this.maxMessagesPerSecond} (sustained abuse detected)`);
        return { allowed: false, retryAfter };
      }
    }
    
    // Add current message timestamp
    rateData.messages.push(now);
    return { allowed: true };
  }

  /**
   * Check if audio data rate is within limits
   * @param {string} connectionId - Connection identifier
   * @param {number} bytes - Number of bytes in this chunk
   * @returns {{allowed: boolean, retryAfter?: number}} - Result with optional retry time
   */
  checkAudioRate(connectionId, bytes) {
    const now = Date.now();
    const rateData = this.connectionRates.get(connectionId);
    
    if (!rateData) {
      return { allowed: true };
    }

    // Token bucket: remove bytes older than 1 second
    rateData.audioBytes = rateData.audioBytes.filter(entry => now - entry.timestamp < 1000);
    
    // Calculate current rate
    const currentBytesPerSecond = rateData.audioBytes.reduce((sum, entry) => sum + entry.bytes, 0);
    
    // Check if adding this chunk would exceed limit
    if (currentBytesPerSecond + bytes > this.maxAudioBytesPerSecond) {
      // Check if this is sustained abuse (adaptive enforcement)
      const sustainedHighRate = this.detectSustainedAbuse(rateData.ip, 'audio');
      
      if (sustainedHighRate) {
        const oldestEntry = rateData.audioBytes[0];
        const retryAfter = oldestEntry ? Math.ceil((1000 - (now - oldestEntry.timestamp)) / 1000) : 1;
        console.warn(`[RateLimiter] Audio rate limit exceeded for connection ${connectionId}: ${currentBytesPerSecond + bytes}/${this.maxAudioBytesPerSecond} bytes/sec (sustained abuse detected)`);
        return { allowed: false, retryAfter };
      }
    }
    
    // Add current audio chunk
    rateData.audioBytes.push({ timestamp: now, bytes });
    return { allowed: true };
  }

  /**
   * Detect sustained abuse patterns (adaptive enforcement)
   * Only enforce limits when abuse is clearly detected (>threshold seconds)
   * @param {string} ip - Client IP address
   * @param {string} type - 'messages' or 'audio'
   * @returns {boolean} - True if sustained abuse detected
   */
  detectSustainedAbuse(ip, type) {
    const now = Date.now();
    const key = `${ip}:${type}`;
    const pattern = this.abusePatterns.get(key);
    
    if (!pattern) {
      // Start tracking abuse pattern
      this.abusePatterns.set(key, {
        startTime: now,
        duration: 0,
        count: 1
      });
      return false; // Not sustained yet
    }
    
    // Check if abuse is sustained (>threshold seconds)
    const duration = (now - pattern.startTime) / 1000;
    pattern.duration = duration;
    pattern.count++;
    
    if (duration >= this.adaptiveThreshold) {
      // Sustained abuse detected - enforce limits
      return true;
    }
    
    return false; // Not sustained yet, allow burst
  }

  /**
   * Cleanup old entries to prevent memory leaks
   */
  cleanup() {
    const now = Date.now();
    const maxAge = 300000; // 5 minutes
    
    // Cleanup connection rates
    for (const [connectionId, rateData] of this.connectionRates.entries()) {
      // Remove old message timestamps
      rateData.messages = rateData.messages.filter(timestamp => now - timestamp < maxAge);
      // Remove old audio entries
      rateData.audioBytes = rateData.audioBytes.filter(entry => now - entry.timestamp < maxAge);
      
      // Remove empty entries
      if (rateData.messages.length === 0 && rateData.audioBytes.length === 0) {
        this.connectionRates.delete(connectionId);
      }
    }
    
    // Cleanup abuse patterns older than threshold
    for (const [key, pattern] of this.abusePatterns.entries()) {
      if (now - pattern.startTime > maxAge) {
        this.abusePatterns.delete(key);
      }
    }
  }

  /**
   * Get rate limit stats for monitoring
   * @param {string} connectionId - Connection identifier
   * @returns {object} - Rate limit statistics
   */
  getStats(connectionId) {
    const rateData = this.connectionRates.get(connectionId);
    if (!rateData) {
      return null;
    }
    
    const now = Date.now();
    const messagesLastSecond = rateData.messages.filter(timestamp => now - timestamp < 1000).length;
    const audioLastSecond = rateData.audioBytes
      .filter(entry => now - entry.timestamp < 1000)
      .reduce((sum, entry) => sum + entry.bytes, 0);
    
    return {
      messagesPerSecond: messagesLastSecond,
      audioBytesPerSecond: audioLastSecond,
      maxMessagesPerSecond: this.maxMessagesPerSecond,
      maxAudioBytesPerSecond: this.maxAudioBytesPerSecond
    };
  }
}

// Export singleton instance
export default new RateLimiter();

