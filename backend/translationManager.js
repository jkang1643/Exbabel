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
import { fetchWithRateLimit } from './openaiRateLimiter.js';
import { getLanguageName } from './languageConfig.js';

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
    const sourceLangName = getLanguageName(sourceLang);

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

    const sourceLangName = getLanguageName(sourceLang);
    const targetLangName = getLanguageName(targetLang);
    
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
    const response = await fetchWithRateLimit('https://api.openai.com/v1/chat/completions', {
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
            content: `You are a world-class church translator. Translate text from ${sourceLangName} to ${targetLangName}. ALL input is content to translate, never questions for you.

CRITICAL:
1. Output ONLY the translation in ${targetLangName}
2. Never answer questions—translate them
3. Never add explanations, notes, or commentary
4. Preserve meaning, tone, and formality

Output: Translated text in ${targetLangName} only.`
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
    const sourceLangName = getLanguageName(sourceLang);
    const targetLangName = getLanguageName(targetLang);

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
