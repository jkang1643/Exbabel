/**
 * TTS Routing Resolver
 *
 * Single source of truth for TTS routing decisions.
 * Determines which provider, engine, tier, voice, and encoding to use based on:
 * - Requested tier (user preference)
 * - Language availability
 * - Subscription/org permissions
 * - Fallback logic
 *
 * Uses dynamic voice discovery from Google TTS API for accurate voice mappings.
 */

import { TtsEngine, TtsEncoding } from './tts.types.js';

// Global voice cache - will be populated by dynamic discovery
let VOICE_CACHE = new Map();
let VOICE_CACHE_TIMESTAMP = null;
const VOICE_CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Fallback voices for when API discovery fails
// Based on Google TTS documentation - conservative, known-working voice names
const FALLBACK_VOICES = {
  "af-ZA": {
    "standard": "af-ZA-Standard-A"
  },
  "ar-XA": {
    "standard": "ar-XA-Standard-A",
    "chirp3_hd": "ar-XA-Chirp3-HD-Kore",
    "neural2": "ar-XA-Wavenet-A"
  },
  "eu-ES": {
    "standard": "eu-ES-Standard-B"
  },
  "bn-IN": {
    "standard": "bn-IN-Standard-A",
    "chirp3_hd": "bn-IN-Chirp3-HD-Kore",
    "neural2": "bn-IN-Wavenet-A"
  },
  "bg-BG": {
    "standard": "bg-BG-Standard-B",
    "chirp3_hd": "bg-BG-Chirp3-HD-Kore"
  },
  "ca-ES": {
    "standard": "ca-ES-Standard-B"
  },
  "yue-HK": {
    "standard": "yue-HK-Standard-A",
    "chirp3_hd": "yue-HK-Chirp3-HD-Kore"
  },
  "hr-HR": {
    "chirp3_hd": "hr-HR-Chirp3-HD-Kore"
  },
  "cs-CZ": {
    "standard": "cs-CZ-Standard-B",
    "chirp3_hd": "cs-CZ-Chirp3-HD-Kore",
    "neural2": "cs-CZ-Wavenet-B"
  },
  "da-DK": {
    "neural2": "da-DK-Neural2-F",
    "standard": "da-DK-Standard-F",
    "chirp3_hd": "da-DK-Chirp3-HD-Kore"
  },
  "nl-BE": {
    "standard": "nl-BE-Standard-C",
    "chirp3_hd": "nl-BE-Chirp3-HD-Kore",
    "neural2": "nl-BE-Wavenet-C"
  },
  "nl-NL": {
    "standard": "nl-NL-Standard-F",
    "chirp3_hd": "nl-NL-Chirp3-HD-Kore",
    "neural2": "nl-NL-Wavenet-F"
  },
  "en-AU": {
    "neural2": "en-AU-Neural2-A",
    "standard": "en-AU-Standard-A",
    "chirp3_hd": "en-AU-Chirp3-HD-Kore"
  },
  "en-IN": {
    "neural2": "en-IN-Neural2-A",
    "standard": "en-IN-Standard-A",
    "chirp3_hd": "en-IN-Chirp3-HD-Kore"
  },
  "en-GB": {
    "neural2": "en-GB-Neural2-A",
    "standard": "en-GB-Standard-A",
    "chirp3_hd": "en-GB-Chirp3-HD-Kore"
  },
  "en-US": {
    "gemini": "Kore",
    "neural2": "en-US-Neural2-A",
    "standard": "en-US-Standard-A",
    "chirp3_hd": "en-US-Chirp3-HD-Kore"
  },
  "et-EE": {
    "standard": "et-EE-Standard-A",
    "chirp3_hd": "et-EE-Chirp3-HD-Kore"
  },
  "fil-PH": {
    "neural2": "fil-ph-Neural2-A",
    "standard": "fil-PH-Standard-A"
  },
  "fi-FI": {
    "standard": "fi-FI-Standard-B",
    "chirp3_hd": "fi-FI-Chirp3-HD-Kore",
    "neural2": "fi-FI-Wavenet-B"
  },
  "fr-CA": {
    "neural2": "fr-CA-Neural2-A",
    "standard": "fr-CA-Standard-A",
    "chirp3_hd": "fr-CA-Chirp3-HD-Kore"
  },
  "fr-FR": {
    "gemini": "Kore",
    "neural2": "fr-FR-Neural2-F",
    "standard": "fr-FR-Standard-F",
    "chirp3_hd": "fr-FR-Chirp3-HD-Kore"
  },
  "gl-ES": {
    "standard": "gl-ES-Standard-B"
  },
  "de-DE": {
    "gemini": "Kore",
    "neural2": "de-DE-Neural2-G",
    "standard": "de-DE-Standard-G",
    "chirp3_hd": "de-DE-Chirp3-HD-Kore"
  },
  "el-GR": {
    "standard": "el-GR-Standard-B",
    "chirp3_hd": "el-GR-Chirp3-HD-Kore",
    "neural2": "el-GR-Wavenet-B"
  },
  "gu-IN": {
    "standard": "gu-IN-Standard-A",
    "chirp3_hd": "gu-IN-Chirp3-HD-Kore",
    "neural2": "gu-IN-Wavenet-A"
  },
  "he-IL": {
    "standard": "he-IL-Standard-A",
    "chirp3_hd": "he-IL-Chirp3-HD-Kore",
    "neural2": "he-IL-Wavenet-A"
  },
  "hi-IN": {
    "neural2": "hi-IN-Neural2-A",
    "standard": "hi-IN-Standard-A",
    "chirp3_hd": "hi-IN-Chirp3-HD-Kore"
  },
  "hu-HU": {
    "standard": "hu-HU-Standard-B",
    "chirp3_hd": "hu-HU-Chirp3-HD-Kore",
    "neural2": "hu-HU-Wavenet-B"
  },
  "is-IS": {
    "standard": "is-IS-Standard-B"
  },
  "id-ID": {
    "standard": "id-ID-Standard-A",
    "chirp3_hd": "id-ID-Chirp3-HD-Kore",
    "neural2": "id-ID-Wavenet-A"
  },
  "it-IT": {
    "gemini": "Kore",
    "neural2": "it-IT-Neural2-A",
    "standard": "it-IT-Standard-E",
    "chirp3_hd": "it-IT-Chirp3-HD-Kore"
  },
  "ja-JP": {
    "gemini": "Kore",
    "neural2": "ja-JP-Neural2-C",
    "standard": "ja-JP-Standard-A",
    "chirp3_hd": "ja-JP-Chirp3-HD-Kore"
  },
  "kn-IN": {
    "standard": "kn-IN-Standard-A",
    "chirp3_hd": "kn-IN-Chirp3-HD-Kore",
    "neural2": "kn-IN-Wavenet-A"
  },
  "ko-KR": {
    "gemini": "Kore",
    "neural2": "ko-KR-Neural2-A",
    "standard": "ko-KR-Standard-A",
    "chirp3_hd": "ko-KR-Chirp3-HD-Kore"
  },
  "lv-LV": {
    "standard": "lv-LV-Standard-B",
    "chirp3_hd": "lv-LV-Chirp3-HD-Kore"
  },
  "lt-LT": {
    "standard": "lt-LT-Standard-B",
    "chirp3_hd": "lt-LT-Chirp3-HD-Kore"
  },
  "ms-MY": {
    "standard": "ms-MY-Standard-A",
    "neural2": "ms-MY-Wavenet-A"
  },
  "ml-IN": {
    "standard": "ml-IN-Standard-A",
    "chirp3_hd": "ml-IN-Chirp3-HD-Kore",
    "neural2": "ml-IN-Wavenet-A"
  },
  "cmn-CN": {
    "gemini": "Kore",
    "standard": "cmn-CN-Standard-A",
    "chirp3_hd": "cmn-CN-Chirp3-HD-Kore",
    "neural2": "cmn-CN-Wavenet-A"
  },
  "zh-CN": {
    "standard": "cmn-CN-Standard-A",
    "chirp3_hd": "cmn-CN-Chirp3-HD-Kore",
    "neural2": "cmn-CN-Wavenet-A"
  },
  "cmn-TW": {
    "standard": "cmn-TW-Standard-A",
    "neural2": "cmn-TW-Wavenet-A"
  },
  "mr-IN": {
    "standard": "mr-IN-Standard-A",
    "chirp3_hd": "mr-IN-Chirp3-HD-Kore",
    "neural2": "mr-IN-Wavenet-A"
  },
  "nb-NO": {
    "standard": "nb-NO-Standard-F",
    "chirp3_hd": "nb-NO-Chirp3-HD-Kore",
    "neural2": "nb-NO-Wavenet-F"
  },
  "pl-PL": {
    "standard": "pl-PL-Standard-F",
    "chirp3_hd": "pl-PL-Chirp3-HD-Kore",
    "neural2": "pl-PL-Wavenet-F"
  },
  "pt-BR": {
    "gemini": "Kore",
    "neural2": "pt-BR-Neural2-A",
    "standard": "pt-BR-Standard-A",
    "chirp3_hd": "pt-BR-Chirp3-HD-Kore"
  },
  "pt-PT": {
    "standard": "pt-PT-Standard-E",
    "neural2": "pt-PT-Wavenet-E"
  },
  "pa-IN": {
    "standard": "pa-IN-Standard-A",
    "chirp3_hd": "pa-IN-Chirp3-HD-Kore",
    "neural2": "pa-IN-Wavenet-A"
  },
  "ro-RO": {
    "standard": "ro-RO-Standard-B",
    "chirp3_hd": "ro-RO-Chirp3-HD-Kore",
    "neural2": "ro-RO-Wavenet-B"
  },
  "ru-RU": {
    "gemini": "Kore",
    "standard": "ru-RU-Standard-A",
    "chirp3_hd": "ru-RU-Chirp3-HD-Kore",
    "neural2": "ru-RU-Wavenet-A"
  },
  "sr-RS": {
    "standard": "sr-RS-Standard-B",
    "chirp3_hd": "sr-RS-Chirp3-HD-Kore"
  },
  "sk-SK": {
    "standard": "sk-SK-Standard-B",
    "chirp3_hd": "sk-SK-Chirp3-HD-Kore",
    "neural2": "sk-SK-Wavenet-B"
  },
  "sl-SI": {
    "chirp3_hd": "sl-SI-Chirp3-HD-Kore"
  },
  "es-ES": {
    "gemini": "Kore",
    "neural2": "es-ES-Neural2-A",
    "standard": "es-ES-Standard-E",
    "chirp3_hd": "es-ES-Chirp3-HD-Kore"
  },
  "es-US": {
    "neural2": "es-US-Neural2-A",
    "standard": "es-US-Standard-A",
    "chirp3_hd": "es-US-Chirp3-HD-Kore"
  },
  "sv-SE": {
    "standard": "sv-SE-Standard-A",
    "chirp3_hd": "sv-SE-Chirp3-HD-Kore",
    "neural2": "sv-SE-Wavenet-A"
  },
  "ta-IN": {
    "standard": "ta-IN-Standard-A",
    "chirp3_hd": "ta-IN-Chirp3-HD-Kore",
    "neural2": "ta-IN-Wavenet-A"
  },
  "te-IN": {
    "standard": "te-IN-Standard-A",
    "chirp3_hd": "te-IN-Chirp3-HD-Kore"
  },
  "th-TH": {
    "neural2": "th-TH-Neural2-C",
    "standard": "th-TH-Standard-A",
    "chirp3_hd": "th-TH-Chirp3-HD-Kore"
  },
  "tr-TR": {
    "standard": "tr-TR-Standard-A",
    "chirp3_hd": "tr-TR-Chirp3-HD-Kore",
    "neural2": "tr-TR-Wavenet-A"
  },
  "uk-UA": {
    "standard": "uk-UA-Standard-B",
    "chirp3_hd": "uk-UA-Chirp3-HD-Kore",
    "neural2": "uk-UA-Wavenet-B"
  },
  "ur-IN": {
    "standard": "ur-IN-Standard-A",
    "chirp3_hd": "ur-IN-Chirp3-HD-Kore",
    "neural2": "ur-IN-Wavenet-A"
  },
  "vi-VN": {
    "neural2": "vi-VN-Neural2-A",
    "standard": "vi-VN-Standard-A",
    "chirp3_hd": "vi-VN-Chirp3-HD-Kore"
  }
};


/**
 * Get Google TTS service instance for voice discovery
 * @private
 */
let _ttsService = null;
async function _getTtsService() {
  if (!_ttsService) {
    const { GoogleTtsService } = await import('./ttsService.js');
    _ttsService = new GoogleTtsService();
  }
  return _ttsService;
}

/**
 * Tier capabilities and mappings
 *
 * Defines which tiers are available and their characteristics.
 */
const TIER_CONFIG = {
  gemini: {
    provider: 'google',
    tier: 'gemini',
    engine: TtsEngine.GEMINI_TTS,
    model: 'gemini-2.5-flash-tts',
    supportsAllLanguages: false, // Primarily English-optimized
    fallbackTier: 'neural2'
  },
  chirp3_hd: {
    provider: 'google',
    tier: 'chirp3_hd',
    engine: TtsEngine.CHIRP3_HD,
    model: 'chirp-3-hd',
    supportsAllLanguages: false, // Limited language support
    fallbackTier: 'neural2'
  },
  elevenlabs: {
    provider: 'elevenlabs',
    tier: 'elevenlabs',
    engine: null, // Not a Google engine
    model: 'eleven_multilingual_v2',
    supportsAllLanguages: true, // Multilingual v2 supports 29 languages
    fallbackTier: 'neural2'
  },
  elevenlabs_v3: {
    provider: 'elevenlabs',
    tier: 'elevenlabs_v3',
    engine: null,
    model: 'eleven_v3',
    supportsAllLanguages: true, // v3 supports 70+ languages
    fallbackTier: 'elevenlabs'
  },
  elevenlabs_turbo: {
    provider: 'elevenlabs',
    tier: 'elevenlabs_turbo',
    engine: null,
    model: 'eleven_turbo_v2_5',
    supportsAllLanguages: true, // Turbo v2.5 supports 32 languages
    fallbackTier: 'elevenlabs'
  },
  elevenlabs_flash: {
    provider: 'elevenlabs',
    tier: 'elevenlabs_flash',
    engine: null,
    model: 'eleven_flash_v2_5',
    supportsAllLanguages: true, // Flash v2.5 supports 32 languages
    fallbackTier: 'elevenlabs'
  },
  neural2: {
    provider: 'google',
    tier: 'neural2',
    engine: TtsEngine.CHIRP3_HD, // Neural2 voices use Chirp3 HD engine
    model: null,
    supportsAllLanguages: true,
    fallbackTier: 'standard'
  },
  standard: {
    provider: 'google',
    tier: 'standard',
    engine: TtsEngine.CHIRP3_HD, // Standard voices use Chirp3 HD engine
    model: null,
    supportsAllLanguages: true,
    fallbackTier: null // Last resort
  }
};

/**
 * ElevenLabs model capabilities (source of truth for voice_settings support)
 * Defines which voice settings each tier supports and their valid ranges
 */
const ELEVENLABS_MODEL_CAPABILITIES = {
  elevenlabs_v3: {
    modelId: 'eleven_v3',
    supports: {
      stability: true,
      similarity_boost: true,
      style: true,              // V3 supports style
      use_speaker_boost: true,  // V3 supports speaker boost
      speed: true
    },
    ranges: {
      stability: [0, 1],
      similarity_boost: [0, 1],
      style: [0, 1],
      speed: [0.7, 1.2]
    }
  },
  elevenlabs_turbo: {
    modelId: 'eleven_turbo_v2_5',
    supports: {
      stability: true,
      similarity_boost: true,
      style: true,              // V2+ models support style
      use_speaker_boost: true,  // V2+ models support speaker boost
      speed: true
    },
    ranges: {
      stability: [0, 1],
      similarity_boost: [0, 1],
      style: [0, 1],
      speed: [0.7, 1.2]
    }
  },
  elevenlabs_flash: {
    modelId: 'eleven_flash_v2_5',
    supports: {
      stability: true,
      similarity_boost: true,
      style: true,              // V2+ models support style
      use_speaker_boost: true,  // V2+ models support speaker boost
      speed: true
    },
    ranges: {
      stability: [0, 1],
      similarity_boost: [0, 1],
      style: [0, 1],
      speed: [0.7, 1.2]
    }
  },
  elevenlabs: {
    modelId: 'eleven_multilingual_v2',
    supports: {
      stability: true,
      similarity_boost: true,
      style: true,              // V2 supports style
      use_speaker_boost: true,  // V2 supports speaker boost
      speed: true
    },
    ranges: {
      stability: [0, 1],
      similarity_boost: [0, 1],
      style: [0, 1],
      speed: [0.7, 1.2]
    }
  }
};

/**
 * Get ElevenLabs model capabilities for a given tier
 * @param {string} tier - ElevenLabs tier (elevenlabs_v3, elevenlabs_turbo, etc.)
 * @returns {object|null} Capability object or null if not an ElevenLabs tier
 */
export function getElevenLabsModelCapabilities(tier) {
  return ELEVENLABS_MODEL_CAPABILITIES[tier] || null;
}

/**

 * Language-specific tier availability
 *
 * Which tiers are available for which languages.
 * null means check subscription/org config.
 */
const LANGUAGE_TIER_AVAILABILITY = {
  "af-ZA": [
    "standard"
  ],
  "ar-XA": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "eu-ES": [
    "standard"
  ],
  "bn-IN": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "bg-BG": [
    "chirp3_hd",
    "standard"
  ],
  "ca-ES": [
    "standard"
  ],
  "yue-HK": [
    "chirp3_hd",
    "standard"
  ],
  "hr-HR": [
    "chirp3_hd"
  ],
  "cs-CZ": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "da-DK": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "nl-BE": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "nl-NL": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "en-AU": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "en-IN": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "en-GB": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "en-US": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "et-EE": [
    "chirp3_hd",
    "standard"
  ],
  "fil-PH": [
    "neural2",
    "standard"
  ],
  "fi-FI": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "fr-CA": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "fr-FR": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "gl-ES": [
    "standard"
  ],
  "de-DE": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "el-GR": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "gu-IN": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "he-IL": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "hi-IN": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "hu-HU": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "is-IS": [
    "standard"
  ],
  "id-ID": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "it-IT": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "ja-JP": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "kn-IN": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "ko-KR": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "lv-LV": [
    "chirp3_hd",
    "standard"
  ],
  "lt-LT": [
    "chirp3_hd",
    "standard"
  ],
  "ms-MY": [
    "neural2",
    "standard"
  ],
  "ml-IN": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "cmn-CN": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "zh-CN": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "cmn-TW": [
    "neural2",
    "standard"
  ],
  "mr-IN": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "nb-NO": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "pl-PL": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "pt-BR": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "pt-PT": [
    "gemini",
    "neural2",
    "standard"
  ],
  "pa-IN": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "ro-RO": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "ru-RU": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "sr-RS": [
    "chirp3_hd",
    "standard"
  ],
  "sk-SK": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "sl-SI": [
    "chirp3_hd"
  ],
  "es-ES": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "es-US": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "sv-SE": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "ta-IN": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "te-IN": [
    "gemini",
    "chirp3_hd",
    "standard"
  ],
  "th-TH": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "tr-TR": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "uk-UA": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "ur-IN": [
    "chirp3_hd",
    "neural2",
    "standard"
  ],
  "vi-VN": [
    "gemini",
    "chirp3_hd",
    "neural2",
    "standard"
  ]
};


/**
 * Normalize language code to full locale format
 * @private
 */
function _normalizeLanguageCode(languageCode) {
  if (!languageCode) return null;

  // If already in full format (e.g., 'es-ES'), return as-is
  if (languageCode.includes('-')) {
    return languageCode;
  }

  // Map short codes to full locale codes
  const languageMap = {
    'es': 'es-ES',
    'en': 'en-US',
    'fr': 'fr-FR',
    'de': 'de-DE',
    'it': 'it-IT',
    'pt': 'pt-BR',
    'ja': 'ja-JP',
    'ko': 'ko-KR',
    'zh': 'cmn-CN', // Map Chinese to Mandarin Chinese
    'ar': 'ar-XA',
    'hi': 'hi-IN',
    'ru': 'ru-RU'
  };

  return languageMap[languageCode] || `${languageCode}-${languageCode.toUpperCase()}`;
}

/**
 * Get available tiers for a language
 * @private
 */
function _getAvailableTiersForLanguage(languageCode) {
  const normalizedCode = _normalizeLanguageCode(languageCode);
  return LANGUAGE_TIER_AVAILABILITY[normalizedCode] || ['neural2', 'standard'];
}

/**
 * Check if tier is available for language
 * @private
 */
function _isTierAvailableForLanguage(tier, languageCode) {
  // First check if tier has supportsAllLanguages flag
  const tierConfig = TIER_CONFIG[tier];
  if (tierConfig && tierConfig.supportsAllLanguages) {
    return true;
  }

  // Otherwise check the per-language availability map
  const availableTiers = _getAvailableTiersForLanguage(languageCode);
  return availableTiers.includes(tier);
}

/**
 * Resolve tier based on user request, language, and availability
 * @private
 */
function _resolveTier(requestedTier, languageCode, orgConfig = {}) {
  // Start with requested tier
  let resolvedTier = requestedTier;

  // Check if requested tier is available for this language
  if (!_isTierAvailableForLanguage(resolvedTier, languageCode)) {
    // Fallback to next available tier
    const availableTiers = _getAvailableTiersForLanguage(languageCode);
    const requestedIndex = availableTiers.indexOf(requestedTier);

    if (requestedIndex > 0) {
      // Use the next highest available tier
      resolvedTier = availableTiers[requestedIndex - 1];
    } else {
      // Use the first available tier
      resolvedTier = availableTiers[0];
    }
  }

  // TODO: Check org/subscription restrictions
  // For now, allow all tiers

  return resolvedTier;
}

/**
 * Resolve voice based on tier, language, and requested voice
 * @private
 */
/**
 * Get available voices for a language and tier using dynamic discovery
 * @private
 */
async function _getAvailableVoicesForLanguageAndTier(languageCode, tier) {
  // Option 2 (Dynamic Discovery) disabled for MVP - using manual mapping (Option 1)
  return [];

  /* Dynamic discovery code preserved for future use
  const cacheKey = `${languageCode}:${tier}`;
  ...
  */
}

/**
 * Resolve voice based on tier, language, and requested voice
 * @private
 */
async function _resolveVoice(tier, languageCode, requestedVoiceName) {
  const normalizedCode = _normalizeLanguageCode(languageCode);

  // 1. Try dynamic discovery first (API discovery)
  // This is currently disabled in our discovery function, returning []
  const availableVoices = await _getAvailableVoicesForLanguageAndTier(normalizedCode, tier);
  if (availableVoices.length > 0) {
    // If requested voice is available, use it
    if (requestedVoiceName && availableVoices.includes(requestedVoiceName)) {
      return requestedVoiceName;
    }
    // Otherwise use the first available voice
    return availableVoices[0];
  }

  // 2. Fallback to hardcoded mappings if discovery fails (Option 1)
  const fallbackVoicesForLang = FALLBACK_VOICES[normalizedCode];

  // If user requested a specific voice, check if it's valid for this tier/language even if discovery is off
  if (requestedVoiceName) {
    // ElevenLabs voices: Strip prefix and pass through voice ID
    // Support all ElevenLabs tiers: elevenlabs, elevenlabs_v3, elevenlabs_turbo, elevenlabs_flash
    if (tier === 'elevenlabs' || tier === 'elevenlabs_v3' || tier === 'elevenlabs_turbo' || tier === 'elevenlabs_flash') {
      // ElevenLabs voices are prefixed with 'elevenlabs-' in the frontend OR catalog URNs
      // Strip the prefix to get the raw voice ID (20-22 chars)
      let voiceId = requestedVoiceName;

      // Handle URN format: elevenlabs:elevenlabs_v3:-:VOICEID
      if (voiceId.includes(':')) {
        const parts = voiceId.split(':');
        voiceId = parts[parts.length - 1]; // Take the last part (the actual ID)
      } else if (voiceId.startsWith('elevenlabs-')) {
        // Legacy frontend behavior
        voiceId = voiceId.substring(11);
      }

      // Strip backend suffix if present (e.g. __elevenlabs_v3) which is used for frontend uniqueness
      if (voiceId.includes('__')) {
        voiceId = voiceId.split('__')[0];
      }

      return voiceId;
    }

    if (tier === 'gemini') {
      // Gemini voices (studio personas) are generally English-only at the moment for direct match
      // but we allow common names to pass through to the Gemini engine
      const GEMINI_VOICES = [
        'Kore', 'Charon', 'Leda', 'Puck', 'Aoede', 'Fenrir',
        'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam',
        'Autonoe', 'Callirrhoe', 'Despina', 'Enceladus', 'Erinome',
        'Gacrux', 'Iapetus', 'Laomedeia', 'Orus', 'Pulcherrima',
        'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat',
        'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi'
      ];

      // Handle catalog URNs like gemini:gemini_tts:-:Achernar
      let normalizedVoiceName = requestedVoiceName;
      if (normalizedVoiceName.includes(':')) {
        const parts = normalizedVoiceName.split(':');
        normalizedVoiceName = parts[parts.length - 1];
      }

      // Strip 'gemini-' prefix if present (legacy frontend convention)
      if (normalizedVoiceName.startsWith('gemini-')) {
        normalizedVoiceName = normalizedVoiceName.substring(7);
      }

      if (GEMINI_VOICES.includes(normalizedVoiceName)) {
        console.log(`[TTS Routing] Gemini voice resolved: ${requestedVoiceName} -> ${normalizedVoiceName}`);
        return normalizedVoiceName;  // Return bare name for Gemini API
      }
    } else {
      // For other tiers (chirp3_hd, neural2, standard), handle voice name extraction

      // List of Gemini/Chirp3 persona names (shared between Gemini and Chirp3 tiers)
      const PERSONA_NAMES = [
        'Kore', 'Charon', 'Leda', 'Puck', 'Aoede', 'Fenrir',
        'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam',
        'Autonoe', 'Callirrhoe', 'Despina', 'Enceladus', 'Erinome',
        'Gacrux', 'Iapetus', 'Laomedeia', 'Orus', 'Pulcherrima',
        'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat',
        'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi'
      ];

      const TIER_NAME_TAGS = {
        'chirp3_hd': ['Chirp3', 'Chirp_3', 'Chirp-3'],
        'neural2': ['Neural2', 'Wavenet', 'Studio'],
        'standard': ['Standard', 'Polyglot', 'Chirp-HD', 'Chirp']
      };

      // Extract voice name from URN if present (e.g., google_cloud_tts:chirp3_hd:es-ES:Leda -> Leda)
      let cleanVoiceName = requestedVoiceName;
      if (cleanVoiceName.includes(':')) {
        const parts = cleanVoiceName.split(':');
        cleanVoiceName = parts[parts.length - 1];
      }

      // SPECIAL CASE: Chirp3 with persona names
      // If tier is chirp3_hd and the voice name is a known persona, construct the full Chirp3 voice name
      if (tier === 'chirp3_hd' && PERSONA_NAMES.includes(cleanVoiceName)) {
        const fullChirp3Name = `${normalizedCode}-Chirp3-HD-${cleanVoiceName}`;
        console.log(`[TTS Routing] Chirp3 persona resolved: ${requestedVoiceName} -> ${fullChirp3Name}`);
        return fullChirp3Name;
      }

      // GENERAL CASE: Check if the voice name already contains tier-specific tags
      const allowedTags = TIER_NAME_TAGS[tier] || [];
      const hasTierMatch = allowedTags.some(tag => cleanVoiceName.includes(tag));

      // Language match: check for full locale or just the language prefix
      const langPrefix = normalizedCode.split('-')[0];
      const hasLangMatch = cleanVoiceName.includes(normalizedCode) ||
        (cleanVoiceName.startsWith(langPrefix + '-') && !cleanVoiceName.includes('Polyglot'));

      if (hasTierMatch && hasLangMatch) {
        console.log(`[TTS Routing] Voice name validated: ${cleanVoiceName}`);
        return cleanVoiceName;
      }
    }
  }

  if (fallbackVoicesForLang && fallbackVoicesForLang[tier]) {
    return fallbackVoicesForLang[tier];
  }

  // 3. Special handling for Gemini if no specific mapping found in FALLBACK_VOICES
  if (tier === 'gemini') {
    return 'Kore';
  }

  // 4. Special handling for all ElevenLabs tiers - use default voice from env
  if (tier === 'elevenlabs' || tier === 'elevenlabs_v3' || tier === 'elevenlabs_turbo' || tier === 'elevenlabs_flash') {
    const defaultVoiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
    console.log(`[TTS Routing] ElevenLabs (${tier}) using default voice: ${defaultVoiceId}`);
    return defaultVoiceId;
  }

  // 4. Last resort: generic patterns based on tier
  if (tier === 'chirp3_hd') {
    return `${normalizedCode}-Chirp3-HD-Kore`;
  } else if (tier === 'neural2') {
    return `${normalizedCode}-Neural2-A`;
  } else if (tier === 'standard') {
    return `${normalizedCode}-Standard-A`;
  }

  return requestedVoiceName || `${normalizedCode}-Standard-A`;
}

/**
 * TTS Route Resolver
 *
 * Single source of truth for TTS routing decisions.
 *
 * @param {Object} params - Routing parameters
 * @param {string} params.requestedTier - User's preferred tier (gemini | chirp3_hd | neural2 | standard)
 * @param {string} params.requestedVoice - User's preferred voice name
 * @param {string} params.languageCode - BCP-47 language code
 * @param {string} [params.mode='unary'] - Synthesis mode (unary | streaming)
 * @param {Object} [params.orgConfig={}] - Organization configuration
 * @param {Object} [params.userSubscription={}] - User subscription details
 * @returns {Promise<Object>} Resolved routing decision
 */
export async function resolveTtsRoute({
  requestedTier = 'neural2',
  requestedVoice,
  languageCode,
  mode = 'unary',
  orgConfig = {},
  userSubscription = {}
}) {
  // Normalize inputs
  const normalizedLanguageCode = _normalizeLanguageCode(languageCode);

  console.log(`[TTS Routing] 🔍 resolveTtsRoute called:`);
  console.log(`[TTS Routing]   requestedTier: ${requestedTier}`);
  console.log(`[TTS Routing]   requestedVoice: ${requestedVoice}`);
  console.log(`[TTS Routing]   languageCode: ${languageCode} -> ${normalizedLanguageCode}`);

  // INFER TIER FROM VOICE if not explicitly specified
  // If we have a requested voice but NO explicit tier preference, we try to detect the tier from the voice name.
  // CRITICAL: Only infer if requestedTier is still the default ('neural2'), meaning user didn't specify a tier.
  let effectiveTier = requestedTier;

  if (requestedVoice && requestedTier === 'neural2') {
    console.log(`[TTS Routing]   ⚠️ Tier is default 'neural2', attempting to infer from voice name...`);
    // Only infer tier if user didn't explicitly request one
    if (requestedVoice.includes('elevenlabs') || /^[a-zA-Z0-9]{20,22}$/.test(requestedVoice)) {
      effectiveTier = 'elevenlabs';
      console.log(`[TTS Routing]   ✅ Inferred tier: elevenlabs`);
    } else if (requestedVoice.includes('Neural2')) {
      effectiveTier = 'neural2';
      console.log(`[TTS Routing]   ✅ Inferred tier: neural2`);
    } else if (requestedVoice.includes('Chirp3') || requestedVoice.includes('Chirp-3')) {
      effectiveTier = 'chirp3_hd';
      console.log(`[TTS Routing]   ✅ Inferred tier: chirp3_hd`);
    } else if (['Kore', 'Fenrir', 'Puck', 'Charon'].some(n => requestedVoice.includes(n))) {
      effectiveTier = 'gemini';
      console.log(`[TTS Routing]   ✅ Inferred tier: gemini (matched Gemini persona)`);
    }
  } else {
    console.log(`[TTS Routing]   ✅ Using explicit tier: ${effectiveTier}`);
  }

  let resolvedTier = _resolveTier(effectiveTier, normalizedLanguageCode, orgConfig);
  console.log(`[TTS Routing]   📍 Resolved tier: ${resolvedTier}`);

  let resolvedVoiceName = await _resolveVoice(resolvedTier, normalizedLanguageCode, requestedVoice);
  console.log(`[TTS Routing]   📍 Resolved voice: ${resolvedVoiceName}`);

  // Get tier configuration
  const tierConfig = TIER_CONFIG[resolvedTier];
  if (!tierConfig) {
    throw new Error(`Invalid resolved tier: ${resolvedTier}`);
  }

  // Determine if this was a fallback
  const wasFallback = resolvedTier !== requestedTier;
  const fallbackFrom = wasFallback ? {
    tier: requestedTier,
    voiceName: requestedVoice
  } : null;

  // Determine reason for routing decision
  let reason = 'direct_match';
  if (wasFallback) {
    if (!_isTierAvailableForLanguage(requestedTier, normalizedLanguageCode)) {
      reason = `tier_not_available_for_language; fallback_to_${resolvedTier}`;
    } else {
      reason = `tier_restricted_by_subscription; fallback_to_${resolvedTier}`;
    }
  }

  // Determine engine and model
  let engine = tierConfig.engine;
  let model = tierConfig.model;

  // Handle engine overrides for specific voice patterns (e.g. Studio voices in the Gemini tier)
  if (resolvedVoiceName && (resolvedVoiceName.includes('Studio') || resolvedVoiceName.includes('Neural2') || resolvedVoiceName.includes('Standard'))) {
    // Standard/Studio/Neural2 voices use the standard engine wrapper even if in Gemini tier
    if (engine === TtsEngine.GEMINI_TTS) {
      engine = TtsEngine.CHIRP3_HD;
      model = 'chirp-3-hd';
      reason = `${reason}; engine_override_for_standard_voice`;
    }
  }

  // Determine audio encoding
  const audioEncoding = mode === 'streaming' ? TtsEncoding.OGG_OPUS : TtsEncoding.MP3;

  return {
    // Provider and engine info
    provider: tierConfig.provider,
    tier: tierConfig.tier,
    engine: engine,
    model: model,

    // Voice and language info
    languageCode: normalizedLanguageCode,
    voiceName: resolvedVoiceName,

    // Audio config
    audioEncoding,

    // Fallback tracking
    fallbackFrom,
    reason,

    // Metadata for debugging
    requested: {
      tier: requestedTier,
      voiceName: requestedVoice,
      languageCode
    }
  };
}

/**
 * Validate that a resolved route is valid
 * @param {Object} route - Resolved route from resolveTtsRoute
 * @throws {Error} If route is invalid
 */
export function validateResolvedRoute(route) {
  const required = ['provider', 'tier', 'engine', 'languageCode', 'voiceName', 'audioEncoding'];
  for (const field of required) {
    if (!route[field]) {
      throw new Error(`Missing required route field: ${field}`);
    }
  }

  // Validate tier exists in config
  if (!TIER_CONFIG[route.tier]) {
    throw new Error(`Invalid tier in route: ${route.tier}`);
  }

  // Validate language has voice mapping (for Neural2/Standard)
  if (route.tier !== 'gemini' && !FALLBACK_VOICES[route.languageCode]) {
    console.warn(`No voice mapping found for language ${route.languageCode}, using fallback`);
  }
}

/**
 * Get all supported languages
 * @returns {string[]} Array of supported language codes
 */
export function getSupportedLanguages() {
  return Object.keys(FALLBACK_VOICES);
}

/**
 * Check if language is supported
 * @param {string} languageCode - Language code to check
 * @returns {boolean} True if supported
 */
export function isLanguageSupported(languageCode) {
  const normalizedCode = _normalizeLanguageCode(languageCode);
  return normalizedCode in FALLBACK_VOICES;
}

/**
 * Get available tiers for a language
 * @param {string} languageCode - Language code
 * @returns {string[]} Array of available tier names
 */
export function getAvailableTiersForLanguage(languageCode) {
  return _getAvailableTiersForLanguage(languageCode);
}
