/**
 * Test suite for grammar correction semantic drift validation
 *
 * Tests the isSemanticallyValid and applyMinimalCorrection methods
 * to ensure legitimate grammar fixes pass while semantic changes are rejected
 */

import { GrammarCorrectorModel } from './grammarCorrectorModel.js';

const corrector = new GrammarCorrectorModel({ enabled: false }); // Don't need actual model for validation tests

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function test(description, original, corrected, shouldAccept) {
  totalTests++;
  console.log(`\n${colors.cyan}Test ${totalTests}: ${description}${colors.reset}`);
  console.log(`  Original:  "${original}"`);
  console.log(`  Corrected: "${corrected}"`);
  console.log(`  Expected:  ${shouldAccept ? 'ACCEPT' : 'REJECT'}`);

  // Test semantic validation
  const isValid = corrector.isSemanticallyValid(original, corrected);

  // Test minimal correction (which includes semantic validation)
  const result = corrector.applyMinimalCorrection(original, corrected);
  const wasAccepted = result === corrected;

  // Check if result matches expectation
  const testPassed = wasAccepted === shouldAccept;

  if (testPassed) {
    passedTests++;
    console.log(`  ${colors.green}✅ PASS${colors.reset} - ${wasAccepted ? 'Accepted' : 'Rejected'} as expected`);
  } else {
    failedTests++;
    console.log(`  ${colors.red}❌ FAIL${colors.reset} - ${wasAccepted ? 'Accepted' : 'Rejected'} (expected ${shouldAccept ? 'Accept' : 'Reject'})`);
  }

  // Calculate and show metrics
  const charSim = corrector.jaroWinklerSimilarity(original, corrected);
  console.log(`  Metrics: Char similarity: ${(charSim * 100).toFixed(1)}%, Semantic valid: ${isValid}`);

  return testPassed;
}

console.log(`${colors.blue}═══════════════════════════════════════════════════════════════${colors.reset}`);
console.log(`${colors.blue}Grammar Correction Validation Test Suite${colors.reset}`);
console.log(`${colors.blue}═══════════════════════════════════════════════════════════════${colors.reset}`);

// ============================================================================
// CATEGORY 1: Capitalization (Should ACCEPT)
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 1: Capitalization Changes ━━━${colors.reset}`);

test(
  'Simple capitalization',
  'hello world',
  'Hello world',
  true
);

test(
  'Capitalization at start',
  'can you believe me?',
  'Can you believe me?',
  true
);

test(
  'Multiple capitalizations',
  'hello there, how are you?',
  'Hello there, how are you?',
  true
);

// ============================================================================
// CATEGORY 2: Punctuation (Should ACCEPT)
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 2: Punctuation Changes ━━━${colors.reset}`);

test(
  'Add comma',
  'hello world',
  'hello, world',
  true
);

test(
  'Add period',
  'hello world',
  'hello world.',
  true
);

test(
  'Add multiple punctuation',
  'hello how are you',
  'hello, how are you?',
  true
);

test(
  'Fix spacing around punctuation',
  'hello , world',
  'hello, world',
  true
);

// ============================================================================
// CATEGORY 3: Contractions (Should ACCEPT)
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 3: Contractions ━━━${colors.reset}`);

test(
  'Add apostrophe to "dont"',
  'I dont know',
  "I don't know",
  true
);

test(
  'Expand "Im" to "I\'m"',
  'Im going home',
  "I'm going home",
  true
);

test(
  'Fix "cant"',
  'I cant do it',
  "I can't do it",
  true
);

test(
  'Fix "wont"',
  'She wont come',
  "She won't come",
  true
);

// ============================================================================
// CATEGORY 4: Missing Words (Grammar) (Should ACCEPT)
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 4: Missing Words (Grammar Fixes) ━━━${colors.reset}`);

test(
  'Add missing "am"',
  'I going to the store',
  "I'm going to the store",
  true
);

test(
  'Add missing "is"',
  'He going home',
  'He is going home',
  true
);

test(
  'Add missing "to"',
  'I want go home',
  'I want to go home',
  true
);

test(
  'Add missing article "a"',
  'I have dog',
  'I have a dog',
  true
);

// ============================================================================
// CATEGORY 5: Article Fixes (Should ACCEPT)
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 5: Article Corrections ━━━${colors.reset}`);

test(
  'Fix "a" to "an" before vowel',
  'I have a apple',
  'I have an apple',
  true
);

test(
  'Fix "an" to "a" before consonant',
  'He is an good person',
  'He is a good person',
  true
);

// ============================================================================
// CATEGORY 6: Verb Tense (Should ACCEPT)
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 6: Verb Tense Corrections ━━━${colors.reset}`);

test(
  'Fix irregular past tense "goed"',
  'I goed to the store',
  'I went to the store',
  true
);

test(
  'Fix "runned" to "ran"',
  'She runned fast',
  'She ran fast',
  true
);

test(
  'Fix present continuous',
  'He go to work',
  'He goes to work',
  true
);

// ============================================================================
// CATEGORY 7: Homophones (Grammar Context) (Should ACCEPT)
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 7: Homophone Corrections ━━━${colors.reset}`);

test(
  'Fix "there" to "their" (possessive context)',
  'I see there car',
  'I see their car',
  true
);

test(
  'Fix "your" to "you\'re"',
  'Your going home',
  "You're going home",
  true
);

test(
  'Fix "its" to "it\'s"',
  'Its a nice day',
  "It's a nice day",
  true
);

// ============================================================================
// CATEGORY 8: Typo Fixes (Should ACCEPT)
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 8: Typo Corrections ━━━${colors.reset}`);

test(
  'Fix "teh" to "the"',
  'I went to teh store',
  'I went to the store',
  true
);

test(
  'Fix "recieve" to "receive"',
  'I will recieve it',
  'I will receive it',
  true
);

test(
  'Fix "seperate" to "separate"',
  'We are seperate',
  'We are separate',
  true
);

// ============================================================================
// CATEGORY 9: Semantic Changes (Should REJECT)
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 9: Semantic Changes (Should REJECT) ━━━${colors.reset}`);

test(
  'Change "hear" to "tell" (different meaning)',
  'Can you hear me?',
  'Can you tell me?',
  false
);

test(
  'Change "believe" to "hear"',
  'Can you believe me?',
  'Can you hear me?',
  false
);

test(
  'Change "has" to "yet"',
  'She has finished',
  'She yet finished',
  false
);

test(
  'Change "going" to "coming"',
  'I am going home',
  'I am coming home',
  false
);

test(
  'Change "happy" to "sad"',
  'I am happy today',
  'I am sad today',
  false
);

// ============================================================================
// CATEGORY 10: Excessive Rewrites (Should REJECT)
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 10: Excessive Rewrites (Should REJECT) ━━━${colors.reset}`);

test(
  'Complete sentence rewrite',
  'Hello world',
  'Greetings to everyone in the universe',
  false
);

test(
  'Paraphrasing',
  'I want to go home',
  'I desire to return to my residence',
  false
);

test(
  'Adding too many words',
  'Quick test',
  'This is a very quick and simple test',
  false
);

// ============================================================================
// CATEGORY 11: Edge Cases
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 11: Edge Cases ━━━${colors.reset}`);

test(
  'Identical text (no change)',
  'Hello world',
  'Hello world',
  true
);

test(
  'Only whitespace change',
  'Hello  world',
  'Hello world',
  true
);

test(
  'Multiple corrections in one sentence',
  'I dont want go there house',
  "I don't want to go to their house",
  true
);

test(
  'Single word with capitalization',
  'hello',
  'Hello',
  true
);

// ============================================================================
// CATEGORY 12: Borderline Cases (Grammar vs Semantic)
// ============================================================================
console.log(`\n${colors.yellow}━━━ Category 12: Borderline Cases ━━━${colors.reset}`);

test(
  'Change "good" to "well" (grammar)',
  'She did good',
  'She did well',
  true // "good" vs "well" is grammatical, not semantic
);

test(
  'Change "less" to "fewer" (grammar)',
  'There are less people',
  'There are fewer people',
  true // "less" vs "fewer" is grammatical
);

test(
  'Change "who" to "whom" (grammar)',
  'To who did you speak',
  'To whom did you speak',
  true // "who" vs "whom" is grammatical
);

// ============================================================================
// SUMMARY
// ============================================================================
console.log(`\n${colors.blue}═══════════════════════════════════════════════════════════════${colors.reset}`);
console.log(`${colors.blue}Test Results Summary${colors.reset}`);
console.log(`${colors.blue}═══════════════════════════════════════════════════════════════${colors.reset}`);
console.log(`Total Tests:  ${totalTests}`);
console.log(`${colors.green}Passed:       ${passedTests}${colors.reset}`);
console.log(`${colors.red}Failed:       ${failedTests}${colors.reset}`);
console.log(`Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);

if (failedTests === 0) {
  console.log(`\n${colors.green}🎉 All tests passed!${colors.reset}`);
} else {
  console.log(`\n${colors.red}⚠️  ${failedTests} test(s) failed. Review the failures above.${colors.reset}`);
}

console.log(`${colors.blue}═══════════════════════════════════════════════════════════════${colors.reset}\n`);

// Exit with appropriate code
process.exit(failedTests === 0 ? 0 : 1);
