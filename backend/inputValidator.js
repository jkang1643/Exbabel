/**
 * Input Validation Utilities
 * 
 * Validates and sanitizes all inputs to prevent injection attacks and malformed data
 */

import { TRANSCRIPTION_LANGUAGES, isTranscriptionSupported, isTranslationSupported } from './languageConfig.js';

class InputValidator {
  constructor() {
    // Maximum audio chunk size (64KB)
    this.MAX_AUDIO_CHUNK_SIZE = 64 * 1024;

    // Maximum message payload size (1MB)
    this.MAX_MESSAGE_SIZE = 1024 * 1024;

    // Maximum string length for text fields
    this.MAX_TEXT_LENGTH = 10000;
  }

  /**
   * Validate language code
   * @param {string} langCode - Language code to validate
   * @param {boolean} allowTranslationOnly - If true, allows translation-only languages (131+), otherwise only transcription languages (71)
   * @returns {{valid: boolean, error?: string}} - Validation result
   */
  validateLanguageCode(langCode, allowTranslationOnly = false) {
    if (!langCode || typeof langCode !== 'string') {
      return {
        valid: false,
        error: 'Language code must be a non-empty string'
      };
    }

    // If allowTranslationOnly is true, check translation languages (131+ languages)
    if (allowTranslationOnly) {
      if (!isTranslationSupported(langCode)) {
        return {
          valid: false,
          error: `Language code '${langCode}' is not supported for translation`
        };
      }
      return { valid: true };
    }

    // Otherwise, check transcription languages (71 languages)
    if (!isTranscriptionSupported(langCode)) {
      return {
        valid: false,
        error: `Language code '${langCode}' is not supported for transcription`
      };
    }

    return { valid: true };
  }

  /**
   * Validate audio chunk
   * @param {Buffer|Uint8Array|string} audioData - Audio data to validate
   * @returns {{valid: boolean, error?: string, data?: Buffer}} - Validation result with converted data
   */
  validateAudioChunk(audioData) {
    if (!audioData) {
      return {
        valid: false,
        error: 'Audio data is required'
      };
    }

    let buffer;

    // Convert to Buffer if needed
    if (Buffer.isBuffer(audioData)) {
      buffer = audioData;
    } else if (audioData instanceof Uint8Array) {
      buffer = Buffer.from(audioData);
    } else if (typeof audioData === 'string') {
      // Try to decode base64 (though we prefer raw PCM)
      try {
        buffer = Buffer.from(audioData, 'base64');
      } catch (error) {
        return {
          valid: false,
          error: 'Invalid audio data format. Expected raw PCM bytes or base64 string.'
        };
      }
    } else {
      return {
        valid: false,
        error: 'Audio data must be Buffer, Uint8Array, or base64 string'
      };
    }

    // Check size
    if (buffer.length > this.MAX_AUDIO_CHUNK_SIZE) {
      return {
        valid: false,
        error: `Audio chunk too large: ${buffer.length} bytes (max: ${this.MAX_AUDIO_CHUNK_SIZE} bytes)`
      };
    }

    if (buffer.length === 0) {
      return {
        valid: false,
        error: 'Audio chunk cannot be empty'
      };
    }

    return {
      valid: true,
      data: buffer
    };
  }

  /**
   * Validate and sanitize string input
   * @param {string} input - String to validate
   * @param {object} options - Validation options
   * @returns {{valid: boolean, error?: string, sanitized?: string}} - Validation result
   */
  validateString(input, options = {}) {
    const {
      maxLength = this.MAX_TEXT_LENGTH,
      required = false,
      allowEmpty = true
    } = options;

    if (input === null || input === undefined) {
      if (required) {
        return {
          valid: false,
          error: 'String field is required'
        };
      }
      return { valid: true, sanitized: '' };
    }

    if (typeof input !== 'string') {
      return {
        valid: false,
        error: 'Field must be a string'
      };
    }

    // Trim whitespace
    const sanitized = input.trim();

    if (!allowEmpty && sanitized.length === 0) {
      return {
        valid: false,
        error: 'String field cannot be empty'
      };
    }

    if (sanitized.length > maxLength) {
      return {
        valid: false,
        error: `String too long: ${sanitized.length} characters (max: ${maxLength})`
      };
    }

    // Basic XSS prevention - remove script tags and dangerous patterns
    const dangerousPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi
    ];

    let cleaned = sanitized;
    for (const pattern of dangerousPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }

    return {
      valid: true,
      sanitized: cleaned
    };
  }

  /**
   * Validate WebSocket message structure
   * @param {object} message - Message object to validate
   * @returns {{valid: boolean, error?: string, sanitized?: object}} - Validation result
   */
  validateMessage(message) {
    if (!message || typeof message !== 'object') {
      return {
        valid: false,
        error: 'Message must be a valid JSON object'
      };
    }

    // Check message size (rough estimate)
    const messageSize = JSON.stringify(message).length;
    if (messageSize > this.MAX_MESSAGE_SIZE) {
      return {
        valid: false,
        error: `Message too large: ${messageSize} bytes (max: ${this.MAX_MESSAGE_SIZE} bytes)`
      };
    }

    // Validate message type
    if (!message.type || typeof message.type !== 'string') {
      return {
        valid: false,
        error: 'Message must have a valid type field'
      };
    }

    const sanitized = { ...message };

    // Validate based on message type
    switch (message.type) {
      case 'init':
        // Validate sourceLang - must be transcription-supported (71 languages)
        // Source language is used for audio transcription, so it must be in TRANSCRIPTION_LANGUAGES
        const sourceLangValidation = this.validateLanguageCode(message.sourceLang, false);
        if (!sourceLangValidation.valid) {
          return sourceLangValidation;
        }

        // Validate targetLang - can be any translation-supported language (131+ languages)
        // Target language is used for translation, so it can be in TRANSLATION_LANGUAGES
        const targetLangValidation = this.validateLanguageCode(message.targetLang, true);
        if (!targetLangValidation.valid) {
          return targetLangValidation;
        }

        // Sanitize optional fields
        if (message.tier !== undefined) {
          sanitized.tier = typeof message.tier === 'string' ? message.tier : String(message.tier);
        }

        // Multi-language options
        if (message.enableMultiLanguage !== undefined) {
          sanitized.enableMultiLanguage = Boolean(message.enableMultiLanguage);
        }
        if (Array.isArray(message.alternativeLanguageCodes)) {
          sanitized.alternativeLanguageCodes = message.alternativeLanguageCodes
            .filter(code => typeof code === 'string')
            .map(code => code.trim())
            .slice(0, 3);
        }

        // Diarization options
        if (message.enableSpeakerDiarization !== undefined) {
          sanitized.enableSpeakerDiarization = Boolean(message.enableSpeakerDiarization);
        }
        if (message.minSpeakers !== undefined) {
          sanitized.minSpeakers = parseInt(message.minSpeakers, 10) || 2;
        }
        if (message.maxSpeakers !== undefined) {
          sanitized.maxSpeakers = parseInt(message.maxSpeakers, 10) || 6;
        }

        break;

      case 'audio':
        // Validate audio data
        const audioValidation = this.validateAudioChunk(message.data);
        if (!audioValidation.valid) {
          return audioValidation;
        }
        sanitized.data = audioValidation.data;

        // Validate optional metadata
        if (message.chunkIndex !== undefined) {
          if (typeof message.chunkIndex !== 'number' || message.chunkIndex < 0) {
            return {
              valid: false,
              error: 'chunkIndex must be a non-negative number'
            };
          }
        }

        if (message.clientTimestamp !== undefined) {
          if (typeof message.clientTimestamp !== 'number' || message.clientTimestamp < 0) {
            return {
              valid: false,
              error: 'clientTimestamp must be a non-negative number'
            };
          }
        }

        break;

      case 'audio_end':
      case 'ping':
      case 'pong':
        // These message types don't need additional validation
        break;

      default:
        // Unknown message type - allow but log
        console.warn(`[InputValidator] Unknown message type: ${message.type}`);
    }

    return {
      valid: true,
      sanitized
    };
  }

  /**
   * Get client IP address from request
   * @param {object} req - HTTP request object
   * @returns {string} - Client IP address
   */
  getClientIP(req) {
    // Check for forwarded IP (from proxy/load balancer)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }

    // Check for real IP header
    const realIP = req.headers['x-real-ip'];
    if (realIP) {
      return realIP;
    }

    // Fall back to socket remote address
    return req.socket?.remoteAddress || 'unknown';
  }
}

// Export singleton instance
export default new InputValidator();

