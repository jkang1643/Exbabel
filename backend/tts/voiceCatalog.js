/**
 * TTS Voice Catalog (Legacy Wrapper)
 * 
 * This file is kept for backward compatibility.
 * All functionality has been moved to voiceCatalog/index.js
 * 
 * @deprecated Import from './voiceCatalog/index.js' instead
 */

export {
    getAllVoices,
    getVoicesFor,
    isVoiceValid,
    getDefaultVoice,
    toGoogleVoiceSelection,
    getSupportedLanguages,
    getCatalogCoverage,
    normalizeLanguageCode
} from './voiceCatalog/index.js';

// Legacy compatibility: toProviderSelection is an alias for toGoogleVoiceSelection
export { toGoogleVoiceSelection as toProviderSelection } from './voiceCatalog/index.js';
