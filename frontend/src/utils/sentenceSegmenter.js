/**
 * Smart Sentence Segmenter
 * 
 * Monitors streaming text, detects sentence boundaries, and manages live display
 * to prevent text from growing indefinitely while keeping the UX smooth.
 */

export class SentenceSegmenter {
  constructor(options = {}) {
    this.maxSentences = options.maxSentences || 10;  // Max sentences in live view (increased from 3 to handle longer text)
    this.maxChars = options.maxChars || 2000;        // Force flush after this many chars (increased from 500 to handle longer text)
    this.maxTimeMs = options.maxTimeMs || 15000;    // Force flush after 15 seconds

    // State
    this.liveText = '';           // Current accumulated text
    this.flushedText = '';        // Text that has already been flushed (to prevent duplicates)
    this.cumulativeText = '';     // Full cumulative text from OpenAI (for overlap detection)
    this.lastUpdateTime = Date.now();
    this.lastPartialTime = Date.now();  // Track when last partial was processed (to prevent premature flushing)
    this.onFlush = options.onFlush || (() => { });  // Callback when sentences move to history
  }

  /**
   * Find overlap between the end of old text and the start of new text
   * This handles OpenAI's cumulative transcription
   */
  findOverlap(oldText, newText) {
    if (!oldText || !newText) return 0;

    const minLen = Math.min(oldText.length, newText.length);

    // Try progressively smaller suffixes of oldText against prefixes of newText
    for (let i = minLen; i > 20; i--) { // Min 20 chars overlap to avoid false matches
      const oldSuffix = oldText.slice(-i);
      if (newText.startsWith(oldSuffix)) {
        return i;
      }
    }

    return 0;
  }

  /**
   * Detect sentence boundaries in text
   * Returns array of sentences (including incomplete last sentence)
   */
  detectSentences(text) {
    if (!text) return [];

    // Regex to split on sentence endings (., !, ?, …) followed by space or end
    // Preserve the punctuation with the sentence
    const sentenceRegex = /[^.!?…]+[.!?…]+[\s]*/g;
    const matches = text.match(sentenceRegex) || [];

    // Check if text ends with incomplete sentence
    const lastMatch = matches[matches.length - 1];
    const hasIncompleteSentence = lastMatch ? !text.endsWith(lastMatch.trim()) : text.length > 0;

    if (hasIncompleteSentence) {
      // Extract the incomplete part
      const completeText = matches.join('');
      const incompletePart = text.substring(completeText.length);
      if (incompletePart.trim()) {
        matches.push(incompletePart);
      }
    }

    return matches.map(s => s.trim()).filter(s => s.length > 0);
  }

  /**
   * Check if a sentence is complete (ends with punctuation)
   */
  isComplete(sentence) {
    if (!sentence) return false;
    const trimmed = sentence.trim();
    return /[.!?…]$/.test(trimmed);
  }

  /**
   * Process incoming partial text (cumulative from OpenAI)
   * Returns: { liveText, flushedSentences }
   */
  processPartial(cumulativeText) {
    const now = Date.now();

    // Update last partial time
    this.lastPartialTime = now;

    // Step 1: Detect if this is a new turn (text got shorter = VAD pause)
    if (this.cumulativeText && cumulativeText.length < this.cumulativeText.length * 0.5) {
      console.log(`[Segmenter] 🔄 New turn detected (text reset from ${this.cumulativeText.length} → ${cumulativeText.length})`);
      this.cumulativeText = '';
      this.flushedText = '';
    }

    // Step 2: Find overlap between previous cumulative and new cumulative
    const overlap = this.findOverlap(this.cumulativeText, cumulativeText);

    // Step 3: Extract only the NEW delta (text after overlap)
    const delta = overlap > 0 ? cumulativeText.slice(overlap).trim() : cumulativeText;

    if (overlap > 0) {
      console.log(`[Segmenter] ✂️ Overlap detected: ${overlap} chars, delta: "${delta.substring(0, 40)}..."`);
    }

    // Update cumulative tracker
    this.cumulativeText = cumulativeText;

    // Step 4: Check CUMULATIVE text for sentence count BEFORE stripping
    // This is critical - we need to detect 3+ sentences in the full cumulative stream
    const allSentences = this.detectSentences(cumulativeText);
    const allCompleteSentences = allSentences.filter(s => this.isComplete(s));

    // Step 4.5: In catch-up mode with reduced thresholds, be more aggressive about flushing
    // If we have a lot of text and many sentences, flush more aggressively
    // This happens after updating cumulativeText so we have the latest data
    const isCatchUpMode = this.maxSentences <= 5 || this.maxChars <= 1000;
    if (isCatchUpMode && allCompleteSentences.length >= 2 && cumulativeText.length > 500) {
      // In catch-up mode, flush after just 2 sentences instead of waiting for maxSentences
      const numToFlush = Math.max(1, allCompleteSentences.length - 1); // Keep only the latest sentence
      const candidateFlush = allCompleteSentences.slice(0, numToFlush);

      // CRITICAL FIX: Don't flush very short sentences (< 25 chars) that are likely fragments
      const MIN_SENTENCE_LENGTH = 25;

      const catchUpFlushed = candidateFlush.filter((sentence, index) => {
        const trimmed = sentence.trim();
        const alreadyFlushed = this.flushedText.includes(trimmed);
        const isShort = trimmed.length < MIN_SENTENCE_LENGTH;
        const isMostRecent = index === candidateFlush.length - 1;

        // Don't flush very short recent sentences (likely fragments)
        if (isShort && isMostRecent) {
          console.log(`[Segmenter] ⏸️ SKIP SHORT FRAGMENT (CATCH-UP): "${trimmed}" (${trimmed.length} chars) - likely part of larger sentence`);
          return false;
        }

        return !alreadyFlushed;
      });

      if (catchUpFlushed.length > 0) {
        this.flushedText += ' ' + catchUpFlushed.join(' ');
        this.flushedText = this.flushedText.trim();
        console.log(`[Segmenter] 🚀 CATCH-UP FLUSH: ${catchUpFlushed.length} sentence(s) → history (catch-up mode)`);
        this.onFlush(catchUpFlushed);
        this.lastUpdateTime = now;
      }
    }

    const incompleteSentence = allSentences.find(s => !this.isComplete(s)) || '';

    // DEBUG: Log sentence count
    console.log(`[Segmenter] 📊 CUMULATIVE has ${allCompleteSentences.length} complete sentences (max: ${this.maxSentences})`);
    if (allCompleteSentences.length > 0) {
      console.log(`[Segmenter] 📝 Sentences: ${allCompleteSentences.map(s => s.substring(0, 30) + '...').join(' | ')}`);
    }

    let flushedSentences = [];

    // RULE 1: If CUMULATIVE has >= maxSentences complete sentences, flush oldest ones
    // This simulates a "pause" - send to history and clear live view
    if (allCompleteSentences.length >= this.maxSentences) {
      // Flush the first N sentences (where N = total - max + 1)
      // Example: 5 sentences, max 3 → flush first 3, keep last 2
      const numToFlush = allCompleteSentences.length - this.maxSentences + 1;
      const candidateFlush = allCompleteSentences.slice(0, numToFlush);

      // CRITICAL FIX: Don't flush very short sentences (< 25 chars) that end with periods
      // These are likely fragments that are part of larger sentences (e.g., "Our own self." → "Our own self-centered...")
      // Only flush them if they're part of multiple longer sentences or if they're not the most recent sentence
      const MIN_SENTENCE_LENGTH = 25; // Minimum length to consider a sentence "complete" for auto-flushing
      const isRecentShortSentence = (sentence, index) => {
        const isShort = sentence.trim().length < MIN_SENTENCE_LENGTH;
        const isMostRecent = index === candidateFlush.length - 1;
        return isShort && isMostRecent;
      };

      // CRITICAL: Don't auto-flush if partial was updated very recently (< 3 seconds)
      // This prevents flushing partials that might be extended by a final
      const timeSinceLastPartial = now - this.lastPartialTime;
      const RECENT_PARTIAL_WINDOW_MS = 3000; // 3 seconds - finals typically arrive within this window
      const isVeryRecentPartial = timeSinceLastPartial < RECENT_PARTIAL_WINDOW_MS;

      // DEDUPLICATE: Only flush sentences NOT already in flushedText
      // AND filter out very short recent sentences that are likely fragments
      // AND skip auto-flushing if partial was updated very recently (might be extended by final)
      flushedSentences = candidateFlush.filter((sentence, index) => {
        const trimmed = sentence.trim();
        const alreadyFlushed = this.flushedText.includes(trimmed);
        const isShortFragment = isRecentShortSentence(sentence, index);
        const isMostRecentSentence = index === candidateFlush.length - 1;

        // Don't flush the most recent sentence if partial was updated very recently
        if (isVeryRecentPartial && isMostRecentSentence) {
          console.log(`[Segmenter] ⏸️ SKIP RECENT PARTIAL: "${trimmed.substring(0, 50)}..." (${timeSinceLastPartial}ms ago) - might be extended by final`);
          return false;
        }

        if (isShortFragment) {
          console.log(`[Segmenter] ⏸️ SKIP SHORT FRAGMENT: "${trimmed}" (${trimmed.length} chars) - likely part of larger sentence`);
          return false;
        }

        return !alreadyFlushed;
      });

      if (flushedSentences.length > 0) {
        // Track what we flushed to prevent duplicates
        this.flushedText += ' ' + flushedSentences.join(' ');
        this.flushedText = this.flushedText.trim();

        console.log(`[Segmenter] 📦 AUTO-FLUSH: ${flushedSentences.length} NEW sentence(s) → history`);
        console.log(`[Segmenter] 🎯 Flushed text length now: ${this.flushedText.length} chars`);
      } else {
        console.log(`[Segmenter] ⏭️ SKIP: All ${candidateFlush.length} sentences already flushed or filtered`);
        flushedSentences = []; // Clear to prevent onFlush trigger
      }
    }

    // RULE 2: If cumulative text exceeds maxChars, force flush complete sentences
    else if (cumulativeText.length > this.maxChars && allCompleteSentences.length > 0) {
      // CRITICAL FIX: Don't flush very short sentences (< 25 chars) that are likely fragments
      const MIN_SENTENCE_LENGTH = 25;

      // CRITICAL: Don't auto-flush if partial was updated very recently (< 3 seconds)
      const timeSinceLastPartial = now - this.lastPartialTime;
      const RECENT_PARTIAL_WINDOW_MS = 3000;
      const isVeryRecentPartial = timeSinceLastPartial < RECENT_PARTIAL_WINDOW_MS;

      // DEDUPLICATE: Only flush NEW sentences that are not short fragments
      flushedSentences = allCompleteSentences.filter((sentence, index) => {
        const trimmed = sentence.trim();
        const alreadyFlushed = this.flushedText.includes(trimmed);
        const isShort = trimmed.length < MIN_SENTENCE_LENGTH;
        const isMostRecent = index === allCompleteSentences.length - 1;

        // Don't flush the most recent sentence if partial was updated very recently
        if (isVeryRecentPartial && isMostRecent) {
          console.log(`[Segmenter] ⏸️ SKIP RECENT PARTIAL (CHAR-FLUSH): "${trimmed.substring(0, 50)}..." (${timeSinceLastPartial}ms ago) - might be extended by final`);
          return false;
        }

        // Don't flush very short recent sentences (likely fragments)
        if (isShort && isMostRecent) {
          console.log(`[Segmenter] ⏸️ SKIP SHORT FRAGMENT (CHAR-FLUSH): "${trimmed}" (${trimmed.length} chars) - likely part of larger sentence`);
          return false;
        }

        return !alreadyFlushed;
      });

      if (flushedSentences.length > 0) {
        this.flushedText += ' ' + flushedSentences.join(' ');
        this.flushedText = this.flushedText.trim();

        console.log(`[Segmenter] 📦 CHAR-FLUSH: ${flushedSentences.length} NEW sentence(s) → history (exceeded ${this.maxChars} chars)`);
      }
    }

    // RULE 3: If too much time has passed, flush all complete sentences
    else if (now - this.lastUpdateTime > this.maxTimeMs && allCompleteSentences.length > 0) {
      // CRITICAL FIX: Don't flush very short sentences (< 25 chars) that are likely fragments
      const MIN_SENTENCE_LENGTH = 25;

      // CRITICAL: Don't auto-flush if partial was updated very recently (< 3 seconds)
      const timeSinceLastPartial = now - this.lastPartialTime;
      const RECENT_PARTIAL_WINDOW_MS = 3000;
      const isVeryRecentPartial = timeSinceLastPartial < RECENT_PARTIAL_WINDOW_MS;

      // DEDUPLICATE: Only flush NEW sentences that are not short fragments
      flushedSentences = allCompleteSentences.filter((sentence, index) => {
        const trimmed = sentence.trim();
        const alreadyFlushed = this.flushedText.includes(trimmed);
        const isShort = trimmed.length < MIN_SENTENCE_LENGTH;
        const isMostRecent = index === allCompleteSentences.length - 1;

        // Don't flush the most recent sentence if partial was updated very recently
        if (isVeryRecentPartial && isMostRecent) {
          console.log(`[Segmenter] ⏸️ SKIP RECENT PARTIAL (TIME-FLUSH): "${trimmed.substring(0, 50)}..." (${timeSinceLastPartial}ms ago) - might be extended by final`);
          return false;
        }

        // Don't flush very short recent sentences (likely fragments)
        if (isShort && isMostRecent) {
          console.log(`[Segmenter] ⏸️ SKIP SHORT FRAGMENT (TIME-FLUSH): "${trimmed}" (${trimmed.length} chars) - likely part of larger sentence`);
          return false;
        }

        return !alreadyFlushed;
      });

      if (flushedSentences.length > 0) {
        this.flushedText += ' ' + flushedSentences.join(' ');
        this.flushedText = this.flushedText.trim();

        console.log(`[Segmenter] 📦 TIME-FLUSH: ${flushedSentences.length} NEW sentence(s) → history (exceeded ${this.maxTimeMs}ms)`);
        this.lastUpdateTime = now;
      }
    }

    // Trigger flush callback if we have sentences to flush
    if (flushedSentences.length > 0) {
      this.onFlush(flushedSentences);
      this.lastUpdateTime = now;
    }

    // Step 5: NOW strip flushed content from cumulative to show live display
    if (this.flushedText) {
      if (cumulativeText.includes(this.flushedText)) {
        const flushedIndex = cumulativeText.lastIndexOf(this.flushedText);
        const afterFlushed = cumulativeText.substring(flushedIndex + this.flushedText.length).trim();
        this.liveText = afterFlushed;
        console.log(`[Segmenter] 📍 Live display stripped to: "${afterFlushed.substring(0, 50)}..." (${afterFlushed.length} chars)`);
      } else {
        this.liveText = cumulativeText;
      }
    } else {
      this.liveText = cumulativeText;
    }

    return {
      liveText: this.liveText,
      flushedSentences
    };
  }

  /**
   * Process final text (when speaker pauses)
   * Moves ONLY NEW text to history (deduplicates already-flushed content)
   */
  processFinal(finalText, options = {}) {
    const isForced = options.isForced === true;
    let textToFlush = finalText;

    console.log(`[Segmenter] 📝 Processing final: "${finalText.substring(0, 50)}..." (flushedText length: ${this.flushedText?.length || 0})`);

    // CRITICAL FIX: Don't commit very short fragments (< 25 chars) unless forced OR they're complete sentences
    // These are likely fragments that are part of larger sentences (e.g., "Our own self." → "Our own self-centered...")
    // BUT: Allow short complete sentences like "Oh my!" or "Yes." that end with punctuation
    const MIN_SENTENCE_LENGTH = 25;
    const finalTextTrimmed = finalText.trim();
    const isCompleteSentence = this.isComplete(finalTextTrimmed);
    const isShort = finalTextTrimmed.length < MIN_SENTENCE_LENGTH;

    if (!isForced && isShort && !isCompleteSentence) {
      console.log(`[Segmenter] ⏸️ SKIP SHORT FRAGMENT FINAL: "${finalTextTrimmed}" (${finalTextTrimmed.length} chars) - likely part of larger sentence`);
      // Don't commit, but also don't reset state - keep it for potential extension
      return {
        liveText: this.liveText,
        flushedSentences: []
      };
    }

    if (!isForced && isShort && isCompleteSentence) {
      console.log(`[Segmenter] ✅ Accepting short complete sentence: "${finalTextTrimmed}" (${finalTextTrimmed.length} chars)`);
    }

    if (!isForced) {
      const finalTextTrimmed = finalText.trim();

      // IMPROVED DEDUPLICATION: Check if final extends previously flushed text
      // This handles cases where a partial was auto-flushed and then a final extends it
      if (this.flushedText) {
        const flushedTrimmed = this.flushedText.trim();

        // Case 1: Final includes all of flushed text (simple case)
        if (finalTextTrimmed.includes(flushedTrimmed)) {
          textToFlush = finalTextTrimmed.replace(flushedTrimmed, '').trim();
          // If replacement resulted in empty or very short text, check if final just extends flushed
          if (!textToFlush || textToFlush.length < 10) {
            // Final might just be an extension - extract only the new part
            if (finalTextTrimmed.startsWith(flushedTrimmed)) {
              textToFlush = finalTextTrimmed.substring(flushedTrimmed.length).trim();
              console.log(`[Segmenter] ✅ FINAL: Extends flushed text, keeping only extension: "${textToFlush.substring(0, 40)}..."`);
            } else {
              // Final contains flushed but doesn't start with it - might be a different arrangement
              textToFlush = finalTextTrimmed;
            }
          } else {
            console.log(`[Segmenter] ✅ FINAL: Deduplicating (${flushedTrimmed.length} chars already flushed)`);
          }
        }
        // Case 2: Final starts with flushed text (extends it)
        else if (finalTextTrimmed.startsWith(flushedTrimmed)) {
          textToFlush = finalTextTrimmed.substring(flushedTrimmed.length).trim();
          console.log(`[Segmenter] ✅ FINAL: Extends flushed text, keeping only extension: "${textToFlush.substring(0, 40)}..."`);
        }
        // Case 3: Check for sentence-level overlap (final might extend a sentence from flushed text)
        else {
          // Split both into sentences and check if final extends any flushed sentences
          const flushedSentences = this.detectSentences(flushedTrimmed);
          const finalSentences = this.detectSentences(finalTextTrimmed);

          // Check if final starts with any complete sentence from flushed
          let foundOverlap = false;
          for (const flushedSentence of flushedSentences) {
            if (this.isComplete(flushedSentence) && finalTextTrimmed.startsWith(flushedSentence.trim())) {
              textToFlush = finalTextTrimmed.substring(flushedSentence.trim().length).trim();
              console.log(`[Segmenter] ✅ FINAL: Extends flushed sentence, keeping only extension: "${textToFlush.substring(0, 40)}..."`);
              foundOverlap = true;
              break;
            }
          }

          // If no sentence-level overlap found, check for character-level overlap
          if (!foundOverlap) {
            const overlap = this.findOverlap(flushedTrimmed, finalTextTrimmed);
            if (overlap > 0) {
              textToFlush = finalTextTrimmed.substring(overlap).trim();
              console.log(`[Segmenter] ✂️ FINAL: Found ${overlap} char overlap, keeping delta: "${textToFlush.substring(0, 40)}..."`);
            }
          }
        }
      }

      // If textToFlush is empty after deduplication, check if finalText is substantially different
      // If so, use the full finalText to ensure history appears
      // CRITICAL: Also allow short complete sentences (like "Oh my!" or "Yes.")
      if (!textToFlush || textToFlush.length < 10) {
        const finalTextTrimmed = finalText.trim();
        const isCompleteSentence = this.isComplete(finalTextTrimmed);
        const isShortComplete = finalTextTrimmed.length < 25 && isCompleteSentence;
        const isSubstantial = finalText.length > 10;

        if ((isSubstantial || isShortComplete) && (!this.flushedText || !this.flushedText.includes(finalText))) {
          if (isShortComplete) {
            console.log(`[Segmenter] ⚠️ After dedup, using short complete sentence as fallback: "${finalTextTrimmed}" (${finalTextTrimmed.length} chars)`);
          } else {
            console.log(`[Segmenter] ⚠️ After dedup, text too short (${textToFlush?.length || 0} chars). Using full finalText as fallback.`);
          }
          textToFlush = finalText;
        }
      }
    } else {
      // For forced finals, still attempt basic deduplication but be more lenient
      // This allows us to catch obvious duplicates while still preserving content
      textToFlush = finalText.trim();
      console.log('[Segmenter] ⚠️ Forced final detected - using lenient deduplication');
    }

    const sentences = this.detectSentences(textToFlush);

    let newSentences;
    if (isForced) {
      // For forced finals, use normalized comparison to catch punctuation differences
      // This is critical because forced finals may have slight punctuation variations
      const textToFlushTrimmed = textToFlush ? textToFlush.trim() : '';
      const textNormalized = textToFlushTrimmed.toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim();
      const flushedNormalized = this.flushedText ? this.flushedText.toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim() : '';

      // Helper function to normalize a sentence
      const normalizeSentence = (s) => s.trim().toLowerCase().replace(/[.,!?;:'"]/g, ' ').replace(/\s+/g, ' ').trim();

      // Check if the full text is already in flushedText (using normalized comparison)
      // For short sentences (< 25 chars), use exact normalized match
      // For longer sentences, use more lenient matching
      const isFullTextDuplicate = flushedNormalized && (
        flushedNormalized === textNormalized ||
        (textNormalized.length <= 25 && flushedNormalized.includes(textNormalized)) ||
        (textNormalized.length > 10 && (
          flushedNormalized.includes(textNormalized) ||
          textNormalized.includes(flushedNormalized) ||
          (textNormalized.length > 20 && flushedNormalized.length > 20 &&
            textNormalized.substring(0, Math.min(80, textNormalized.length)) ===
            flushedNormalized.substring(0, Math.min(80, flushedNormalized.length)))
        ))
      );

      if (isFullTextDuplicate) {
        console.log(`[Segmenter] ⏭️ SKIP DUPLICATE FORCED FINAL (normalized match): "${textToFlushTrimmed.substring(0, 50)}..." (already in flushedText)`);
        newSentences = [];
      } else {
        // Filter sentences using normalized comparison
        newSentences = sentences.filter(s => {
          const trimmed = s.trim();
          if (trimmed.length === 0) return false;

          // Check against flushedText using normalized comparison
          if (flushedNormalized) {
            const sentenceNormalized = normalizeSentence(trimmed);
            // Skip if this sentence (normalized) is already in flushedText
            // For short sentences, check exact match; for longer, use includes
            if ((sentenceNormalized.length <= 25 && flushedNormalized.includes(sentenceNormalized)) ||
              (sentenceNormalized.length > 10 && (
                flushedNormalized.includes(sentenceNormalized) ||
                sentenceNormalized.includes(flushedNormalized.substring(0, Math.min(100, flushedNormalized.length)))
              ))) {
              return false;
            }
          }
          return true;
        });

        // If no new sentences but we have substantial text, check if it's truly new
        // Also allow short complete sentences (like "Oh my!" or "Yes.")
        const isCompleteSentence = textToFlushTrimmed ? this.isComplete(textToFlushTrimmed) : false;
        const isShortComplete = textToFlushTrimmed.length < 25 && isCompleteSentence;
        const isSubstantial = textToFlushTrimmed.length > 10;

        if (newSentences.length === 0 && textToFlush && (isSubstantial || isShortComplete)) {
          // Double-check for duplicates before adding as fallback
          // (important for short sentences that might have been missed in earlier checks)
          const isDuplicate = flushedNormalized && (
            flushedNormalized === textNormalized ||
            (textNormalized.length <= 25 && flushedNormalized.includes(textNormalized)) ||
            (textNormalized.length > 10 && (
              flushedNormalized.includes(textNormalized) ||
              textNormalized.includes(flushedNormalized)
            ))
          );

          if (!isDuplicate) {
            newSentences = [textToFlush];
            if (isShortComplete) {
              console.log(`[Segmenter] ✅ Adding short complete sentence as forced final fallback: "${textToFlushTrimmed}"`);
            } else {
              console.log(`[Segmenter] ✅ Adding forced final as fallback (not in flushedText): "${textToFlushTrimmed.substring(0, 50)}..."`);
            }
          } else {
            console.log(`[Segmenter] ⏭️ SKIP DUPLICATE FORCED FINAL (fallback check): "${textToFlushTrimmed.substring(0, 50)}..." (already in flushedText)`);
          }
        }
      }

      // Update flushedText even for forced finals (so future similar ones can be deduplicated)
      if (newSentences.length > 0) {
        this.flushedText += ' ' + newSentences.join(' ');
        this.flushedText = this.flushedText.trim();
      }
    } else {
      // Filter out sentences we've already seen
      newSentences = sentences.filter(s => {
        const trimmed = s.trim();
        // Only include if not already in flushedText OR if flushedText is empty (first final)
        return trimmed.length > 0 && (!this.flushedText || !this.flushedText.includes(trimmed));
      });

      // Update flushedText with new content (DON'T reset it - Google sends multiple finals!)
      if (newSentences.length > 0) {
        this.flushedText += ' ' + newSentences.join(' ');
        this.flushedText = this.flushedText.trim();
      } else if (textToFlush && textToFlush.length > 10) {
        // FALLBACK: If no new sentences detected but we have substantial text, add it as a single sentence
        console.log(`[Segmenter] ⚠️ No sentences detected but text substantial (${textToFlush.length} chars). Adding as single entry.`);
        newSentences.push(textToFlush);
        this.flushedText += ' ' + textToFlush;
        this.flushedText = this.flushedText.trim();
      }
    }

    // FORCED FINAL: This is a TTS/stream boundary — speech continues immediately on the next stream.
    // Preserve cumulativeText (slide forward past committed text) and lastPartialTime so the next
    // arriving partial hits warm segmenter state and renders instantly, with no blank gap.
    // NATURAL FINAL: Full reset — speaker actually paused, next utterance starts fresh.
    if (isForced) {
      // Slide cumulativeText forward past what we just committed
      const committed = (textToFlush || '').trim();
      if (committed && this.cumulativeText) {
        const idx = this.cumulativeText.indexOf(committed.slice(0, 40));
        if (idx !== -1) {
          this.cumulativeText = this.cumulativeText.substring(idx + committed.length).trim();
        } else {
          // Committed text not found verbatim — clear it so we don't get phantom duplicates,
          // but keep lastPartialTime so the 3s guard stays warm.
          this.cumulativeText = '';
        }
      } else {
        this.cumulativeText = '';
      }
      // liveText follows cumulativeText on the next processPartial call — don't wipe it now.
      // Keep lastPartialTime as-is: we do NOT reset it, so the 3s recent-partial guard
      // doesn't block the first batch of new partials.
    } else {
      // Natural pause — full reset for the next utterance
      this.liveText = '';
      this.cumulativeText = '';
      this.lastPartialTime = 0; // Allow immediate flush on the next processPartial cycle
    }
    this.lastUpdateTime = Date.now();

    console.log(`[Segmenter] ✅ FINAL (isForced=${isForced}): Moving ${newSentences.length} NEW sentence(s) to history (total flushed: ${this.flushedText.length} chars)`);

    return {
      liveText: isForced ? this.liveText : '',
      flushedSentences: newSentences
    };
  }

  /**
   * Reset the segmenter
   */
  reset() {
    this.liveText = '';
    this.flushedText = '';
    this.cumulativeText = '';
    this.lastUpdateTime = Date.now();
  }

  /**
   * Soft reset - clear live state but keep deduplication memory
   * Use this between short pauses in the same conversation
   */
  softReset() {
    this.liveText = '';
    this.cumulativeText = '';
    this.lastUpdateTime = Date.now();
    // Keep flushedText for deduplication
  }

  /**
   * Hard reset - clear everything including deduplication memory
   * Use this when starting a completely new session
   */
  hardReset() {
    this.reset();
  }

  /**
   * Get current state
   */
  getState() {
    const sentences = this.detectSentences(this.liveText);
    return {
      liveText: this.liveText,
      sentenceCount: sentences.length,
      charCount: this.liveText.length,
      ageMs: Date.now() - this.lastUpdateTime
    };
  }
}

