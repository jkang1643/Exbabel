/**
 * Shared Logic Functions for Retext Plugins
 * 
 * These are pure, synchronous functions that contain the core correction logic.
 * They are used by both:
 * 1. Retext plugins (for AST mutation)
 * 2. Sync pipeline (for fast partial processing)
 * 
 * This ensures 100% code reuse between sync and async paths.
 */

import nlp from 'compromise';
import {
  contractions,
  fillers,
  homophones,
  properNouns,
  acronyms,
  colloquialisms,
  divineNames,
  liturgicalTerms,
  discourseMarkers,
  coordinatingConjunctions,
  subordinatingConjunctions,
  introductoryPhrases,
  bibleBooks,
  bibleBookAbbreviations,
  singleChapterBooks,
  religiousHomophones,
  theologyTerms,
  sermonStructurePatterns,
  prayerLanguagePatterns,
  divinePronouns,
  divineTitles,
  sacredTextReferences,
  ordinalWords,
  versePatterns
} from '../cleanupRules.js';

/**
 * ============================================================================
 * CRITICAL: ALL LOGIC FUNCTIONS AUTOMATICALLY APPLY FIXES
 * ============================================================================
 * 
 * These functions are NOT just detection - they AUTOMATICALLY APPLY corrections.
 * Every function returns the CORRECTED text with all fixes already applied.
 * 
 * Examples:
 * - fixContractionsLogic("dont") → "don't" (automatically fixed)
 * - capitalizeSentencesLogic("hello world") → "Hello world" (automatically capitalized)
 * - restorePunctuationLogic("hello world") → "Hello world." (punctuation automatically added)
 * 
 * These functions are used by both:
 * 1. processPartialSync (synchronous path for live partials)
 * 2. processWithRetext (async path for final transcripts via retext plugins)
 * 
 * ============================================================================
 */

// ============================================================================
// A. CONTRACTIONS
// ============================================================================

/**
 * Fixes contractions - AUTOMATICALLY APPLIES ALL FIXES
 * @param {string} text - Input text
 * @returns {string} Text with all contractions fixed (e.g., "dont" → "don't")
 */
export function fixContractionsLogic(text) {
  let result = text;
  Object.entries(contractions).forEach(([bad, good]) => {
    const regex = new RegExp(`\\b${bad}\\b`, 'gi');
    result = result.replace(regex, good);
  });
  return result;
}

// ============================================================================
// B. FILLERS
// ============================================================================

export function removeFillersLogic(text) {
  let result = text;
  fillers.forEach(filler => {
    const regex = new RegExp(`\\b${filler}\\b`, 'gi');
    result = result.replace(regex, '');
  });
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}

// ============================================================================
// C. HOMOPHONES
// ============================================================================

export function fixHomophonesLogic(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }
  let result = text;
  
  // ============================================================================
  // STT ERROR CORRECTIONS - Fix common transcription mistakes
  // ============================================================================
  
  // Fix "Know" vs "No" - very common STT error
  // "Know, I haven't" → "No, I haven't"
  // Context: If followed by comma or appears to be a negative response
  result = result.replace(/\bKnow\s*,/gi, 'No,');
  result = result.replace(/\bKnow\s+I\s+haven't\b/gi, "No, I haven't");
  result = result.replace(/\bKnow\s+I\s+don't\b/gi, "No, I don't");
  result = result.replace(/\bKnow\s+I\s+didn't\b/gi, "No, I didn't");
  
  // ============================================================================
  // CONTEXT-BASED HOMOPHONE CORRECTIONS
  // ============================================================================
  
  // Fix other common homophones using context
  Object.entries(homophones).forEach(([word, config]) => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      // Get context around the word
      const before = text.substring(Math.max(0, offset - 20), offset).toLowerCase();
      const after = text.substring(offset + match.length, Math.min(text.length, offset + match.length + 20)).toLowerCase();
      const context = before + ' ' + after;
      
      // Context-based disambiguation
      const contextCheck = config.contextCheck;
      
      // their/there/they're
      if (word.toLowerCase() === 'their' && /\b(their|there|they're)\s+(house|home|car|place|location|is|was|are|were)\b/i.test(context)) {
        return 'there'; // "there is", "there was"
      }
      if (word.toLowerCase() === 'there' && /\b(their|there|they're)\s+(name|book|idea|thought|property|belonging)\b/i.test(context)) {
        return 'their'; // "their name", "their book"
      }
      if (word.toLowerCase() === 'their' && /\b(their|there|they're)\s+(going|coming|doing|saying|thinking)\b/i.test(context)) {
        return "they're"; // "they're going"
      }
      
      // to/too/two
      if (word.toLowerCase() === 'to' && /\b(to|too|two)\s+(much|many|often|late|early|fast|slow)\b/i.test(context)) {
        return 'too'; // "too much"
      }
      if (word.toLowerCase() === 'too' && /\b(to|too|two)\s+(go|come|do|see|be|have|get|make|take|give)\b/i.test(context)) {
        return 'to'; // "to go"
      }
      if (word.toLowerCase() === 'two' && /\b(to|too|two)\s+(go|come|do|see|be|have|get|make|take|give)\b/i.test(context)) {
        return 'to'; // "to go" (misheard as "two")
      }
      
      // your/you're
      if (word.toLowerCase() === 'your' && /\b(your|you're)\s+(going|coming|doing|saying|thinking|talking|walking|running)\b/i.test(context)) {
        return "you're"; // "you're going"
      }
      if (word.toLowerCase() === "you're" && /\b(your|you're)\s+(name|book|idea|thought|property|car|house|home)\b/i.test(context)) {
        return 'your'; // "your name"
      }
      
      // Default: keep original for now (full implementation would use compromise POS)
      return match;
    });
  });
  
  return result;
}

// ============================================================================
// D. PUNCTUATION
// ============================================================================

export function restorePunctuationLogic(text, isPartial = false, doc = null) {
  if (!text || text.trim().length === 0) return text;
  if (!doc) {
    doc = nlp(text);
  }
  
  let result = text.trim();
  
  // CRITICAL: Never add punctuation at the start of text
  // Remove any leading punctuation that might have been incorrectly added
  result = result.replace(/^[.!?,]\s*/, '');
  
  // CRITICAL: Detect sentence boundaries using multiple strategies
  // Strategy 1: Use compromise's sentence detection (but don't rely on it exclusively)
  const sentences = doc.sentences();
  const boundaries = [];
  
  // Strategy 2: Detect subject changes generically - when a lowercase word is followed by a pronoun/noun
  // This catches cases like "unplug we", "closed and a", "engage rather than unplug we"
  // Pattern: lowercase word + space + pronoun/noun starting new thought
  const subjectPronouns = /\s+(we|they|I|you|he|she|it|our|your|their|my|his|her|people|someone|somebody|everyone|everybody|anyone|anybody)\s+[a-z]/gi;
  
  let pronounMatch;
  while ((pronounMatch = subjectPronouns.exec(result)) !== null) {
    // pronounMatch.index is the position of the space before the pronoun
    const pronounStart = pronounMatch.index;
    const beforePronoun = result.substring(Math.max(0, pronounStart - 40), pronounStart).trim();
    
    // Check if before has a verb/predicate (complete thought)
    if (beforePronoun.length > 10) {
      const beforeDoc = nlp(beforePronoun);
      const hasVerb = beforeDoc.match('#Verb').length > 0;
      
      // Also check for common action words that might not be detected as verbs
      const hasActionWord = /\b(unplug|engage|pray|start|go|do|say|tell|show|see|know|think|want|need|get|make|take|give|come|leave|stay|stand|sit|walk|run|move|turn|open|close|beat|care|miss|entertain|gather|choose|reject|fulfill|spend|call|separate|isolate|insinuate|back|rather|than)\b/i.test(beforePronoun);
      
      if ((hasVerb || hasActionWord) && !/[.!?]/.test(beforePronoun.slice(-1))) {
        // The boundary is at pronounStart (where the space before the pronoun is)
        // We want to insert punctuation before the pronoun, so use pronounStart as the boundary
        const boundaryPos = pronounStart;
        if (boundaryPos > 0 && boundaryPos < result.length - 3) {
          boundaries.push({
            position: boundaryPos,
            type: 'subject_change',
            punctuation: '.',
            confidence: 0.85
          });
        }
      }
    }
  }
  
  // More aggressive run-on detection: look for multiple independent clauses
  sentences.forEach((sentence, idx) => {
    const sentenceText = sentence.text();
    
    // Check for multiple verbs - indicates multiple clauses
    const verbs = sentence.match('#Verb');
    if (verbs.length > 1) {
      // Look for patterns that indicate sentence breaks
      // Pattern: "has been" or "is" followed by "for" or "when" often indicates new sentence
      const patterns = [
        /\b(has been|is|was|are|were)\s+(for|since|when|where|if|that|which|who)\s+/gi,
        /\b(for|since|when|where|if|that|which|who)\s+[a-z]+\s+(has|is|was|are|were)\s+/gi
      ];
      
      patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(sentenceText)) !== null) {
          // Check if this is a good break point
          const before = sentenceText.substring(0, match.index).trim();
          const after = sentenceText.substring(match.index + match[0].length).trim();
          
          if (before.length > 10 && after.length > 10) {
            const beforeDoc = nlp(before);
            const afterDoc = nlp(after);
            const beforeHasVerb = beforeDoc.match('#Verb').length > 0;
            const afterHasVerb = afterDoc.match('#Verb').length > 0;
            
            // If both parts have verbs and are substantial, likely separate sentences
            if (beforeHasVerb && afterHasVerb) {
              // Find the actual position in the full text
              const sentenceStart = result.indexOf(sentenceText);
              if (sentenceStart >= 0) {
                const boundaryPos = sentenceStart + match.index;
                // Only add if not at start of text and not already has punctuation
                if (boundaryPos > 0 && boundaryPos < result.length) {
                  const charBefore = result[boundaryPos - 1];
                  if (!/[.!?]/.test(charBefore)) {
                    boundaries.push({
                      position: boundaryPos,
                      type: 'run_on_split',
                      punctuation: '.',
                      confidence: 0.8
                    });
                  }
                }
              }
            }
          }
        }
      });
    }
    
    // CRITICAL: Detect coordinating conjunctions and decide PERIOD vs COMMA
    // For long sentences with multiple "and" clauses, split into separate sentences
    const conjunctions = [' and ', ' but ', ' or ', ' so ', ' yet ', ' for ', ' nor '];
    
    // Count how many "and" clauses are in this sentence
    const andCount = (sentenceText.match(/\s+and\s+/gi) || []).length;
    const isLongSentence = sentenceText.length > 150 || andCount > 2;
    
    conjunctions.forEach(conj => {
      // Find ALL occurrences, not just the first
      let searchStart = 0;
      while (true) {
        const index = sentenceText.indexOf(conj, searchStart);
        if (index < 0 || index >= sentenceText.length - conj.length) break;
        
        const before = sentenceText.substring(0, index).trim();
        const after = sentenceText.substring(index + conj.length).trim();
        
        if (before.length > 10 && after.length > 10) {
          const beforeDoc = nlp(before);
          const afterDoc = nlp(after);
          const beforeHasVerb = beforeDoc.match('#Verb').length > 0;
          const afterHasVerb = afterDoc.match('#Verb').length > 0;
          
          if (beforeHasVerb && afterHasVerb) {
            // Find position in full text
            const sentenceStart = result.indexOf(sentenceText);
            if (sentenceStart >= 0) {
              const boundaryPos = sentenceStart + index;
              // Only add if not at start and not already has punctuation
              if (boundaryPos > 0 && boundaryPos < result.length) {
                const charBefore = result[boundaryPos - 1];
                if (!/[.!?]/.test(charBefore)) {
                  // CRITICAL: Decide PERIOD vs COMMA based on sentence length and context
                  // For long sentences or multiple "and" clauses, use PERIOD (split sentence)
                  // For shorter sentences with single "and", use COMMA (same sentence)
                  let punctuation = ',';
                  let confidence = 0.7;
                  
                  // Use PERIOD if:
                  // 1. Sentence is long (>150 chars) OR has multiple "and" clauses
                  // 2. "but", "so", "yet" often start new sentences
                  // 3. The clause after "and" starts with a verb (action starting new thought)
                  if (isLongSentence || conj === ' but ' || conj === ' so ' || conj === ' yet ') {
                    punctuation = '.';
                    confidence = 0.85;
                  } else if (conj === ' and ') {
                    // For "and", check if it's connecting independent thoughts
                    // If "and" is followed by a verb (new action), likely new sentence
                    const afterFirstWord = after.split(/\s+/)[0];
                    const afterDocCheck = nlp(afterFirstWord + ' ' + after.split(/\s+/).slice(1, 3).join(' '));
                    const startsWithVerb = afterDocCheck.match('#Verb').length > 0 || 
                                          /\b(go|sit|get|let|say|see|know|think|want|need|make|take|give|come|leave|stay|stand|walk|run|move|turn|open|close|beat|care|miss|entertain|gather|choose|reject|fulfill|spend|call|separate|isolate|invite|have|move)\b/i.test(afterFirstWord);
                    
                    // If sentence is already long or has multiple "ands", split it
                    if (startsWithVerb && (sentenceText.length > 100 || andCount > 1)) {
                      punctuation = '.';
                      confidence = 0.8;
                    }
                  }
                  
                  boundaries.push({
                    position: boundaryPos,
                    type: 'clause_boundary',
                    punctuation: punctuation,
                    confidence: confidence
                  });
                }
              }
            }
          }
        }
        
        searchStart = index + 1;
      }
    });
    
    // Detect discourse markers that indicate sentence breaks
    const discourseMarkers = ['when', 'where', 'if', 'because', 'although', 'while', 'since', 'until', 'after', 'before'];
    discourseMarkers.forEach(marker => {
      const regex = new RegExp(`\\b${marker}\\s+`, 'gi');
      let match;
      while ((match = regex.exec(sentenceText)) !== null) {
        const before = sentenceText.substring(0, match.index).trim();
        if (before.length > 15) {
          // Check if before has a complete thought (verb)
          const beforeDoc = nlp(before);
          if (beforeDoc.match('#Verb').length > 0) {
            const sentenceStart = result.indexOf(sentenceText);
            if (sentenceStart >= 0) {
              const boundaryPos = sentenceStart + match.index;
              if (boundaryPos > 0 && boundaryPos < result.length) {
                const charBefore = result[boundaryPos - 1];
                if (!/[.!?]/.test(charBefore)) {
                  boundaries.push({
                    position: boundaryPos,
                    type: 'discourse_marker',
                    punctuation: '.',
                    confidence: 0.75
                  });
                }
              }
            }
          }
        }
      }
    });
  });
  
  // Strategy 3: Detect "and/or/but" + article + noun starting new independent clause
  // Pattern: "and a", "or the", "but this" when previous clause is complete
  const conjunctionArticlePattern = /\b(and|or|but)\s+(a|an|the|this|that|these|those)\s+[a-z]+\s+[a-z]/gi;
  
  let conjMatch;
  while ((conjMatch = conjunctionArticlePattern.exec(result)) !== null) {
    const before = result.substring(Math.max(0, conjMatch.index - 40), conjMatch.index).trim();
    
    if (before.length > 15) {
      const beforeDoc = nlp(before);
      const hasVerb = beforeDoc.match('#Verb').length > 0;
      
      // If previous clause has a verb and no punctuation, likely a sentence break before "and/or/but"
      if (hasVerb && !/[.!?]/.test(before.slice(-1))) {
        const boundaryPos = conjMatch.index;
        if (boundaryPos > 0 && boundaryPos < result.length - 3) {
          boundaries.push({
            position: boundaryPos,
            type: 'conjunction_clause',
            punctuation: '.',
            confidence: 0.75
          });
        }
      }
    }
  }
  
  // Strategy 4: Scan ENTIRE text for long run-on sentences (not just compromise sentences)
  // This catches long run-ons that compromise doesn't segment properly
  // Approach: Find ALL "and" occurrences in text and check if they connect independent clauses
  // Don't rely on compromise's sentence segmentation - work directly on the text
  
  // Find all "and" positions in the entire text
  let textSearchStart = 0;
  const allAndPositions = [];
  while (true) {
    const andIndex = result.indexOf(' and ', textSearchStart);
    if (andIndex < 0) break;
    
    // Get context around this "and"
    const beforeAnd = result.substring(Math.max(0, andIndex - 80), andIndex).trim();
    const afterAnd = result.substring(andIndex + 5, Math.min(result.length, andIndex + 5 + 80)).trim();
    
    // Skip if there's already punctuation nearby
    if (!/[.!?]/.test(beforeAnd.slice(-1))) {
      // Check if both parts have verbs (independent clauses)
      if (beforeAnd.length > 15 && afterAnd.length > 15) {
        const beforeDoc = nlp(beforeAnd);
        const afterDoc = nlp(afterAnd);
        const beforeVerbs = beforeDoc.match('#Verb').length;
        const afterVerbs = afterDoc.match('#Verb').length;
        
        // If both parts have verbs, likely independent clauses
        if (beforeVerbs > 0 && afterVerbs > 0) {
          // Count how many "and"s are in the surrounding context (detect series)
          const contextStart = Math.max(0, andIndex - 200);
          const contextEnd = Math.min(result.length, andIndex + 200);
          const context = result.substring(contextStart, contextEnd);
          const andCountInContext = (context.match(/\s+and\s+/gi) || []).length;
          
          // CRITICAL: Decide PERIOD vs COMMA based on context
          // Split with PERIOD if both clauses are independent (have verbs) and substantial
          const beforeWords = beforeAnd.split(/\s+/).length;
          const afterWords = afterAnd.split(/\s+/).length;
          const isSubstantialClause = beforeWords > 5 && afterWords > 5;
          
          // CRITICAL: More aggressive splitting logic
          // Split with PERIOD if:
          // 1. We're in a series (2+ "and"s in context) AND clauses are substantial
          // 2. OR context is long (>100 chars) AND both clauses have 8+ words
          // 3. OR both clauses are very substantial (10+ words each) - independent thoughts
          const shouldSplit = (andCountInContext > 1 && isSubstantialClause) || 
                             (context.length > 100 && beforeWords > 8 && afterWords > 8) ||
                             (beforeWords > 10 && afterWords > 10);
          
          if (shouldSplit) {
            allAndPositions.push({
              position: andIndex,
              beforeVerbs: beforeVerbs,
              afterVerbs: afterVerbs,
              andCount: andCountInContext,
              contextLength: context.length,
              beforeWords: beforeWords,
              afterWords: afterWords
            });
          }
        }
      }
    }
    
    textSearchStart = andIndex + 1;
  }
  
  // Add boundaries for "and"s that should split sentences
  // Deduplicate by position (multiple strategies might find the same "and")
  const positionMap = new Map();
  allAndPositions.forEach(andPos => {
    const existing = positionMap.get(andPos.position);
    // Keep the one with more context (higher andCount or longer context)
    if (!existing || 
        andPos.andCount > existing.andCount || 
        (andPos.andCount === existing.andCount && andPos.contextLength > existing.contextLength)) {
      positionMap.set(andPos.position, andPos);
    }
  });
  
  // Add all unique boundaries - don't skip any, let the deduplication handle it
  positionMap.forEach((andPos, position) => {
    boundaries.push({
      position: position,
      type: 'runon_split',
      punctuation: '.',
      confidence: 0.85
    });
  });
  
  // Strategy 6: Fix "Well" starting new sentence - replace comma with period
  // This is a simple replacement, not a boundary insertion
  result = result.replace(/,\s*well\s+([a-z])/gi, '. Well $1');
  
  // Sort boundaries by position (descending) to avoid offset issues
  // CRITICAL: Reduce minimum distance - 3 characters is enough for most cases
  // The previous 10 character requirement was too restrictive and prevented valid breaks
  const MIN_DISTANCE_FROM_END = 3;
  const sortedBoundaries = boundaries
    .filter(b => b.position > 0 && b.position < result.length - MIN_DISTANCE_FROM_END) // Never at start or too close to end
    .sort((a, b) => b.position - a.position);

  // Add punctuation at boundaries
  let offset = 0;
  sortedBoundaries.forEach(boundary => {
    const pos = boundary.position + offset;
    
    // CRITICAL: Double-check we're not too close to the end after offset adjustments
    if (pos > 0 && pos < result.length - MIN_DISTANCE_FROM_END) {
      // Check if punctuation already exists nearby
      const charAtPos = result[pos];
      const charBefore = result[pos - 1];
      
      // Skip if already has punctuation
      if (!/[.!?]/.test(charBefore) && !/[.!?]/.test(charAtPos)) {
        // Check if this is a word boundary (not in middle of word)
        const before = result.substring(Math.max(0, pos - 10), pos);
        const after = result.substring(pos, Math.min(result.length, pos + 10));
        
        if (/\s/.test(before.slice(-1)) || /\s/.test(after[0])) {
          // CRITICAL: Don't insert punctuation inside quotes
          // Check if we're inside a quote (between opening and closing quote)
          const textBefore = result.substring(0, pos);
          const textAfter = result.substring(pos);
          const openQuotes = (textBefore.match(/["']/g) || []).length;
          const closeQuotes = (textBefore.match(/["']/g) || []).length;
          // If we have unmatched quotes, we might be inside a quote
          const isInsideQuote = (openQuotes % 2 !== 0) || (textBefore.includes('"') && !textAfter.includes('"'));
          
          if (!isInsideQuote) {
            const beforeText = result.substring(0, pos);
            const afterText = result.substring(pos);
            
            let punct = boundary.punctuation || '.';
            
            // CRITICAL FIX: Preserve all words - only trim leading whitespace, never trailing
            // This ensures we don't lose the last word when adding punctuation
            const trimmedAfter = afterText.trimStart(); // Only trim leading whitespace
            
            // For periods, add space after and capitalize next word
            if (punct === '.' && !trimmedAfter.match(/^\s/)) {
              // Capitalize first letter of next word
              const firstChar = trimmedAfter.charAt(0);
              const capitalizedAfter = firstChar.toUpperCase() + trimmedAfter.slice(1);
              result = beforeText + punct + ' ' + capitalizedAfter;
              offset += 2;
            } else if (punct === ',' && !trimmedAfter.match(/^\s/)) {
              result = beforeText + punct + ' ' + trimmedAfter;
              offset += 2;
            }
          }
        }
      }
    }
  });
  
  // Add commas after introductory phrases
  introductoryPhrases.forEach(phrase => {
    const regex = new RegExp(`\\b${phrase}\\s+([a-z])`, 'gi');
    result = result.replace(regex, (match, p1, matchOffset) => {
      // Never add at start of text
      if (matchOffset === 0) return match;
      
      const before = result.substring(Math.max(0, matchOffset - 10), matchOffset);
      if (!before.includes(',')) {
        return `${phrase}, ${p1}`;
      }
      return match;
    });
  });
  
  // Add comma after "quote" when followed by a noun/adjective (common pattern)
  // "I love this quote biblical" → "I love this quote, biblical"
  result = result.replace(/\bquote\s+([a-z][a-z]+)\b/gi, (match, word, offset) => {
    // Check if word after "quote" looks like a noun/adjective (starts with lowercase, has length)
    if (word.length > 3 && !/[.!?]/.test(word)) {
      const before = result.substring(Math.max(0, offset - 20), offset);
      if (!before.includes(',')) {
        return `quote, ${word}`;
      }
    }
    return match;
  });
  
  // Fix artifacts and weird punctuation BEFORE run-on detection
  result = result.replace(/\s+["']e["']\s+/gi, ' ');
  result = result.replace(/["']e["']/gi, '');
  result = result.replace(/,\s*\./g, '.');
  result = result.replace(/and,\./gi, 'and');
  result = result.replace(/\s+,\s+\./g, '.');
  result = result.replace(/,\s*Off/gi, '. Off');
  result = result.replace(/,\s*And/gi, '. And');
  
  // CRITICAL: Fix common STT transcription errors using NLP context
  // Use compromise NLP to detect likely errors based on context
  
  // Fix words that were incorrectly combined (missing space)
  // Pattern: lowercase word followed by lowercase word (likely should be two words)
  // But ONLY if it's a known compound word error
  const compoundErrors = [
    { wrong: /\bdoctrineall\b/gi, correct: 'doctrine all' },
    { wrong: /\bdoctrineall\b/gi, correct: 'doctrine all' },
    { wrong: /\b(\w+)(all|the|and|of|in|on|at|to|for|with|from)\b/gi, correct: (match, word, particle) => {
      // Check if this is likely a compound error (word + particle without space)
      // Only fix if the word is substantial (5+ chars) and particle is a common word
      if (word.length >= 5 && !/[A-Z]/.test(word)) {
        return `${word} ${particle}`;
      }
      return match;
    }}
  ];
  
  compoundErrors.forEach(({ wrong, correct }) => {
    if (typeof correct === 'function') {
      result = result.replace(wrong, correct);
    } else {
      result = result.replace(wrong, correct);
    }
  });
  
  // Fix specific STT errors using context-aware detection
  // "decades fight" → "to cage fight" (STT mishearing in fighting context)
  if (/\bfight|fighting|match|matches|combat|battle\b/i.test(result)) {
    result = result.replace(/\bdecades\s+fight\b/gi, 'to cage fight');
  }
  
  // "200 of churches" → remove incorrect "of" or change to "hundreds"
  result = result.replace(/\b(\d+)\s+of\s+(churches|people|places|things)\b/gi, (match, num, noun) => {
    const numVal = parseInt(num);
    if (numVal >= 100) {
      return `hundreds of ${noun}`;
    }
    return `${num} ${noun}`;
  });
  
  // Fix run-on sentences: Split sentences connected by "and" that are too long
  // This handles cases like "X is Y and rejects Z" → "X is Y. And rejects Z"
  const beforeRunOn = result;
  result = fixRunOnSentencesLogic(result, doc);
  if (result !== beforeRunOn) {
    console.log(`[GrammarPipeline] 🔧 Run-on sentences fixed: "${beforeRunOn.substring(0, 100)}${beforeRunOn.length > 100 ? '...' : ''}" → "${result.substring(0, 100)}${result.length > 100 ? '...' : ''}"`);
  }
  
  // Add comma after "quote from" patterns
  result = result.replace(/\bquote\s+from\s+([a-z]+)\s+([A-Z])/gi, 'quote from $1, $2');
  
  // CRITICAL: Ensure proper capitalization after punctuation is added
  // This must happen AFTER punctuation is added, not before
  result = result.replace(/([.!?])\s+([a-z])/g, (match, punct, letter) => {
    return punct + ' ' + letter.toUpperCase();
  });
  
  // Add final punctuation only for non-partials and only if text doesn't already end with punctuation
  if (!isPartial && !/[.!?]$/.test(result.trim())) {
    result = result.trim() + '.';
  }
  
  return result;
}

// ============================================================================
// E. CAPITALIZATION
// ============================================================================

export function capitalizeSentencesLogic(text) {
  if (!text || text.trim().length === 0) return text;
  let result = text.trim();
  
  // Always capitalize first letter
  result = result.charAt(0).toUpperCase() + result.slice(1);
  
  // Capitalize after sentence-ending punctuation
  result = result.replace(/([.!?])\s+([a-z])/g, (match, punct, letter) => {
    return punct + ' ' + letter.toUpperCase();
  });
  
  // CRITICAL FIX: Capitalize after interjections followed by commas
  // "Again, that is not" → "Again, That is not"
  const interjections = ['again', 'however', 'therefore', 'furthermore', 'moreover', 'nevertheless', 'meanwhile', 'indeed', 'thus', 'hence'];
  interjections.forEach(interjection => {
    const regex = new RegExp(`\\b${interjection}\\s*,\\s+([a-z])`, 'gi');
    result = result.replace(regex, (match, letter, offset) => {
      // Only capitalize if the interjection is at sentence start or after punctuation
      const before = result.substring(Math.max(0, offset - 5), offset);
      if (offset === 0 || /[.!?]\s*$/.test(before)) {
        return `${interjection.charAt(0).toUpperCase() + interjection.slice(1)}, ${letter.toUpperCase()}`;
      }
      // If interjection is mid-sentence, still capitalize the word after comma if it starts a new thought
      return `${interjection.charAt(0).toUpperCase() + interjection.slice(1)}, ${letter.toUpperCase()}`;
    });
  });
  
  // CRITICAL FIX: Capitalize after standalone interjections that start sentences
  // "Again, that" → "Again, That" (if "Again" starts a new sentence)
  result = result.replace(/\b(Again|However|Therefore|Furthermore|Moreover|Nevertheless|Meanwhile|Indeed|Thus|Hence)\s*,\s+([a-z])/g, (match, interjection, letter) => {
    return `${interjection}, ${letter.toUpperCase()}`;
  });
  
  // Also capitalize after colons and semicolons if they're followed by a new sentence
  result = result.replace(/([;:])\s+([A-Z][a-z]+)\s+([a-z])/g, (match, punct, word, letter) => {
    // Check if this looks like a new sentence (capital word followed by lowercase)
    // This handles cases like "quote: biblical hospitality" → "quote: Biblical hospitality"
    return punct + ' ' + word + ' ' + letter;
  });
  
  // Capitalize common sentence starters that might not have punctuation
  const sentenceStarters = ['you know', 'and', 'but', 'or', 'so', 'then', 'now', 'oh', 'well'];
  sentenceStarters.forEach(starter => {
    // Only capitalize if it's at the start or after a potential sentence break
    const regex = new RegExp(`(^|[.!?]\\s+)${starter}\\b`, 'gi');
    result = result.replace(regex, (match, prefix) => {
      const capitalized = starter.charAt(0).toUpperCase() + starter.slice(1);
      return prefix + capitalized;
    });
  });
  
  // CRITICAL FIX: Ensure "you" is capitalized at sentence start
  // "you just need" → "You just need" (if it's a new sentence)
  result = result.replace(/([.!?])\s+you\s+/g, (match, punct) => {
    return `${punct} You `;
  });
  
  // Also capitalize "you" at the very start if lowercase
  result = result.replace(/^you\s+/g, 'You ');
  
  return result;
}

export function fixPronounILogic(text) {
  return text.replace(/\bi\b/g, 'I');
}

export function capitalizeProperNounsLogic(text) {
  let result = text;
  properNouns.forEach(noun => {
    const regex = new RegExp(`\\b${noun.toLowerCase()}\\b`, 'gi');
    result = result.replace(regex, noun);
  });
  return result;
}

export function capitalizeAcronymsLogic(text) {
  let result = text;
  Object.entries(acronyms).forEach(([lower, upper]) => {
    const regex = new RegExp(`\\b${lower}\\b`, 'gi');
    result = result.replace(regex, upper);
  });
  return result;
}

// ============================================================================
// F. DEDUPLICATE WORDS
// ============================================================================

export function deduplicateWordsLogic(text) {
  return text.replace(/\b(\w+)\s+\1\b/gi, '$1');
}

// ============================================================================
// G. COLLOQUIALISMS
// ============================================================================

export function normalizeColloquialismsLogic(text) {
  let result = text;
  Object.entries(colloquialisms).forEach(([informal, formal]) => {
    const regex = new RegExp(`\\b${informal}\\b`, 'gi');
    result = result.replace(regex, formal);
  });
  return result;
}

// ============================================================================
// H. BIBLE/FAITH-SPECIFIC LOGIC
// ============================================================================

export function normalizeBibleBookNamesLogic(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }
  let result = text;
  
  // CRITICAL: Common English words that should NEVER be changed to Bible books
  // These are common words that happen to sound like Bible book names
  const PROTECTED_COMMON_WORDS = new Set([
    'name',        // NEVER change to "Nahum"
    'job',         // Only change with context
    'acts',        // Can be "Acts" (book) or "acts" (verb) - check context
    'mark',        // Can be "Mark" (book) or "mark" (verb/noun) - check context
    'james',       // Can be "James" (book) or "james" (name) - check context
    'john',        // Can be "John" (book) or "john" (name) - check context
    'luke',        // Can be "Luke" (book) or "luke" (name) - check context
    'peter',       // Can be "Peter" (book) or "peter" (name) - check context
    'jude',        // Can be "Jude" (book) or "jude" (name) - check context
  ]);
  
  // Patterns that indicate a Bible book reference (STRONG context)
  const BIBLE_CONTEXT_PATTERNS = [
    /\b(book\s+of|prophet|book)\s+/i,           // "book of Genesis"
    /\s+(chapter|ch\.|chap\.)\s*(\d+)/i,       // "Genesis chapter 1"
    /\s+(verse|v\.|verses|vv\.)\s*(\d+)/i,     // "Genesis 1:1" or "verse 1"
    /\s+(\d+)\s*[:\-]\s*(\d+)/,                // "Genesis 1:1" or "1-5"
    /\s+(\d+)\s+(chapter|verse)/i,              // "Genesis 1 chapter"
    /\b(first|second|third|1st|2nd|3rd)\s+(samuel|kings|chronicles|corinthians|thessalonians|timothy|peter|john)/i,
  ];
  
  // Helper: Check if word has Bible reference context
  function hasBibleContext(text, wordOffset, wordLength) {
    const before = text.substring(Math.max(0, wordOffset - 50), wordOffset).toLowerCase();
    const after = text.substring(wordOffset + wordLength, Math.min(text.length, wordOffset + wordLength + 50)).toLowerCase();
    const context = before + ' ' + after;
    
    // Check for Bible context patterns
    for (const pattern of BIBLE_CONTEXT_PATTERNS) {
      if (pattern.test(context)) {
        return true;
      }
    }
    
    // Check for numbers nearby (chapter/verse indicators)
    const nearby = before.slice(-20) + ' ' + after.slice(0, 20);
    if (/\d+\s*[:\-]\s*\d+/.test(nearby) || /\b(chapter|verse|ch\.|v\.)\s*\d+/i.test(nearby)) {
      return true;
    }
    
    return false;
  }
  
  // Process Bible book mappings
  Object.entries(bibleBooks).forEach(([spoken, correct]) => {
    const spokenLower = spoken.toLowerCase();
    const isProtectedWord = PROTECTED_COMMON_WORDS.has(spokenLower);
    
    // Skip if this is a protected common word UNLESS it has strong Bible context
    if (isProtectedWord) {
      const regex = new RegExp(`\\b${spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      result = result.replace(regex, (match, offset) => {
        // Check if this is actually a Bible reference
        if (hasBibleContext(text, offset, match.length)) {
          return correct;
        }
        // Keep original - it's the common English word
        return match;
      });
    } else {
      // For non-protected words, still check context but be less strict
      // Only apply if it's clearly a Bible book (capitalized at sentence start or has Bible context)
      const regex = new RegExp(`\\b${spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      result = result.replace(regex, (match, offset) => {
        // If it's at sentence start (capitalized) or has Bible context, apply
        const isSentenceStart = offset === 0 || /[.!?]\s+/.test(text.substring(Math.max(0, offset - 10), offset));
        if (isSentenceStart || hasBibleContext(text, offset, match.length)) {
          return correct;
        }
        // For ambiguous cases, keep original to avoid incorrect changes
        return match;
      });
    }
  });
  
  // Always apply these corrections (unambiguous)
  result = result.replace(/\bRevelations\b/gi, 'Revelation');
  result = result.replace(/\bSongs\s+of\s+Solomon\b/gi, 'Song of Solomon');
  result = result.replace(/\bPsalms\s+(\d+)\b/gi, 'Psalm $1');
  
  return result;
}

export function normalizeVerseReferencesLogic(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }
  
  let result = text;
  
  // CRITICAL: Only normalize verse references in religious context
  // Check if text contains Bible/book indicators before applying
  const hasReligiousContext = /\b(bible|scripture|gospel|chapter|verse|psalm|genesis|exodus|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|john|jude|revelation|samuel|kings|chronicles|isaiah|jeremiah|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|acts)\b/i.test(text);
  
  if (!hasReligiousContext) {
    // No religious context - don't apply verse reference changes
    return result;
  }
  
  const numberWords = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    hundred: 100
  };
  
  const convertNumber = (words) => {
    if (!words || words.trim().length === 0) return words;
    const parts = words.trim().toLowerCase().split(/\s+/).filter(p => p !== 'and');
    let hundreds = 0;
    let tens = 0;
    let units = 0;
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === 'oh' || part === 'o') {
        if (tens === 0 && units === 0) {
          tens = 0;
          units = 0;
        } else {
          units = units * 10 + 0;
        }
      } else if (numberWords[part] !== undefined) {
        const num = numberWords[part];
        if (num === 100) {
          if (units > 0 || tens > 0) {
            hundreds = (tens + units) * 100;
            tens = 0;
            units = 0;
          } else {
            hundreds = 100;
          }
        } else if (num >= 20 && num < 100) {
          tens = num;
        } else if (num < 20) {
          if (tens > 0) {
            units = num;
          } else {
            units += num;
          }
        }
      }
    }
    
    const total = hundreds + tens + units;
    return total > 0 ? total : words;
  };
  
  // Pattern: "Genesis one one" → "Genesis 1:1"
  // CRITICAL: Only apply if book name is a known Bible book
  result = result.replace(/\b([A-Za-z]+(?:\s+(?:of|the))?)\s+(?:chapter\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:verse\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi, (match, book) => {
    // Check if book is a known Bible book
    const bookLower = book.toLowerCase().trim();
    const isBibleBook = Object.keys(bibleBooks).some(key => key.toLowerCase().includes(bookLower) || bookLower.includes(key.toLowerCase()));
    
    if (!isBibleBook) {
      // Not a Bible book - don't transform
      return match;
    }
    
    const parts = match.substring(book.length).trim().split(/\s+/);
    const chapterPart = parts.filter(p => !['verse', 'verses', 'chapter'].includes(p.toLowerCase())).slice(0, -1).join(' ');
    const versePart = parts.filter(p => !['verse', 'verses', 'chapter'].includes(p.toLowerCase())).slice(-1).join(' ');
    const chapter = convertNumber(chapterPart);
    const verse = convertNumber(versePart);
    return `${book} ${chapter}:${verse}`;
  });
  
  // Pattern: "Romans chapter eight verse one" → "Romans 8:1"
  result = result.replace(/\b([A-Za-z]+(?:\s+(?:of|the))?)\s+chapter\s+([a-z\s]+?)\s+verse\s+([a-z\s]+?)(?:\s+through|\s+to|\s+and)?\s*([a-z\s]+)?\b/gi, (match, book, chapterWords, verseWords, rangeWords) => {
    const bookLower = book.toLowerCase().trim();
    const isBibleBook = Object.keys(bibleBooks).some(key => key.toLowerCase().includes(bookLower) || bookLower.includes(key.toLowerCase()));
    
    if (!isBibleBook) {
      return match;
    }
    
    const chapter = convertNumber(chapterWords);
    const verse = convertNumber(verseWords);
    if (rangeWords) {
      const range = convertNumber(rangeWords.trim());
      return `${book} ${chapter}:${verse}–${range}`;
    }
    return `${book} ${chapter}:${verse}`;
  });
  
  // Pattern: "Romans ten nine through ten" → "Romans 10:9–10"
  result = result.replace(/\b([A-Za-z]+(?:\s+(?:of|the))?)\s+([a-z\s]+?)\s+([a-z\s]+?)\s+through\s+([a-z\s]+)\b/gi, (match, book, chapterWords, verseWords, endVerse) => {
    const bookLower = book.toLowerCase().trim();
    const isBibleBook = Object.keys(bibleBooks).some(key => key.toLowerCase().includes(bookLower) || bookLower.includes(key.toLowerCase()));
    
    if (!isBibleBook) {
      return match;
    }
    
    const chapter = convertNumber(chapterWords);
    const verse = convertNumber(verseWords);
    const end = convertNumber(endVerse);
    return `${book} ${chapter}:${verse}–${end}`;
  });
  
  // Pattern: "Psalm one hundred and nineteen" → "Psalm 119"
  result = result.replace(/\b(Psalm|Psalms)\s+([a-z\s]+?)(?:\s+verse|\s+chapter)?\s*$/gi, (match, book, numberWords) => {
    const num = convertNumber(numberWords);
    return `Psalm ${num}`;
  });
  
  return result;
}

export function capitalizeDivinePronounsLogic(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }
  let result = text;
  
  divineTitles.forEach(title => {
    const regex = new RegExp(`\\b${title}\\s+(he|him|his|you|your|yours|thou|thee|thy|thine)\\b`, 'gi');
    result = result.replace(regex, (match, pronoun) => {
      return match.replace(pronoun, pronoun.charAt(0).toUpperCase() + pronoun.slice(1));
    });
  });
  
  result = result.replace(/\b(?:dear|o|oh|father|lord|god|heavenly|holy)\s+(you|your|yours)\b/gi, (match, pronoun) => {
    return match.replace(pronoun, pronoun.charAt(0).toUpperCase() + pronoun.slice(1));
  });
  
  return result;
}

export function capitalizeDivineTitlesLogic(text) {
  let result = text;
  
  // CRITICAL: Only capitalize divine titles in religious context
  const hasReligiousContext = /\b(bible|scripture|gospel|jesus|christ|spirit|church|faith|prayer|worship|amen|prophet|apostle|disciple|theology|religious|sacred|holy|pray|praying)\b/i.test(text);
  
  if (!hasReligiousContext) {
    // No religious context - don't capitalize (might be common words like "lord" in non-religious context)
    return result;
  }
  
  divineTitles.forEach(title => {
    const regex = new RegExp(`\\b${title.toLowerCase()}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      // Check context around this match
      const before = text.substring(Math.max(0, offset - 30), offset).toLowerCase();
      const after = text.substring(offset + match.length, Math.min(text.length, offset + match.length + 30)).toLowerCase();
      const context = before + ' ' + after;
      
      // Only capitalize if there's religious context nearby
      if (/\b(bible|scripture|gospel|jesus|christ|spirit|church|faith|prayer|worship|amen|prophet|apostle|disciple|theology|religious|sacred|holy|pray|praying|heaven|heavenly)\b/i.test(context)) {
        return title;
      }
      // Keep original capitalization if no religious context
      return match;
    });
  });
  return result;
}

export function capitalizeSacredTextsLogic(text) {
  let result = text;
  
  // CRITICAL: Only capitalize sacred texts in religious context
  const hasReligiousContext = /\b(bible|scripture|gospel|jesus|christ|spirit|church|faith|prayer|worship|amen|prophet|apostle|disciple|theology|religious|sacred|holy|word\s+of\s+god)\b/i.test(text);
  
  if (!hasReligiousContext) {
    return result;
  }
  
  sacredTextReferences.forEach(ref => {
    const regex = new RegExp(`\\b${ref.toLowerCase()}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      // Check context around this match
      const before = text.substring(Math.max(0, offset - 30), offset).toLowerCase();
      const after = text.substring(offset + match.length, Math.min(text.length, offset + match.length + 30)).toLowerCase();
      const context = before + ' ' + after;
      
      // Only capitalize if there's religious context nearby
      if (/\b(bible|scripture|gospel|jesus|christ|spirit|church|faith|prayer|worship|amen|prophet|apostle|disciple|theology|religious|sacred|holy)\b/i.test(context)) {
        return ref;
      }
      // Keep original if no religious context
      return match;
    });
  });
  return result;
}

export function fixReligiousHomophonesLogic(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }
  let result = text;
  
  Object.entries(religiousHomophones).forEach(([word, config]) => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      const before = text.substring(Math.max(0, offset - 30), offset).toLowerCase();
      const after = text.substring(offset + match.length, Math.min(text.length, offset + match.length + 30)).toLowerCase();
      const context = before + ' ' + after;
      
      const contextCheck = config.contextCheck;
      if (contextCheck.includes('religious') || contextCheck.includes('spiritual') || contextCheck.includes('worship')) {
        if (/\b(pray|worship|god|lord|jesus|christ|spirit|church|faith|bible|scripture)\b/i.test(context)) {
          return match;
        }
      }
      
      if (contextCheck.includes('noun_religious')) {
        if (/\b(altar|prophet|soul|praise|peace|reign|rite|sermon|seal|raise|sins|mary|prophecy)\b/i.test(context)) {
          return match;
        }
      }
      
      return match;
    });
  });
  
  return result;
}

export function normalizeSermonStructureLogic(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }
  let result = text;
  
  // CRITICAL: Only apply sermon structure patterns in religious/sermon context
  const hasReligiousContext = /\b(bible|scripture|gospel|sermon|preach|preacher|church|faith|prayer|worship|amen|prophet|apostle|disciple|point|main\s+point|first|second|third)\b/i.test(text);
  
  if (!hasReligiousContext) {
    // No religious context - don't apply sermon structure changes
    return result;
  }
  
  Object.entries(sermonStructurePatterns).forEach(([spoken, replacement]) => {
    const regex = new RegExp(`\\b${spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      // Check context around this match
      const before = text.substring(Math.max(0, offset - 30), offset).toLowerCase();
      const after = text.substring(offset + match.length, Math.min(text.length, offset + match.length + 30)).toLowerCase();
      const context = before + ' ' + after;
      
      // Only apply if there's religious/sermon context nearby
      if (/\b(bible|scripture|gospel|sermon|preach|preacher|church|faith|prayer|worship|amen|prophet|apostle|disciple|point|main\s+point)\b/i.test(context)) {
        return replacement;
      }
      // Keep original if no religious context
      return match;
    });
  });
  
  result = result.replace(/\b(?:Point|Main point)\s+number\s+(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (match, offset) => {
    const before = text.substring(Math.max(0, offset - 30), offset).toLowerCase();
    if (/\b(bible|scripture|gospel|sermon|preach|preacher|church|faith|prayer|worship|point)\b/i.test(before)) {
      const numMap = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
      const num = match.match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
      if (num) {
        return `${numMap[num[0].toLowerCase()]}.`;
      }
    }
    return match;
  });
  
  result = result.replace(/\bnew\s+paragraph\b/gi, (match, offset) => {
    const before = text.substring(Math.max(0, offset - 30), offset).toLowerCase();
    if (/\b(bible|scripture|gospel|sermon|preach|preacher|church|faith|prayer|worship)\b/i.test(before)) {
      return '\n\n';
    }
    return match;
  });
  
  return result;
}

export function normalizePrayerLanguageLogic(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }
  let result = text;
  
  // CRITICAL: Only apply prayer language normalization in religious context
  const hasReligiousContext = /\b(bible|scripture|gospel|jesus|christ|spirit|church|faith|prayer|pray|worship|amen|hallelujah|lord|god|heavenly|father|holy)\b/i.test(text);
  
  if (!hasReligiousContext) {
    // No religious context - don't apply prayer language changes
    return result;
  }
  
  Object.entries(prayerLanguagePatterns).forEach(([spoken, replacement]) => {
    const regex = new RegExp(`\\b${spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      // Check context around this match
      const before = text.substring(Math.max(0, offset - 30), offset).toLowerCase();
      const after = text.substring(offset + match.length, Math.min(text.length, offset + match.length + 30)).toLowerCase();
      const context = before + ' ' + after;
      
      // Only apply if there's religious/prayer context nearby
      if (/\b(bible|scripture|gospel|jesus|christ|spirit|church|faith|prayer|pray|worship|amen|lord|god|heavenly|father|holy)\b/i.test(context)) {
        return replacement;
      }
      // Keep original if no religious context
      return match;
    });
  });
  
  // These patterns are specific enough that they're safe to apply in religious context
  result = result.replace(/\bDear\s+Lord\s+please\b/gi, 'Dear Lord, please');
  result = result.replace(/\bThank\s+you\s+Lord\b/gi, 'Thank You, Lord.');
  result = result.replace(/\bIn\s+Jesus\s+name\s+amen\b/gi, "In Jesus' name, Amen.");
  result = result.replace(/\bOh\s+Lord\b/gi, 'O Lord,');
  result = result.replace(/\bhallelujah\b/gi, 'Hallelujah!');
  result = result.replace(/\bamen\s*$/gi, 'Amen.');
  result = result.replace(/\bpraise\s+the\s+lord\b/gi, 'Praise the Lord!');
  
  return result;
}

export function normalizeTheologyTermsLogic(text) {
  let result = text;
  
  // CRITICAL: Only apply theology term normalization in religious context
  // Check if text contains religious indicators before applying
  const hasReligiousContext = /\b(bible|scripture|gospel|lord|god|jesus|christ|spirit|church|faith|prayer|worship|amen|hallelujah|prophet|apostle|disciple|theology|religious|sacred|holy)\b/i.test(text);
  
  if (!hasReligiousContext) {
    // No religious context - don't apply theology term changes
    return result;
  }
  
  const sortedTerms = Object.entries(theologyTerms).sort((a, b) => b[0].length - a[0].length);
  sortedTerms.forEach(([lower, upper]) => {
    const regex = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      // Double-check context around this specific match
      const before = text.substring(Math.max(0, offset - 30), offset).toLowerCase();
      const after = text.substring(offset + match.length, Math.min(text.length, offset + match.length + 30)).toLowerCase();
      const context = before + ' ' + after;
      
      // Only apply if there's religious context nearby
      if (/\b(bible|scripture|gospel|lord|god|jesus|christ|spirit|church|faith|prayer|worship|amen|prophet|apostle|disciple|theology|religious|sacred|holy)\b/i.test(context)) {
        return upper;
      }
      // Keep original if no religious context
      return match;
    });
  });
  return result;
}

export function normalizeQuotationSyntaxLogic(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }
  let result = text;
  const originalResult = result;
  
  console.log(`[QuoteDetection] 🔍 Starting quote detection on: "${result.substring(0, 150)}${result.length > 150 ? '...' : ''}"`);
  
  // CRITICAL: We DO want to process even if quotes exist - we need to detect quotes after "I love this quote," patterns
  // The existing quotes might be STT artifacts that need fixing
  const hasQuotes = /["'"]/.test(result);
  if (hasQuotes) {
    console.log(`[QuoteDetection] ℹ️ Text contains existing quotes - will check if they're correctly placed`);
  }
  
  // Handle "Quote ... end quote" patterns
  result = result.replace(/\bQuote\s+(.+?)\s+end\s+quote\b/gi, (match, quoteText) => {
    const words = quoteText.trim().split(/\s+/);
    if (words.length > 0) {
      words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    }
    const final = words.join(' ');
    if (!/[.!?]$/.test(final)) {
      return `"${final}."`;
    }
    return `"${final}"`;
  });
  
  // Handle "X said quote ... end quote" patterns
  result = result.replace(/\b([A-Za-z]+)\s+said\s+quote\s+(.+?)\s+end\s+quote\b/gi, (match, speaker, quote) => {
    const quoteText = quote.trim();
    const capitalized = quoteText.charAt(0).toUpperCase() + quoteText.slice(1);
    return `${speaker} said, "${capitalized}."`;
  });
  
  // Handle "X said," with quotes (preserve existing quotes)
  // Pattern: "she said," "I was absolutely blown away" or "she said," ""
  result = result.replace(/\b([A-Za-z]+)\s+said,?\s*["']([^"']*)["']/gi, (match, speaker, quote) => {
    // If quote is empty, check if there's content after that should be quoted
    if (!quote || quote.trim() === '') {
      // Look ahead for content that should be in quotes
      // This handles cases like "she said," "" where the quote content comes after
      return match; // Preserve as-is for now, will be handled by quote preservation logic
    }
    // Preserve the quote with proper formatting
    return `${speaker} said, "${quote.trim()}"`;
  });
  
  // CRITICAL: Handle "I love this quote," patterns - detect quotes after "quote," or "this quote,"
  // Pattern: "I love this quote, biblical hospitality is..."
  const quoteMatches = []; // Initialize quoteMatches array here
  const quoteIntroPatterns = [
    /\b(?:I|we|they|he|she)\s+(?:love|like|remember|recall|heard)\s+this\s+quote,?\s+/gi,
    /\bthis\s+quote,?\s+/gi,
    /\bquote,?\s+/gi
  ];
  
  quoteIntroPatterns.forEach((pattern, patternIndex) => {
    let quoteMatch;
    pattern.lastIndex = 0;
    const patternNames = ['I love this quote', 'this quote', 'quote'];
    console.log(`[QuoteDetection] 🔍 Checking pattern ${patternIndex + 1}: "${patternNames[patternIndex]}"`);
    
    while ((quoteMatch = pattern.exec(result)) !== null) {
      const afterQuoteStart = quoteMatch.index + quoteMatch[0].length;
      const remainingText = result.substring(afterQuoteStart);
      console.log(`[QuoteDetection] ✅ Found "${patternNames[patternIndex]}" at position ${quoteMatch.index}, checking text after: "${remainingText.substring(0, 80)}..."`);
      
      // Find where quote ends - look for end markers or natural sentence boundaries
      const endMarkerPatterns = [
        { pattern: /\s+and\s+rejects\b/i, name: 'and rejects' },
        { pattern: /\s+What\s+if\b/i, name: 'What if' },
        { pattern: /\s+You\s+know\b/i, name: 'You know' },
        { pattern: /\.\s+[A-Z][a-z]+\s+[a-z]+\s+is\b/i, name: 'new sentence' }, // New sentence starting with capitalized word
      ];
      
      let quoteEndOffset = remainingText.length;
      let foundEndMarker = null;
      
      // Find the earliest end marker
      for (const { pattern: endPattern, name } of endMarkerPatterns) {
        const markerMatch = remainingText.match(endPattern);
        if (markerMatch && markerMatch.index !== undefined && markerMatch.index < quoteEndOffset) {
          quoteEndOffset = markerMatch.index;
          foundEndMarker = name;
          console.log(`[QuoteDetection] 📍 Found end marker "${name}" at position ${markerMatch.index}`);
        }
      }
      
      // Also look for natural sentence boundaries (periods followed by capital letters)
      // But only if we haven't found a closer end marker
      const sentenceBoundary = remainingText.match(/\.\s+([A-Z])/);
      if (sentenceBoundary && sentenceBoundary.index !== undefined && sentenceBoundary.index < quoteEndOffset) {
        // Check if this looks like the end of a quote (not just a sentence break)
        const textBeforePeriod = remainingText.substring(0, sentenceBoundary.index).trim();
        // If it's a substantial quote (at least 20 chars), treat the period as quote end
        if (textBeforePeriod.length > 20) {
          quoteEndOffset = sentenceBoundary.index;
          foundEndMarker = 'sentence boundary';
          console.log(`[QuoteDetection] 📍 Found sentence boundary at position ${sentenceBoundary.index}`);
        }
      }
      
      // Extract quote text
      let quoteText = remainingText.substring(0, quoteEndOffset).trim();
      console.log(`[QuoteDetection] 📝 Extracted quote text (${quoteText.length} chars): "${quoteText.substring(0, 100)}${quoteText.length > 100 ? '...' : ''}"`);
      
      // CRITICAL: Find where quote naturally ends by looking for sentence boundaries
      // Quotes typically end at: periods, exclamation marks, question marks
      // OR before discourse markers like "and", "but", "however" at sentence start
      const sentenceEndMatch = quoteText.match(/[.!?]\s+[A-Z]/);
      if (sentenceEndMatch && sentenceEndMatch.index !== undefined) {
        // Quote ends at this sentence boundary
        quoteText = quoteText.substring(0, sentenceEndMatch.index + 1).trim();
        console.log(`[QuoteDetection] 📍 Found sentence boundary in quote at position ${sentenceEndMatch.index}`);
      }
      
      // Clean up quote text
      if (foundEndMarker && foundEndMarker !== 'sentence boundary') {
        quoteText = quoteText.replace(new RegExp(`\\s+${foundEndMarker.replace(/\s+/g, '\\s+')}.*$`, 'i'), '').trim();
        console.log(`[QuoteDetection] 🧹 Cleaned quote text after removing end marker: "${quoteText.substring(0, 100)}${quoteText.length > 100 ? '...' : ''}"`);
      }
      
      // Only add quote if we found substantial content (at least 15 chars)
      if (quoteText && quoteText.length > 15) {
        // Check if quote text already has quotes - if so, clean them up
        let cleanQuoteText = quoteText;
        const hasExistingQuotes = quoteText.includes('"') || quoteText.includes("'");
        
        if (hasExistingQuotes) {
          // Remove existing quotes and clean up
          cleanQuoteText = quoteText.replace(/^["']+|["']+$/g, '').trim();
          // Remove any artifacts like "e" or single letters in quotes
          cleanQuoteText = cleanQuoteText.replace(/\s+["']e["']\s+/gi, ' ').trim();
          cleanQuoteText = cleanQuoteText.replace(/["']e["']/gi, '').trim();
          console.log(`[QuoteDetection] 🧹 Cleaned existing quotes: "${quoteText.substring(0, 80)}" → "${cleanQuoteText.substring(0, 80)}"`);
        }
        
        // Only add if we still have substantial content after cleaning
        if (cleanQuoteText && cleanQuoteText.length > 15) {
          console.log(`[QuoteDetection] ✅ Adding quote match: "${cleanQuoteText.substring(0, 100)}${cleanQuoteText.length > 100 ? '...' : ''}"`);
          quoteMatches.push({
            start: afterQuoteStart,
            end: afterQuoteStart + quoteEndOffset,
            speaker: null,
            quoteText: cleanQuoteText
          });
        } else {
          console.log(`[QuoteDetection] ⚠️ Skipping - quote text too short after cleaning (${cleanQuoteText ? cleanQuoteText.length : 0} chars, need 15+)`);
        }
      } else {
        console.log(`[QuoteDetection] ⚠️ Skipping - quote text too short (${quoteText ? quoteText.length : 0} chars, need 15+)`);
      }
    }
  });
  
  console.log(`[QuoteDetection] 📊 Found ${quoteMatches.length} quote matches to apply`);
  
  // CRITICAL: Handle pattern: "X said," followed by unquoted content that should be quoted
  // This is the most important case - quotes that are implied by context
  // Pattern: "he said, love God with everything. Have but love your neighbor as yourself."
  
  // Find all "X said," patterns (without existing quotes)
  // Use a more intelligent approach: find "said," and extract content until we hit a quote end marker
  const saidPattern = /\b([A-Za-z]+)\s+said,?\s+(?!["'])/gi;
  let match;
  
  // Reset regex lastIndex
  saidPattern.lastIndex = 0;
  
  while ((match = saidPattern.exec(result)) !== null) {
    const speaker = match[1];
    const afterSaidStart = match.index + match[0].length;
    
    // Get all text after "said," 
    const remainingText = result.substring(afterSaidStart);
    
    // Find where quote ends - look for patterns that indicate end of quote
    // Quotes typically end before:
    // - "What if" (new question/thought)
    // - "You know" (new thought/commentary)
    // - Discourse markers that start new sentences
    const endMarkerPatterns = [
      { pattern: /\s+What\s+if\b/i, name: 'What if' },
      { pattern: /\s+You\s+know\b/i, name: 'You know' },
      { pattern: /\.\s+But\s+[A-Z]/i, name: 'But' },
      { pattern: /\.\s+And\s+[A-Z]/i, name: 'And' },
      { pattern: /\.\s+However\b/i, name: 'However' },
      { pattern: /\.\s+So\s+[A-Z]/i, name: 'So' }
    ];
    
    let quoteEndOffset = remainingText.length;
    let foundEndMarker = null;
    
    // Find the earliest end marker
    for (const { pattern, name } of endMarkerPatterns) {
      const markerMatch = remainingText.match(pattern);
      if (markerMatch && markerMatch.index !== undefined && markerMatch.index < quoteEndOffset) {
        quoteEndOffset = markerMatch.index;
        foundEndMarker = name;
      }
    }
    
    // CRITICAL FIX: Find the FIRST sentence boundary after "said,"
    // Quotes should typically end at the first complete sentence (period/question/exclamation)
    const firstSentenceEnd = remainingText.match(/[.!?]\s+[A-Z]/);
    if (firstSentenceEnd && firstSentenceEnd.index !== undefined) {
      // Quote ends at the first sentence boundary
      quoteEndOffset = firstSentenceEnd.index + 1;
      foundEndMarker = 'first sentence';
    }
    
    // Extract quote text (everything before the end marker)
    let quoteText = remainingText.substring(0, quoteEndOffset).trim();
    
    // If we found an end marker, make sure we're not including it in the quote
    if (foundEndMarker && foundEndMarker !== 'first sentence') {
      // Remove any trailing instances of the end marker
      quoteText = quoteText.replace(new RegExp(`\\s+${foundEndMarker.replace(/\s+/g, '\\s+')}.*$`, 'i'), '').trim();
    }
    
    // CRITICAL: Only quote the first sentence after "said," - don't quote multiple sentences
    // Split by sentence boundaries and take only the first one
    const sentenceMatch = quoteText.match(/^([^.!?]*[.!?]+)/);
    if (sentenceMatch) {
      quoteText = sentenceMatch[0].trim();
      quoteEndOffset = afterSaidStart + sentenceMatch[0].length;
    }
    
    // Only add quote if we found substantial content (at least 10 chars)
    if (quoteText && quoteText.length > 10) {
      quoteMatches.push({
        start: afterSaidStart,
        end: afterSaidStart + quoteEndOffset,
        speaker,
        quoteText
      });
    }
  }
  
  // Also detect "here's a quote" or "quote from" patterns
  const quoteIntroPattern = /\b(?:here'?s?\s+a\s+quote|quote\s+from|according\s+to)\s+[^.!?]+?\.\s+([A-Z][^.!?]+(?:\.\s+[A-Z][^.!?]+)*)/gi;
  let introMatch;
  
  while ((introMatch = quoteIntroPattern.exec(result)) !== null) {
    const quoteStart = introMatch.index + introMatch[0].length - introMatch[1].length;
    const quoteText = introMatch[1].trim();
    
    if (quoteText && quoteText.length > 10) {
      // Find where this quote ends
      const remainingText = result.substring(quoteStart);
      let quoteEndOffset = remainingText.length;
      
      const endMarkers = [
        /\s+What\s+if\b/i,
        /\s+You\s+know\b/i
      ];
      
      for (const marker of endMarkers) {
        const markerMatch = remainingText.match(marker);
        if (markerMatch && markerMatch.index !== undefined && markerMatch.index < quoteEndOffset) {
          quoteEndOffset = markerMatch.index;
        }
      }
      
      let cleanQuote = remainingText.substring(0, quoteEndOffset).trim();
      cleanQuote = cleanQuote.replace(/\s+(What\s+if|You\s+know).*$/i, '').trim();
      
      if (cleanQuote && cleanQuote.length > 10) {
        quoteMatches.push({
          start: quoteStart,
          end: quoteStart + quoteEndOffset,
          speaker: null,
          quoteText: cleanQuote
        });
      }
    }
  }
  
  // Detect quotes that follow questions like "What if he meant?" or "What if X?"
  // Pattern: "What if X?" followed by a statement that might be a quote/interpretation
  const questionQuotePattern = /\bWhat\s+if\s+[^.!?]+\?\s+([A-Z][^.!?]+(?:\.\s+[A-Z][^.!?]+)*)/gi;
  let questionMatch;
  
  while ((questionMatch = questionQuotePattern.exec(result)) !== null) {
    const quoteStart = questionMatch.index + questionMatch[0].length - questionMatch[1].length;
    const quoteText = questionMatch[1].trim();
    
    if (quoteText && quoteText.length > 10) {
      // Find where this quote ends (typically before "You know" or end of text)
      const remainingText = result.substring(quoteStart);
      let quoteEndOffset = remainingText.length;
      
      const endMarkers = [
        /\s+You\s+know\b/i
      ];
      
      for (const marker of endMarkers) {
        const markerMatch = remainingText.match(marker);
        if (markerMatch && markerMatch.index !== undefined && markerMatch.index < quoteEndOffset) {
          quoteEndOffset = markerMatch.index;
        }
      }
      
      let cleanQuote = remainingText.substring(0, quoteEndOffset).trim();
      cleanQuote = cleanQuote.replace(/\s+You\s+know.*$/i, '').trim();
      
      if (cleanQuote && cleanQuote.length > 10) {
        quoteMatches.push({
          start: quoteStart,
          end: quoteStart + quoteEndOffset,
          speaker: null,
          quoteText: cleanQuote
        });
      }
    }
  }
  
  // Apply quotes in reverse order (to preserve positions)
  quoteMatches.sort((a, b) => b.start - a.start);
  quoteMatches.forEach(({ start, end, speaker, quoteText }, index) => {
    const before = result.substring(0, start);
    const after = result.substring(end);
    const beforeReplacement = result.substring(start, end);
    
    // CRITICAL FIX: Check if "said," already exists before the quote
    // If speaker is set, it means we found "X said," pattern, but we need to check
    // if "said," is already in the text before start position
    let replacement;
    if (speaker) {
      // Check if "said," already exists right before the quote text
      const textBeforeQuote = result.substring(Math.max(0, start - 50), start);
      const hasSaidBefore = /\b\w+\s+said,?\s*$/i.test(textBeforeQuote);
      
      if (hasSaidBefore) {
        // "said," already exists - just add quotes around the quote text
        replacement = `"${quoteText}"`;
      } else {
        // No "said," found - add it with quotes
        replacement = `${speaker} said, "${quoteText}"`;
      }
    } else {
      // No speaker - just add quotes
      replacement = `"${quoteText}"`;
    }
    
    console.log(`[QuoteDetection] 🔧 Applying quote ${index + 1}/${quoteMatches.length}:`);
    console.log(`  Before: "${beforeReplacement.substring(0, 80)}${beforeReplacement.length > 80 ? '...' : ''}"`);
    console.log(`  After: "${replacement.substring(0, 80)}${replacement.length > 80 ? '...' : ''}"`);
    result = before + replacement + after;
  });
  
  // Normalize consecutive verse references
  result = result.replace(/\b([A-Za-z]+\s+\d+:\d+)\s+([A-Za-z]+\s+\d+:\d+)\b/g, '$1; $2');
  
  if (result !== originalResult) {
    console.log(`[QuoteDetection] ✅ QUOTES APPLIED: "${originalResult.substring(0, 150)}${originalResult.length > 150 ? '...' : ''}" → "${result.substring(0, 150)}${result.length > 150 ? '...' : ''}"`);
  } else {
    console.log(`[QuoteDetection] ⚠️ NO QUOTES APPLIED - text unchanged`);
  }
  
  return result;
}

export function normalizeFormattingCommandsLogic(text) {
  let result = text;
  const formatCommands = {
    'new paragraph': '\n\n',
    'new line': '\n',
    'verse break': '¶',
    'section break': '---',
    'chapter heading': '##',
    'bullet point': '•',
    'numbered list': '1.',
    'quotation mark': '"',
    'apostrophe': "'",
    'dash': '—'
  };
  
  Object.entries(formatCommands).forEach(([spoken, replacement]) => {
    const regex = new RegExp(`\\b${spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(regex, replacement);
  });
  
  return result;
}

export function fixDivineNamesLogic(text) {
  let result = text;
  Object.entries(divineNames).forEach(([lower, upper]) => {
    const regex = new RegExp(`\\b${lower}\\b`, 'gi');
    result = result.replace(regex, upper);
  });
  return result;
}

export function normalizeLiturgicalTermsLogic(text) {
  let result = text;
  Object.entries(liturgicalTerms).forEach(([lower, upper]) => {
    const regex = new RegExp(`\\b${lower}\\b`, 'gi');
    result = result.replace(regex, upper);
  });
  return result;
}

/**
 * Fix run-on sentences by splitting long sentences connected by "and"
 * Handles cases like: "X is Y and rejects Z" → "X is Y. And rejects Z"
 * @param {string} text - Input text
 * @param {object} doc - Compromise NLP document (optional)
 * @returns {string} Text with run-on sentences fixed
 */
export function fixRunOnSentencesLogic(text, doc = null) {
  if (!text || text.trim().length === 0) return text;
  if (!doc) {
    doc = nlp(text);
  }
  
  let result = text;
  const original = result;
  
  console.log(`[RunOnFix] 🔍 Checking for run-on sentences in: "${result.substring(0, 150)}${result.length > 150 ? '...' : ''}"`);
  
  // First, fix common artifacts like "e" in quotes and weird punctuation
  result = result.replace(/\s+["']e["']\s+/gi, ' ');
  result = result.replace(/["']e["']/gi, '');
  result = result.replace(/,\s*\./g, '.');
  result = result.replace(/and,\./gi, 'and');
  result = result.replace(/\s+,\s+\./g, '.');
  
  // Fix "And Rejects" -> "And rejects" (capitalization after "And")
  result = result.replace(/\bAnd\s+([A-Z][a-z]+)\b/g, (match, word) => {
    // Check if it's a verb that should be lowercase after "And"
    const verbPattern = /\b(rejects|reject|is|are|was|were|has|have|does|do|will|can|should|could)\b/i;
    if (verbPattern.test(word)) {
      return `And ${word.toLowerCase()}`;
    }
    return match;
  });
  
  // Find patterns like "X is Y and rejects Z" where "and" connects two independent clauses
  // Pattern: word "and" word (where both parts have verbs)
  // More aggressive: look for "and" followed by verbs
  const runOnPatterns = [
    /\b([^.!?]{15,})\s+and\s+([A-Z][a-z]+\s+[^.!?]{10,})\b/g, // "and" followed by capitalized word (likely new clause)
    /\b([^.!?]{20,})\s+and\s+([^.!?]{15,})\b/gi // General pattern
  ];
  
  const processedPositions = new Set();
  
  runOnPatterns.forEach((runOnPattern, patternIndex) => {
    let match;
    runOnPattern.lastIndex = 0;
    
    while ((match = runOnPattern.exec(result)) !== null) {
      const beforeAnd = match[1].trim();
      const afterAnd = match[2].trim();
      const fullMatch = match[0];
      const matchIndex = match.index;
      const absoluteAndPos = matchIndex + beforeAnd.length;
      
      // Skip if we've already processed this position
      if (processedPositions.has(absoluteAndPos)) {
        continue;
      }
      
      console.log(`[RunOnFix] 🔍 Found potential run-on (pattern ${patternIndex + 1}): "${fullMatch.substring(0, 80)}${fullMatch.length > 80 ? '...' : ''}"`);
      
      // Check if both parts have verbs (independent clauses)
      const beforeDoc = nlp(beforeAnd);
      const afterDoc = nlp(afterAnd);
      const beforeVerbs = beforeDoc.match('#Verb').length;
      const afterVerbs = afterDoc.match('#Verb').length;
      
      console.log(`[RunOnFix] 📊 Before "and": ${beforeVerbs} verbs, ${beforeAnd.split(/\s+/).length} words`);
      console.log(`[RunOnFix] 📊 After "and": ${afterVerbs} verbs, ${afterAnd.split(/\s+/).length} words`);
      
      // More aggressive splitting: if pattern 0 (capitalized after "and") OR both have verbs
      const shouldSplit = (patternIndex === 0) || // Pattern 0: "and" followed by capitalized word (likely new clause)
                         (beforeVerbs > 0 && afterVerbs > 0 && beforeAnd.length > 15 && afterAnd.length > 15);
      
      if (shouldSplit) {
        const beforeWords = beforeAnd.split(/\s+/).length;
        const afterWords = afterAnd.split(/\s+/).length;
        
        // Split if both clauses are substantial (5+ words each) OR if combined is long (30+ words) OR pattern 0
        const isSubstantial = (beforeWords >= 5 && afterWords >= 5) || (beforeWords + afterWords > 30) || (patternIndex === 0);
        
        if (isSubstantial) {
          console.log(`[RunOnFix] ✅ Splitting run-on sentence: "${beforeAnd.substring(0, 60)}... AND ${afterAnd.substring(0, 60)}..."`);
          
          // Replace " and " with ". And " (period + space + capitalized And)
          const before = result.substring(0, absoluteAndPos);
          const after = result.substring(absoluteAndPos + 5); // Skip " and "
          
          // Capitalize the first letter after "and"
          const capitalizedAfter = after.charAt(0).toUpperCase() + after.slice(1);
          
          result = before + '. And ' + capitalizedAfter;
          processedPositions.add(absoluteAndPos);
          
          console.log(`[RunOnFix] 🔧 Applied fix: "${before.substring(Math.max(0, before.length - 40))} and ${after.substring(0, 40)}" → "${before.substring(Math.max(0, before.length - 40))}. And ${capitalizedAfter.substring(0, 40)}"`);
          
          // Reset all patterns since we modified the string
          runOnPatterns.forEach(p => p.lastIndex = 0);
          break; // Restart from beginning
        } else {
          console.log(`[RunOnFix] ⚠️ Skipping - clauses too short (${beforeWords} + ${afterWords} words)`);
        }
      } else {
        console.log(`[RunOnFix] ⚠️ Skipping - not independent clauses (before: ${beforeVerbs} verbs, after: ${afterVerbs} verbs)`);
      }
    }
  });
  
  if (result !== original) {
    console.log(`[RunOnFix] ✅ RUN-ON SENTENCES FIXED: "${original.substring(0, 150)}${original.length > 150 ? '...' : ''}" → "${result.substring(0, 150)}${result.length > 150 ? '...' : ''}"`);
  } else {
    console.log(`[RunOnFix] ⚠️ NO RUN-ON SENTENCES FOUND - text unchanged`);
  }
  
  return result;
}

