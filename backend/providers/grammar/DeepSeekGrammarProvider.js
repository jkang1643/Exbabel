
import { BaseGrammarProvider } from './BaseGrammarProvider.js';
import { fetchWithRateLimit, isCurrentlyRateLimited } from '../../openaiRateLimiter.js';
import { normalizePunctuation } from '../../transcriptionCleanup.js';

const GRAMMAR_SYSTEM_PROMPT = `SYSTEM PROMPT — Grammar + Homophone + Sermon Speech Fixer

You are a real-time transcription corrector for live church sermons transcribed by Whisper or other speech-to-text systems.

Your goal is to take partial or final text transcribed from speech-to-text and make it readable while preserving the exact spoken meaning.

**IMPORTANT: This is SPEECH transcription correction, not written text editing. Focus on catching common Whisper/STT mishears that occur in spoken language, especially words that sound similar but are contextually wrong.**

### Rules:

1. **Preserve meaning** — Never change what the speaker meant.
2. **CRITICAL: Word replacement rules for STT/Whisper cleanup**:
   - **ONLY correct words that sound highly similar** (homophones or near-homophones)
   - **Common Whisper/STT speech mishears to watch for**:
     - "so" → "those" (very common: "it was so small groups" → "it was those small groups")
     - "a" → "the" or vice versa (when contextually wrong: "a Bible" vs "the Bible")
     - "there/their/they're" confusion
     - "to/too/two" confusion
     - "sun/son", "hear/here", "right/write", "peace/piece", "break/brake", "see/sea"
     - "knew/new", "know/no", "its/it's", "your/you're", "we're/were/where"
     - "then/than", "affect/effect", "accept/except"
     - "and counter" → "encounter"
     - "are" → "our" (when possessive)
   - **NEVER replace words with synonyms or contextually "better" alternatives** (e.g., "calling" → "addressing", "said" → "stated", "talk" → "speak", "big" → "large")
   - **DO NOT replace words with contextually better alternatives if they don't sound similar**
   - If a word makes sense in context but sounds different, KEEP IT AS IS - the speaker may have actually said that word
   - Only fix words where STT clearly misheard a similar-sounding word (e.g., "sun" → "Son" when referring to Jesus, "there" → "their" for possession)
   - **Remember: Your job is transcription correction, not word improvement. Preserve the speaker's exact word choice unless it's clearly a sound-alike error.**
   - **Pay special attention to speech-specific errors**: Words that are uncommon in written text but common in speech, especially when Whisper mishears similar-sounding words (e.g., "so" misheard instead of "those")
   - **CRITICAL: Fix multi-word phrase mishears, not just single words**: When a phrase doesn't make contextual sense, identify the correct homophone phrase that sounds similar. Examples:
     - "on a work" → "unaware" (sounds similar, "on a work" makes no sense contextually)
     - "for theirs" → "for strangers" (when context suggests it)
     - "do not neces to show" → "do not neglect to show" (when "neces" doesn't make sense)
   - **Use context to identify phrase errors**: If a phrase sounds grammatically wrong or doesn't fit the context, check if there's a similar-sounding phrase that makes sense (e.g., "entertained angels on a work" → "entertained angels unaware")
3. **Fix ALL errors aggressively**:
   - Grammar (run-on sentences, sentence fragments, subject-verb agreement)
   - Punctuation and capitalization (fix ALL capitalization errors, not just sentence starts)
   - Spelling mistakes
   - Homophones and near-homophones (ONLY when they sound similar - see rule 2)
   - Speech-to-text mishears (ONLY choose words that *sound the same or very similar*)
   - Fix incorrect capitalization of common words (e.g., "Hospitality" → "hospitality", "Brotherly Love" → "brotherly love" unless it's a proper noun)
   - Fix run-on sentences by adding proper punctuation
   - Fix sentence fragments by completing them naturally
4. **Respect biblical / church language**:
   - Keep proper nouns like "God", "Jesus", "Holy Spirit", "Gospel", "Revival", "Kingdom", "Scripture" capitalized.
   - Do not modernize or rephrase verses or phrases from the Bible.
   - Recognize sermon phrases like "praise the Lord", "come on somebody", "hallelujah", "amen" and keep them natural.
5. **Never paraphrase or summarize**.
6. **Never change numbers, names, or theological meaning.**
7. If the sentence is incomplete, fix basic punctuation but don't guess the rest — just clean what you have.
8. Maintain oral rhythm: short, natural sentences as a preacher might speak.
9. **Be thorough**: Fix every error you see. Don't leave capitalization mistakes, run-on sentences, or grammar errors uncorrected.
 
### Examples:

Input: "and god so loved the world he give his only begotten sun. One of my Generations. Favorite authors is Max. Lucado. they're heart was broken. we must except Jesus as our savior"
Output: "And God so loved the world that He gave His only begotten Son. One of my generation's favorite authors is Max Lucado. Their heart was broken. We must accept Jesus as our Savior."
(Note: **Homophones:** "sun" → "Son", "they're" → "Their", "except" → "accept". **Grammar:** Fixes punctuation/capitalization errors aggressively.)

Input: "It was so small groups leaving this church in, canoes and boats, and going out and chopping holes in roof and pulling people out. I want to read a Bible verse."
Output: "It was those small groups leaving this church in canoes and boats, and going out and chopping holes in roofs and pulling people out. I want to read the Bible verse."
(Note: **CRITICAL STT Fix:** "so" → "those" (very common STT mishear). **Punctuation/Capitalization** fixed. **A/The** correction.)

Input: "Says, let Brotherly Love continue, do not neces to show. Hospitality to stranger for theirs. Thereby some have entertained angels on a work. we need to and counter God in our daily lives"
Output: "Says, 'Let brotherly love continue. Do not neglect to show hospitality to strangers, for thereby some have entertained angels unaware.' We need to encounter God in our daily lives."
(Note: **Multi-Word Mishears:** "on a work" → "unaware", "neces" → "neglect", "for theirs" → "for strangers". **Speech Mishears:** "and counter" → "encounter". **Capitalization** corrected.)


### Output format:
Output ONLY as a JSON object with the key 'corrected_text'. Example: {"corrected_text": "Your corrected text here"}.`;

// Helper function to validate correction
function validateCorrectionResponse(corrected, original) {
    // Filter out common AI error/help responses
    const errorPatterns = [
        /I'm sorry/i,
        /I need the text/i,
        /would like me to correct/i,
        /Please provide/i,
        /I'll be happy to assist/i,
        /I can help/i,
        /I don't understand/i,
        /Could you please/i,
        /Can you provide/i,
        /I'm here to help/i,
        /What text would you like/i,
        /I cannot/i,
        /I'm unable/i,
        /I don't have/i,
        /I need more information/i
    ];

    const isErrorResponse = errorPatterns.some(pattern => pattern.test(corrected));

    if (isErrorResponse) {
        console.warn(`[DeepSeekGrammarProvider] ⚠️ AI returned error/question instead of correction: "${corrected.substring(0, 100)}..."`);
        console.warn(`[DeepSeekGrammarProvider] ⚠️ Using original text instead: "${original.substring(0, 100)}..."`);
        return original;
    }

    return corrected;
}

export class DeepSeekGrammarProvider extends BaseGrammarProvider {
    constructor(config = {}) {
        super(config);
        this.name = 'deepseek';
        // DeepSeek V3 (deepseek-chat) is the main chat model
        // DeepSeek R1 (deepseek-reasoner) is the reasoning model
        // defaulting to V3 (chat) for speed and cost
        this.model = config.model || 'deepseek-chat';
        this.apiKey = process.env.DEEPSEEK_API; // Load from environment variable
    }

    async correctPartial(text, options = {}) {
        // Logic adapted from OpenAIGrammarProvider
        // Default to using internal key if none provided, or verify passed key
        // NOTE: In production, we assume options.apiKey might be OpenAI key from client,
        // so we prefer using our server-side DEEPSEEK_API key unless configured otherwise.
        const apiKey = this.apiKey;
        const signal = options.signal;

        if (!apiKey) {
            console.error('[DeepSeekGrammarProvider] ERROR: No DEEPSEEK_API key configured in environment');
            return text;
        }

        // Skip API call if rate limited via OpenAI limiter (shared limiter - might want to separate later)
        if (isCurrentlyRateLimited()) {
            console.log(`[DeepSeekGrammarProvider] ⏸️ Rate limited - skipping correction, returning original text`);
            return text;
        }

        try {
            console.log(`[DeepSeekGrammarProvider] 🔄 Correcting PARTIAL (${text.length} chars) with ${this.model}: "${text}"`);

            const requestBody = {
                model: this.model,
                messages: [
                    { role: 'system', content: GRAMMAR_SYSTEM_PROMPT },
                    { role: 'user', content: text }
                ],
                temperature: 0.1, // Low temperature for stability
                max_tokens: 800,
                response_format: { type: 'json_object' }
            };

            const startTime = Date.now();

            // DeepSeek is OpenAI-compatible
            const response = await fetchWithRateLimit('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody),
                signal: signal
            });

            console.log(`[DeepSeekGrammarProvider] 🏁 Request complete in ${Date.now() - startTime}ms. Status: ${response.status}`);

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
                throw new Error(`Grammar API error: ${error.error?.message || response.statusText}`);
            }

            const data = await response.json();
            let corrected = text;

            try {
                const content = data.choices[0]?.message?.content?.trim() || '';
                if (content) {
                    const jsonResponse = JSON.parse(content);
                    corrected = jsonResponse.corrected_text || text;
                }
            } catch (parseError) {
                console.warn(`[DeepSeekGrammarProvider] ⚠️ Failed to parse JSON response, using original text:`, parseError.message);
                corrected = text;
            }

            corrected = validateCorrectionResponse(corrected, text);
            corrected = normalizePunctuation(corrected);

            return corrected;
        } catch (error) {
            if (error.name === 'AbortError') {
                // Let caller handle abort
                throw error;
            }
            console.error(`[DeepSeekGrammarProvider] ❌ Error (${text.length} chars): `, error.message);
            return text;
        }
    }

    async correctFinal(text, options = {}) {
        // Logic adapted from OpenAIGrammarProvider
        const apiKey = this.apiKey;
        const signal = options.signal;

        if (!apiKey) {
            console.error('[DeepSeekGrammarProvider] ERROR: No DEEPSEEK_API key configured');
            return text;
        }

        if (isCurrentlyRateLimited()) {
            console.log(`[DeepSeekGrammarProvider] ⏸️ Rate limited - skipping FINAL correction, returning original text`);
            return text;
        }

        try {
            console.log(`[DeepSeekGrammarProvider] 🔄 Correcting FINAL (${text.length} chars) with ${this.model}: "${text}"`);

            const requestBody = {
                model: this.model,
                messages: [
                    { role: 'system', content: GRAMMAR_SYSTEM_PROMPT },
                    { role: 'user', content: text }
                ],
                temperature: 0.1,
                max_tokens: 2000, // Higher limit for final
                response_format: { type: 'json_object' }
            };

            const startTime = Date.now();

            const response = await fetchWithRateLimit('https://api.deepseek.com/chat/completions', {
                signal: signal,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            console.log(`[DeepSeekGrammarProvider] 🏁 Final Request complete in ${Date.now() - startTime}ms. Status: ${response.status}`);

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
                throw new Error(`Grammar API error: ${error.error?.message || response.statusText}`);
            }

            const data = await response.json();
            let corrected = text;

            try {
                const content = data.choices[0]?.message?.content?.trim() || '';
                if (content) {
                    const jsonResponse = JSON.parse(content);
                    corrected = jsonResponse.corrected_text || text;
                }
            } catch (parseError) {
                console.warn(`[DeepSeekGrammarProvider] ⚠️ Failed to parse JSON response, using original text:`, parseError.message);
                corrected = text;
            }

            corrected = validateCorrectionResponse(corrected, text);
            corrected = normalizePunctuation(corrected);

            return corrected;

        } catch (error) {
            if (error.name === 'AbortError') {
                throw error;
            }
            console.error(`[DeepSeekGrammarProvider] ❌ Final correction error (${text.length} chars): `, error.message);
            return text;
        }
    }
}
