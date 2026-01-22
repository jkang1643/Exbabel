/**
 * TTS Defaults Store - Interface Selector
 * 
 * Factory that returns the appropriate defaults storage implementation.
 * Currently uses JSON file storage, but can be swapped to Redis/DB via env var.
 */

// Import implementations
import * as jsonStore from './defaultsStoreJson.js';

/**
 * Get defaults store implementation based on configuration
 * @returns {object} Defaults store with { getOrgVoiceDefaults, setOrgVoiceDefault }
 */
function getDefaultsStore() {
    // For now, always use JSON file store
    // Future: Check env var to select Redis/DB implementation
    const storeType = process.env.TTS_DEFAULTS_STORE || 'json';

    switch (storeType) {
        case 'json':
            return jsonStore;
        // Future implementations:
        // case 'redis':
        //   return redisStore;
        // case 'db':
        //   return dbStore;
        default:
            console.warn(`[DefaultsStore] Unknown store type: ${storeType}, using JSON`);
            return jsonStore;
    }
}

// Export store methods
const store = getDefaultsStore();
export const { getOrgVoiceDefaults, setOrgVoiceDefault } = store;
