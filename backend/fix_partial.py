#!/usr/bin/env python3
import sys

with open('soloModeHandler.js', 'r') as f:
    lines = f.readlines()

# Find the insertion point for tracking variables (after currentPartialText)
new_lines = []
i = 0
while i < len(lines):
    new_lines.append(lines[i])
    
    # Add tracking variables after currentPartialText
    if 'let currentPartialText =' in lines[i] and 'Track current partial text' in lines[i]:
        new_lines.append('              \n')
        new_lines.append('              // Track latest partial to prevent word loss when final arrives\n')
        new_lines.append('              // Google Speech can finalize a shorter phrase while partial has more text\n')
        new_lines.append('              let latestPartialText = \'\'; // Most recent partial text from Google Speech\n')
        new_lines.append('              let lastFinalText = \'\'; // Last final text received (for deduplication)\n')
    
    # Add partial tracking in isPartial block
    if i > 0 and 'if (isPartial) {' in lines[i-1] and '// Live partial transcript' in lines[i]:
        new_lines.insert(-1, '                  // CRITICAL: Track the latest partial text to prevent word loss\n')
        new_lines.insert(-1, '                  // Google Speech can finalize a shorter phrase while a partial has more text\n')
        new_lines.insert(-1, '                  // This happens during continuous speech when the API finalizes an earlier chunk\n')
        new_lines.insert(-1, '                  if (transcriptText.length > latestPartialText.length || \n')
        new_lines.insert(-1, '                      !latestPartialText || \n')
        new_lines.insert(-1, '                      !transcriptText.startsWith(latestPartialText.substring(0, Math.min(latestPartialText.length, 50)))) {\n')
        new_lines.insert(-1, '                    latestPartialText = transcriptText;\n')
        new_lines.insert(-1, '                  }\n')
        new_lines.insert(-1, '                  \n')
    
    i += 1

# Now handle the final block - find and replace it
output = ''.join(new_lines)

# Replace the final handling section
import re

# Find the final block
final_start = output.find('} else {\n                  // Final transcript from Google Speech')
if final_start == -1:
    print("Could not find final block")
    sys.exit(1)

# Find where the async function starts
async_start = output.find('// Process final immediately', final_start)
if async_start == -1:
    print("Could not find async start")
    sys.exit(1)

# Extract the parts
before = output[:final_start]
after = output[async_start:]

# Build the replacement
replacement = '''} else {
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
                  
                  '''

# Replace transcriptText with finalTextToProcess in the async function
async_section = after
async_section = async_section.replace('transcriptText.substring(0, 50)', 'finalTextToProcess.substring(0, 50)')
async_section = async_section.replace('finalTranslationWorker.translateFinal(\n                            transcriptText,', 'finalTranslationWorker.translateFinal(\n                            finalTextToProcess,')
async_section = async_section.replace('originalText: transcriptText,', 'originalText: finalTextToProcess,')
async_section = async_section.replace('translatedText: transcriptText,', 'translatedText: finalTextToProcess,')
async_section = async_section.replace('originalText: transcriptText,', 'originalText: finalTextToProcess,')
async_section = async_section.replace('(original: "` + transcriptText.substring', '(original: "` + finalTextToProcess.substring')

output = before + replacement + async_section

with open('soloModeHandler.js', 'w') as f:
    f.write(output)

print("Fixed partial tracking!")

