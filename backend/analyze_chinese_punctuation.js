// Analyze the Chinese string to identify punctuation types
const string1 = '然后彼得对他们说: "你们各人要悔改, 并奉耶稣基督的名受洗. "';
const string2 = '然后彼得对他们说: "你们各人要悔改, 并奉耶稣基督的名受洗. "';

console.log("=== String 1 Analysis ===");
console.log("String:", string1);
console.log("Length:", string1.length);

console.log("\n=== Character-by-Character Analysis ===");
for (let i = 0; i < string1.length; i++) {
    const char = string1[i];
    const code = string1.charCodeAt(i);
    const hex = 'U+' + code.toString(16).toUpperCase().padStart(4, '0');

    // Identify character type
    let type = "Han Character";
    if (code < 128) type = "ASCII";
    else if (code >= 0xFF00 && code <= 0xFFEF) type = "Full-width";
    else if (code >= 0x2000 && code <= 0x206F) type = "General Punctuation";
    else if (code >= 0x3000 && code <= 0x303F) type = "CJK Symbols/Punctuation";

    // Highlight punctuation
    if ([0x3A, 0x22, 0x2C, 0x2E, 0x20].includes(code) ||
        [0xFF1A, 0x201C, 0x201D, 0xFF0C, 0x3002].includes(code)) {
        console.log(`[${i}] '${char}' ${hex} - ${type} *** PUNCTUATION ***`);
    }
}

console.log("\n=== Specific Punctuation Check ===");
// Find all punctuation
const punctuationIndices = [];
for (let i = 0; i < string1.length; i++) {
    const code = string1.charCodeAt(i);
    if ([0x3A, 0x22, 0x2C, 0x2E, 0x20].includes(code) ||
        [0xFF1A, 0x201C, 0x201D, 0xFF0C, 0x3002].includes(code)) {
        const char = string1[i];
        const hex = 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
        console.log(`Position ${i}: '${char}' ${hex}`);
        punctuationIndices.push(i);
    }
}

console.log("\n=== Punctuation Summary ===");
console.log("Colon (index 7):", string1[7], "U+" + string1.charCodeAt(7).toString(16).toUpperCase());
console.log("Quote 1 (index 9):", string1[9], "U+" + string1.charCodeAt(9).toString(16).toUpperCase());
console.log("Comma (index 17):", string1[17], "U+" + string1.charCodeAt(17).toString(16).toUpperCase());
console.log("Period (index 28):", string1[28], "U+" + string1.charCodeAt(28).toString(16).toUpperCase());
console.log("Quote 2 (index 30):", string1[30], "U+" + string1.charCodeAt(30).toString(16).toUpperCase());

console.log("\n=== Comparison ===");
console.log("ASCII colon ':':", "U+003A");
console.log("ASCII quote '\"':", "U+0022");
console.log("ASCII comma ',':", "U+002C");
console.log("ASCII period '.':", "U+002E");
console.log("Full-width comma '，':", "U+FF0C");
console.log("Chinese period '。':", "U+3002");
console.log("Left double quote '"':", "U+201C");
console.log("Right double quote '"':", "U+201D");

console.log("\n=== Verdict ===");
const colon = string1.charCodeAt(7);
const quote1 = string1.charCodeAt(9);
const comma = string1.charCodeAt(17);
const period = string1.charCodeAt(28);

if (colon === 0x3A) console.log("✓ Colon is WESTERN (ASCII)");
else if (colon === 0xFF1A) console.log("✗ Colon is CHINESE (Full-width)");

if (quote1 === 0x22) console.log("✓ Quote is WESTERN (ASCII)");
else if (quote1 === 0x201C) console.log("✗ Quote is CHINESE (Left curly quote)");

if (comma === 0x2C) console.log("✓ Comma is WESTERN (ASCII)");
else if (comma === 0xFF0C) console.log("✗ Comma is CHINESE (Full-width)");

if (period === 0x2E) console.log("✓ Period is WESTERN (ASCII)");
else if (period === 0x3002) console.log("✗ Period is CHINESE (Full-stop)");
