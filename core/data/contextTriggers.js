/**
 * Contextual Trigger Phrases for Bible Reference Detection
 * 
 * Comprehensive list of spoken triggers/sermon lead-ins that indicate
 * a Bible verse is coming. Used to:
 * 1. Pre-filter AI calls (only call AI when triggers are found)
 * 2. Boost confidence scores when detected
 * 
 * All triggers are lowercase for case-insensitive matching.
 * Triggers are normalized (punctuation stripped, whitespace collapsed)
 * before matching.
 */

/**
 * Array of contextual trigger phrases
 * 
 * Categories:
 * - Explicit Scripture References
 * - Introduced by Book/Chapter/Verse
 * - Pastoral/Sermon Context
 * - Paraphrase/Theological Lead-ins
 * - Narrative/Sermon Flow Triggers
 * - Less Formal/Spoken Variants
 * - Partial/Mid-Sentence Indicators
 */
export const CONTEXT_TRIGGERS = [
  // Explicit Scripture References
  'the bible says',
  'the word of god says',
  'the scripture says',
  'it is written',
  'as it is written',
  'according to the bible',
  'according to scripture',
  'scripture says',
  'the holy scripture says',
  'the lord says in the bible',
  
  // Introduced by Book/Chapter/Verse
  'in acts chapter',
  'in romans',
  'in the book of',
  'in psalms',
  'the bible tells us in',
  'as it says in',
  'in genesis',
  'in matthew',
  'in mark',
  'in luke',
  'in john',
  
  // Pastoral/Sermon Context
  'the lord spoke to us saying',
  'the prophet says',
  'god tells us in his word',
  'the lord says',
  'the lord commands',
  'the lord declares',
  'god says',
  'jesus said in the scriptures',
  'as the lord says in his word',
  'jesus said',
  'the lord said',
  'god said',
  'peter said',
  'paul said',
  'moses said',
  
  // Paraphrase/Theological Lead-ins
  'the scripture teaches us',
  'the bible teaches',
  'this passage says',
  'this verse says',
  'the lord instructs',
  'god reminds us',
  'the word instructs us',
  'as we read in the word',
  
  // Narrative/Sermon Flow Triggers
  'let s read from the bible', // Apostrophe becomes space: "let's" → "let s"
  'lets read from the bible', // Alternative without apostrophe
  'let\'s read from the bible',
  'let us read from the bible',
  'according to the holy word',
  'as recorded in scripture',
  'as the word declares',
  'as the scriptures tell us',
  'as written in the word of god',
  'scripture reminds us',
  'gods word reminds us', // Apostrophe stripped in normalization
  'god\'s word reminds us',
  'gods word tells us', // Apostrophe stripped in normalization
  'god\'s word tells us',
  
  // Less Formal/Spoken Variants
  'in the word it says',
  'bible says',
  'god says in the bible',
  'as we read in scripture',
  'scripture says that',
  'the word says that',
  'as written in the bible',
  'the lord says in scripture',
  'it is found in the word',
  'it is found in the bible',
  
  // Partial/Mid-Sentence Indicators
  'as it says',
  'as the word says',
  'it says in scripture',
  'it says in the bible',
  'this passage reminds us',
  'the verse reminds us',
  'the lord said',
  'jesus said',
  'god said',
  'peter said',
  'paul said',
  'moses said',
  
  // Base Word Triggers (match in any context)
  // These catch variations and paraphrases that include these key words
  // Core quotation verbs
  'says',           // Matches: "the bible says", "god says", "scripture says", etc.
  'said',           // Matches: "peter said", "jesus said", "the lord said", etc.
  'quote',          // Matches: "quote", "as the quote says", "let me quote", etc.
  'quoted',         // Matches: "as quoted", "he quoted", "scripture quoted", etc.
  'written',        // Matches: "it is written", "as written", "what is written", etc.
  
  // Teaching / explanation
  'teaches',        // Matches: "scripture teaches", "the bible teaches", etc.
  'shows',          // Matches: "god shows", "the word shows", etc.
  'reveals',        // Matches: "god reveals", "scripture reveals", etc.
  'explains',       // Matches: "the bible explains", "jesus explains", etc.
  'reminds',        // Matches: "god reminds", "scripture reminds", etc.
  'warns',          // Matches: "the lord warns", "scripture warns", etc.
  'promises',       // Matches: "god promises", "the bible promises", etc.
  'commands',       // Matches: "the lord commands", "god commands", etc.
  
  // Reading / referencing
  'read',           // Matches: "let us read", "as we read", etc.
  'reads',          // Matches: "the bible reads", "scripture reads", etc.
  'reading',        // Matches: "when reading", "in reading", etc.
  'found',          // Matches: "it is found", "as found", etc.
  'find',           // Matches: "we find", "you find", etc.
  'finds',          // Matches: "scripture finds", "the word finds", etc.
  
  // Indirect lead-ins
  'according',      // Matches: "according to", "according as", etc.
  'stated',         // Matches: "as stated", "it is stated", etc.
  'recorded',       // Matches: "as recorded", "it is recorded", etc.
  
  // Context anchors (used as boosters)
  'scripture',      // Matches: "scripture", "in scripture", etc.
  'bible',          // Matches: "bible", "the bible", etc.
  'word',           // Matches: "word", "the word", "gods word", etc.
  'passage',        // Matches: "passage", "this passage", etc.
  'verse',          // Matches: "verse", "this verse", etc.
  'chapter'         // Matches: "chapter", "in chapter", etc.
];

/**
 * Get the number of trigger phrases
 * @returns {number} Total number of triggers
 */
export function getTriggerCount() {
  return CONTEXT_TRIGGERS.length;
}

/**
 * Get triggers by category (for documentation/debugging)
 * @returns {Object} Triggers grouped by category
 */
export function getTriggersByCategory() {
  return {
    'Explicit Scripture References': CONTEXT_TRIGGERS.slice(0, 10),
    'Introduced by Book/Chapter/Verse': CONTEXT_TRIGGERS.slice(10, 20),
    'Pastoral/Sermon Context': CONTEXT_TRIGGERS.slice(20, 35),
    'Paraphrase/Theological Lead-ins': CONTEXT_TRIGGERS.slice(35, 43),
    'Narrative/Sermon Flow Triggers': CONTEXT_TRIGGERS.slice(43, 55),
    'Less Formal/Spoken Variants': CONTEXT_TRIGGERS.slice(55, 65),
    'Partial/Mid-Sentence Indicators': CONTEXT_TRIGGERS.slice(65, 75),
    'Base Word Triggers': CONTEXT_TRIGGERS.slice(75)
  };
}

export default CONTEXT_TRIGGERS;

