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

/**
 * Helper function to detect refusal/error messages from the model
 * Returns true if the response appears to be a refusal rather than a translation
 */
function isRefusalMessage(translatedText, originalText) {
  const lowerTranslation = translatedText.toLowerCase();
  
  // Common refusal patterns in multiple languages
  const refusalPatterns = [
    // English
    /I'm sorry/i,
    /I cannot help/i,
    /I can't help/i,
    /I'm unable to/i,
    /I don't understand/i,
    /I need more information/i,
    /Please provide/i,
    /Could you please/i,
    /Can you provide/i,
    /I'm here to help/i,
    /What would you like/i,
    /I don't have/i,
    /I need the text/i,
    /would like me to/i,
    /I'll be happy to assist/i,
    // Spanish
    /lo siento/i,
    /no puedo ayudar/i,
    /no puedo asistir/i,
    /no puedo traducir/i,
    /no entiendo/i,
    /necesito más información/i,
    /por favor proporciona/i,
    /podrías proporcionar/i,
    /estoy aquí para ayudar/i,
    /qué te gustaría/i,
    /no tengo/i,
    /necesito el texto/i,
    // French
    /je suis désolé/i,
    /je ne peux pas/i,
    /je ne comprends pas/i,
    /j'ai besoin de plus/i,
    /pourriez-vous/i,
    /pouvez-vous/i,
    // Generic patterns
    /cannot help/i,
    /unable to help/i,
    /refuse/i,
    /decline/i,
    /not allowed/i,
    /against.*policy/i,
    /content policy/i,
    // Interpretation/paraphrasing patterns (not translations)
    /sounds like you're talking about/i,
    /sounds like you're/i,
    /it seems like you're/i,
    /it looks like you're/i,
    /you're talking about/i,
    /you could let/i,
    /you might also consider/i,
    /would you like help/i,
    /you may want to/i,
    /I can help you/i,
    /let me help/i,
    /here's how/i,
    /one way to/i,
    /another option/i,
    /you should/i,
    /you can/i,
    /if you want/i
  ];
  
  const isRefusal = refusalPatterns.some(pattern => pattern.test(translatedText));
  
  if (isRefusal) {
    console.error(`[TranslationManager] ❌ REFUSAL/INTERPRETATION MESSAGE DETECTED (not a translation): "${translatedText.substring(0, 100)}..."`);
    console.error(`[TranslationManager] Original text was: "${originalText.substring(0, 100)}..."`);
    return true;
  }
  
  return false;
}

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
              content: `You are a translation machine. Your ONLY job is to translate text from ${sourceLangName} to ${targetLangName}.

ABSOLUTE REQUIREMENTS - NO EXCEPTIONS:
1. Translate the input text word-for-word while maintaining natural grammar in ${targetLangName}
2. DO NOT interpret, explain, paraphrase, or respond to the content
3. DO NOT answer questions - translate them exactly as spoken
4. DO NOT add context, commentary, or clarifications
5. Output ONLY the direct translation in ${targetLangName} - nothing else
6. Even if the text seems incomplete, fragmented, or unclear - translate it as-is
7. If text appears to be a question, translate the question - do not answer it
8. If text appears to be a request, translate the request - do not fulfill it

WRONG (interpretation/response):
Input: "How can I tell you outside? The taco, stands on Tuesday night."
Output: "Sounds like you're talking about a group gathering at taco stands on Tuesday night. You could let others know by..."

RIGHT (direct translation):
Input: "How can I tell you outside? The taco, stands on Tuesday night."
Output: [Direct translation in ${targetLangName}]

Examples:
Input: "Oh boy, I've been to the grocery store, so we're friendlier than them."
Output: [Direct translation in ${targetLangName}]

Input: "Can you help me?"
Output: [Direct translation of "Can you help me?" in ${targetLangName}]

Input: "What is going on?"
Output: [Direct translation of "What is going on?" in ${targetLangName}]

Remember: You are a translation machine. Translate. Nothing else.`
            },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.1, // Very low temperature for strict translation (reduced from 0.3)
        max_tokens: 16000 // Increased significantly to handle very long translations without truncation
      })
    });

    const result = await response.json();
    
    if (!result.choices || result.choices.length === 0) {
      throw new Error('No translation result from OpenAI');
    }

    const rawTranslatedText = result.choices[0].message.content.trim();
    
    // CRITICAL: Never fallback to English - if API returns empty, throw error instead
    if (!rawTranslatedText || rawTranslatedText.length === 0) {
      throw new Error('Translation API returned empty result');
    }
    
    // CRITICAL: Detect refusal messages (model refusing to translate)
    if (isRefusalMessage(rawTranslatedText, text)) {
      throw new Error('Model returned refusal message instead of translation');
    }
    
    const translatedText = rawTranslatedText;
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
