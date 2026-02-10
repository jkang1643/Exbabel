
const stringToAnalyze = '然后彼得对他们说: "你们各人要悔改, 并奉耶稣基督的名受洗. "';

console.log("Analyzing String:", stringToAnalyze);
console.log("Length:", stringToAnalyze.length);

console.log("\n--- Character Analysis ---");
for (let i = 0; i < stringToAnalyze.length; i++) {
    const char = stringToAnalyze[i];
    const code = stringToAnalyze.charCodeAt(i);
    const hex = code.toString(16).toUpperCase().padStart(4, '0');

    let type = "Other";
    if (code >= 0x4E00 && code <= 0x9FFF) type = "CJK Unified Ideograph";
    else if (code < 128) type = "ASCII";
    else if (code >= 0xFF00 && code <= 0xFFEF) type = "Full-width / Half-width";
    else if (code >= 0x2000 && code <= 0x206F) type = "General Punctuation";

    // Highlight punctuation explicitly
    if ([':', '"', ',', '.'].includes(char) || [0xFF1A, 0x201C, 0x201D, 0xFF0C, 0x3002].includes(code)) {
        console.log(`Index ${i}: '${char}' \t (U+${hex}) - ${type} [PUNCTUATION]`);
    }
}

console.log("\n--- Specific Punctuation Check ---");
const colon = stringToAnalyze[7];
const quote1 = stringToAnalyze[9];
const comma = stringToAnalyze[17];
const period = stringToAnalyze[28];
const quote2 = stringToAnalyze[30];

console.log(`Colon (Index 7): '${colon}' (U+${colon.charCodeAt(0).toString(16).toUpperCase()})`);
console.log(`Quote 1 (Index 9): '${quote1}' (U+${quote1.charCodeAt(0).toString(16).toUpperCase()})`);
console.log(`Comma (Index 17): '${comma}' (U+${comma.charCodeAt(0).toString(16).toUpperCase()})`);
console.log(`Period (Index 28): '${period}' (U+${period.charCodeAt(0).toString(16).toUpperCase()})`);
// Note: Index might vary slightly if I miscounted, loop above is safer.
