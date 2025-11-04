/**
 * Translation Manager - Handles translation for multi-user sessions
 * 
 * MIGRATION NOTES:
 * - Replaced Gemini WebSocket API with OpenAI Chat Completions API
 * - Uses GPT-4 for high-quality translations
 * - Maintains caching and batch translation optimization
 * - Same interface for backward compatibility
 */

import fetch from 'node-fetch';

// Language code to full name mapping
const LANGUAGE_NAMES = {
  'en': 'English',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'it': 'Italian',
  'pt': 'Portuguese',
  'pt-BR': 'Portuguese (Brazil)',
  'ru': 'Russian',
  'ja': 'Japanese',
  'ko': 'Korean',
  'zh': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  'ar': 'Arabic',
  'hi': 'Hindi',
  'nl': 'Dutch',
  'pl': 'Polish',
  'tr': 'Turkish',
  'bn': 'Bengali',
  'vi': 'Vietnamese',
  'th': 'Thai',
  'id': 'Indonesian',
  'sv': 'Swedish',
  'no': 'Norwegian',
  'da': 'Danish',
  'fi': 'Finnish',
  'el': 'Greek',
  'cs': 'Czech',
  'ro': 'Romanian',
  'hu': 'Hungarian',
  'he': 'Hebrew',
  'uk': 'Ukrainian',
  'fa': 'Persian',
  'ur': 'Urdu',
  'ta': 'Tamil',
  'te': 'Telugu',
  'mr': 'Marathi',
  'gu': 'Gujarati',
  'kn': 'Kannada',
  'ml': 'Malayalam',
  'sw': 'Swahili',
  'fil': 'Filipino',
  'ms': 'Malay',
  'ca': 'Catalan',
  'sk': 'Slovak',
  'bg': 'Bulgarian',
  'hr': 'Croatian',
  'sr': 'Serbian',
  'lt': 'Lithuanian',
  'lv': 'Latvian',
  'et': 'Estonian',
  'sl': 'Slovenian',
  'af': 'Afrikaans'
};

class TranslationManager {
  constructor() {
    this.translationCache = new Map(); // Cache recent translations
    this.pendingTranslations = new Map(); // Debounce translation requests
  }

  /**
   * Translate text from source language to multiple target languages
   * Uses batch translation to minimize API calls
   * MIGRATION NOTE: Now uses OpenAI instead of Gemini
   */
  async translateToMultipleLanguages(text, sourceLang, targetLangs, apiKey) {
    if (!text || targetLangs.length === 0) {
      return {};
    }

    const translations = {};
    const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;

    // If source language is in target languages, include original text
    if (targetLangs.includes(sourceLang)) {
      translations[sourceLang] = text;
    }

    // Filter out source language from targets
    const langsToTranslate = targetLangs.filter(lang => lang !== sourceLang);

    if (langsToTranslate.length === 0) {
      return translations;
    }

    console.log(`[TranslationManager] Translating from ${sourceLangName} to ${langsToTranslate.length} languages using OpenAI`);

    // Translate to each target language
    const translationPromises = langsToTranslate.map(async (targetLang) => {
      try {
        const translated = await this.translateText(text, sourceLang, targetLang, apiKey);
        return { lang: targetLang, text: translated };
      } catch (error) {
        console.error(`[TranslationManager] Failed to translate to ${targetLang}:`, error.message);
        return { lang: targetLang, text: `[Translation error: ${targetLang}]` };
      }
    });

    const results = await Promise.all(translationPromises);
    
    results.forEach(({ lang, text }) => {
      translations[lang] = text;
    });

    return translations;
  }

  /**
   * Translate text from source to target language using OpenAI Chat API
   * MIGRATION NOTE: Replaced Gemini WebSocket with OpenAI Chat Completions API
   */
  async translateText(text, sourceLang, targetLang, apiKey) {
    const cacheKey = `${sourceLang}:${targetLang}:${text.substring(0, 100)}`;
    
    // Check cache
    if (this.translationCache.has(cacheKey)) {
      const cached = this.translationCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 60000) { // 1 minute cache
        console.log(`[TranslationManager] Using cached translation`);
        return cached.text;
      }
    }

    const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
    const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;
    
    if (!apiKey) {
      console.error('[TranslationManager] ERROR: No OpenAI API key provided!');
      throw new Error('No OpenAI API key provided for translation');
    }
    
    console.log(`[TranslationManager] Translating via OpenAI: "${text.substring(0, 50)}..." (${sourceLangName} → ${targetLangName})`);

    try {
      // Use OpenAI Chat Completions API for translation
      const translatedText = await this.translateViaOpenAI(text, sourceLangName, targetLangName, apiKey);

      const finalText = translatedText.trim() || text; // Fallback to original if translation fails

      // Cache the result
      this.translationCache.set(cacheKey, {
        text: finalText,
        timestamp: Date.now()
      });

      // Limit cache size
      if (this.translationCache.size > 100) {
        const firstKey = this.translationCache.keys().next().value;
        this.translationCache.delete(firstKey);
      }

      return finalText;
    } catch (error) {
      console.error(`[TranslationManager] Translation error (${sourceLangName} → ${targetLangName}):`, error.message);
      throw error;
    }
  }

  /**
   * Translate text using OpenAI Chat Completions API
   * MIGRATION NOTE: This replaces the Gemini WebSocket translation
   */
  async translateViaOpenAI(text, sourceLangName, targetLangName, apiKey) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Use GPT-4o-mini for faster translation
        messages: [
          {
            role: 'system',
            content: `You are a professional translator. Translate text from ${sourceLangName} to ${targetLangName}.

CRITICAL RULES:
1. ONLY provide the direct translation - no explanations
2. Do NOT include phrases like "The translation is..." or "Here's the translation"
3. Do NOT add any notes or commentary
4. Preserve the meaning, tone, and context
5. Maintain proper grammar and natural phrasing in ${targetLangName}
6. Keep the same level of formality as the original

Output: Only the translated text in ${targetLangName}.`
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.3, // Low temperature for consistent translations
        max_tokens: 16000 // Increased significantly to handle very long translations without truncation
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
      throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
    }

    const result = await response.json();
    
    if (!result.choices || result.choices.length === 0) {
      throw new Error('No translation result from OpenAI');
    }

    const translatedText = result.choices[0].message.content.trim();
    return translatedText;
  }

  /**
   * Get system instruction for real-time translation
   * MIGRATION NOTE: This is no longer used with OpenAI Realtime (uses instructions in pool)
   * Kept for backward compatibility
   */
  getSystemInstruction(sourceLang, targetLang) {
    const sourceLangName = LANGUAGE_NAMES[sourceLang] || sourceLang;
    const targetLangName = LANGUAGE_NAMES[targetLang] || targetLang;

    return {
      parts: [{
        text: `You are a professional real-time transcriber. You will receive audio input in ${sourceLangName}.

CRITICAL RULES:
1. Your PRIMARY task is to transcribe the audio you hear into clear text in ${sourceLangName}
2. Provide accurate transcription of the exact words spoken
3. Do NOT translate to ${targetLangName} - only transcribe to ${sourceLangName}
4. Do NOT ask for text or say "please provide text" - you receive AUDIO
5. Do NOT include explanations
6. Preserve the exact meaning and phrasing from the audio
7. Maintain proper grammar and punctuation in ${sourceLangName}

Your ONLY job: Write what you hear in ${sourceLangName}.`
      }]
    };
  }

  /**
   * Clear translation cache
   */
  clearCache() {
    this.translationCache.clear();
    console.log('[TranslationManager] Cache cleared');
  }
}

// Singleton instance
const translationManager = new TranslationManager();

export default translationManager;
