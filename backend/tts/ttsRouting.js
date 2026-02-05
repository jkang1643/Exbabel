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
import { getAllowedTtsTiers } from '../entitlements/index.js';

// All Gemini TTS persona voice names
// Used for tier inference and voice resolution
const GEMINI_VOICES = [
  'Kore', 'Charon', 'Leda', 'Puck', 'Aoede', 'Fenrir',
  'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam',
  'Autonoe', 'Callirrhoe', 'Despina', 'Enceladus', 'Erinome',
  'Gacrux', 'Iapetus', 'Laomedeia', 'Orus', 'Pulcherrima',
  'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat',
  'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi'
];

// Global voice cache - will be populated by dynamic discovery
let VOICE_CACHE = new Map();
let VOICE_CACHE_TIMESTAMP = null;
const VOICE_CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Fallback voices for when API discovery fails
// Based on Google TTS documentation - conservative, known-working voice names
// Fallback voices for when API discovery fails or voice resolution is ambiguous
// Based on Google TTS documentation - conservative, known-working voice names
const FALLBACK_VOICES = {
  "af-ZA": { "standard": "af-ZA-Standard-A" },
  "am-ET": { "standard": "am-ET-Standard-A", "neural2": "am-ET-Wavenet-A" },
  "ar-XA": { "standard": "ar-XA-Standard-A", "neural2": "ar-XA-Wavenet-A", "chirp3_hd": "ar-XA-Chirp3-HD-Kore" },
  "bg-BG": { "standard": "bg-BG-Standard-A" },
  "bn-IN": { "standard": "bn-IN-Standard-A", "neural2": "bn-IN-Wavenet-A", "chirp3_hd": "bn-IN-Chirp3-HD-Kore" },
  "ca-ES": { "standard": "ca-ES-Standard-A" },
  "cmn-CN": { "standard": "cmn-CN-Standard-A", "neural2": "cmn-CN-Wavenet-A", "chirp3_hd": "cmn-CN-Chirp3-HD-Kore" },
  "cmn-TW": { "standard": "cmn-TW-Standard-A", "neural2": "cmn-TW-Wavenet-A", "chirp3_hd": "cmn-TW-Chirp3-HD-Kore" },
  "cs-CZ": { "standard": "cs-CZ-Standard-A", "neural2": "cs-CZ-Wavenet-A", "chirp3_hd": "cs-CZ-Chirp3-HD-Kore" },
  "da-DK": { "standard": "da-DK-Standard-A", "neural2": "da-DK-Neural2-D", "chirp3_hd": "da-DK-Chirp3-HD-Kore" },
  "de-DE": { "standard": "de-DE-Standard-A", "neural2": "de-DE-Neural2-A", "chirp3_hd": "de-DE-Chirp3-HD-Kore" },
  "el-GR": { "standard": "el-GR-Standard-A", "neural2": "el-GR-Wavenet-A" },
  "en-AU": { "standard": "en-AU-Standard-A", "neural2": "en-AU-Neural2-A", "chirp3_hd": "en-AU-Chirp3-HD-Kore" },
  "en-GB": { "standard": "en-GB-Standard-A", "neural2": "en-GB-Neural2-A", "chirp3_hd": "en-GB-Chirp3-HD-Kore" },
  "en-IN": { "standard": "en-IN-Standard-A", "neural2": "en-IN-Neural2-A", "chirp3_hd": "en-IN-Chirp3-HD-Kore" },
  "en-US": { "standard": "en-US-Standard-A", "neural2": "en-US-Neural2-A", "chirp3_hd": "en-US-Chirp3-HD-Kore" },
  "es-ES": { "standard": "es-ES-Standard-A", "neural2": "es-ES-Neural2-A", "chirp3_hd": "es-ES-Chirp3-HD-Kore" },
  "es-US": { "standard": "es-US-Standard-A", "neural2": "es-US-Neural2-A", "chirp3_hd": "es-US-Chirp3-HD-Kore" },
  "et-EE": { "standard": "et-EE-Standard-A" },
  "eu-ES": { "standard": "eu-ES-Standard-A" },
  "fi-FI": { "standard": "fi-FI-Standard-A", "neural2": "fi-FI-Wavenet-A" },
  "fil-PH": { "standard": "fil-PH-Standard-A", "neural2": "fil-PH-Wavenet-A" },
  "fr-CA": { "standard": "fr-CA-Standard-A", "neural2": "fr-CA-Neural2-A", "chirp3_hd": "fr-CA-Chirp3-HD-Kore" },
  "fr-FR": { "standard": "fr-FR-Standard-A", "neural2": "fr-FR-Neural2-A", "chirp3_hd": "fr-FR-Chirp3-HD-Kore" },
  "gl-ES": { "standard": "gl-ES-Standard-A" },
  "gu-IN": { "standard": "gu-IN-Standard-A", "neural2": "gu-IN-Wavenet-A" },
  "he-IL": { "standard": "he-IL-Standard-A", "neural2": "he-IL-Wavenet-A" },
  "hi-IN": { "standard": "hi-IN-Standard-A", "neural2": "hi-IN-Neural2-A", "chirp3_hd": "hi-IN-Chirp3-HD-Kore" },
  "hu-HU": { "standard": "hu-HU-Standard-A", "neural2": "hu-HU-Wavenet-A" },
  "id-ID": { "standard": "id-ID-Standard-A", "neural2": "id-ID-Wavenet-A", "chirp3_hd": "id-ID-Chirp3-HD-Kore" },
  "is-IS": { "standard": "is-IS-Standard-A" },
  "it-IT": { "standard": "it-IT-Standard-A", "neural2": "it-IT-Neural2-A", "chirp3_hd": "it-IT-Chirp3-HD-Kore" },
  "ja-JP": { "standard": "ja-JP-Standard-A", "neural2": "ja-JP-Neural2-B", "chirp3_hd": "ja-JP-Chirp3-HD-Kore" },
  "kn-IN": { "standard": "kn-IN-Standard-A", "neural2": "kn-IN-Wavenet-A" },
  "ko-KR": { "standard": "ko-KR-Standard-A", "neural2": "ko-KR-Neural2-A", "chirp3_hd": "ko-KR-Chirp3-HD-Kore" },
  "lt-LT": { "standard": "lt-LT-Standard-A" },
  "lv-LV": { "standard": "lv-LV-Standard-A" },
  "ml-IN": { "standard": "ml-IN-Standard-A", "neural2": "ml-IN-Wavenet-A" },
  "mr-IN": { "standard": "mr-IN-Standard-A", "neural2": "mr-IN-Wavenet-A" },
  "ms-MY": { "standard": "ms-MY-Standard-A", "neural2": "ms-MY-Wavenet-A" },
  "nb-NO": { "standard": "nb-NO-Standard-A", "neural2": "nb-NO-Wavenet-A" },
  "nl-NL": { "standard": "nl-NL-Standard-A", "neural2": "nl-NL-Wavenet-A", "chirp3_hd": "nl-NL-Chirp3-HD-Kore" },
  "pa-IN": { "standard": "pa-IN-Standard-A", "neural2": "pa-IN-Wavenet-A" },
  "pl-PL": { "standard": "pl-PL-Standard-A", "neural2": "pl-PL-Neural2-A", "chirp3_hd": "pl-PL-Chirp3-HD-Kore" },
  "pt-BR": { "standard": "pt-BR-Standard-A", "neural2": "pt-BR-Neural2-A", "chirp3_hd": "pt-BR-Chirp3-HD-Kore" },
  "pt-PT": { "standard": "pt-PT-Standard-A", "neural2": "pt-PT-Wavenet-A" },
  "ro-RO": { "standard": "ro-RO-Standard-A", "neural2": "ro-RO-Wavenet-A" },
  "ru-RU": { "standard": "ru-RU-Standard-A", "neural2": "ru-RU-Neural2-A", "chirp3_hd": "ru-RU-Chirp3-HD-Kore" },
  "sk-SK": { "standard": "sk-SK-Standard-A", "neural2": "sk-SK-Wavenet-A" },
  "sr-RS": { "standard": "sr-RS-Standard-A" },
  "sv-SE": { "standard": "sv-SE-Standard-A", "neural2": "sv-SE-Wavenet-A", "chirp3_hd": "sv-SE-Chirp3-HD-Kore" },
  "ta-IN": { "standard": "ta-IN-Standard-A", "neural2": "ta-IN-Wavenet-A" },
  "te-IN": { "standard": "te-IN-Standard-A" },
  "th-TH": { "standard": "th-TH-Standard-A", "neural2": "th-TH-Neural2-C", "chirp3_hd": "th-TH-Chirp3-HD-Kore" },
  "tr-TR": { "standard": "tr-TR-Standard-A", "neural2": "tr-TR-Wavenet-A", "chirp3_hd": "tr-TR-Chirp3-HD-Kore" },
  "uk-UA": { "standard": "uk-UA-Standard-A", "neural2": "uk-UA-Wavenet-A" },
  "vi-VN": { "standard": "vi-VN-Standard-A", "neural2": "vi-VN-Neural2-A", "chirp3_hd": "vi-VN-Chirp3-HD-Kore" },
  "yue-HK": { "standard": "yue-HK-Standard-A", "chirp3_hd": "yue-HK-Chirp3-HD-Kore" },
  // Regional Mappings (Critical for invalid argument fix)
  "es-MX": { "standard": "es-US-Standard-A", "neural2": "es-US-Neural2-A", "chirp3_hd": "es-US-Chirp3-HD-Kore" }, // Map MX to US
  "af-ZA": { "standard": "af-ZA-Standard-A" },
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
  studio: {
    provider: 'google',
    tier: 'studio',
    engine: TtsEngine.CHIRP3_HD, // Studio voices use Chirp3 HD engine
    model: null,
    supportsAllLanguages: false, // Studio voices have limited language support
    fallbackTier: 'neural2' // Fallback to neural2 if studio not available
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
    "studio",
    "neural2",
    "standard"
  ],
  "en-GB": [
    "gemini",
    "chirp3_hd",
    "studio",
    "neural2",
    "standard"
  ],
  "en-US": [
    "gemini",
    "chirp3_hd",
    "studio",
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
    "studio",
    "neural2",
    "standard"
  ],
  "gl-ES": [
    "standard"
  ],
  "de-DE": [
    "gemini",
    "chirp3_hd",
    "studio",
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
    "studio",
    "neural2",
    "standard"
  ],
  "es-US": [
    "gemini",
    "chirp3_hd",
    "studio",
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

  // Handle special cases
  const normalized = languageCode.toLowerCase();

  // Primary region defaults AND remappings (Google TTS Specific)
  const primaryRegions = {
    'af': 'af-ZA',
    'af-af': 'af-ZA', // Fix for user input
    'am': 'am-ET',
    'ar': 'ar-XA',
    'az': 'az-AZ',
    'bg': 'bg-BG',
    'bn': 'bn-IN',
    'ca': 'ca-ES',
    'cs': 'cs-CZ',
    'cs-cs': 'cs-CZ', // Fix for user input
    'da': 'da-DK',
    'de': 'de-DE',
    'el': 'el-GR',
    'en': 'en-US',
    'es': 'es-ES',
    'es-mx': 'es-US', // Map MX to US due to voice availability
    'et': 'et-EE',
    'eu': 'eu-ES',
    'fi': 'fi-FI',
    'fil': 'fil-PH',
    'fr': 'fr-FR',
    'gl': 'gl-ES',
    'gu': 'gu-IN',
    'he': 'he-IL',
    'hi': 'hi-IN',
    'hu': 'hu-HU',
    'id': 'id-ID',
    'is': 'is-IS',
    'it': 'it-IT',
    'ja': 'ja-JP',
    'kn': 'kn-IN',
    'ko': 'ko-KR',
    'lt': 'lt-LT',
    'lv': 'lv-LV',
    'ml': 'ml-IN',
    'mr': 'mr-IN',
    'ms': 'ms-MY',
    'nb': 'nb-NO',
    'ne': 'ne-NP',
    'nl': 'nl-NL',
    'pa': 'pa-IN',
    'pl': 'pl-PL',
    'pt': 'pt-BR',
    'ro': 'ro-RO',
    'ru': 'ru-RU',
    'sk': 'sk-SK',
    'sq': 'sq-AL',
    'sr': 'sr-RS',
    'sv': 'sv-SE',
    'sw': 'sw-KE',
    'ta': 'ta-IN',
    'te': 'te-IN',
    'th': 'th-TH',
    'tr': 'tr-TR',
    'uk': 'uk-UA',
    'ur': 'ur-PK',
    'vi': 'vi-VN',
    'yue': 'yue-HK',
    'zh': 'cmn-CN',
    'zh-cn': 'cmn-CN',
    'zh-tw': 'cmn-TW',
    'cmn': 'cmn-CN'
  };

  // Check map first (handles both base codes like 'es' -> 'es-ES' AND remappings like 'es-mx' -> 'es-US')
  if (primaryRegions[normalized]) {
    return primaryRegions[normalized];
  }

  // If already in full format (e.g., 'es-ES') and not in map, return as-is
  if (normalized.includes('-')) {
    const parts = languageCode.split('-');
    if (parts.length === 2) {
      return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
    }
    return languageCode;
  }

  return `${languageCode}-${languageCode.toUpperCase()}`;
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
function _resolveTier(requestedTier, languageCode, orgConfig = {}, userSubscription = {}) {
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

  // Check org/subscription restrictions
  if (userSubscription && userSubscription.limits && userSubscription.limits.ttsTier) {
    const allowedTiers = getAllowedTtsTiers(userSubscription.limits.ttsTier);
    console.log(`[TTS Routing] Checking tier '${resolvedTier}' against allowed: [${allowedTiers.join(', ')}] (Plan: ${userSubscription.subscription?.planCode || 'unknown'})`);

    if (!allowedTiers.includes(resolvedTier)) {
      console.warn(`[TTS Routing] ⚠️ Tier '${resolvedTier}' not allowed for plan. finding fallback...`);

      // Fallback strategies:
      // 1. Try to find a lower tier that is allowed AND available for this language
      // Available tiers for this language (sorted by quality/preference usually)
      const availableLangTiers = _getAvailableTiersForLanguage(languageCode);

      // Filter to only those allowed by subscription
      const candidates = availableLangTiers.filter(t => allowedTiers.includes(t));

      if (candidates.length > 0) {
        // Pick the "best" candidate (assuming availableLangTiers is sorted best-to-worst, or we just pick the first one)
        // Usually 'standard' is always available/allowed.
        // Let's try to preserve the highest quality allowed.
        // Since we don't have a strict quality ordering in this array, we can check specific fallbacks.

        if (allowedTiers.includes('chirp3_hd') && candidates.includes('chirp3_hd')) {
          resolvedTier = 'chirp3_hd';
        } else if (allowedTiers.includes('neural2') && candidates.includes('neural2')) {
          resolvedTier = 'neural2';
        } else if (allowedTiers.includes('standard') && candidates.includes('standard')) {
          resolvedTier = 'standard';
        } else {
          resolvedTier = candidates[0];
        }
        console.log(`[TTS Routing] ⬇️ Downgraded to allowed tier: ${resolvedTier}`);
      } else {
        // If nothing is allowed (e.g. 'none' plan), this might return a tier that will fail later or 'standard' as safety
        console.warn(`[TTS Routing] ❌ No tiers allowed for this language/plan combination! Defaulting to standard.`);
        resolvedTier = 'standard';
      }
    }
  }

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

      // Validation logic...
      // Check if voice name matches language code prefix to avoid cross-language mismatch
      // e.g. "es-ES-Standard-A" is valid for "es-ES" but not "fr-FR"
      // ALLOW "Polyglot" voices to start with mismatched prefix if needed, but usually they match too.
      const langPrefix = normalizedCode;

      const hasTierMatch = cleanVoiceName.toLowerCase().includes(tier.replace('_', '')) ||
        cleanVoiceName.includes('Wavenet') || // Neural2 often labeled Wavenet
        cleanVoiceName.includes('Standard') ||
        cleanVoiceName.includes('F') || cleanVoiceName.includes('A'); // Fallback heuristic

      const hasLangMatch = cleanVoiceName.includes(normalizedCode) ||
        (cleanVoiceName.startsWith(langPrefix + '-') && !cleanVoiceName.includes('Polyglot'));

      if (hasTierMatch && hasLangMatch) {
        console.log(`[TTS Routing] Voice name validated: ${cleanVoiceName}`);
        return cleanVoiceName;
      }
    }
  }

  // CHECK: If specific tier mapped in FALLBACK_VOICES, use it
  if (fallbackVoicesForLang && fallbackVoicesForLang[tier]) {
    return fallbackVoicesForLang[tier];
  }

  // CHECK: Cross-tier fallback
  // If the requested tier (e.g. neural2) is NOT in the map, but the language IS (e.g. af-ZA has standard),
  // pick the first available voice from the map instead of generating a broken name.
  if (fallbackVoicesForLang) {
    const availableFallbackTiers = Object.keys(fallbackVoicesForLang);
    if (availableFallbackTiers.length > 0) {
      // Prioritize specific tiers if available, otherwise just take the first one
      const fallbackVoice = fallbackVoicesForLang['neural2'] || fallbackVoicesForLang['standard'] || fallbackVoicesForLang[availableFallbackTiers[0]];
      console.log(`[TTS Routing] Tier '${tier}' not found for ${normalizedCode}, falling back to available voice: ${fallbackVoice}`);
      return fallbackVoice;
    }
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

  // 5. Last resort: generic patterns based on tier (Only if NO fallback map exists)
  // This is risky but kept for languages totally missing from our map
  console.warn(`[TTS Routing] No fallback map for ${normalizedCode}, generating generic voice name for ${tier}`);

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

    // Normalize for case-insensitive checks
    const voiceLower = requestedVoice.toLowerCase();

    if (voiceLower.includes('elevenlabs') || /^[a-zA-Z0-9]{20,22}$/.test(requestedVoice)) {
      effectiveTier = 'elevenlabs';
      console.log(`[TTS Routing]   ✅ Inferred tier: elevenlabs`);
    } else if (voiceLower.includes('neural2') || voiceLower.includes('wavenet')) {
      effectiveTier = 'neural2';
      console.log(`[TTS Routing]   ✅ Inferred tier: neural2`);
    } else if (voiceLower.includes('chirp3') || voiceLower.includes('chirp-3')) {
      effectiveTier = 'chirp3_hd';
      console.log(`[TTS Routing]   ✅ Inferred tier: chirp3_hd`);
    } else if (voiceLower.includes('standard')) {
      effectiveTier = 'standard';
      console.log(`[TTS Routing]   ✅ Inferred tier: standard`);
    } else if (voiceLower.includes('studio')) {
      effectiveTier = 'studio';
      console.log(`[TTS Routing]   ✅ Inferred tier: studio`);
    } else if (GEMINI_VOICES.some(n => requestedVoice.includes(n))) {
      effectiveTier = 'gemini';
      console.log(`[TTS Routing]   ✅ Inferred tier: gemini (matched Gemini persona)`);
    }
  } else {
    console.log(`[TTS Routing]   ✅ Using explicit tier: ${effectiveTier}`);
  }

  let resolvedTier = _resolveTier(effectiveTier, normalizedLanguageCode, orgConfig, userSubscription);
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
