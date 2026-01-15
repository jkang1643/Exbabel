import { buildSSML, applyDeliveryStyle } from '../ssmlBuilder.js';

console.log('--- TEST 1: Standard Preaching Dynamic ---');
const text1 = "Church, listen to me. God is not finished with you.";
const result1 = applyDeliveryStyle(text1, 'standard_preaching');
console.log(result1.ssml);

console.log('\n--- TEST 2: Pentecostal Dynamic (Short Phrases) ---');
const text2 = "God is good! All the time! Believe it!";
const result2 = applyDeliveryStyle(text2, 'pentecostal');
console.log(result2.ssml);

console.log('\n--- TEST 3: Teaching Dynamic (Should be steady) ---');
const text3 = "Let us turn to the book of John, chapter three.";
const result3 = applyDeliveryStyle(text3, 'teaching');
console.log(result3.ssml);

console.log('\n--- TEST 4: Power Words & Mixed Punctuation ---');
const text4 = "And today, we choose faith. Jesus is Lord.";
const result4 = applyDeliveryStyle(text4, 'standard_preaching');
console.log(result4.ssml);

console.log('\n--- TEST 5: XML Entities (The Fix) ---');
// Input has a single quote `'` which becomes `&apos;`
const text5 = "Don't stop now; we are just beginning.";
const result5 = applyDeliveryStyle(text5, 'standard_preaching');
console.log(result5.ssml);
