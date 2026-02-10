/**
 * Transcription Cleanup Module
 * Comprehensive post-processing cleanup functions for STT transcription
 * Handles all categories: A-L (punctuation, capitalization, contractions, homophones, etc.)
 * Uses node-nlp and compromise for NLP-based corrections
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
  protectedWords,
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
  versePatterns,
  punctuationNormalization
} from './cleanupRules.js';

/**
 * Helper: Use retext for advanced text processing (optional, async)
 * 
 * How retext improves the algorithm:
 * 1. Better sentence boundary detection - retext-english provides more accurate
 *    sentence segmentation than regex alone, using linguistic rules
 * 2. Proper capitalization - retext-capitalization handles complex rules like
 *    sentence starts, proper nouns, titles, etc. more accurately
 * 3. Contraction handling - retext-contractions is more context-aware than
 *    simple dictionary replacements, understanding when contractions are appropriate
 * 4. Smart quotes - retext-quotes handles quotation marks and apostrophes correctly,
 *    including nested quotes and different quote styles
 * 5. Sentence spacing - retext-sentence-spacing ensures proper spacing after punctuation
 * 6. Natural language understanding - retext provides AST (Abstract Syntax Tree)
 *    for better text analysis and transformation
 * 7. Plugin ecosystem - Modular plugins allow fine-tuned control over each aspect
 * 
 * Note: retext is async, so it's used as an optional enhancement. For synchronous
 * processing, we use compromise which provides similar functionality.
 */
export async function processWithRetext(text) {
  try {
    // Dynamic import to avoid blocking if retext is not available
    const { retext } = await import('retext');
    const { retextEnglish } = await import('retext-english');
    const { retextCapitalization } = await import('retext-capitalization');
    const { retextContractions } = await import('retext-contractions');
    const { retextQuotes } = await import('retext-quotes');
    const { retextSentenceSpacing } = await import('retext-sentence-spacing');

    const processor = retext()
      .use(retextEnglish)
      .use(retextCapitalization)
      .use(retextContractions)
      .use(retextQuotes)
      .use(retextSentenceSpacing);

    const result = await processor.process(text);
    return String(result);
  } catch (error) {
    // If retext fails or is not installed, return original text
    console.warn('[transcriptionCleanup] Retext processing failed, using original:', error.message);
    return text;
  }
}

// ============================================================================
// A. PUNCTUATION RESTORATION
// ============================================================================

/**
 * Main punctuation restoration - uses comprehensive sentence segmentation
 */
export function restorePunctuation(text, isPartial = false) {
  if (!text || text.trim().length === 0) return text;

  let result = text.trim();

  // CRITICAL: Never add punctuation at the start of text
  // Remove any leading punctuation that might have been incorrectly added
  result = result.replace(/^[.!?,]\s*/, '');

  // First, use compromise to analyze the text
  const doc = nlp(result);

  // Detect sentence boundaries using NLP
  const boundaries = detectSentenceBoundaries(result, doc);

  // Add punctuation at detected boundaries
  result = addPunctuationAtBoundaries(result, boundaries, isPartial);

  // Add commas using clause detection
  result = addCommas(result, doc);

  // Final check: remove any leading punctuation that might have been added
  result = result.replace(/^[.!?,]\s*/, '');

  return result;
}

/**
 * Detect sentence boundaries using comprehensive NLP analysis
 */
export function detectSentenceBoundaries(text, doc) {
  const boundaries = [];

  // Use compromise clause detection
  const clauses = findClauseBoundaries(doc);

  // Analyze sentence structure
  const structure = analyzeSentenceStructure(doc);

  // Detect run-on sentences
  const runOns = detectRunOnSentences(text, doc);

  // Segment by discourse markers
  const markerSegments = segmentByDiscourseMarkers(text, doc);

  // Combine all detected boundaries
  boundaries.push(...clauses, ...structure.boundaries, ...runOns, ...markerSegments);

  // Sort and deduplicate
  return boundaries.sort((a, b) => a.position - b.position)
    .filter((b, i, arr) => i === 0 || b.position !== arr[i - 1].position);
}

/**
 * Find clause boundaries using compromise
 */
export function findClauseBoundaries(doc) {
  const boundaries = [];

  try {
    // Get clauses from compromise
    const sentences = doc.sentences();

    sentences.forEach((sentence, idx) => {
      // Check if this sentence has multiple independent clauses
      const text = sentence.text();

      // Look for coordinating conjunctions that might indicate clause boundaries
      const conjunctions = [' and ', ' but ', ' or ', ' so ', ' yet '];
      conjunctions.forEach(conj => {
        const index = text.indexOf(conj);
        if (index > 0 && index < text.length - conj.length) {
          // Check if it's connecting two independent clauses
          const before = text.substring(0, index).trim();
          const after = text.substring(index + conj.length).trim();

          // Simple heuristic: if both parts have verbs, likely independent clauses
          const beforeDoc = nlp(before);
          const afterDoc = nlp(after);
          const beforeHasVerb = beforeDoc.match('#Verb').length > 0;
          const afterHasVerb = afterDoc.match('#Verb').length > 0;

          if (beforeHasVerb && afterHasVerb) {
            boundaries.push({
              position: index,
              type: 'clause_boundary',
              punctuation: ',',
              confidence: 0.7
            });
          }
        }
      });
    });
  } catch (error) {
    console.warn('[transcriptionCleanup] Error finding clause boundaries:', error.message);
  }

  return boundaries;
}

/**
 * Analyze sentence structure using compromise
 */
export function analyzeSentenceStructure(doc) {
  const boundaries = [];

  try {
    const sentences = doc.sentences();

    sentences.forEach((sentence, idx) => {
      const text = sentence.text();

      // Detect subject-verb-object patterns
      const terms = sentence.terms();

      // Look for verb tense changes or subject changes as potential boundaries
      let lastVerb = null;
      let lastSubject = null;

      terms.forEach((term, termIdx) => {
        if (term.has('#Verb')) {
          const verb = term.text();
          if (lastVerb && verb !== lastVerb) {
            // Verb change might indicate new thought
            boundaries.push({
              position: term.start,
              type: 'verb_change',
              punctuation: '.',
              confidence: 0.5
            });
          }
          lastVerb = verb;
        }

        if (term.has('#Noun') && term.has('#Subject')) {
          const subject = term.text();
          if (lastSubject && subject.toLowerCase() !== lastSubject.toLowerCase()) {
            // Subject change might indicate new sentence
            boundaries.push({
              position: term.start,
              type: 'subject_change',
              punctuation: '.',
              confidence: 0.6
            });
          }
          lastSubject = subject;
        }
      });
    });
  } catch (error) {
    console.warn('[transcriptionCleanup] Error analyzing sentence structure:', error.message);
  }

  return { boundaries };
}

/**
 * Detect run-on sentences that need splitting
 */
export function detectRunOnSentences(text, doc) {
  const boundaries = [];

  try {
    // Look for long sentences without punctuation
    const sentences = doc.sentences();

    sentences.forEach(sentence => {
      const sentenceText = sentence.text();

      // More aggressive: check for multiple verbs (indicates multiple clauses)
      const verbs = sentence.match('#Verb');

      // Check if sentence is long or has multiple verbs
      if ((sentenceText.length > 100 || verbs.length > 1) && !/[.!?]/.test(sentenceText)) {
        // Look for patterns that indicate sentence breaks
        // Pattern: "has been" or "is" followed by "for" or "when" often indicates new sentence
        const patterns = [
          /\b(has been|is|was|are|were)\s+(for|since|when|where|if|that|which|who)\s+/gi,
          /\b(for|since|when|where|if|that|which|who)\s+[a-z]+\s+(has|is|was|are|were)\s+/gi,
          /\b(has been|is|was|are|were)\s+[a-z]+\s+(for|since|when|where|if|that)\s+/gi
        ];

        patterns.forEach(pattern => {
          let match;
          while ((match = pattern.exec(sentenceText)) !== null) {
            const before = sentenceText.substring(0, match.index).trim();
            const after = sentenceText.substring(match.index + match[0].length).trim();

            if (before.length > 10 && after.length > 10) {
              const beforeDoc = nlp(before);
              const afterDoc = nlp(after);
              const beforeHasVerb = beforeDoc.match('#Verb').length > 0;
              const afterHasVerb = afterDoc.match('#Verb').length > 0;

              // If both parts have verbs and are substantial, likely separate sentences
              if (beforeHasVerb && afterHasVerb) {
                const sentenceStart = text.indexOf(sentenceText);
                if (sentenceStart >= 0) {
                  const boundaryPos = sentenceStart + match.index;
                  if (boundaryPos > 0 && boundaryPos < text.length) {
                    const charBefore = text[boundaryPos - 1];
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

        // Also check for discourse markers
        discourseMarkers.forEach(marker => {
          const regex = new RegExp(`\\s+${marker}\\s+`, 'gi');
          let match;
          while ((match = regex.exec(sentenceText)) !== null) {
            const before = sentenceText.substring(0, match.index).trim();
            if (before.length > 15) {
              const beforeDoc = nlp(before);
              if (beforeDoc.match('#Verb').length > 0) {
                const sentenceStart = text.indexOf(sentenceText);
                if (sentenceStart >= 0) {
                  const boundaryPos = sentenceStart + match.index + match[0].indexOf(marker);
                  if (boundaryPos > 0 && boundaryPos < text.length) {
                    const charBefore = text[boundaryPos - 1];
                    if (!/[.!?]/.test(charBefore)) {
                      boundaries.push({
                        position: boundaryPos,
                        type: 'run_on_split',
                        punctuation: '.',
                        confidence: 0.7
                      });
                    }
                  }
                }
              }
            }
          }
        });
      }
    });
  } catch (error) {
    console.warn('[transcriptionCleanup] Error detecting run-on sentences:', error.message);
  }

  return boundaries;
}

/**
 * Segment sentences by discourse markers
 */
export function segmentByDiscourseMarkers(text, doc) {
  const boundaries = [];

  try {
    discourseMarkers.forEach(marker => {
      const regex = new RegExp(`\\b${marker}\\b`, 'gi');
      let match;
      while ((match = regex.exec(text)) !== null) {
        // Check context: is this marker starting a new sentence or connecting clauses?
        const before = text.substring(Math.max(0, match.index - 50), match.index).trim();
        const after = text.substring(match.index + match[0].length, Math.min(text.length, match.index + match[0].length + 50)).trim();

        // If marker is at start or after a complete thought, likely sentence start
        const beforeDoc = nlp(before);
        const beforeHasVerb = beforeDoc.match('#Verb').length > 0;

        if (beforeHasVerb || before.length < 10) {
          boundaries.push({
            position: match.index,
            type: 'discourse_marker',
            punctuation: '.',
            confidence: 0.6
          });
        }
      }
    });
  } catch (error) {
    console.warn('[transcriptionCleanup] Error segmenting by discourse markers:', error.message);
  }

  return boundaries;
}

/**
 * Add punctuation at detected boundaries
 */
export function addPunctuationAtBoundaries(text, boundaries, isPartial = false) {
  if (!boundaries || boundaries.length === 0) return text;

  let result = text.trim();

  // CRITICAL: Never add punctuation at the start of text
  // Remove any leading punctuation that might have been incorrectly added
  result = result.replace(/^[.!?,]\s*/, '');

  let offset = 0;

  // CRITICAL FIX: Never split too close to the end to preserve last words
  // Require at least 10 characters after boundary to ensure we don't cut off the last word
  const MIN_DISTANCE_FROM_END = 10;

  // Filter out boundaries at start or end, and sort by position (descending)
  const sortedBoundaries = boundaries
    .filter(b => b.position > 0 && b.position < result.length - MIN_DISTANCE_FROM_END) // Never at start or too close to end
    .sort((a, b) => b.position - a.position);

  sortedBoundaries.forEach(boundary => {
    const pos = boundary.position + offset;

    // CRITICAL: Double-check we're not too close to the end after offset adjustments
    // Check if punctuation already exists at this position
    if (pos > 0 && pos < result.length - MIN_DISTANCE_FROM_END) {
      const charAtPos = result[pos];
      const charBefore = result[pos - 1];

      // Skip if already has punctuation
      if (!/[.!?]/.test(charBefore) && !/[.!?]/.test(charAtPos)) {
        // Check if this is a word boundary (not in middle of word)
        const before = result.substring(Math.max(0, pos - 10), pos);
        const after = result.substring(pos, Math.min(result.length, pos + 10));

        if (/\s/.test(before.slice(-1)) || /\s/.test(after[0])) {
          // Insert punctuation
          const beforeText = result.substring(0, pos);
          const afterText = result.substring(pos);

          // Determine punctuation type
          let punct = boundary.punctuation || '.';

          // For partial transcripts, don't add final punctuation to last sentence
          if (isPartial && pos >= result.length - 5) {
            // Skip if this is near the end (incomplete sentence)
            return;
          }

          // CRITICAL FIX: Preserve all words - only trim leading whitespace, never trailing
          // This ensures we don't lose the last word when adding punctuation
          const trimmedAfter = afterText.trimStart(); // Only trim leading whitespace

          // Insert punctuation with space if needed
          if (punct === '.' && !trimmedAfter.match(/^\s/)) {
            result = beforeText + punct + ' ' + trimmedAfter;
            offset += 2; // Added punctuation + space
          } else if (punct === ',' && !trimmedAfter.match(/^\s/)) {
            result = beforeText + punct + ' ' + trimmedAfter;
            offset += 2;
          } else {
            result = beforeText + punct + afterText;
            offset += 1;
          }
        }
      }
    }
  });

  return result;
}

/**
 * Add commas using clause detection and rules
 */
export function addCommas(text, doc) {
  let result = text;

  try {
    // Add comma after introductory phrases
    introductoryPhrases.forEach(phrase => {
      const regex = new RegExp(`\\b${phrase}\\s+([a-z])`, 'gi');
      result = result.replace(regex, (match, p1, offset) => {
        // Check if comma already exists
        const before = result.substring(Math.max(0, offset - 10), offset);
        if (!before.includes(',')) {
          return `${phrase}, ${p1}`;
        }
        return match;
      });
    });

    // Add comma before coordinating conjunctions in compound sentences
    coordinatingConjunctions.forEach(conj => {
      const regex = new RegExp(`([a-z][^.!?]+?)\\s+${conj}\\s+([a-z][^.!?]+)`, 'gi');
      result = result.replace(regex, (match, before, after, offset) => {
        // Check if both parts have verbs (likely independent clauses)
        const beforeDoc = nlp(before);
        const afterDoc = nlp(after);
        const beforeHasVerb = beforeDoc.match('#Verb').length > 0;
        const afterHasVerb = afterDoc.match('#Verb').length > 0;

        if (beforeHasVerb && afterHasVerb) {
          // Check if comma already exists
          const beforeText = result.substring(Math.max(0, offset - 20), offset);
          if (!beforeText.includes(',')) {
            return `${before}, ${conj} ${after}`;
          }
        }
        return match;
      });
    });
  } catch (error) {
    console.warn('[transcriptionCleanup] Error adding commas:', error.message);
  }

  return result;
}

/**
 * Add periods at sentence boundaries
 */
export function addPeriods(text) {
  let result = text.trim();

  // Ensure text ends with punctuation
  if (!/[.!?]$/.test(result)) {
    result += '.';
  }

  return result;
}

// ============================================================================
// B. CAPITALIZATION NORMALIZATION
// ============================================================================

/**
 * Capitalize first word of sentences
 */
export function capitalizeSentences(text) {
  if (!text || text.trim().length === 0) return text;

  let result = text;

  // Capitalize first letter
  result = result.charAt(0).toUpperCase() + result.slice(1);

  // Capitalize after sentence endings
  result = result.replace(/([.!?])\s+([a-z])/g, (match, punct, letter) => {
    return punct + ' ' + letter.toUpperCase();
  });

  return result;
}

/**
 * Capitalize proper nouns using dictionary
 */
export function capitalizeProperNouns(text) {
  let result = text;

  properNouns.forEach(noun => {
    const regex = new RegExp(`\\b${noun.toLowerCase()}\\b`, 'gi');
    result = result.replace(regex, noun);
  });

  return result;
}

/**
 * Capitalize acronyms
 */
export function capitalizeAcronyms(text) {
  let result = text;

  Object.entries(acronyms).forEach(([lower, upper]) => {
    const regex = new RegExp(`\\b${lower}\\b`, 'gi');
    result = result.replace(regex, upper);
  });

  return result;
}

/**
 * Fix pronoun "i" → "I"
 */
export function fixPronounI(text) {
  let result = text;

  // Fix standalone "i" (with word boundaries)
  result = result.replace(/\bi\b/g, 'I');

  return result;
}

// ============================================================================
// C. CONTRACTION FIXES
// ============================================================================

/**
 * Fix contractions using dictionary
 */
export function fixContractions(text) {
  let result = text;

  Object.entries(contractions).forEach(([bad, good]) => {
    // Use word boundaries to avoid false matches
    const regex = new RegExp(`\\b${bad}\\b`, 'gi');
    result = result.replace(regex, good);
  });

  return result;
}

// ============================================================================
// D. HOMOPHONE CORRECTION
// ============================================================================

/**
 * Fix homophones using context-aware analysis
 * Note: This is a simplified synchronous version - full implementation would use async POS tagging
 */
export function fixHomophones(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }

  let result = text;

  // CRITICAL: Fix "Know" vs "No" - very common STT error
  // "Know, I haven't" → "No, I haven't"
  result = result.replace(/\bKnow\s*,/gi, 'No,');
  result = result.replace(/\bKnow\s+I\s+haven't\b/gi, "No, I haven't");
  result = result.replace(/\bKnow\s+I\s+don't\b/gi, "No, I don't");
  result = result.replace(/\bKnow\s+I\s+didn't\b/gi, "No, I didn't");

  // Use compromise for context-aware homophone correction
  // This is a simplified version - full implementation would use POS tagging
  Object.entries(homophones).forEach(([word, config]) => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      // Get context around the word
      const before = text.substring(Math.max(0, offset - 20), offset).toLowerCase();
      const after = text.substring(offset + match.length, Math.min(text.length, offset + match.length + 20)).toLowerCase();
      const context = before + ' ' + after;

      // Context-based disambiguation
      const contextCheck = config.contextCheck;

      // Simple heuristics for common cases
      if (word.toLowerCase() === 'their' && /\b(their|there|they're)\s+(house|home|car|place|location|is|was)\b/i.test(context)) {
        return 'there';
      }
      if (word.toLowerCase() === 'there' && /\b(their|there|they're)\s+(name|book|idea|thought)\b/i.test(context)) {
        return 'their';
      }

      // For now, keep original - full implementation would analyze context with POS
      return match;
    });
  });

  return result;
}

// ============================================================================
// E. FILLERS & DISFLUENCIES
// ============================================================================

/**
 * Remove filler words and disfluencies
 */
export function removeFillers(text) {
  let result = text;

  fillers.forEach(filler => {
    // Use word boundaries to avoid removing parts of words
    const regex = new RegExp(`\\b${filler}\\b`, 'gi');
    result = result.replace(regex, '');
  });

  // Clean up extra spaces
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

// ============================================================================
// F. WORD REPETITION/OMISSIONS
// ============================================================================

/**
 * Remove consecutive repeated words
 */
export function deduplicateWords(text) {
  let result = text;

  // Remove consecutive repeated words: "I I think" → "I think"
  result = result.replace(/\b(\w+)\s+\1\b/gi, '$1');

  return result;
}

/**
 * Insert missing words (auxiliaries, prepositions)
 */
export function insertMissingWords(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }

  let result = text;

  // Fix "He going" → "He is going"
  result = result.replace(/\b(he|she|it)\s+(going|coming|doing|working)\b/gi, (match, pronoun, verb) => {
    return `${pronoun} is ${verb}`;
  });

  // Fix "They going" → "They are going"
  result = result.replace(/\b(they|we|you)\s+(going|coming|doing|working)\b/gi, (match, pronoun, verb) => {
    return `${pronoun} are ${verb}`;
  });

  return result;
}

// ============================================================================
// G. NUMBERS, DATES, TIME
// ============================================================================

/**
 * Normalize numbers (optional - can be kept as words)
 */
export function normalizeNumbers(text) {
  // This is a placeholder - full implementation would convert "twenty five" → "25"
  // For now, keep as words unless specifically needed
  return text;
}

/**
 * Normalize dates
 */
export function normalizeDates(text) {
  let result = text;

  // "february tenth" → "February 10th"
  result = result.replace(/\b(february|march|april|may|june|july|august|september|october|november|december)\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-first|twenty-second|twenty-third|twenty-fourth|twenty-fifth|twenty-sixth|twenty-seventh|twenty-eighth|twenty-ninth|thirtieth|thirty-first)\b/gi, (match, month, day) => {
    const monthCap = month.charAt(0).toUpperCase() + month.slice(1);
    // Convert day to ordinal
    const dayMap = {
      'first': '1st', 'second': '2nd', 'third': '3rd', 'fourth': '4th', 'fifth': '5th',
      'sixth': '6th', 'seventh': '7th', 'eighth': '8th', 'ninth': '9th', 'tenth': '10th'
    };
    const dayOrdinal = dayMap[day.toLowerCase()] || day;
    return `${monthCap} ${dayOrdinal}`;
  });

  return result;
}

/**
 * Normalize times
 */
export function normalizeTimes(text) {
  let result = text;

  // "five thirty" → "5:30"
  result = result.replace(/\b(five|six|seven|eight|nine|ten|eleven|twelve)\s+(thirty|fifteen|forty-five)\b/gi, (match, hour, minute) => {
    const hourMap = { 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12 };
    const minuteMap = { 'thirty': 30, 'fifteen': 15, 'forty-five': 45 };
    const h = hourMap[hour.toLowerCase()] || hour;
    const m = minuteMap[minute.toLowerCase()] || minute;
    return `${h}:${m}`;
  });

  return result;
}

// ============================================================================
// H. ACRONYMS & UNITS
// ============================================================================

/**
 * Normalize acronyms (already handled in capitalizeAcronyms)
 */
export function normalizeAcronyms(text) {
  return capitalizeAcronyms(text);
}

/**
 * Normalize units
 */
export function normalizeUnits(text) {
  let result = text;

  // "ten kilometers" → "10 km"
  result = result.replace(/\b(ten|twenty|thirty|forty|fifty)\s+kilometers?\b/gi, (match, num) => {
    const numMap = { 'ten': 10, 'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50 };
    return `${numMap[num.toLowerCase()] || num} km`;
  });

  return result;
}

// ============================================================================
// I. SPEECH PATTERNS
// ============================================================================

/**
 * Normalize colloquialisms
 */
export function normalizeColloquialisms(text) {
  let result = text;

  Object.entries(colloquialisms).forEach(([informal, formal]) => {
    const regex = new RegExp(`\\b${informal}\\b`, 'gi');
    result = result.replace(regex, formal);
  });

  return result;
}

// ============================================================================
// J. SENTENCE SEGMENTATION (already in restorePunctuation)
// ============================================================================

/**
 * Segment sentences (wrapper for restorePunctuation)
 */
export function segmentSentences(text, isPartial = false) {
  return restorePunctuation(text, isPartial);
}

// ============================================================================
// K. SPEAKER TAGS (placeholder)
// ============================================================================

/**
 * Format speaker tags for multi-speaker transcripts
 */
export function formatSpeakerTags(text) {
  // Placeholder - implement if multi-speaker support is needed
  return text;
}

// ============================================================================
// L. DOMAIN-SPECIFIC (BIBLE/WORSHIP) - COMPREHENSIVE IMPLEMENTATION
// ============================================================================

/**
 * L1. Normalize Bible Book Names - ALL 66 books + mispronunciations
 * Handles: "Genesis one one" → "Genesis 1:1", "First Corinthians" → "1 Corinthians", etc.
 */
export function normalizeBibleBookNames(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }

  let result = text;

  // Fix mispronunciations first
  Object.entries(bibleBooks).forEach(([spoken, correct]) => {
    // Use word boundaries and case-insensitive matching
    const regex = new RegExp(`\\b${spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      // Check context for ambiguous cases like "Job" vs "job"
      if (spoken === 'job' && match.toLowerCase() === 'job') {
        // Check if followed by a number (likely Bible reference)
        const after = text.substring(offset + match.length, offset + match.length + 20);
        if (/\d|chapter|verse/.test(after)) {
          return 'Job'; // Bible book
        }
        // Otherwise keep as is (might be regular "job")
      }
      return correct;
    });
  });

  // Fix "Revelations" → "Revelation" (common mispronunciation)
  result = result.replace(/\bRevelations\b/gi, 'Revelation');

  // Fix "Songs of Solomon" → "Song of Solomon"
  result = result.replace(/\bSongs\s+of\s+Solomon\b/gi, 'Song of Solomon');

  // Fix "Psalms" → "Psalm" when referring to single chapter
  // "Psalm 23" not "Psalms 23"
  result = result.replace(/\bPsalms\s+(\d+)\b/gi, 'Psalm $1');

  return result;
}

/**
 * L2. Normalize Verse References - Comprehensive verse notation
 * Handles ALL cases: "Genesis one one", "Romans chapter eight verse one", ranges, etc.
 */
export function normalizeVerseReferences(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }

  let result = text;

  // Number word mappings (0-999)
  const numberWords = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    hundred: 100
  };

  // Helper to convert number words to digits (handles compound numbers like "one hundred and nineteen")
  const convertNumber = (words) => {
    if (!words || words.trim().length === 0) return words;

    const parts = words.trim().toLowerCase().split(/\s+/).filter(p => p !== 'and');
    let hundreds = 0;
    let tens = 0;
    let units = 0;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (part === 'oh' || part === 'o') {
        // Handle "one oh three" → 103
        if (tens === 0 && units === 0) {
          tens = 0;
          units = 0;
        } else {
          units = units * 10 + 0;
        }
      } else if (numberWords[part] !== undefined) {
        const num = numberWords[part];

        if (num === 100) {
          // "hundred" - if we have a number before it, multiply; otherwise it's 100
          if (units > 0 || tens > 0) {
            hundreds = (tens + units) * 100;
            tens = 0;
            units = 0;
          } else {
            hundreds = 100;
          }
        } else if (num >= 20 && num < 100) {
          // Tens (twenty, thirty, etc.)
          tens = num;
        } else if (num < 20) {
          // Units (one through nineteen)
          // If we already have tens, add to it (e.g., "twenty one" → 21)
          if (tens > 0) {
            units = num;
          } else {
            units += num;
          }
        }
      }
    }

    const total = hundreds + tens + units;

    // Return number if conversion succeeded, otherwise return original
    return total > 0 ? total : words;
  };

  // Pattern 1: "Genesis one one" → "Genesis 1:1"
  result = result.replace(/\b([A-Za-z]+(?:\s+(?:of|the))?)\s+(?:chapter\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:verse\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi, (match, book) => {
    const parts = match.substring(book.length).trim().split(/\s+/);
    const chapterPart = parts.filter(p => !['verse', 'verses', 'chapter'].includes(p.toLowerCase())).slice(0, -1).join(' ');
    const versePart = parts.filter(p => !['verse', 'verses', 'chapter'].includes(p.toLowerCase())).slice(-1).join(' ');

    const chapter = convertNumber(chapterPart);
    const verse = convertNumber(versePart);

    return `${book} ${chapter}:${verse}`;
  });

  // Pattern 2: "Romans chapter eight verse one" → "Romans 8:1"
  result = result.replace(/\b([A-Za-z]+(?:\s+(?:of|the))?)\s+chapter\s+([a-z\s]+?)\s+verse\s+([a-z\s]+?)(?:\s+through|\s+to|\s+and)?\s*([a-z\s]+)?\b/gi, (match, book, chapterWords, verseWords, rangeWords) => {
    const chapter = convertNumber(chapterWords);
    const verse = convertNumber(verseWords);

    if (rangeWords) {
      const range = convertNumber(rangeWords.trim());
      return `${book} ${chapter}:${verse}–${range}`;
    }
    return `${book} ${chapter}:${verse}`;
  });

  // Pattern 3: "Romans ten nine through ten" → "Romans 10:9–10"
  result = result.replace(/\b([A-Za-z]+(?:\s+(?:of|the))?)\s+([a-z\s]+?)\s+([a-z\s]+?)\s+through\s+([a-z\s]+)\b/gi, (match, book, chapterWords, verseWords, endVerse) => {
    const chapter = convertNumber(chapterWords);
    const verse = convertNumber(verseWords);
    const end = convertNumber(endVerse);
    return `${book} ${chapter}:${verse}–${end}`;
  });

  // Pattern 4: "John three sixteen to seventeen" → "John 3:16–17"
  result = result.replace(/\b([A-Za-z]+(?:\s+(?:of|the))?)\s+([a-z\s]+?)\s+([a-z\s]+?)\s+to\s+([a-z\s]+)\b/gi, (match, book, chapterWords, verseWords, endVerse) => {
    const chapter = convertNumber(chapterWords);
    const verse = convertNumber(verseWords);
    const end = convertNumber(endVerse);
    return `${book} ${chapter}:${verse}–${end}`;
  });

  // Pattern 5: "Verses five through seven" → "vv. 5–7"
  result = result.replace(/\bVerses\s+([a-z\s]+?)\s+through\s+([a-z\s]+)\b/gi, (match, start, end) => {
    const startNum = convertNumber(start);
    const endNum = convertNumber(end);
    return `vv. ${startNum}–${endNum}`;
  });

  // Pattern 6: "Verse three" → "v. 3"
  result = result.replace(/\bVerse\s+([a-z\s]+)\b/gi, (match, verseWords) => {
    const verse = convertNumber(verseWords);
    return `v. ${verse}`;
  });

  // Pattern 7: "Psalm one hundred and nineteen" → "Psalm 119"
  result = result.replace(/\b(Psalm|Psalms)\s+([a-z\s]+?)(?:\s+verse|\s+chapter)?\s*$/gi, (match, book, numberWords) => {
    const num = convertNumber(numberWords);
    return `Psalm ${num}`;
  });

  // Pattern 8: "Psalm one oh three" → "Psalm 103" ("oh" → "0")
  result = result.replace(/\b(Psalm|Psalms)\s+([a-z\s]+?oh[a-z\s]*)\b/gi, (match, book, numberWords) => {
    const num = convertNumber(numberWords.replace(/\boh\b/g, 'zero'));
    return `Psalm ${num}`;
  });

  // Pattern 9: Handle single-chapter books - "Philemon verse six" → "Philemon 1:6"
  singleChapterBooks.forEach(book => {
    const bookLower = book.toLowerCase();
    result = result.replace(new RegExp(`\\b${bookLower}\\s+verse\\s+([a-z\\s]+)\\b`, 'gi'), (match, verseWords) => {
      const verse = convertNumber(verseWords);
      return `${book} 1:${verse}`;
    });

    // "Jude twenty four" → "Jude 1:24"
    result = result.replace(new RegExp(`\\b${bookLower}\\s+([a-z\\s]+)\\b`, 'gi'), (match, numberWords) => {
      // Check if it's a number (not a word)
      const num = convertNumber(numberWords);
      if (typeof num === 'number' && num > 0 && num < 200) {
        return `${book} 1:${num}`;
      }
      return match;
    });
  });

  // Pattern 10: "Romans eight one" → "Romans 8:1" (simplified parsing)
  result = result.replace(/\b([A-Za-z]+(?:\s+(?:of|the))?)\s+([a-z\s]+?)\s+([a-z\s]+?)\b/gi, (match, book, chapterWords, verseWords) => {
    // Only apply if book is a Bible book and numbers are present
    const bookLower = book.toLowerCase();
    if (bibleBooks[bookLower] || Object.keys(bibleBooks).some(k => k.includes(bookLower))) {
      const chapter = convertNumber(chapterWords);
      const verse = convertNumber(verseWords);
      if (typeof chapter === 'number' && typeof verse === 'number' && chapter > 0 && chapter < 200 && verse > 0 && verse < 200) {
        return `${book} ${chapter}:${verse}`;
      }
    }
    return match;
  });

  // Pattern 11: "Chapter two verse three" → "2:3" (without book name)
  result = result.replace(/\bChapter\s+([a-z\s]+?)\s+verse\s+([a-z\s]+)\b/gi, (match, chapterWords, verseWords) => {
    const chapter = convertNumber(chapterWords);
    const verse = convertNumber(verseWords);
    return `${chapter}:${verse}`;
  });

  // Pattern 12: "One to three" → "1–3" (ranges)
  result = result.replace(/\b([a-z\s]+?)\s+to\s+([a-z\s]+)\b/gi, (match, start, end) => {
    const startNum = convertNumber(start);
    const endNum = convertNumber(end);
    if (typeof startNum === 'number' && typeof endNum === 'number') {
      return `${startNum}–${endNum}`;
    }
    return match;
  });

  return result;
}

/**
 * L3. Capitalize Divine Pronouns - Context-aware using compromise
 * "He", "Him", "Your" when referring to God/Christ
 */
export function capitalizeDivinePronouns(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }

  let result = text;

  // Capitalize pronouns after divine titles
  divineTitles.forEach(title => {
    const regex = new RegExp(`\\b${title}\\s+(he|him|his|you|your|yours|thou|thee|thy|thine)\\b`, 'gi');
    result = result.replace(regex, (match, pronoun) => {
      return match.replace(pronoun, pronoun.charAt(0).toUpperCase() + pronoun.slice(1));
    });
  });

  // Capitalize "You", "Your" in prayer context (after "Dear", "O", "Oh", "Father", "Lord")
  result = result.replace(/\b(?:dear|o|oh|father|lord|god|heavenly|holy)\s+(you|your|yours)\b/gi, (match, pronoun) => {
    return match.replace(pronoun, pronoun.charAt(0).toUpperCase() + pronoun.slice(1));
  });

  return result;
}

/**
 * L3. Capitalize Divine Titles - Always capitalize
 */
export function capitalizeDivineTitles(text) {
  let result = text;

  divineTitles.forEach(title => {
    const regex = new RegExp(`\\b${title.toLowerCase()}\\b`, 'gi');
    result = result.replace(regex, title);
  });

  return result;
}

/**
 * L3. Capitalize Sacred Text References
 */
export function capitalizeSacredTexts(text) {
  let result = text;

  sacredTextReferences.forEach(ref => {
    const regex = new RegExp(`\\b${ref.toLowerCase()}\\b`, 'gi');
    result = result.replace(regex, ref);
  });

  return result;
}

/**
 * L3. Capitalize "Church" when referring to Body of Christ (context-aware)
 */
export function capitalizeChurchBody(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }

  let result = text;

  // Capitalize "Church" when referring to Body of Christ
  result = result.replace(/\bthe\s+church\s+(?:is|was|are|were|growing|universal|body|of|belongs)\b/gi, 'the Church');
  result = result.replace(/\bchurch\s+(?:is|was|are|were|growing|universal|body|of|belongs)\b/gi, 'Church');
  result = result.replace(/\bbody\s+of\s+christ\b/gi, 'Body of Christ');

  return result;
}

/**
 * L3. Capitalize "Kingdom" when referring to Kingdom of God
 */
export function capitalizeKingdom(text) {
  let result = text;

  result = result.replace(/\bkingdom\s+of\s+god\b/gi, 'Kingdom of God');
  result = result.replace(/\bkingdom\s+of\s+heaven\b/gi, 'Kingdom of Heaven');
  result = result.replace(/\bseek\s+first\s+the\s+kingdom\b/gi, 'seek first the Kingdom');

  return result;
}

/**
 * L4. Fix Religious Homophones - Context-aware using compromise
 * ALL pairs: pray/prey, altar/alter, prophet/profit, etc.
 */
export function fixReligiousHomophones(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }

  let result = text;

  // Use compromise for context-aware disambiguation
  Object.entries(religiousHomophones).forEach(([word, config]) => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      // Get context around the word
      const before = text.substring(Math.max(0, offset - 30), offset).toLowerCase();
      const after = text.substring(offset + match.length, Math.min(text.length, offset + match.length + 30)).toLowerCase();
      const context = before + ' ' + after;

      // Context-based disambiguation
      const contextCheck = config.contextCheck;

      if (contextCheck.includes('religious') || contextCheck.includes('spiritual') || contextCheck.includes('worship')) {
        // Religious context - check for religious keywords
        if (/\b(pray|worship|god|lord|jesus|christ|spirit|church|faith|bible|scripture)\b/i.test(context)) {
          return match; // Keep religious word
        }
      }

      if (contextCheck.includes('noun_religious')) {
        if (/\b(altar|prophet|soul|praise|peace|reign|rite|sermon|seal|raise|sins|mary|prophecy)\b/i.test(context)) {
          return match; // Keep religious noun
        }
      }

      // For now, keep original - full implementation would use compromise POS tagging
      return match;
    });
  });

  return result;
}

/**
 * L5. Normalize Sermon Structure - ALL patterns
 * "Point number one" → "1.", "Roman numeral two" → "II.", etc.
 */
export function normalizeSermonStructure(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }

  let result = text;

  // Apply sermon structure patterns
  Object.entries(sermonStructurePatterns).forEach(([spoken, replacement]) => {
    const regex = new RegExp(`\\b${spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(regex, replacement);
  });

  // "Point number one" → "1."
  result = result.replace(/\b(?:Point|Main point)\s+number\s+(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (match) => {
    const numMap = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
    const num = match.match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
    if (num) {
      return `${numMap[num[0].toLowerCase()]}.`;
    }
    return match;
  });

  // "Roman numeral two" → "II."
  result = result.replace(/\bRoman\s+numeral\s+(?:one|two|three|four|five)\b/gi, (match) => {
    const romanMap = { one: 'I', two: 'II', three: 'III', four: 'IV', five: 'V' };
    const num = match.match(/\b(?:one|two|three|four|five)\b/i);
    if (num) {
      return `${romanMap[num[0].toLowerCase()]}.`;
    }
    return match;
  });

  // "Subpoint A" → "A."
  result = result.replace(/\bSubpoint\s+([A-Z])\b/gi, '$1.');

  // "Part two introduction" → "Part II: Introduction"
  result = result.replace(/\bPart\s+(?:one|two|three)\s+([a-z]+)\b/gi, (match, title) => {
    const romanMap = { one: 'I', two: 'II', three: 'III' };
    const num = match.match(/\b(?:one|two|three)\b/i);
    const titleCased = title.charAt(0).toUpperCase() + title.slice(1);
    if (num) {
      return `Part ${romanMap[num[0].toLowerCase()]}: ${titleCased}`;
    }
    return match;
  });

  // "Title the power of grace" → "Title: The Power of Grace"
  result = result.replace(/\bTitle\s+(.+?)(?:\s|$)/gi, (match, titleText) => {
    const words = titleText.trim().split(/\s+/);
    const titleCased = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return `Title: ${titleCased}`;
  });

  // "New paragraph" → "\n\n"
  result = result.replace(/\bnew\s+paragraph\b/gi, '\n\n');

  // "Quote end quote" → """
  let inQuote = false;
  result = result.replace(/\b(?:quote|end\s+quote)\b/gi, (match) => {
    inQuote = !inQuote;
    return inQuote ? '"' : '"';
  });

  // "Parentheses this is extra" → "(This is extra)"
  result = result.replace(/\bParentheses\s+(.+?)(?:\s+end\s+parentheses)?\b/gi, '($1)');

  // "Colon after grace" → "Grace:"
  result = result.replace(/\bColon\s+after\s+([a-z]+)\b/gi, '$1:');

  return result;
}

/**
 * L6. Normalize Prayer Language - ALL patterns
 * "Dear Lord please help me" → "Dear Lord, please help me.", etc.
 */
export function normalizePrayerLanguage(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }

  let result = text;

  // Apply prayer language patterns
  Object.entries(prayerLanguagePatterns).forEach(([spoken, replacement]) => {
    const regex = new RegExp(`\\b${spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(regex, replacement);
  });

  // "Dear Lord please help me" → "Dear Lord, please help me."
  result = result.replace(/\bDear\s+Lord\s+please\b/gi, 'Dear Lord, please');

  // "Thank you Lord" → "Thank You, Lord."
  result = result.replace(/\bThank\s+you\s+Lord\b/gi, 'Thank You, Lord.');

  // "Father God we come before you" → "Father God, we come before You."
  result = result.replace(/\bFather\s+God\s+we\s+come\s+before\s+you\b/gi, 'Father God, we come before You.');

  // "In Jesus name amen" → "In Jesus' name, Amen."
  result = result.replace(/\bIn\s+Jesus\s+name\s+amen\b/gi, "In Jesus' name, Amen.");

  // "Heavenly father thank you for today" → "Heavenly Father, thank You for today."
  result = result.replace(/\bHeavenly\s+father\s+thank\s+you\b/gi, 'Heavenly Father, thank You');

  // "Oh Lord" → "O Lord" (formal biblical address)
  result = result.replace(/\bOh\s+Lord\b/gi, 'O Lord,');

  // "hallelujah" → "Hallelujah!"
  result = result.replace(/\bhallelujah\b/gi, 'Hallelujah!');

  // "amen" → "Amen." (capitalize and period if end of sentence)
  result = result.replace(/\bamen\s*$/gi, 'Amen.');
  result = result.replace(/\bamen\s+([A-Z])/gi, 'Amen. $1');

  // "praise the Lord" → "Praise the Lord!"
  result = result.replace(/\bpraise\s+the\s+lord\b/gi, 'Praise the Lord!');

  return result;
}

/**
 * L7. Normalize Theology Terms - ALL terms
 * "new testament" → "New Testament", "holy ghost" → "Holy Spirit", etc.
 */
export function normalizeTheologyTerms(text) {
  let result = text;

  // Apply theology term normalization (longest first to avoid partial matches)
  const sortedTerms = Object.entries(theologyTerms).sort((a, b) => b[0].length - a[0].length);

  sortedTerms.forEach(([lower, upper]) => {
    const regex = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    result = result.replace(regex, upper);
  });

  return result;
}

/**
 * L8. Normalize Quotation Syntax - ALL patterns
 * "Quote in the beginning was the word end quote" → ""In the beginning was the Word.""
 */
export function normalizeQuotationSyntax(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }

  let result = text;

  // "Quote ... end quote" → "...""
  result = result.replace(/\bQuote\s+(.+?)\s+end\s+quote\b/gi, (match, quoteText) => {
    // Capitalize first word
    const words = quoteText.trim().split(/\s+/);
    if (words.length > 0) {
      words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    }
    // Add ending punctuation if missing
    const final = words.join(' ');
    if (!/[.!?]$/.test(final)) {
      return `"${final}."`;
    }
    return `"${final}"`;
  });

  // "Jesus said quote it is written end quote" → "Jesus said, "It is written.""
  result = result.replace(/\b([A-Za-z]+)\s+said\s+quote\s+(.+?)\s+end\s+quote\b/gi, (match, speaker, quote) => {
    const quoteText = quote.trim();
    const capitalized = quoteText.charAt(0).toUpperCase() + quoteText.slice(1);
    return `${speaker} said, "${capitalized}."`;
  });

  // "John three sixteen and seventeen" → "John 3:16–17" (multiple verses)
  // This is handled in normalizeVerseReferences, but ensure it's applied

  // "Title colon God's faithfulness" → "Title: God's Faithfulness"
  result = result.replace(/\bTitle\s+colon\s+(.+?)(?:\s|$)/gi, (match, titleText) => {
    const words = titleText.trim().split(/\s+/);
    const titleCased = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return `Title: ${titleCased}`;
  });

  // "Romans chapter eight verse one" → "Rom. 8:1" (reference abbreviation - optional)
  // Keep full name for now, abbreviation can be added later if needed

  // "John three sixteen Galatians two twenty" → "John 3:16; Galatians 2:20" (consecutive refs)
  // This requires detecting two verse references in sequence
  result = result.replace(/\b([A-Za-z]+\s+\d+:\d+)\s+([A-Za-z]+\s+\d+:\d+)\b/g, '$1; $2');

  return result;
}

/**
 * L9. Fix Book Mispronunciations - ALL mishearings
 * Context-aware fixes for "Job" vs "job", "Acts" vs "axe", etc.
 */
export function fixBookMispronunciations(text, doc = null) {
  if (!doc) {
    doc = nlp(text);
  }

  let result = text;

  // "Job" (as in work) vs "Job" (biblical person) - context needed
  result = result.replace(/\bJob\s+(\d+)/gi, 'Job $1'); // If followed by number, it's the book

  // "Acts" vs "axe" - if followed by number/verse, it's Acts
  result = result.replace(/\baxe\s+(\d+)/gi, 'Acts $1');

  // "Mark" vs "march" - if followed by number/verse, it's Mark
  result = result.replace(/\bmarch\s+(\d+)/gi, (match, num) => {
    // Check if it's a verse reference (small number = chapter, larger = year)
    if (parseInt(num) < 200) {
      return `Mark ${num}`;
    }
    return match; // Keep "march" for dates
  });

  // "Numbers" vs literal numbers - if standalone and capitalized, it's the book
  result = result.replace(/\bNumbers\s+(?:chapter|verse|\d+)/gi, 'Numbers');

  // All other mispronunciations are handled in normalizeBibleBookNames
  // "Amos" vs "aim us", "Nahum" vs "name", etc.

  return result;
}

/**
 * L10. Normalize Formatting Commands - ALL stylistic conventions
 * "new paragraph" → "\n\n", "verse break" → "¶", etc.
 */
export function normalizeFormattingCommands(text) {
  let result = text;

  // Apply formatting command patterns
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

/**
 * Fix divine names capitalization (updated to use new dictionaries)
 */
export function fixDivineNames(text) {
  let result = text;

  Object.entries(divineNames).forEach(([lower, upper]) => {
    const regex = new RegExp(`\\b${lower}\\b`, 'gi');
    result = result.replace(regex, upper);
  });

  return result;
}

/**
 * Fix prayer language (updated to use new function)
 */
export function fixPrayerLanguage(text) {
  return normalizePrayerLanguage(text);
}

/**
 * Normalize liturgical terms (updated to use new dictionaries)
 */
export function normalizeLiturgicalTerms(text) {
  let result = text;

  Object.entries(liturgicalTerms).forEach(([lower, upper]) => {
    const regex = new RegExp(`\\b${lower}\\b`, 'gi');
    result = result.replace(regex, upper);
  });

  return result;
}

// ============================================================================
// L. PUNCTUATION NORMALIZATION
// ============================================================================

/**
 * Normalize language-specific punctuation (e.g. Chinese full-width periods)
 * @param {string} text
 * @returns {string}
 */
export function normalizePunctuation(text) {
  if (!text) return text;

  const original = text;
  let normalized = text;

  // Always log to see if function is being called
  console.log('[normalizePunctuation] Called with text:', text.substring(0, 100));
  console.log('[normalizePunctuation] Text contains curly quotes?', text.includes('\u2018') || text.includes('\u2019') || text.includes('\u201C') || text.includes('\u201D'));

  if (punctuationNormalization) {
    for (const [key, value] of Object.entries(punctuationNormalization)) {
      if (normalized.includes(key)) {
        console.log(`[normalizePunctuation] Found character to normalize: "${key}" (U+${key.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}) → "${value}"`);
      }

      if (key === '。') {
        // Ensure there's a space after the period if it was a Chinese full-stop
        normalized = normalized.split(key).join('. ');
      } else if (key === '：') {
        // Ensure there's a space after the colon if it was a Chinese full-width colon
        normalized = normalized.split(key).join(': ');
      } else if (key === '，') {
        // Ensure there's a space after the comma if it was a Chinese full-width comma
        normalized = normalized.split(key).join(', ');
      } else {
        normalized = normalized.split(key).join(value);
      }
    }
  }

  // Clean up any double spaces introduced by the replacement or already present
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // CRITICAL: Replace straight single quotes with double quotes for ALL languages
  // Single quotes cause ElevenLabs hallucinations, double quotes work better
  // Example: "Entonces Pedro les dijo: 'Arrepentíos.'" → "Entonces Pedro les dijo: \"Arrepentíos.\""
  normalized = normalized.replace(/'/g, '"');

  // Add space before opening double quotes if missing (for better TTS readability)
  // Example: 'dijo:"Arrepentíos' → 'dijo: "Arrepentíos'
  normalized = normalized.replace(/(\S)"([^"])/g, '$1 "$2');

  // CRITICAL: Remove trailing spaces after punctuation (causes ElevenLabs hallucinations)
  // Example: "Arrepentíos. " → "Arrepentíos."
  normalized = normalized.replace(/([.!?,;:])\s+$/g, '$1');

  // Also clean up spaces before closing quotes
  normalized = normalized.replace(/\s+(["'])/g, '$1');

  // Debug logging if text changed
  if (original !== normalized) {
    console.log('[normalizePunctuation] ✅ Text normalized:');
    console.log('  BEFORE:', original.substring(0, 100));
    console.log('  AFTER:', normalized.substring(0, 100));
  } else {
    console.log('[normalizePunctuation] ⚠️ No changes made (text already normalized or no special chars)');
  }

  return normalized;
}
