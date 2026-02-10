/**
 * Cleanup Rules - Centralized dictionaries and rules for transcription cleanup
 * Contains all dictionaries for contractions, fillers, homophones, proper nouns, etc.
 */

// A. Contractions - Map of common STT mistakes to proper contractions
export const contractions = {
  dont: "don't",
  cant: "can't",
  wont: "won't",
  wouldnt: "wouldn't",
  shouldnt: "shouldn't",
  couldnt: "couldn't",
  isnt: "isn't",
  arent: "aren't",
  wasnt: "wasn't",
  werent: "weren't",
  hasnt: "hasn't",
  havent: "haven't",
  hadnt: "hadn't",
  doesnt: "doesn't",
  didnt: "didn't",
  im: "I'm",
  ive: "I've",
  ill: "I'll",
  idd: "I'd",
  youre: "you're",
  youve: "you've",
  youll: "you'll",
  youd: "you'd",
  were: "we're",
  weve: "we've",
  well: "we'll",
  wed: "we'd",
  theyre: "they're",
  theyve: "they've",
  theyll: "they'll",
  theyd: "they'd",
  thats: "that's",
  whats: "what's",
  whos: "who's",
  wheres: "where's",
  whens: "when's",
  hows: "how's",
  lets: "let's",
  its: "it's", // Note: careful with "its" vs "it's"
  hes: "he's",
  shes: "she's",
  theres: "there's",
  heres: "here's",
  aint: "ain't"
};

// B. Fillers and Disfluencies - Words/phrases to remove
export const fillers = [
  'uh',
  'um',
  'you know',
  'like',
  'i mean',
  'sort of',
  'kind of',
  'er',
  'ah',
  'hmm',
  'well', // Sometimes, but be careful
  'so', // Sometimes, but be careful
  'actually',
  'basically',
  'literally'
];

// C. Homophones - Common STT confusions (context-dependent)
export const homophones = {
  // their/there/they're
  their: { alternatives: ['there', "they're"], contextCheck: 'pronoun' },
  there: { alternatives: ['their', "they're"], contextCheck: 'location' },
  "they're": { alternatives: ['their', 'there'], contextCheck: 'contraction' },

  // to/too/two
  to: { alternatives: ['too', 'two'], contextCheck: 'preposition' },
  too: { alternatives: ['to', 'two'], contextCheck: 'adverb' },
  two: { alternatives: ['to', 'too'], contextCheck: 'number' },

  // your/you're
  your: { alternatives: ["you're"], contextCheck: 'possessive' },
  "you're": { alternatives: ['your'], contextCheck: 'contraction' },

  // its/it's
  its: { alternatives: ["it's"], contextCheck: 'possessive' },
  "it's": { alternatives: ['its'], contextCheck: 'contraction' },

  // peace/piece
  peace: { alternatives: ['piece'], contextCheck: 'noun' },
  piece: { alternatives: ['peace'], contextCheck: 'noun' },

  // by/buy/bye
  by: { alternatives: ['buy', 'bye'], contextCheck: 'preposition' },
  buy: { alternatives: ['by', 'bye'], contextCheck: 'verb' },
  bye: { alternatives: ['by', 'buy'], contextCheck: 'interjection' },

  // right/write/rite
  right: { alternatives: ['write', 'rite'], contextCheck: 'adjective' },
  write: { alternatives: ['right', 'rite'], contextCheck: 'verb' },
  rite: { alternatives: ['right', 'write'], contextCheck: 'noun' }
};

// D. Proper Nouns - Common names, places, organizations
export const properNouns = [
  // People
  'Jesus', 'Christ', 'God', 'Lord', 'Holy Spirit',
  'Paul', 'Peter', 'Mary', 'Moses', 'David', 'John', 'Matthew', 'Mark', 'Luke',

  // Places
  'United States', 'USA', 'UK', 'Europe', 'Asia', 'Africa', 'America',

  // Organizations
  'Google', 'Apple', 'Microsoft', 'Amazon', 'Facebook', 'Twitter', 'Instagram',
  'NASA', 'FBI', 'CIA',

  // Religious terms
  'Bible', 'Scripture', 'Gospel', 'Church', 'Amen', 'Hallelujah'
];

// E. Acronyms - Should be uppercase
export const acronyms = {
  'us': 'US',
  'usa': 'USA',
  'uk': 'UK',
  'nasa': 'NASA',
  'fbi': 'FBI',
  'cia': 'CIA',
  'ai': 'AI',
  'api': 'API',
  'http': 'HTTP',
  'https': 'HTTPS',
  'url': 'URL',
  'html': 'HTML',
  'css': 'CSS',
  'js': 'JS',
  'json': 'JSON',
  'xml': 'XML'
};

// F. Colloquialisms - Informal speech patterns
export const colloquialisms = {
  'gonna': 'going to',
  'wanna': 'want to',
  'gotta': 'have to',
  "ain't": "isn't", // or "aren't" depending on context
  'kinda': 'kind of',
  'sorta': 'sort of',
  'lemme': 'let me',
  'outta': 'out of',
  'gimme': 'give me',
  'dunno': "don't know",
  'whatcha': 'what are you',
  'howdy': 'how do you do'
};

// G. Divine Names - Religious terms requiring capitalization
export const divineNames = {
  'god': 'God',
  'jesus': 'Jesus',
  'christ': 'Christ',
  'lord': 'Lord',
  'holy spirit': 'Holy Spirit',
  'holy ghost': 'Holy Spirit',
  'father': 'Father', // When referring to God
  'son': 'Son', // When referring to Jesus
  'savior': 'Savior',
  'redeemer': 'Redeemer',
  'messiah': 'Messiah'
};

// H. Liturgical Terms - Religious terms that should be capitalized
export const liturgicalTerms = {
  'amen': 'Amen',
  'hallelujah': 'Hallelujah',
  'prayer': 'Prayer', // When referring to Lord's Prayer
  'bible': 'Bible',
  'scripture': 'Scripture',
  'gospel': 'Gospel',
  'church': 'Church' // When referring to Body of Christ
};

// I. Protected Words - Words that should NOT be corrected
// These are domain-specific terms, jargon, or words that might be incorrectly "corrected"
export const protectedWords = [
  // Technical terms
  'API', 'REST', 'GraphQL', 'JSON', 'XML', 'HTTP', 'HTTPS',

  // Domain-specific
  'Mephibosheth', 'Ziba', 'Habakkuk', 'Nahum',

  // Proper nouns that might be incorrectly changed
  'Exbabel'
];

// J. Discourse Markers - Words that often indicate sentence boundaries
export const discourseMarkers = [
  'and',
  'then',
  'so',
  'but',
  'however',
  'therefore',
  'because',
  'although',
  'though',
  'while',
  'whereas',
  'furthermore',
  'moreover',
  'nevertheless',
  'consequently',
  'thus',
  'hence'
];

// K. Coordinating Conjunctions - Often indicate sentence breaks
export const coordinatingConjunctions = [
  'and',
  'but',
  'or',
  'nor',
  'for',
  'so',
  'yet'
];

// L. Subordinating Conjunctions - May indicate clause boundaries
export const subordinatingConjunctions = [
  'because',
  'although',
  'though',
  'while',
  'when',
  'where',
  'if',
  'unless',
  'since',
  'until',
  'before',
  'after',
  'as',
  'that',
  'which',
  'who',
  'whose',
  'whom'
];

// M. Introductory Phrases - Often need commas after them
export const introductoryPhrases = [
  'all right',
  'well',
  'so',
  'now',
  'then',
  'first',
  'second',
  'finally',
  'however',
  'therefore',
  'furthermore',
  'moreover',
  'in addition',
  'for example',
  'for instance',
  'on the other hand',
  'as a result',
  'in conclusion'
];

// ============================================================================
// BIBLE / FAITH-SPECIFIC COMPREHENSIVE RULES
// ============================================================================

// N. All 66 Canonical Bible Books + Mispronunciations
export const bibleBooks = {
  // Old Testament
  'genesis': 'Genesis',
  'exodus': 'Exodus',
  'leviticus': 'Leviticus', 'levitate us': 'Leviticus',
  'numbers': 'Numbers',
  'deuteronomy': 'Deuteronomy', 'duty romney': 'Deuteronomy',
  'joshua': 'Joshua',
  'judges': 'Judges',
  'ruth': 'Ruth',
  '1 samuel': '1 Samuel', 'one samuel': '1 Samuel', 'first samuel': '1 Samuel',
  '2 samuel': '2 Samuel', 'two samuel': '2 Samuel', 'second samuel': '2 Samuel',
  '1 kings': '1 Kings', 'one kings': '1 Kings', 'first kings': '1 Kings',
  '2 kings': '2 Kings', 'two kings': '2 Kings', 'second kings': '2 Kings',
  '1 chronicles': '1 Chronicles', 'one chronicles': '1 Chronicles', 'first chronicles': '1 Chronicles',
  '2 chronicles': '2 Chronicles', 'two chronicles': '2 Chronicles', 'second chronicles': '2 Chronicles',
  'ezra': 'Ezra',
  'nehemiah': 'Nehemiah',
  'esther': 'Esther',
  'job': 'Job', // Context needed - distinguish from "job" (work)
  'psalms': 'Psalms', 'psalm': 'Psalm',
  'proverbs': 'Proverbs',
  'ecclesiastes': 'Ecclesiastes',
  'song of solomon': 'Song of Solomon', 'songs of solomon': 'Song of Solomon',
  'isaiah': 'Isaiah',
  'jeremiah': 'Jeremiah',
  'lamentations': 'Lamentations',
  'ezekiel': 'Ezekiel',
  'daniel': 'Daniel',
  'hosea': 'Hosea',
  'joel': 'Joel',
  'amos': 'Amos', 'aim us': 'Amos',
  'obadiah': 'Obadiah',
  'jonah': 'Jonah',
  'micah': 'Micah',
  'nahum': 'Nahum',
  'habakkuk': 'Habakkuk', 'habitat cook': 'Habakkuk',
  'zephaniah': 'Zephaniah',
  'haggai': 'Haggai', 'hag i': 'Haggai',
  'zechariah': 'Zechariah',
  'malachi': 'Malachi', 'malachai': 'Malachi',

  // New Testament
  'matthew': 'Matthew',
  'mark': 'Mark', 'march': 'Mark',
  'luke': 'Luke',
  'john': 'John',
  'acts': 'Acts', 'axe': 'Acts',
  'romans': 'Romans',
  '1 corinthians': '1 Corinthians', 'one corinthians': '1 Corinthians', 'first corinthians': '1 Corinthians',
  '2 corinthians': '2 Corinthians', 'two corinthians': '2 Corinthians', 'second corinthians': '2 Corinthians',
  'galatians': 'Galatians', 'relations': 'Galatians',
  'ephesians': 'Ephesians', 'effusions': 'Ephesians',
  'philippians': 'Philippians',
  'colossians': 'Colossians',
  '1 thessalonians': '1 Thessalonians', 'one thessalonians': '1 Thessalonians', 'first thessalonians': '1 Thessalonians',
  '2 thessalonians': '2 Thessalonians', 'two thessalonians': '2 Thessalonians', 'second thessalonians': '2 Thessalonians',
  '1 timothy': '1 Timothy', 'one timothy': '1 Timothy', 'first timothy': '1 Timothy',
  '2 timothy': '2 Timothy', 'two timothy': '2 Timothy', 'second timothy': '2 Timothy',
  'titus': 'Titus', 'tightest': 'Titus',
  'philemon': 'Philemon', 'file lemon': 'Philemon',
  'hebrews': 'Hebrews',
  'james': 'James',
  '1 peter': '1 Peter', 'one peter': '1 Peter', 'first peter': '1 Peter',
  '2 peter': '2 Peter', 'two peter': '2 Peter', 'second peter': '2 Peter',
  '1 john': '1 John', 'one john': '1 John', 'first john': '1 John',
  '2 john': '2 John', 'two john': '2 John', 'second john': '2 John',
  '3 john': '3 John', 'three john': '3 John', 'third john': '3 John',
  'jude': 'Jude',
  'revelation': 'Revelation', 'revelations': 'Revelation'
};

// O. Bible Book Abbreviations
export const bibleBookAbbreviations = {
  'gen': 'Genesis', 'ex': 'Exodus', 'lev': 'Leviticus', 'num': 'Numbers', 'deut': 'Deuteronomy',
  'josh': 'Joshua', 'judg': 'Judges', 'ruth': 'Ruth',
  '1 sam': '1 Samuel', '2 sam': '2 Samuel', '1 kgs': '1 Kings', '2 kgs': '2 Kings',
  '1 chr': '1 Chronicles', '2 chr': '2 Chronicles', 'ezra': 'Ezra', 'neh': 'Nehemiah', 'esth': 'Esther',
  'job': 'Job', 'ps': 'Psalm', 'psa': 'Psalm', 'psalm': 'Psalm', 'prov': 'Proverbs', 'eccl': 'Ecclesiastes',
  'song': 'Song of Solomon', 'isa': 'Isaiah', 'jer': 'Jeremiah', 'lam': 'Lamentations',
  'ezek': 'Ezekiel', 'dan': 'Daniel', 'hos': 'Hosea', 'joel': 'Joel', 'amos': 'Amos',
  'obad': 'Obadiah', 'jonah': 'Jonah', 'mic': 'Micah', 'nah': 'Nahum', 'hab': 'Habakkuk',
  'zeph': 'Zephaniah', 'hag': 'Haggai', 'zech': 'Zechariah', 'mal': 'Malachi',
  'matt': 'Matthew', 'mark': 'Mark', 'luke': 'Luke', 'john': 'John', 'acts': 'Acts',
  'rom': 'Romans', '1 cor': '1 Corinthians', '2 cor': '2 Corinthians', 'gal': 'Galatians',
  'eph': 'Ephesians', 'phil': 'Philippians', 'col': 'Colossians',
  '1 thess': '1 Thessalonians', '2 thess': '2 Thessalonians',
  '1 tim': '1 Timothy', '2 tim': '2 Timothy', 'titus': 'Titus', 'philem': 'Philemon',
  'heb': 'Hebrews', 'james': 'James', '1 pet': '1 Peter', '2 pet': '2 Peter',
  '1 john': '1 John', '2 john': '2 John', '3 john': '3 John', 'jude': 'Jude', 'rev': 'Revelation'
};

// P. Single-Chapter Books (auto-add chapter 1)
export const singleChapterBooks = ['Obadiah', 'Philemon', '2 John', '3 John', 'Jude'];

// Q. Religious Homophones - Comprehensive list
export const religiousHomophones = {
  'pray': { alternatives: ['prey'], contextCheck: 'verb_religious' },
  'prey': { alternatives: ['pray'], contextCheck: 'noun_animal' },
  'altar': { alternatives: ['alter'], contextCheck: 'noun_religious' },
  'alter': { alternatives: ['altar'], contextCheck: 'verb_change' },
  'holy': { alternatives: ['wholly'], contextCheck: 'adjective_religious' },
  'wholly': { alternatives: ['holy'], contextCheck: 'adverb_complete' },
  'prophet': { alternatives: ['profit'], contextCheck: 'noun_religious' },
  'profit': { alternatives: ['prophet'], contextCheck: 'noun_business' },
  'soul': { alternatives: ['sole'], contextCheck: 'noun_spiritual' },
  'sole': { alternatives: ['soul'], contextCheck: 'noun_body_part' },
  'heal': { alternatives: ['heel'], contextCheck: 'verb_religious' },
  'heel': { alternatives: ['heal'], contextCheck: 'noun_body_part' },
  'praise': { alternatives: ['prays', 'preys'], contextCheck: 'noun_worship' },
  'prays': { alternatives: ['praise', 'preys'], contextCheck: 'verb_religious' },
  'preys': { alternatives: ['praise', 'prays'], contextCheck: 'verb_hunt' },
  'peace': { alternatives: ['piece'], contextCheck: 'noun_religious' },
  'piece': { alternatives: ['peace'], contextCheck: 'noun_part' },
  'reign': { alternatives: ['rain', 'rein'], contextCheck: 'verb_rule' },
  'rain': { alternatives: ['reign', 'rein'], contextCheck: 'noun_weather' },
  'rein': { alternatives: ['reign', 'rain'], contextCheck: 'noun_control' },
  'rite': { alternatives: ['right', 'write'], contextCheck: 'noun_ceremony' },
  'right': { alternatives: ['rite', 'write'], contextCheck: 'adjective_correct' },
  'write': { alternatives: ['rite', 'right'], contextCheck: 'verb_communication' },
  'sermon': { alternatives: ['summon'], contextCheck: 'noun_religious' },
  'summon': { alternatives: ['sermon'], contextCheck: 'verb_call' },
  'morning': { alternatives: ['mourning'], contextCheck: 'noun_time' },
  'mourning': { alternatives: ['morning'], contextCheck: 'noun_grief' },
  'seal': { alternatives: ['zeal'], contextCheck: 'noun_mark' },
  'zeal': { alternatives: ['seal'], contextCheck: 'noun_passion' },
  'raise': { alternatives: ['raze'], contextCheck: 'verb_build' },
  'raze': { alternatives: ['raise'], contextCheck: 'verb_destroy' },
  'sins': { alternatives: ['since'], contextCheck: 'noun_religious' },
  'since': { alternatives: ['sins'], contextCheck: 'preposition_time' },
  'mary': { alternatives: ['marry'], contextCheck: 'noun_person' },
  'marry': { alternatives: ['mary'], contextCheck: 'verb_union' },
  'prophecy': { alternatives: ['prophesy'], contextCheck: 'noun_prediction' },
  'prophesy': { alternatives: ['prophecy'], contextCheck: 'verb_predict' }
};

// R. Theology Terms - Comprehensive normalization
export const theologyTerms = {
  'the gospel according to john': 'The Gospel According to John',
  'gospel according to john': 'Gospel According to John',
  'new testament': 'New Testament',
  'old testament': 'Old Testament',
  'holy ghost': 'Holy Spirit',
  'holy spirit': 'Holy Spirit',
  'holy bible': 'Holy Bible',
  'ten commandments': 'Ten Commandments',
  'beatitudes': 'Beatitudes',
  'book of revelation': 'Book of Revelation',
  'word of god': 'Word of God',
  'armor of god': 'Armor of God',
  'armour of god': 'Armor of God', // British spelling
  'fruit of the spirit': 'Fruit of the Spirit',
  "lord's prayer": "Lord's Prayer",
  "lords prayer": "Lord's Prayer",
  'body of christ': 'Body of Christ',
  'holy communion': 'Holy Communion',
  'holy trinity': 'Holy Trinity',
  'day of pentecost': 'Day of Pentecost',
  'good news': 'Good News',
  'kingdom of god': 'Kingdom of God',
  'kingdom of heaven': 'Kingdom of Heaven'
};

// S. Sermon Structure Patterns
export const sermonStructurePatterns = {
  'point number one': '1.',
  'point number two': '2.',
  'point number three': '3.',
  'point number four': '4.',
  'point number five': '5.',
  'main point number one': '1.',
  'main point number two': '2.',
  'main point number three': '3.',
  'roman numeral one': 'I.',
  'roman numeral two': 'II.',
  'roman numeral three': 'III.',
  'roman numeral four': 'IV.',
  'roman numeral five': 'V.',
  'subpoint a': 'A.',
  'subpoint b': 'B.',
  'subpoint c': 'C.',
  'subpoint d': 'D.',
  'part one': 'Part I',
  'part two': 'Part II',
  'part three': 'Part III',
  'title': 'Title:',
  'new paragraph': '\n\n',
  'new line': '\n',
  'verse break': '¶',
  'section break': '---',
  'chapter heading': '##',
  'bullet point': '•',
  'numbered list': '1.',
  'quotation mark': '"',
  'quote': '"',
  'end quote': '"',
  'apostrophe': "'",
  'dash': '—',
  'colon after': ':'
};

// T. Prayer Language Patterns
export const prayerLanguagePatterns = {
  'dear lord': 'Dear Lord,',
  'dear lord please': 'Dear Lord, please',
  'thank you lord': 'Thank You, Lord.',
  'father god': 'Father God,',
  'heavenly father': 'Heavenly Father,',
  'oh lord': 'O Lord,',
  'o lord': 'O Lord,',
  'in jesus name': "In Jesus' name,",
  'in jesus name amen': "In Jesus' name, Amen.",
  'praise the lord': 'Praise the Lord!',
  'hallelujah': 'Hallelujah!',
  'amen': 'Amen.'
};

// U. Divine Pronouns (capitalize when referring to God/Christ)
export const divinePronouns = ['He', 'Him', 'His', 'You', 'Your', 'Yours', 'Thou', 'Thee', 'Thy', 'Thine'];

// V. Divine Titles (always capitalize)
export const divineTitles = ['Lord', 'God', 'Father', 'Son', 'Holy Spirit', 'Messiah', 'Christ', 'Savior', 'Redeemer', 'Immanuel', 'Word'];

// W. Sacred Text References (capitalize)
export const sacredTextReferences = ['Scripture', 'Word of God', 'Bible', 'Gospel', 'Good News', 'Holy Bible', 'Scriptures'];

// X. Ordinal Number Words for Bible Books
export const ordinalWords = {
  'first': '1', 'second': '2', 'third': '3', 'fourth': '4', 'fifth': '5',
  'sixth': '6', 'seventh': '7', 'eighth': '8', 'ninth': '9', 'tenth': '10'
};

// Y. Verse Reference Patterns
export const versePatterns = {
  'chapter': ':',
  'verse': ':',
  'verses': 'vv.',
  'verse': 'v.',
  'through': '–',
  'to': '–',
  'and': '–'
};

// Z. Punctuation Normalization - Map full-width/CJK characters to half-width equivalents
// These characters can cause TTS models to vocalize artifacts or hallucinate
export const punctuationNormalization = {
  // Chinese/CJK full-width punctuation
  '。': '.',     // Full-width period
  '，': ',',     // Full-width comma (CRITICAL: was missing, caused TTS artifacts)
  '：': ':',     // Full-width colon
  '；': ';',     // Full-width semicolon
  '！': '!',     // Full-width exclamation
  '？': '?',     // Full-width question mark
  '（': '(',     // Full-width left parenthesis
  '）': ')',     // Full-width right parenthesis
  '【': '[',     // Full-width left bracket
  '】': ']',     // Full-width right bracket
  '「': '"',     // CJK left corner bracket
  '」': '"',     // CJK right corner bracket
  '『': '"',     // CJK left white corner bracket
  '』': '"',     // CJK right white corner bracket
  '“': '"',      // Left double quotation mark
  '”': '"',      // Right double quotation mark
  '‘': "'",      // Left single quotation mark
  '’': "'",      // Right single quotation mark
  '、': ',',     // Chinese enumeration comma (ideographic comma)
  '‥': '..',    // Two-dot leader
  '…': '...',   // Horizontal ellipsis
  '—': '-',     // Em dash
  '～': '~',     // Full-width tilde
  '·': ' ',     // Middle dot (interpunct) - replace with space
  '　': ' ',     // Ideographic space (full-width space)

  // International quote variants
  '«': '"',     // French/Russian left guillemet
  '»': '"',     // French/Russian right guillemet
  '‹': "'",     // Single left guillemet
  '›': "'",     // Single right guillemet
  '„': '"',     // German/Polish low-9 double quote
  '‚': "'",     // German/Polish low-9 single quote
  '‟': '"',     // Double high-reversed-9 quotation mark

  // Arabic/Hebrew punctuation
  '،': ',',     // Arabic comma
  '؛': ';',     // Arabic semicolon
  '؟': '?',     // Arabic question mark
  '״': '"',     // Hebrew double geresh (U+05F4) - Hebrew double quote
  '׳': "'",     // Hebrew geresh (U+05F3) - Hebrew single quote

  // Indic script punctuation (Hindi, Bengali, Marathi, Tamil, Telugu, Gujarati, etc.)
  '।': '.',     // Devanagari danda (U+0964) - period for Hindi, Marathi, Nepali, etc.
  '॥': '.',     // Devanagari double danda (U+0965)

  // Burmese punctuation
  '၊': ',',     // Burmese comma (U+104A)
  '။': '.',     // Burmese full stop (U+104B)

  // Ethiopic punctuation (Amharic)
  '።': '.',     // Ethiopic full stop (U+1362)
  '፣': ',',     // Ethiopic comma (U+1363)
  '፤': ';',     // Ethiopic semicolon (U+1364)
  '፧': '?',     // Ethiopic question mark (U+1367)

  // Armenian punctuation
  '՝': ',',     // Armenian comma (U+055D)
  '։': '.',     // Armenian full stop (U+0589)
  '՞': '?',     // Armenian question mark (U+055E)

  // Other special punctuation
  '–': '-',     // En dash
  '‐': '-',     // Hyphen
  '‑': '-',     // Non-breaking hyphen
  '⁃': '-',     // Hyphen bullet
  '′': "'",     // Prime (often used as apostrophe)
  '″': '"',     // Double prime
  '‵': "'",     // Reversed prime
  '‶': '"'      // Reversed double prime
};
