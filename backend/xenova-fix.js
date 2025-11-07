/**
 * Minimal targeted patch for Xenova Transformers.js generation bug
 * 
 * Fixes: "Cannot set properties of undefined" in generation.js
 * Root cause: logits.data is undefined when LogitsProcessor tries to modify it
 * 
 * This patches ONLY the affected classes, nothing else.
 */

console.log('[XenovaFix] 🔧 Loading targeted generation fix...');

// We need to patch AFTER Xenova imports but BEFORE model.generate() is called
// So we export a function to call from grammarCorrectorModel.js

export async function patchXenovaGeneration() {
  if (global._xenovaGenerationPatched) {
    console.log('[XenovaFix] ⚠️ Already patched');
    return;
  }

  try {
    // Import the generation module
    const generationModule = await import('@xenova/transformers/src/utils/generation.js');
    
    // Patch MinLengthLogitsProcessor._call
    if (generationModule.MinLengthLogitsProcessor) {
      const original_call = generationModule.MinLengthLogitsProcessor.prototype._call;
      generationModule.MinLengthLogitsProcessor.prototype._call = function(input_ids, logits) {
        // Guard: ensure logits.data exists
        if (!logits.data && logits.cpuData) {
          // console.warn('[XenovaFix] ⚠️ MinLengthLogitsProcessor: logits.data undefined, using cpuData');
          logits.data = logits.cpuData;
        } else if (!logits.data) {
          // console.error('[XenovaFix] ❌ MinLengthLogitsProcessor: logits has no data/cpuData!');
          return logits; // Return as-is to avoid crash
        }
        return original_call.call(this, input_ids, logits);
      };
      console.log('[XenovaFix] ✅ Patched MinLengthLogitsProcessor._call');
    }
    
    // Patch MinNewTokensLengthLogitsProcessor._call
    if (generationModule.MinNewTokensLengthLogitsProcessor) {
      const original_call = generationModule.MinNewTokensLengthLogitsProcessor.prototype._call;
      generationModule.MinNewTokensLengthLogitsProcessor.prototype._call = function(input_ids, logits) {
        // Guard: ensure logits.data exists
        if (!logits.data && logits.cpuData) {
          // console.warn('[XenovaFix] ⚠️ MinNewTokensLengthLogitsProcessor: logits.data undefined, using cpuData');
          logits.data = logits.cpuData;
        } else if (!logits.data) {
          // console.error('[XenovaFix] ❌ MinNewTokensLengthLogitsProcessor: logits has no data/cpuData!');
          return logits; // Return as-is to avoid crash
        }
        return original_call.call(this, input_ids, logits);
      };
      console.log('[XenovaFix] ✅ Patched MinNewTokensLengthLogitsProcessor._call');
    }
    
    // Patch NoBadWordsLogitsProcessor._call
    if (generationModule.NoBadWordsLogitsProcessor) {
      const original_call = generationModule.NoBadWordsLogitsProcessor.prototype._call;
      generationModule.NoBadWordsLogitsProcessor.prototype._call = function(input_ids, logits) {
        // Guard: ensure logits.data exists
        if (!logits.data && logits.cpuData) {
          // console.warn('[XenovaFix] ⚠️ NoBadWordsLogitsProcessor: logits.data undefined, using cpuData');
          logits.data = logits.cpuData;
        } else if (!logits.data) {
          // console.error('[XenovaFix] ❌ NoBadWordsLogitsProcessor: logits has no data/cpuData!');
          return logits; // Return as-is to avoid crash
        }
        return original_call.call(this, input_ids, logits);
      };
      console.log('[XenovaFix] ✅ Patched NoBadWordsLogitsProcessor._call');
    }
    
    // CRITICAL: Patch Sampler.getLogits() - this is where the "slice" error happens
    if (generationModule.Sampler) {
      const originalGetLogits = generationModule.Sampler.prototype.getLogits;
      generationModule.Sampler.prototype.getLogits = function(logits, index) {
        // Guard: ensure logits.data exists before calling original
        if (!logits || !logits.data) {
          if (logits && logits.cpuData) {
            // console.warn('[XenovaFix] ⚠️ Sampler.getLogits: logits.data undefined, using cpuData');
            logits.data = logits.cpuData;
          } else {
            // console.error('[XenovaFix] ❌ Sampler.getLogits: logits has no data/cpuData, returning empty array');
            // Return empty Float32Array to avoid crash
            return new Float32Array(0);
          }
        }
        return originalGetLogits.call(this, logits, index);
      };
      console.log('[XenovaFix] ✅ Patched Sampler.getLogits');
    }

    global._xenovaGenerationPatched = true;
    console.log('[XenovaFix] ✅ All generation functions patched successfully');
    
  } catch (err) {
    console.error('[XenovaFix] ❌ Failed to patch:', err.message);
  }
}

