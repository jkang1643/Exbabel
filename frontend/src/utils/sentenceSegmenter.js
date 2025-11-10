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
    this.onFlush = options.onFlush || (() => {});  // Callback when sentences move to history
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
      
      const catchUpFlushed = candidateFlush.filter(sentence => {
        return !this.flushedText.includes(sentence.trim());
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
      
      // DEDUPLICATE: Only flush sentences NOT already in flushedText
      flushedSentences = candidateFlush.filter(sentence => {
        return !this.flushedText.includes(sentence.trim());
      });
      
      if (flushedSentences.length > 0) {
        // Track what we flushed to prevent duplicates
        this.flushedText += ' ' + flushedSentences.join(' ');
        this.flushedText = this.flushedText.trim();
        
        console.log(`[Segmenter] 📦 AUTO-FLUSH: ${flushedSentences.length} NEW sentence(s) → history`);
        console.log(`[Segmenter] 🎯 Flushed text length now: ${this.flushedText.length} chars`);
      } else {
        console.log(`[Segmenter] ⏭️ SKIP: All ${candidateFlush.length} sentences already flushed`);
        flushedSentences = []; // Clear to prevent onFlush trigger
      }
    }
    
    // RULE 2: If cumulative text exceeds maxChars, force flush complete sentences
    else if (cumulativeText.length > this.maxChars && allCompleteSentences.length > 0) {
      // DEDUPLICATE: Only flush NEW sentences
      flushedSentences = allCompleteSentences.filter(sentence => {
        return !this.flushedText.includes(sentence.trim());
      });
      
      if (flushedSentences.length > 0) {
        this.flushedText += ' ' + flushedSentences.join(' ');
        this.flushedText = this.flushedText.trim();
        
        console.log(`[Segmenter] 📦 CHAR-FLUSH: ${flushedSentences.length} NEW sentence(s) → history (exceeded ${this.maxChars} chars)`);
      }
    }
    
    // RULE 3: If too much time has passed, flush all complete sentences
    else if (now - this.lastUpdateTime > this.maxTimeMs && allCompleteSentences.length > 0) {
      // DEDUPLICATE: Only flush NEW sentences
      flushedSentences = allCompleteSentences.filter(sentence => {
        return !this.flushedText.includes(sentence.trim());
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
  processFinal(finalText) {
    let textToFlush = finalText;
    
    console.log(`[Segmenter] 📝 Processing final: "${finalText.substring(0, 50)}..." (flushedText length: ${this.flushedText?.length || 0})`);
    
    // Deduplicate: If we already flushed part of this text, only flush the new part
    if (this.flushedText && finalText.includes(this.flushedText)) {
      textToFlush = finalText.replace(this.flushedText, '').trim();
      console.log(`[Segmenter] ✅ FINAL: Deduplicating (${this.flushedText.length} chars already flushed)`);
    }
    
    // Also check for substring overlaps (Google Speech can send overlapping finals)
    if (this.flushedText && !finalText.includes(this.flushedText) && textToFlush === finalText) {
      // Check if finalText overlaps with end of flushedText
      const overlap = this.findOverlap(this.flushedText, finalText);
      if (overlap > 0) {
        textToFlush = finalText.substring(overlap).trim();
        console.log(`[Segmenter] ✂️ FINAL: Found ${overlap} char overlap, keeping delta: "${textToFlush.substring(0, 40)}..."`);
      }
    }
    
    // If textToFlush is empty after deduplication, check if finalText is substantially different
    // If so, use the full finalText to ensure history appears
    if (!textToFlush || textToFlush.length < 10) {
      if (finalText.length > 10 && (!this.flushedText || !this.flushedText.includes(finalText))) {
        console.log(`[Segmenter] ⚠️ After dedup, text too short (${textToFlush?.length || 0} chars). Using full finalText as fallback.`);
        textToFlush = finalText;
      }
    }
    
    const sentences = this.detectSentences(textToFlush);
    
    // Filter out sentences we've already seen
    const newSentences = sentences.filter(s => {
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
    
    // Reset live text but KEEP flushedText for deduplication
    this.liveText = '';
    this.cumulativeText = ''; // Reset cumulative for next utterance
    this.lastUpdateTime = Date.now();
    
    console.log(`[Segmenter] ✅ FINAL: Moving ${newSentences.length} NEW sentence(s) to history (total flushed: ${this.flushedText.length} chars)`);
    
    return {
      liveText: '',
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

