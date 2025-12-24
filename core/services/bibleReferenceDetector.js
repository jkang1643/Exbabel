/**
 * Bible Reference Detector
 * 
 * Main detection engine that combines multiple detection strategies:
 * 1. Explicit reference regex detection (high confidence)
 * 2. AI-based verse matching using GPT-4o-mini (medium-high confidence)
 * 
 * Architecture: Hybrid approach
 * - Fast regex for explicit references
 * - AI matching for paraphrased/heavy context references
 * - Never uses AI to generate Scripture text (only matches references)
 */

import { normalizeTranscript } from './bibleReferenceNormalizer.js';
import { findAllSpokenNumbers } from './spokenNumberParser.js';
import { detectBookName, findAllBookNames } from './bookNameDetector.js';
import { CONTEXT_TRIGGERS } from '../data/contextTriggers.js';

/**
 * Bible Reference Detector class
 */
export class BibleReferenceDetector {
  constructor(options = {}) {
    this.config = {
      confidenceThreshold: options.confidenceThreshold || 0.85,
      aiConfidenceThreshold: options.aiConfidenceThreshold || 0.75, // Minimum confidence from AI
      enableAIMatching: options.enableAIMatching !== false, // Enable AI matching
      llmModel: options.llmModel || 'gpt-4o-mini',
      openaiApiKey: options.openaiApiKey,
      transcriptWindowSeconds: options.transcriptWindowSeconds || 10,
      ...options
    };
    
    this.llmRateLimiter = {
      lastCall: 0,
      minInterval: 0 // No rate limiting - Bible verse detection is infrequent
    };
  }
  
  /**
   * Detect Bible references in transcript text
   * 
   * @param {string} text - Transcript text
   * @param {Object} options - Detection options
   * @returns {Promise<Array<Object>>} Array of detected references
   */
  async detectReferences(text, options = {}) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return [];
    }
    
    // Normalize transcript
    const normalized = normalizeTranscript(text);
    
    // Step 1: Try explicit reference detection (highest confidence, fastest)
    const explicitRefs = this.detectExplicitReferences(normalized, text);
    
    // Separate complete references (with verse) from chapter-only references
    const completeRefs = explicitRefs.filter(ref => ref.verse !== undefined && ref.verse !== null);
    const chapterOnlyRefs = explicitRefs.filter(ref => ref.verse === undefined || ref.verse === null);
    
    // Return complete references immediately if they meet threshold
    if (completeRefs.length > 0) {
      const validRefs = completeRefs.filter(ref => ref.confidence >= this.config.confidenceThreshold);
      if (validRefs.length > 0) {
        return validRefs;
      }
    }
    
    // Step 2: Handle chapter-only references with AI verse matching
    // If we found chapter-only references (e.g., "Acts 2"), use AI to find the specific verse
    // ONLY call AI if contextual triggers are found (reduces API calls)
    if (chapterOnlyRefs.length > 0 && this.config.enableAIMatching && this.hasContextualTrigger(text)) {
      const aiRefs = await this.aiVerseMatchingForChapter(text, normalized, chapterOnlyRefs);
      
      // Apply contextual confidence boosts
      const boostedRefs = this.applyContextualBoosts(aiRefs, normalized, text);
      
      // Filter by confidence threshold
      const validRefs = boostedRefs.filter(ref => ref.confidence >= this.config.confidenceThreshold);
      if (validRefs.length > 0) {
        return validRefs;
      }
    }
    
    // Step 3: Use AI-based verse matching for non-explicit references
    // This handles paraphrased references, heavy context, etc.
    // ONLY call AI if contextual triggers are found (reduces API calls)
    if (this.config.enableAIMatching && this.hasContextualTrigger(text)) {
      const aiRefs = await this.aiVerseMatching(text, normalized);
      
      // Step 4: Apply contextual confidence boosts
      const boostedRefs = this.applyContextualBoosts(aiRefs, normalized, text);
      
      // Step 5: Filter by confidence threshold
      return boostedRefs.filter(ref => ref.confidence >= this.config.confidenceThreshold);
    }
    
    return [];
  }
  
  /**
   * Detect explicit Bible references using regex patterns
   * 
   * @param {Object} normalized - Normalized transcript object
   * @param {string} originalText - Original text for position tracking
   * @returns {Array<Object>} Array of detected references
   */
  detectExplicitReferences(normalized, originalText) {
    const results = [];
    const { tokens, normalizedText } = normalized;
    
    // Find all book names
    const bookDetections = findAllBookNames(tokens);
    
    // Filter out low-confidence book matches to prevent false positives
    // Low-confidence matches (typically < 0.7) are from fuzzy matching and are unreliable
    // Only use book detections with confidence >= 0.7 for explicit reference detection
    const reliableBookDetections = bookDetections.filter(det => det.confidence >= 0.7);
    
    for (const bookDetection of reliableBookDetections) {
      const startIndex = bookDetection.startIndex;
      
      // Look for chapter/verse patterns after book name
      // Pattern 1: "Acts 2:38" or "Acts 2 38"
      if (startIndex + 1 < tokens.length) {
        const nextToken = tokens[startIndex + bookDetection.tokenCount];
        
        // Try to parse as chapter number
        let chapter = null;
        let verse = null;
        
        // Check if next token is a number
        const chapterMatch = nextToken?.match(/^(\d+)$/);
        if (chapterMatch) {
          chapter = parseInt(chapterMatch[1], 10);
          
          // Look for verse (next token after colon or space)
          if (startIndex + bookDetection.tokenCount + 1 < tokens.length) {
            const verseToken = tokens[startIndex + bookDetection.tokenCount + 1];
            const verseMatch = verseToken?.match(/^(\d+)$/);
            if (verseMatch) {
              verse = parseInt(verseMatch[1], 10);
            }
          }
        } else {
          // Try spoken numbers
          const spokenNumbers = findAllSpokenNumbers(
            tokens.slice(startIndex + bookDetection.tokenCount).join(' ')
          );
          if (spokenNumbers.length > 0) {
            chapter = spokenNumbers[0].value;
            if (spokenNumbers.length > 1) {
              verse = spokenNumbers[1].value;
            }
          }
        }
        
        if (chapter !== null) {
          results.push({
            book: bookDetection.book,
            chapter: chapter,
            verse: verse || undefined,
            method: 'regex',
            confidence: verse !== null ? 0.9 : 0.75,
            displayText: verse !== null 
              ? `${bookDetection.book} ${chapter}:${verse}`
              : `${bookDetection.book} ${chapter}`
          });
        }
      }
      
      // Pattern 2: "Acts chapter two verse thirty eight"
      const chapterWords = ['chapter', 'ch', 'chap'];
      const verseWords = ['verse', 'v', 'verses'];
      
      for (let i = startIndex + bookDetection.tokenCount; i < Math.min(startIndex + bookDetection.tokenCount + 8, tokens.length); i++) {
        if (chapterWords.includes(tokens[i])) {
            // Found "chapter" - next should be number (could be multiple tokens for spoken numbers)
            if (i + 1 < tokens.length) {
              // Try numeric first
              let chapterNum = parseInt(tokens[i + 1], 10);
              let chapterTokenCount = 1;
              
              // If not a number, try parsing as spoken number (could be multiple tokens)
              if (!chapterNum) {
                // Try two tokens first (e.g., "thirty eight") - prefer compound numbers
                if (i + 2 < tokens.length) {
                  const twoTokens = `${tokens[i + 1]} ${tokens[i + 2]}`;
                  const twoNum = findAllSpokenNumbers(twoTokens);
                  if (twoNum.length > 0) {
                    chapterNum = twoNum[0].value;
                    chapterTokenCount = 2;
                  }
                }
                
                // If two-token didn't work, try single token
                if (!chapterNum) {
                  const singleNum = findAllSpokenNumbers(tokens[i + 1]);
                  if (singleNum.length > 0) {
                    chapterNum = singleNum[0].value;
                    chapterTokenCount = 1;
                  }
                }
              }
            
            if (chapterNum) {
              // chapterTokenCount is already set above
              
              // Look for verse (start after chapter word + chapter number tokens)
              const verseSearchStart = i + 1 + chapterTokenCount;
              
              for (let j = verseSearchStart; j < Math.min(verseSearchStart + 6, tokens.length); j++) {
                if (verseWords.includes(tokens[j])) {
                  // Found "verse" - next should be the verse number
                  if (j + 1 < tokens.length) {
                    // Try numeric first
                    let verseNum = parseInt(tokens[j + 1], 10);
                    let verseTokenCount = 1;
                    
                    if (!verseNum) {
                      // Try two tokens first (e.g., "thirty eight") - prefer compound numbers
                      if (j + 2 < tokens.length) {
                        const twoVerseTokens = `${tokens[j + 1]} ${tokens[j + 2]}`;
                        const twoVerse = findAllSpokenNumbers(twoVerseTokens);
                        if (twoVerse.length > 0) {
                          verseNum = twoVerse[0].value;
                          verseTokenCount = 2;
                        }
                      }
                      
                      // If two-token didn't work, try single token
                      if (!verseNum) {
                        const singleVerse = findAllSpokenNumbers(tokens[j + 1]);
                        if (singleVerse.length > 0) {
                          verseNum = singleVerse[0].value;
                          verseTokenCount = 1;
                        }
                      }
                    }
                    
                    if (verseNum) {
                      results.push({
                        book: bookDetection.book,
                        chapter: chapterNum,
                        verse: verseNum,
                        method: 'regex',
                        confidence: 0.85,
                        displayText: `${bookDetection.book} ${chapterNum}:${verseNum}`
                      });
                      break; // Found verse, exit loop
                    }
                  }
                }
              }
              
              // Chapter only (no verse found)
              if (!results.some(r => r.chapter === chapterNum && r.book === bookDetection.book && r.verse)) {
                results.push({
                  book: bookDetection.book,
                  chapter: chapterNum,
                  method: 'regex',
                  confidence: 0.7,
                  displayText: `${bookDetection.book} ${chapterNum}`
                });
              }
            }
          }
        }
      }
    }
    
    return results;
  }
  
  /**
   * Detect references using keyword fingerprint matching
   * 
   * @deprecated Replaced with AI-based verse matching (aiVerseMatching)
   * Kept for reference but no longer used
   * 
   * @param {Object} normalized - Normalized transcript object
   * @param {string} originalText - Original text
   * @returns {Array<Object>} Array of detected references with confidence scores
   */
  detectKeywordMatches(normalized, originalText) {
    // This method is deprecated - keyword matching replaced with AI matching
    // All keyword matching logic has been removed in favor of AI-based matching
    return [];
    
    // Convert scores to reference objects
    const results = [];
    for (const [ref, score] of verseScores.entries()) {
      // Parse reference (e.g., "Acts 2:38")
      const match = ref.match(/^(\w+(?:\s+\w+)*)\s+(\d+):(\d+)$/);
      if (!match) continue;
      
      const book = match[1];
      const chapter = parseInt(match[2], 10);
      const verse = parseInt(match[3], 10);
      
      // Calculate confidence from weighted score
      // Normalize score (max possible score would be sum of all weights)
      const maxPossibleScore = 5.0; // Approximate max for typical verse
      const normalizedScore = Math.min(score.weightedScore / maxPossibleScore, 1.0);
      
      // Base confidence from keyword matching
      // Use a formula that accounts for both hits and weighted score
      // Weighted score indicates quality of matches (higher = better keywords matched)
      // Hits indicate quantity of matches (more = more evidence)
      
      // Base confidence from weighted score (normalized to 0-1, then scaled)
      let confidence = Math.min(normalizedScore * 0.4, 0.4); // Base from weighted score
      
      // Boost based on number of keyword hits (more hits = more evidence)
      if (score.hits >= 2) {
        confidence += 0.15; // Significant boost for 2+ hits
      }
      if (score.hits >= 3) {
        confidence += 0.15; // Even more for 3+ hits
      }
      if (score.hits >= 4) {
        confidence += 0.1; // Additional boost for 4+ hits
      }
      if (score.hits >= 5) {
        confidence += 0.1; // Maximum boost for 5+ hits
      }
      
      // Additional boost for high weighted scores (indicates strong keyword matches)
      // This rewards matching high-weight keywords like "holy spirit" (weight 1.0)
      if (score.weightedScore >= 2.5) {
        confidence += 0.1;
      }
      if (score.weightedScore >= 3.5) {
        confidence += 0.1;
      }
      
      confidence = Math.min(confidence, 0.84); // Cap at just below auto-emit threshold
      
      // Ensure minimum confidence for any match (at least 0.5 if we have 2+ hits)
      if (score.hits >= 2 && confidence < 0.5) {
        confidence = 0.5;
      }
      
      results.push({
        book,
        chapter,
        verse,
        method: 'keywords',
        confidence,
        displayText: ref,
        matchedKeywords: score.matchedKeywords,
        hits: score.hits,
        weightedScore: score.weightedScore
      });
    }
    
    // Sort by confidence (highest first)
    return results.sort((a, b) => b.confidence - a.confidence);
  }
  
  /**
   * Calculate Levenshtein distance (edit distance) between two strings
   * 
   * @param {string} a - First string
   * @param {string} b - Second string
   * @returns {number} Edit distance
   */
  _levenshteinDistance(a, b) {
    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
    for (let j = 1; j <= b.length; j++) {
      for (let i = 1; i <= a.length; i++) {
        const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,      // insertion
          matrix[j - 1][i] + 1,      // deletion
          matrix[j - 1][i - 1] + indicator // substitution
        );
      }
    }
    return matrix[b.length][a.length];
  }

  /**
   * Calculate similarity score between two strings (0.0 to 1.0)
   * 
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} Similarity score (1.0 = identical, 0.0 = completely different)
   */
  _calculateSimilarity(str1, str2) {
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;
    
    const distance = this._levenshteinDistance(str1, str2);
    const maxLen = Math.max(str1.length, str2.length);
    return 1.0 - (distance / maxLen);
  }

  /**
   * Check if text contains any contextual trigger phrases (with fuzzy matching)
   * 
   * @param {string} text - Original text to check
   * @param {number} fuzzyThreshold - Minimum similarity for fuzzy match (default: 0.75)
   * @returns {boolean} True if any trigger phrase is found (exact or fuzzy)
   */
  hasContextualTrigger(text, fuzzyThreshold = 0.75) {
    if (!text || typeof text !== 'string') {
      return false;
    }
    
    // Normalize text for trigger matching: lowercase, strip punctuation, collapse whitespace
    const triggerText = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Step 1: Try exact substring matching first (fast)
    for (const trigger of CONTEXT_TRIGGERS) {
      if (triggerText.includes(trigger)) {
        return true;
      }
    }
    
    // Step 2: If no exact match, try fuzzy matching
    // Check if any trigger phrase is similar enough to appear in the text
    for (const trigger of CONTEXT_TRIGGERS) {
      const triggerWords = trigger.split(' ');
      const textWords = triggerText.split(' ');
      
      // Strategy 1: Word-by-word sliding window (most efficient)
      // Slide a window of the same length as the trigger through the text
      for (let i = 0; i <= textWords.length - triggerWords.length; i++) {
        const window = textWords.slice(i, i + triggerWords.length).join(' ');
        const similarity = this._calculateSimilarity(trigger, window);
        
        if (similarity >= fuzzyThreshold) {
          return true; // Found a fuzzy match
        }
      }
      
      // Strategy 2: Character-level substring matching (for typos within words)
      // Only check if text is long enough and trigger is reasonably sized
      if (triggerText.length >= trigger.length * 0.7 && trigger.length >= 5) {
        // Check substrings of similar length to the trigger
        const minLen = Math.max(trigger.length - 3, trigger.length * 0.7);
        const maxLen = Math.min(trigger.length + 3, triggerText.length);
        
        for (let start = 0; start <= triggerText.length - minLen; start++) {
          for (let len = minLen; len <= maxLen && start + len <= triggerText.length; len++) {
            const substring = triggerText.substring(start, start + len);
            const similarity = this._calculateSimilarity(trigger, substring);
            
            if (similarity >= fuzzyThreshold) {
              return true; // Found a fuzzy match
            }
          }
        }
      }
    }
    
    return false;
  }

  /**
   * Apply contextual confidence boosts
   * 
   * @param {Array<Object>} references - Array of reference candidates
   * @param {Object} normalized - Normalized transcript
   * @param {string} originalText - Original text
   * @returns {Array<Object>} References with boosted confidence
   */
  applyContextualBoosts(references, normalized, originalText) {
    // Check for contextual triggers
    const hasTrigger = this.hasContextualTrigger(originalText);
    
    if (hasTrigger) {
      // Boost all candidates by 0.05
      return references.map(ref => ({
        ...ref,
        confidence: Math.min(ref.confidence + 0.05, 1.0)
      }));
    }
    
    return references;
  }
  
  /**
   * AI-based verse matching for chapter-only references
   * 
   * When a chapter-only reference is detected (e.g., "Acts 2"), use AI to
   * determine which specific verse in that chapter is being referenced.
   * 
   * @param {string} text - Transcript text
   * @param {Object} normalized - Normalized transcript object
   * @param {Array<Object>} chapterRefs - Array of chapter-only references (book + chapter)
   * @returns {Promise<Array<Object>>} Validated references with verses from AI
   */
  async aiVerseMatchingForChapter(text, normalized, chapterRefs) {
    if (!this.config.openaiApiKey || !this.config.enableAIMatching) {
      return [];
    }
    
    // Skip if text is too short
    if (text.trim().length < 20) {
      return [];
    }
    
    // IMPORTANT: Only call AI if contextual triggers are found
    // This pre-filter significantly reduces API calls
    // Triggers are checked in detectReferences() before calling this method,
    // but we double-check here as a safety measure
    if (!this.hasContextualTrigger(text)) {
      return []; // No triggers found, skip AI call
    }
    
    // Use the first chapter reference (most likely)
    const chapterRef = chapterRefs[0];
    if (!chapterRef || !chapterRef.book || !chapterRef.chapter) {
      return [];
    }
    
    // Update last call time
    this.llmRateLimiter.lastCall = Date.now();
    
    try {
      // System prompt - AI as verse identifier for chapter-only references
      const systemPrompt = `You are a Bible reference matching engine.

Your task is to identify which specific verse in a given Bible chapter is being referenced in the transcript.

Rules:
- Do NOT quote Scripture text.
- Do NOT invent verses.
- Only output verses you are confident in.
- If uncertain, respond with "UNCERTAIN".
- Use canonical book names.
- Output structured JSON only.`;

      // User prompt - include chapter context
      const userPrompt = `Transcript:
"${text}"

The speaker mentioned ${chapterRef.book} chapter ${chapterRef.chapter}, but did not specify a verse number.

Instructions:
- Based on the transcript content, identify which specific verse in ${chapterRef.book} ${chapterRef.chapter} is most likely being referenced.
- Consider the context, themes, and keywords mentioned in the transcript.
- Output confidence score from 0.0–1.0 (be conservative - only high confidence).

Output format (JSON only):
{
  "matches": [
    {
      "book": "${chapterRef.book}",
      "chapter": ${chapterRef.chapter},
      "verse": <verse_number>,
      "confidence": 0.91
    }
  ]
}

If no confident match, return: { "matches": [] }`;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.openaiApiKey}`
        },
        body: JSON.stringify({
          model: this.config.llmModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.2,
          max_tokens: 200,
          response_format: { type: 'json_object' }
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[BibleReference] AI chapter matching failed:', response.status, errorText);
        return [];
      }
      
      const data = await response.json();
      const content = data.choices[0]?.message?.content;
      
      if (!content || content.includes('UNCERTAIN') || content.trim().toLowerCase() === 'uncertain') {
        return [];
      }
      
      // Parse JSON response
      let parsed;
      try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return [];
        }
        parsed = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error('[BibleReference] Failed to parse AI response:', parseError);
        return [];
      }
      
      const matches = parsed.matches || [];
      
      // Validate and return matches with guardrails
      return matches
        .filter(match => {
          // Validate structure
          if (!match.book || typeof match.chapter !== 'number' || typeof match.verse !== 'number') {
            return false;
          }
          
          // Validate it matches the chapter we're looking for
          if (match.book !== chapterRef.book || match.chapter !== chapterRef.chapter) {
            return false;
          }
          
          // Confidence threshold
          if (typeof match.confidence !== 'number' || match.confidence < this.config.aiConfidenceThreshold) {
            return false;
          }
          
          // Sanity check - verse bounds
          if (match.verse < 1 || match.verse > 200) {
            return false;
          }
          
          return true;
        })
        .map(match => {
          const normalizedBook = String(match.book).trim().split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          return {
            book: normalizedBook,
            chapter: match.chapter,
            verse: match.verse,
            method: 'regex+ai', // Indicates it was chapter-only regex + AI verse matching
            confidence: Math.min(match.confidence, 0.95),
            displayText: `${normalizedBook} ${match.chapter}:${match.verse}`
          };
        });
      
    } catch (error) {
      console.error('[BibleReference] AI chapter matching error:', error);
      return [];
    }
  }

  /**
   * AI-based verse matching using GPT-4o-mini
   * 
   * Uses AI as a verse identifier (not generator) to match transcript text
   * to Bible verse references. Never generates Scripture text.
   * 
   * @param {string} text - Transcript text
   * @param {Object} normalized - Normalized transcript object
   * @returns {Promise<Array<Object>>} Validated references from AI
   */
  async aiVerseMatching(text, normalized) {
    if (!this.config.openaiApiKey) {
      return []; // No API key, skip
    }
    
    // Skip if text is too short (likely not a verse reference)
    if (text.trim().length < 20) {
      return [];
    }
    
    // IMPORTANT: Only call AI if contextual triggers are found
    // This pre-filter significantly reduces API calls
    // Triggers are checked in detectReferences() before calling this method,
    // but we double-check here as a safety measure
    if (!this.hasContextualTrigger(text)) {
      return []; // No triggers found, skip AI call
    }
    
    // Update last call time (for optional tracking, no rate limiting)
    this.llmRateLimiter.lastCall = Date.now();
    
    try {
      // System prompt - AI as verse identifier, NOT generator
      const systemPrompt = `You are a Bible reference matching engine.

Your task is to identify whether the given transcript likely refers to a specific Bible verse or passage.

Rules:
- Do NOT quote Scripture text.
- Do NOT invent verses.
- Only output references you are confident in.
- If uncertain, respond with "UNCERTAIN".
- Prefer well-known verses commonly quoted in sermons.
- Use canonical book names (e.g., "1 Corinthians" not "First Corinthians").
- Output structured JSON only.`;

      // User prompt - transcript window
      const userPrompt = `Transcript:
"${text}"

Instructions:
- Identify the most likely Bible reference(s) that this transcript refers to.
- The speaker may be paraphrasing or quoting from memory.
- Use canonical book names.
- Output confidence score from 0.0–1.0 (be conservative - only high confidence).

Output format (JSON only):
{
  "matches": [
    {
      "book": "Acts",
      "chapter": 2,
      "verse": 38,
      "confidence": 0.91
    }
  ]
}

If no confident match, return: { "matches": [] }`;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.openaiApiKey}`
        },
        body: JSON.stringify({
          model: this.config.llmModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.2, // Lower temperature for more consistent matching
          max_tokens: 300,
          response_format: { type: 'json_object' } // Request JSON mode if supported
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[BibleReference] AI matching failed:', response.status, errorText);
        return [];
      }
      
      const data = await response.json();
      const content = data.choices[0]?.message?.content;
      
      if (!content || content.includes('UNCERTAIN') || content.trim().toLowerCase() === 'uncertain') {
        return [];
      }
      
      // Parse JSON response
      let parsed;
      try {
        // Try to extract JSON from response (handles both JSON mode and text responses)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return [];
        }
        parsed = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error('[BibleReference] Failed to parse AI response:', parseError);
        return [];
      }
      
      const matches = parsed.matches || [];
      
      // Validate and return matches with guardrails
      return matches
        .filter(match => {
          // Guardrail 1: Validate structure
          if (!match.book || typeof match.chapter !== 'number' || typeof match.verse !== 'number') {
            return false;
          }
          
          // Guardrail 2: Confidence threshold (minimum 0.75)
          if (typeof match.confidence !== 'number' || match.confidence < this.config.aiConfidenceThreshold) {
            return false;
          }
          
          // Guardrail 3: Sanity check - validate chapter/verse bounds
          // Most books have < 150 chapters, most chapters have < 200 verses
          if (match.chapter < 1 || match.chapter > 150 || match.verse < 1 || match.verse > 200) {
            return false;
          }
          
          // Guardrail 4: Validate book name format (basic check)
          const bookName = String(match.book).trim();
          if (bookName.length < 2 || bookName.length > 30) {
            return false;
          }
          
          return true;
        })
        .map(match => {
          // Normalize book name (capitalize properly)
          const bookName = String(match.book).trim();
          const normalizedBook = bookName.split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
          
          return {
            book: normalizedBook,
            chapter: match.chapter,
            verse: match.verse,
            method: 'ai',
            confidence: Math.min(match.confidence, 0.95), // Cap at 0.95 (never 100% from AI)
            displayText: `${normalizedBook} ${match.chapter}:${match.verse}`
          };
        });
      
    } catch (error) {
      console.error('[BibleReference] AI matching error:', error);
      return [];
    }
  }
}

export default {
  BibleReferenceDetector
};


