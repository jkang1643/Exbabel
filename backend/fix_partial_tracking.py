#!/usr/bin/env python3
"""Fix partial tracking in soloModeHandler.js to prevent word loss"""

import re

# Read the file
with open('soloModeHandler.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Add tracking variables after currentPartialText declaration
content = re.sub(
    r'(let currentPartialText = .*?; // Track current partial text for delayed translations)\s*\n',
    r'\1\n              \n              // Track latest partial to prevent word loss when final arrives\n              // Google Speech can finalize a shorter phrase while partial has more text\n              let latestPartialText = \'\'; // Most recent partial text from Google Speech\n              let lastFinalText = \'\'; // Last final text received (for deduplication)\n',
    content
)

# Add partial tracking in isPartial block
content = re.sub(
    r'(if \(isPartial\) \{)\s*\n\s*// Live partial transcript',
    r'\1\n                  // CRITICAL: Track the latest partial text to prevent word loss\n                  // Google Speech can finalize a shorter phrase while a partial has more text\n                  // This happens during continuous speech when the API finalizes an earlier chunk\n                  if (transcriptText.length > latestPartialText.length || \n                      !latestPartialText || \n                      !transcriptText.startsWith(latestPartialText.substring(0, Math.min(latestPartialText.length, 50)))) {\n                    latestPartialText = transcriptText;\n                  }\n                  \n                  // Live partial transcript',
    content
)

# Fix final handling - find the else block and replace it
# This is more complex, so we'll do it in parts
final_pattern = r'(} else \{)\s*// Final transcript from Google Speech - send immediately.*?(\n\s*// Process final immediately)'

def replace_final(match):
    return '''} else {
                  // Final transcript from Google Speech
                  // CRITICAL FIX: Check if latest partial extends beyond this final
                  // Google Speech can finalize an earlier chunk while partial has more text
                  // This prevents word loss during continuous speech without pauses
                  let finalTextToProcess = transcriptText;
                  
                  if (latestPartialText && latestPartialText.length > transcriptText.length) {
                    // Check if partial extends beyond final (common case during continuous speech)
                    // The partial might include the final plus additional words
                    if (latestPartialText.startsWith(transcriptText.trim())) {
                      // Partial extends beyond final - use the longer partial text
                      finalTextToProcess = latestPartialText;
                      console.log(`[SoloMode] ⚠️ FINAL truncated - using partial instead (${transcriptText.length} → ${latestPartialText.length} chars)`);
                      console.log(`[SoloMode]   Final: "${transcriptText.substring(0, 50)}..."`);
                      console.log(`[SoloMode]   Partial: "${latestPartialText.substring(0, 50)}..."`);
                    } else {
                      // Partial might be for a different part - check for overlap
                      const findOverlap = (oldText, newText) => {
                        if (!oldText || !newText) return 0;
                        const minLen = Math.min(oldText.length, newText.length);
                        for (let i = minLen; i > 20; i--) {
                          const oldSuffix = oldText.slice(-i);
                          if (newText.startsWith(oldSuffix)) {
                            return i;
                          }
                        }
                        return 0;
                      };
                      
                      const overlap = findOverlap(transcriptText, latestPartialText);
                      if (overlap > 0 && latestPartialText.length > transcriptText.length) {
                        // Merge: final + new part from partial
                        const newPart = latestPartialText.substring(overlap);
                        finalTextToProcess = transcriptText.trim() + ' ' + newPart.trim();
                        console.log(`[SoloMode] ⚠️ FINAL merged with partial (${transcriptText.length} + ${newPart.length} = ${finalTextToProcess.length} chars)`);
                        console.log(`[SoloMode]   Final: "${transcriptText.substring(0, 50)}..."`);
                        console.log(`[SoloMode]   Partial: "${latestPartialText.substring(0, 50)}..."`);
                        console.log(`[SoloMode]   Merged: "${finalTextToProcess.substring(0, 50)}..."`);
                      }
                    }
                  }
                  
                  // Deduplicate: Skip if this final is the same as the last one
                  if (finalTextToProcess === lastFinalText) {
                    console.log(`[SoloMode] ⏭️ Skipping duplicate final: "${finalTextToProcess.substring(0, 50)}..."`);
                    // Reset partial tracking even if skipping
                    latestPartialText = '';
                    return;
                  }
                  lastFinalText = finalTextToProcess;
                  
                  // Reset latest partial after processing final
                  latestPartialText = '';
                  
                  console.log(`[SoloMode] 📝 FINAL Transcript (processed): "${finalTextToProcess.substring(0, 50)}..."`);
                  
                  // Cancel any pending finalization timeout (in case we had delayed finalization)
                  if (pendingFinalization && pendingFinalization.timeout) {
                    clearTimeout(pendingFinalization.timeout);
                    pendingFinalization = null;
                  }
''' + match.group(2)

content = re.sub(
    r'} else \{\s*// Final transcript from Google Speech - send immediately.*?(\n\s*// Process final immediately)',
    replace_final,
    content,
    flags=re.DOTALL
)

# Replace transcriptText with finalTextToProcess in the final processing section
content = re.sub(
    r'(console\.log\(`\[SoloMode\] ✅ Sending final transcript: "` \+ )transcriptText',
    r'\1finalTextToProcess',
    content
)
content = re.sub(
    r'(translatedText: )transcriptText(,)',
    r'\1finalTextToProcess\2',
    content
)
content = re.sub(
    r'(originalText: \'\',\s*translatedText: )transcriptText(,)',
    r'\1finalTextToProcess\2',
    content
)
content = re.sub(
    r'(const translatedText = await finalTranslationWorker\.translateFinal\(\s*)transcriptText',
    r'\1finalTextToProcess',
    content
)
content = re.sub(
    r'(original: "` \+ )transcriptText\.substring',
    r'\1finalTextToProcess.substring',
    content
)

# Write the file
with open('soloModeHandler.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Fixed partial tracking in soloModeHandler.js")

