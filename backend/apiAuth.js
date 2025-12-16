/**
 * API Authentication Middleware
 * 
 * Validates API keys for /api/translate WebSocket connections
 * Supports multiple API keys for different clients and key rotation
 */

class APIAuth {
  constructor() {
    // Load API keys from environment variable (comma-separated)
    const apiKeysEnv = process.env.WS_API_KEYS || '';
    this.validKeys = new Set(
      apiKeysEnv
        .split(',')
        .map(key => key.trim())
        .filter(key => key.length > 0)
    );
    
    if (this.validKeys.size === 0) {
      console.warn('[APIAuth] ⚠️  No API keys configured. Set WS_API_KEYS environment variable.');
    } else {
      console.log(`[APIAuth] ✓ Loaded ${this.validKeys.size} API key(s)`);
    }
  }

  /**
   * Validate API key from WebSocket connection
   * @param {object} req - HTTP request object
   * @returns {{valid: boolean, key?: string, error?: string}} - Validation result
   */
  validateRequest(req) {
    // Extract API key from query parameter or header
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const apiKeyFromQuery = url.searchParams.get('apiKey');
    
    // Also check for X-API-Key header (for WebSocket, this might be in upgrade headers)
    const apiKeyFromHeader = req.headers['x-api-key'] || req.headers['X-API-Key'];
    
    const apiKey = apiKeyFromQuery || apiKeyFromHeader;
    
    if (!apiKey) {
      return {
        valid: false,
        error: 'API key required. Provide ?apiKey=xxx in URL or X-API-Key header'
      };
    }
    
    if (!this.validKeys.has(apiKey)) {
      console.warn(`[APIAuth] ❌ Invalid API key attempt from ${req.socket.remoteAddress}`);
      return {
        valid: false,
        error: 'Invalid API key'
      };
    }
    
    return {
      valid: true,
      key: apiKey
    };
  }

  /**
   * Check if API key is valid (for programmatic checks)
   * @param {string} apiKey - API key to validate
   * @returns {boolean} - True if valid
   */
  isValidKey(apiKey) {
    return this.validKeys.has(apiKey);
  }

  /**
   * Add a new API key (for key rotation)
   * @param {string} apiKey - New API key to add
   */
  addKey(apiKey) {
    if (apiKey && apiKey.trim().length > 0) {
      this.validKeys.add(apiKey.trim());
      console.log(`[APIAuth] ✓ Added new API key (total: ${this.validKeys.size})`);
    }
  }

  /**
   * Remove an API key (for key rotation)
   * @param {string} apiKey - API key to remove
   */
  removeKey(apiKey) {
    if (this.validKeys.has(apiKey)) {
      this.validKeys.delete(apiKey);
      console.log(`[APIAuth] ✓ Removed API key (remaining: ${this.validKeys.size})`);
    }
  }

  /**
   * Get number of configured API keys
   * @returns {number} - Number of valid API keys
   */
  getKeyCount() {
    return this.validKeys.size;
  }
}

// Export singleton instance
export default new APIAuth();

