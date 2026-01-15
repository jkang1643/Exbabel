/**
 * Bible Verse Fingerprints Service
 * 
 * Loads and manages precomputed verse keyword fingerprints
 * for semantic matching of Bible references.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load fingerprints from JSON file
let verseFingerprintsData = {};
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const dataPath = join(__dirname, '../data/verseFingerprints.json');
  const fileContent = readFileSync(dataPath, 'utf-8');
  verseFingerprintsData = JSON.parse(fileContent);
} catch (error) {
  console.warn('[BibleVerseFingerprints] Failed to load fingerprints:', error.message);
  verseFingerprintsData = {};
}

/**
 * Verse Fingerprints Manager
 */
export class BibleVerseFingerprints {
  constructor() {
    this.fingerprints = new Map();
    this.keywordIndex = new Map(); // keyword → [verse refs]
    
    this.loadFingerprints();
    this.buildKeywordIndex();
  }
  
  /**
   * Load fingerprints from JSON data
   */
  loadFingerprints() {
    for (const [ref, data] of Object.entries(verseFingerprintsData)) {
      this.fingerprints.set(ref, {
        ref: data.ref,
        keywords: data.keywords || [],
        weights: data.weights || {}
      });
    }
  }
  
  /**
   * Build inverted index: keyword → verse references
   */
  buildKeywordIndex() {
    for (const [ref, data] of this.fingerprints.entries()) {
      for (const keyword of data.keywords) {
        if (!this.keywordIndex.has(keyword)) {
          this.keywordIndex.set(keyword, []);
        }
        this.keywordIndex.get(keyword).push(ref);
      }
    }
  }
  
  /**
   * Get fingerprint for a verse reference
   * 
   * @param {string} ref - Verse reference (e.g., "Acts 2:38")
   * @returns {Object|null} Fingerprint data or null
   */
  getFingerprint(ref) {
    return this.fingerprints.get(ref) || null;
  }
  
  /**
   * Get all verse references that contain a keyword
   * 
   * @param {string} keyword - Keyword to search
   * @returns {Array<string>} Array of verse references
   */
  getVersesByKeyword(keyword) {
    return this.keywordIndex.get(keyword) || [];
  }
  
  /**
   * Match tokens against keyword index and return scored verses
   * 
   * @param {Array<string>} tokens - Normalized tokens from transcript
   * @returns {Map<string, Object>} Map of verse ref → { hits, weightedScore }
   */
  matchKeywords(tokens) {
    const verseScores = new Map();
    
    // Check each token against keyword index
    for (const token of tokens) {
      const verses = this.getVersesByKeyword(token);
      for (const ref of verses) {
        const fingerprint = this.getFingerprint(ref);
        if (!fingerprint) continue;
        
        const weight = fingerprint.weights[token] || 0.5;
        
        if (!verseScores.has(ref)) {
          verseScores.set(ref, {
            hits: 0,
            weightedScore: 0,
            matchedKeywords: []
          });
        }
        
        const score = verseScores.get(ref);
        score.hits++;
        score.weightedScore += weight;
        score.matchedKeywords.push(token);
      }
    }
    
    // Also check for multi-word phrases (e.g., "holy spirit")
    for (let i = 0; i < tokens.length - 1; i++) {
      const phrase = `${tokens[i]} ${tokens[i + 1]}`;
      const verses = this.getVersesByKeyword(phrase);
      for (const ref of verses) {
        const fingerprint = this.getFingerprint(ref);
        if (!fingerprint) continue;
        
        const weight = fingerprint.weights[phrase] || 0.5;
        
        if (!verseScores.has(ref)) {
          verseScores.set(ref, {
            hits: 0,
            weightedScore: 0,
            matchedKeywords: []
          });
        }
        
        const score = verseScores.get(ref);
        score.hits++;
        score.weightedScore += weight;
        score.matchedKeywords.push(phrase);
      }
    }
    
    return verseScores;
  }
  
  /**
   * Get all available verse references
   * 
   * @returns {Array<string>} Array of verse references
   */
  getAllReferences() {
    return Array.from(this.fingerprints.keys());
  }
}

// Singleton instance
let instance = null;

/**
 * Get singleton instance
 * 
 * @returns {BibleVerseFingerprints} Singleton instance
 */
export function getFingerprintsInstance() {
  if (!instance) {
    instance = new BibleVerseFingerprints();
  }
  return instance;
}

export default {
  BibleVerseFingerprints,
  getFingerprintsInstance
};

