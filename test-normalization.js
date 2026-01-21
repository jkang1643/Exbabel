import { normalizePunctuation } from './backend/transcriptionCleanup.js';

const testCases = [
    {
        name: "Basic Chinese Period",
        input: "彼得对他们说：“你们每一个人都要悔改，奉耶稣基督的名受洗，以赦免你们의罪。”",
        expected: "彼得对他们说: \"你们每一个人都要悔改，奉耶稣基督的名受洗，以赦免你们의罪. \""
    },
    {
        name: "Multiple Chinese Periods",
        input: "第一句。第二句。",
        expected: "第一句. 第二句."
    },
    {
        name: "Chinese Quotes",
        input: "彼得对他们说：“你们每一个人都要悔改.”",
        expected: "彼得对他们说: \"你们每一个人都要悔改.\""
    },
    {
        name: "Full-width Punctuation Mixed",
        input: "他说：“你好。”",
        expected: "他说: \"你好. \""
    }
];

console.log("--- Punctuation Normalization Test ---");

let passedCount = 0;
testCases.forEach(testCase => {
    const output = normalizePunctuation(testCase.input);
    const passed = output === testCase.expected;
    console.log(`[${passed ? "PASS" : "FAIL"}] ${testCase.name}`);
    if (!passed) {
        console.log(`  Input:    ${testCase.input}`);
        console.log(`  Expected: ${testCase.expected}`);
        console.log(`  Actual:   ${output}`);
    } else {
        passedCount++;
    }
});

console.log(`\nSummary: ${passedCount}/${testCases.length} tests passed.`);

if (passedCount === testCases.length) {
    process.exit(0);
} else {
    process.exit(1);
}
