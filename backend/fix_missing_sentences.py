#!/usr/bin/env python3
"""Fix missing sentences by tracking partials and accumulating finals"""

with open('soloModeHandler.js', 'r') as f:
    content = f.read()

# 1. Add tracking variables after currentPartialText
content = content.replace(
    'let currentPartialText = \'\'; // Track current partial text for delayed translations\n              \n              // EXTREME SPEED:',
    '''let currentPartialText = ''; // Track current partial text for delayed translations
              
              // Track latest partial to prevent word loss when final arrives
              // Google Speech can finalize a shorter phrase while partial has more text
              let latestPartialText = ''; // Most recent partial text from Google Speech
              let accumulatedFinals = ''; // Accumulate multiple final results for long phrases
              let lastFinalText = ''; // Last final text received (for deduplication)
              
              // EXTREME SPEED:'''
)

# 2. Add partial tracking in isPartial block
content = content.replace(
    '''                if (isPartial) {
                  // Live partial transcript - send original immediately with sequence ID''',
    '''                if (isPartial) {
                  // CRITICAL: Track the latest partial text to prevent word loss
                  // Google Speech can finalize a shorter phrase while a partial has more text
                  // This happens during continuous speech when the API finalizes an earlier chunk
                  if (transcriptText.length > latestPartialText.length || 
                      !latestPartialText || 
                      !transcriptText.startsWith(latestPartialText.substring(0, Math.min(latestPartialText.length, 50)))) {
                    latestPartialText = transcriptText;
                  }
                  
                  // Live partial transcript - send original immediately with sequence ID'''
)

# 3. Replace the final handling section
# Find the final block
final_start_marker = '} else {\n                  // Final transcript from Google Speech - send immediately (restored simple approach)'
final_end_marker = '                  })();\n                }\n              });'

if final_start_marker in content and final_end_marker in content:
    # Extract before and after
    before = content[:content.find(final_start_marker)]
    after = content[content.find(final_end_marker) + len(final_end_marker):]
    
    # New final handling code
    new_final_code = '''} else {
                  // Final transcript from Google Speech
                  // CRITICAL FIX: Handle multiple finals and merge with partials to prevent word loss
                  console.log(`[SoloMode] 📝 FINAL Transcript (raw): "${transcriptText.substring(0, 50)}..."`);
                  
                  // Accumulate this final with any previous finals (Google can send multiple finals for long phrases)
                  // Check if this final extends or is new compared to accumulated finals
                  let finalTextToProcess = transcriptText;
                  
                  if (accumulatedFinals) {
                    // Check if this final is a continuation or replacement
                    const findOverlap = (oldText, newText) => {
                      if (!oldText || !newText) return 0;
                      const minLen = Math.min(oldText.length, newText.length);
                      // Try progressively smaller suffixes to find overlap
                      for (let i = Math.min(minLen, 100); i > 20; i--) {
                        const oldSuffix = oldText.slice(-i).trim();
                        if (newText.trim().startsWith(oldSuffix)) {
                          return oldText.length - i; // Return position where overlap starts
                        }
                      }
                      return -1; // No overlap found
                    };
                    
                    const overlapPos = findOverlap(accumulatedFinals, transcriptText);
                    if (overlapPos >= 0) {
                      // This final extends the accumulated text - merge them
                      const newPart = transcriptText.substring(accumulatedFinals.length - (accumulatedFinals.length - overlapPos)).trim();
                      if (newPart) {
                        accumulatedFinals = accumulatedFinals + ' ' + newPart;
                        finalTextToProcess = accumulatedFinals;
                        console.log(`[SoloMode] 📦 Accumulated final (${transcriptText.length} → ${accumulatedFinals.length} chars)`);
                      } else {
                        // New final is contained in accumulated - use accumulated
                        finalTextToProcess = accumulatedFinals;
                        console.log(`[SoloMode] ⏭️ Final already in accumulated text`);
                      }
                    } else if (transcriptText.length > accumulatedFinals.length * 1.5) {
                      // New final is much longer - likely a replacement, use it
                      accumulatedFinals = transcriptText;
                      finalTextToProcess = transcriptText;
                      console.log(`[SoloMode] 🔄 Replacing accumulated with longer final`);
                    } else {
                      // No clear relationship - append (might be a new segment)
                      accumulatedFinals = accumulatedFinals + ' ' + transcriptText.trim();
                      finalTextToProcess = accumulatedFinals;
                      console.log(`[SoloMode] ➕ Appending final to accumulated`);
                    }
                  } else {
                    // First final - start accumulation
                    accumulatedFinals = transcriptText;
                    finalTextToProcess = transcriptText;
                  }
                  
                  // CRITICAL: Check if latest partial extends beyond the processed final
                  // This prevents word loss when Google finalizes an earlier chunk while partial has more
                  if (latestPartialText && latestPartialText.length > finalTextToProcess.length) {
                    // Check if partial extends beyond final
                    if (latestPartialText.startsWith(finalTextToProcess.trim())) {
                      // Partial extends beyond final - use the longer partial text
                      finalTextToProcess = latestPartialText;
                      accumulatedFinals = latestPartialText; // Update accumulation too
                      console.log(`[SoloMode] ⚠️ FINAL truncated - using partial instead (${finalTextToProcess.length - latestPartialText.length} → ${latestPartialText.length} chars)`);
                      console.log(`[SoloMode]   Final: "${finalTextToProcess.substring(0, 80)}..."`);
                      console.log(`[SoloMode]   Partial: "${latestPartialText.substring(0, 80)}..."`);
                    } else {
                      // Check for overlap between final and partial
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
                      
                      const overlap = findOverlap(finalTextToProcess, latestPartialText);
                      if (overlap > 0 && latestPartialText.length > finalTextToProcess.length) {
                        // Merge: final + new part from partial
                        const newPart = latestPartialText.substring(overlap);
                        finalTextToProcess = finalTextToProcess.trim() + ' ' + newPart.trim();
                        accumulatedFinals = finalTextToProcess;
                        console.log(`[SoloMode] ⚠️ FINAL merged with partial (${transcriptText.length} + ${newPart.length} = ${finalTextToProcess.length} chars)`);
                        console.log(`[SoloMode]   Final: "${finalTextToProcess.substring(0, 80)}..."`);
                        console.log(`[SoloMode]   Partial: "${latestPartialText.substring(0, 80)}..."`);
                        console.log(`[SoloMode]   Merged: "${finalTextToProcess.substring(0, 80)}..."`);
                      }
                    }
                  }
                  
                  // Deduplicate: Skip if this processed final is the same as the last one sent
                  if (finalTextToProcess === lastFinalText) {
                    console.log(`[SoloMode] ⏭️ Skipping duplicate final: "${finalTextToProcess.substring(0, 50)}..."`);
                    // Reset partial tracking even if skipping
                    latestPartialText = '';
                    return;
                  }
                  lastFinalText = finalTextToProcess;
                  
                  // Reset latest partial after processing final (but keep accumulatedFinals for next final)
                  latestPartialText = '';
                  
                  console.log(`[SoloMode] 📝 FINAL Transcript (processed): "${finalTextToProcess.substring(0, 80)}..."`);
                  
                  // Cancel any pending finalization timeout (in case we had delayed finalization)
                  if (pendingFinalization && pendingFinalization.timeout) {
                    clearTimeout(pendingFinalization.timeout);
                    pendingFinalization = null;
                  }
                  
                  // Process final immediately - translate and send to client
                  (async () => {
                    try {
                      if (isTranscriptionOnly) {
                        // Same language - just send transcript
                        console.log(`[SoloMode] ✅ Sending final transcript: "${finalTextToProcess.substring(0, 50)}..."`);
                        sendWithSequence({
                          type: 'translation',
                          originalText: '',
                          translatedText: finalTextToProcess,
                          timestamp: Date.now()
                        }, false);
                        
                        // Clear accumulated finals after sending (they've been processed)
                        accumulatedFinals = '';
                      } else {
                        // Different language - translate the transcript
                        try {
                          // Use dedicated final translation worker (high-quality, GPT-4o)
                          const translatedText = await finalTranslationWorker.translateFinal(
                            finalTextToProcess,
                            currentSourceLang,
                            currentTargetLang,
                            process.env.OPENAI_API_KEY
                          );
                          
                          console.log(`[SoloMode] ✅ Sending final translation: "${translatedText.substring(0, 50)}..." (original: "${finalTextToProcess.substring(0, 50)}...")`);
                          
                          sendWithSequence({
                            type: 'translation',
                            originalText: finalTextToProcess,
                            translatedText: translatedText,
                            timestamp: Date.now()
                          }, false);
                          
                          // Clear accumulated finals after sending (they've been processed)
                          accumulatedFinals = '';
                        } catch (error) {
                          console.error(`[SoloMode] Final translation error:`, error);
                          // Send transcript as fallback
                          sendWithSequence({
                            type: 'translation',
                            originalText: finalTextToProcess,
                            translatedText: `[Translation error: ${error.message}]`,
                            timestamp: Date.now()
                          }, false);
                          // Clear accumulated on error too
                          accumulatedFinals = '';
                        }
                      }
                    } catch (error) {
                      console.error(`[SoloMode] Error processing final:`, error);
                      accumulatedFinals = '';
                    }
                  })();
                }'''
    
    content = before + new_final_code + after
else:
    print("ERROR: Could not find final block markers")
    print("Looking for:", final_start_marker[:50])
    exit(1)

with open('soloModeHandler.js', 'w') as f:
    f.write(content)

print("✅ Fixed missing sentences by tracking partials and accumulating finals!")

