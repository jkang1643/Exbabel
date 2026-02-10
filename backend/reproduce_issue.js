
import { retextPunctuationNormalize } from './retext-plugins/retext-punctuation-normalize.js';
import { normalizeQuotationSyntaxLogic } from './retext-plugins/logic.js';
import { processWithRetext, processPartialSync } from './retext-processor.js';

const text = '然后彼得对他们说: "你们各人要悔改, 并奉耶稣基督的名受洗. "';

console.log("Original text:", text);

async function runTests() {
    console.log("\n--- Testing retextPunctuationNormalize ---");
    try {
        const plugin = retextPunctuationNormalize({ isPartial: false });
        const file = { value: text, toString: () => text };
        plugin({}, file);
        console.log("retextPunctuationNormalize output:", file.value);
    } catch (e) {
        console.error("retextPunctuationNormalize failed:", e);
    }

    console.log("\n--- Testing normalizeQuotationSyntaxLogic ---");
    try {
        const result = normalizeQuotationSyntaxLogic(text);
        console.log("normalizeQuotationSyntaxLogic output:", result);
    } catch (e) {
        console.error("normalizeQuotationSyntaxLogic failed:", e);
    }

    console.log("\n--- Testing processPartialSync ---");
    try {
        const result = processPartialSync(text, { enableDomainSpecific: true });
        console.log("processPartialSync output:", result);
    } catch (e) {
        console.error("processPartialSync failed:", e);
    }

    console.log("\n--- Testing processWithRetext (Full Pipeline) ---");
    try {
        const result = await processWithRetext(text, { enableDomainSpecific: true });
        console.log("processWithRetext output:", result);
    } catch (e) {
        console.error("processWithRetext failed:", e);
    }
}

runTests();
