/**
 * Recovery Stream Engine - Handles audio recovery stream operations
 * 
 * Extracted from soloModeHandler.js and host/adapter.js to eliminate duplication.
 * 
 * This engine handles the complete recovery stream flow:
 * - Stream creation and initialization
 * - Audio processing and result waiting
 * - Text merging and commit logic
 * - Error handling and cleanup
 * 
 * CRITICAL: This must maintain exact same behavior as the original implementations.
 */

import { mergeRecoveryText } from '../../backend/utils/recoveryMerge.js';

/**
 * Recovery Stream Engine class
 * Manages recovery stream operations for forced final audio recovery
 */
export class RecoveryStreamEngine {
  constructor() {
    // Timing constants (standardized to conservative values)
    this.STREAM_READY_POLL_INTERVAL_MS = 25; // Fast polling for quick detection
    this.STREAM_READY_MAX_WAIT_MS = 2000; // Longer wait for reliability
    this.RECOVERY_STREAM_TIMEOUT_MS = 5000; // Longer timeout for reliability
    this.ADDITIONAL_WAIT_MS = 50; // Short wait after stream ready
  }

  /**
   * Perform recovery stream operation
   * 
   * @param {Object} params - Recovery stream parameters
   * @param {Object} params.speechStream - Speech stream with getRecentAudio() method
   * @param {string} params.sourceLang - Source language for stream initialization
   * @param {ForcedCommitEngine} params.forcedCommitEngine - Forced commit engine for state management
   * @param {string} params.finalWithPartials - Text with late partials to merge with
   * @param {string} params.latestPartialText - Latest partial text for merge context
   * @param {Object} params.nextFinalAfterRecovery - Next final after recovery for merge context
   * @param {string} params.bufferedText - Original forced final text
   * @param {Function} params.processFinalText - Callback to commit recovered text
   * @param {Function} params.syncForcedFinalBuffer - Function to sync buffer state
   * @param {Function} params.syncPartialVariables - Function to sync partial variables
   * @param {string} params.mode - 'SoloMode' or 'HostMode' for logging
   * @param {Object} params.recoveryStartTime - Reference to recovery start time (will be reset)
   * @param {Object} params.nextFinalAfterRecovery - Reference to next final (will be reset)
   * @param {Buffer} params.recoveryAudio - Audio buffer to recover (if already captured)
   * @returns {Promise<string>} Recovered text or empty string
   */
  async performRecoveryStream({
    speechStream,
    sourceLang,
    forcedCommitEngine,
    finalWithPartials,
    latestPartialText,
    nextFinalAfterRecovery,
    bufferedText,
    processFinalText,
    syncForcedFinalBuffer,
    syncPartialVariables,
    mode = 'UnknownMode',
    recoveryStartTime,
    nextFinalAfterRecovery: nextFinalRef,
    recoveryAudio: providedRecoveryAudio
  }) {
    // Get recovery audio if not provided
    const captureWindowMs = forcedCommitEngine.CAPTURE_WINDOW_MS || 2200;
    const recoveryAudio = providedRecoveryAudio || speechStream.getRecentAudio(captureWindowMs);

    console.log(`[${mode}] 🎵 Starting decoder gap recovery with PRE+POST-final audio: ${recoveryAudio.length} bytes`);

    // CRITICAL: Create recovery promise BEFORE starting recovery
    // This allows other code (like new FINALs) to wait for recovery to complete
    let recoveryResolve = null;
    const recoveryPromise = new Promise((resolve) => {
      recoveryResolve = resolve;
    });

    // Store recovery promise in buffer so other code can await it
    syncForcedFinalBuffer();
    if (forcedCommitEngine.hasForcedFinalBuffer()) {
      forcedCommitEngine.setRecoveryInProgress(true, recoveryPromise);
      syncForcedFinalBuffer();
      console.log(`[${mode}] ✅ Recovery promise created and stored in buffer`);
    }

    try {
      console.log(`[${mode}] 🔄 ENTERED recovery try block - about to import GoogleSpeechStream...`);
      console.log(`[${mode}] 🔄 Importing GoogleSpeechStream...`);
      
      // Import GoogleSpeechStream - use path that works from core/engine/
      // Both solo and host modes have googleSpeechStream.js in backend/
      const { GoogleSpeechStream } = await import('../../backend/googleSpeechStream.js');

      const tempStream = new GoogleSpeechStream();
      await tempStream.initialize(sourceLang, { 
        disablePunctuation: true,
        forceEnhanced: true  // Always use enhanced model for recovery streams
      });

      // CRITICAL: Disable auto-restart for recovery stream
      // We want it to end naturally after processing our audio
      tempStream.shouldAutoRestart = false;

      console.log(`[${mode}] ✅ Temporary recovery stream initialized (auto-restart disabled)`);

      // Wait for stream to be FULLY ready (not just exist)
      console.log(`[${mode}] ⏳ Waiting for recovery stream to be ready...`);
      let streamReadyTimeout = 0;
      while (!tempStream.isStreamReady() && streamReadyTimeout < this.STREAM_READY_MAX_WAIT_MS) {
        await new Promise(resolve => setTimeout(resolve, this.STREAM_READY_POLL_INTERVAL_MS));
        streamReadyTimeout += this.STREAM_READY_POLL_INTERVAL_MS;
      }

      if (!tempStream.isStreamReady()) {
        console.log(`[${mode}] ❌ Recovery stream not ready after ${this.STREAM_READY_MAX_WAIT_MS}ms!`);
        console.log(`[${mode}] Stream state:`, {
          exists: !!tempStream.recognizeStream,
          writable: tempStream.recognizeStream?.writable,
          destroyed: tempStream.recognizeStream?.destroyed,
          isActive: tempStream.isActive,
          isRestarting: tempStream.isRestarting
        });
        throw new Error('Recognition stream not ready');
      }

      console.log(`[${mode}] ✅ Recovery stream ready after ${streamReadyTimeout}ms`);
      await new Promise(resolve => setTimeout(resolve, this.ADDITIONAL_WAIT_MS));
      console.log(`[${mode}] ✅ Additional ${this.ADDITIONAL_WAIT_MS}ms wait complete`);

      // Set up result handler and create promise to wait for stream completion
      let recoveredText = '';
      let lastPartialText = '';
      let allPartials = [];

      // CRITICAL: Create promise that waits for Google's 'end' event
      const streamCompletionPromise = new Promise((resolve) => {
        tempStream.onResult((text, isPartial) => {
          console.log(`[${mode}] 📥 Recovery stream ${isPartial ? 'PARTIAL' : 'FINAL'}: "${text}"`);
          if (!isPartial) {
            recoveredText = text;
          } else {
            allPartials.push(text);
            lastPartialText = text;
          }
        });

        // Wait for Google to finish processing (stream 'end' event)
        tempStream.recognizeStream.on('end', () => {
          console.log(`[${mode}] 🏁 Recovery stream 'end' event received from Google`);
          resolve();
        });

        // Also handle errors
        tempStream.recognizeStream.on('error', (err) => {
          console.error(`[${mode}] ❌ Recovery stream error:`, err);
          resolve(); // Resolve anyway to prevent hanging
        });
      });

      // Send the PRE+POST-final audio DIRECTLY to recognition stream
      // BYPASS jitter buffer - send entire audio as one write for recovery
      console.log(`[${mode}] 📤 Sending ${recoveryAudio.length} bytes directly to recovery stream (bypassing jitter buffer)...`);

      // Write directly to the recognition stream
      if (tempStream.recognizeStream && tempStream.isStreamReady()) {
        tempStream.recognizeStream.write(recoveryAudio);
        console.log(`[${mode}] ✅ Audio written directly to recognition stream`);

        // CRITICAL: End write side IMMEDIATELY after writing
        // This tells Google "no more audio coming, finalize what you have"
        tempStream.recognizeStream.end();
        console.log(`[${mode}] ✅ Write side closed - waiting for Google to process and send results...`);
      } else {
        console.error(`[${mode}] ❌ Recovery stream not ready for direct write!`);
        throw new Error('Recovery stream not ready');
      }

      // Wait for Google to process and send back results
      // This waits for the actual 'end' event, not a timer
      console.log(`[${mode}] ⏳ Waiting for Google to decode and send results (stream 'end' event)...`);

      // Add timeout to prevent infinite hang
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
          console.warn(`[${mode}] ⚠️ Recovery stream timeout after ${this.RECOVERY_STREAM_TIMEOUT_MS}ms`);
          resolve();
        }, this.RECOVERY_STREAM_TIMEOUT_MS);
      });

      await Promise.race([streamCompletionPromise, timeoutPromise]);
      console.log(`[${mode}] ✅ Google decode wait complete`);

      // Use last partial if no final
      if (!recoveredText && lastPartialText) {
        recoveredText = lastPartialText;
      }

      console.log(`[${mode}] 📊 === DECODER GAP RECOVERY RESULTS ===`);
      console.log(`[${mode}]   Total partials: ${allPartials.length}`);
      console.log(`[${mode}]   All partials: ${JSON.stringify(allPartials)}`);
      console.log(`[${mode}]   Final text: "${recoveredText}"`);
      console.log(`[${mode}]   Audio sent: ${recoveryAudio.length} bytes`);

      // Clean up
      tempStream.destroy();

      // Find the missing words by comparing recovered vs buffered
      let finalRecoveredText = '';
      let mergeResult = null;
      if (recoveredText && recoveredText.length > 0) {
        console.log(`[${mode}] ✅ Recovery stream transcribed: "${recoveredText}"`);

        // Use shared merge utility for improved merge logic
        syncPartialVariables();
        
        mergeResult = mergeRecoveryText(
          finalWithPartials,
          recoveredText,
          {
            nextPartialText: latestPartialText,
            nextFinalText: nextFinalAfterRecovery?.text,
            mode: mode
          }
        );

        // Use merge result
        let finalTextToCommit = finalWithPartials;
        const originalBufferedText = finalWithPartials;
        if (mergeResult.merged) {
          finalTextToCommit = mergeResult.mergedText;
          finalRecoveredText = mergeResult.mergedText; // Store for promise resolution
          console.log(`[${mode}] 📋 Merge result: ${mergeResult.reason}`);
        } else {
          // Fallback to buffered text if merge failed
          finalTextToCommit = finalWithPartials;
          console.log(`[${mode}] ⚠️ Merge failed: ${mergeResult.reason}`);
        }
        
        // CRITICAL: If recovery found additional words, commit them as an update
        // The forced final was already committed immediately when detected
        // Recovery just adds the missing words we found
        // Special handling for "full append" case (no overlap - entire recovery appended)
        const isFullAppend = mergeResult?.reason?.startsWith('No overlap - full append');
        const hasAdditionalWords = finalTextToCommit !== originalBufferedText && finalTextToCommit.length > originalBufferedText.length;
        
        if (isFullAppend || hasAdditionalWords) {
          // Check if buffer still exists before committing recovery update
          syncForcedFinalBuffer();
          if (forcedCommitEngine.hasForcedFinalBuffer()) {
            const additionalWords = finalTextToCommit.substring(originalBufferedText.length).trim();
            if (isFullAppend) {
              console.log(`[${mode}] 📎 Full append case detected - appending entire recovery text`);
            }
            console.log(`[${mode}] ✅ Recovery found additional words: "${additionalWords}"`);
            console.log(`[${mode}] 📊 Committing recovery update: "${finalTextToCommit.substring(0, 80)}..."`);
            
            // Mark as committed by recovery BEFORE clearing buffer
            syncForcedFinalBuffer();
            const forcedFinalBuffer = forcedCommitEngine.getForcedFinalBuffer();
            if (forcedFinalBuffer) {
              forcedFinalBuffer.committedByRecovery = true;
            }
            
            // Commit the full recovered text (forced final + recovery words)
            processFinalText(finalTextToCommit, { forceFinal: true });
            forcedCommitEngine.clearForcedFinalBuffer();
            syncForcedFinalBuffer();
            
            // Reset recovery tracking after commit (if passed as object refs)
            if (recoveryStartTime && typeof recoveryStartTime === 'object' && 'value' in recoveryStartTime) {
              recoveryStartTime.value = 0;
            }
            if (nextFinalRef && typeof nextFinalRef === 'object' && 'value' in nextFinalRef) {
              nextFinalRef.value = null;
            }
            
            // Mark that we've already committed, so timeout callback can skip
            console.log(`[${mode}] ✅ Recovery commit completed - timeout callback will skip`);
          } else {
            console.log(`[${mode}] ⚠️ Buffer already cleared - recovery found words but cannot commit update`);
          }
        } else {
          // CRITICAL FIX: Even if recovery didn't find additional words, we must still commit the forced final
          // Don't wait for timeout - commit immediately to ensure it's never lost
          // The timeout might skip if buffer is cleared by new FINAL or extending partial
          syncForcedFinalBuffer();
          if (forcedCommitEngine.hasForcedFinalBuffer()) {
            const forcedFinalBuffer = forcedCommitEngine.getForcedFinalBuffer();
            const forcedFinalText = forcedFinalBuffer.text;
            
            console.log(`[${mode}] ✅ No new text recovered - committing forced final immediately to prevent loss`);
            console.log(`[${mode}] 📊 Committing forced final: "${forcedFinalText.substring(0, 80)}..."`);
            
            // Mark as committed by recovery BEFORE clearing buffer
            if (forcedFinalBuffer) {
              forcedFinalBuffer.committedByRecovery = true;
            }
            
            // Commit the forced final (with grammar correction via processFinalText)
            processFinalText(forcedFinalText, { forceFinal: true });
            forcedCommitEngine.clearForcedFinalBuffer();
            syncForcedFinalBuffer();
            
            // Reset recovery tracking after commit
            if (recoveryStartTime && typeof recoveryStartTime === 'object' && 'value' in recoveryStartTime) {
              recoveryStartTime.value = 0;
            }
            if (nextFinalRef && typeof nextFinalRef === 'object' && 'value' in nextFinalRef) {
              nextFinalRef.value = null;
            }
            
            console.log(`[${mode}] ✅ Forced final committed - timeout callback will skip`);
          } else {
            console.log(`[${mode}] ⚠️ Buffer already cleared - forced final was likely committed by new FINAL or extending partial`);
          }
        }
      } else {
        // CRITICAL FIX: Even if recovery stream returned no text, we must still commit the forced final
        // Don't wait for timeout - commit immediately to ensure it's never lost
        console.log(`[${mode}] ⚠️ Recovery stream returned no text - committing forced final immediately to prevent loss`);
        syncForcedFinalBuffer();
        if (forcedCommitEngine.hasForcedFinalBuffer()) {
          const forcedFinalBuffer = forcedCommitEngine.getForcedFinalBuffer();
          const forcedFinalText = forcedFinalBuffer.text;
          
          console.log(`[${mode}] 📊 Committing forced final: "${forcedFinalText.substring(0, 80)}..."`);
          
          // Mark as committed by recovery BEFORE clearing buffer
          if (forcedFinalBuffer) {
            forcedFinalBuffer.committedByRecovery = true;
          }
          
          // Commit the forced final (with grammar correction via processFinalText)
          processFinalText(forcedFinalText, { forceFinal: true });
          forcedCommitEngine.clearForcedFinalBuffer();
          syncForcedFinalBuffer();
          
          // Reset recovery tracking after commit
          if (recoveryStartTime && typeof recoveryStartTime === 'object' && 'value' in recoveryStartTime) {
            recoveryStartTime.value = 0;
          }
          if (nextFinalRef && typeof nextFinalRef === 'object' && 'value' in nextFinalRef) {
            nextFinalRef.value = null;
          }
          
          console.log(`[${mode}] ✅ Forced final committed - timeout callback will skip`);
        } else {
          console.log(`[${mode}] ⚠️ Buffer already cleared - forced final was likely committed by new FINAL or extending partial`);
        }
      }

      // CRITICAL: Resolve recovery promise with recovered text (or empty if nothing found)
      // This allows other code (like new FINALs) to wait for recovery to complete
      if (recoveryResolve) {
        console.log(`[${mode}] ✅ Resolving recovery promise with recovered text: "${finalRecoveredText || ''}"`);
        recoveryResolve(finalRecoveredText || '');
      }

      return finalRecoveredText || '';

    } catch (error) {
      console.error(`[${mode}] ❌ Decoder gap recovery failed:`, error.message);
      console.error(`[${mode}] ❌ Error stack:`, error.stack);
      console.error(`[${mode}] ❌ Full error object:`, error);
      
      // CRITICAL: Resolve recovery promise even on error (with empty string)
      // This prevents other code from hanging while waiting for recovery
      if (recoveryResolve) {
        console.log(`[${mode}] ⚠️ Resolving recovery promise with empty text due to error`);
        recoveryResolve('');
      }
      
      return '';
    } finally {
      // Mark recovery as complete
      syncForcedFinalBuffer();
      if (forcedCommitEngine.hasForcedFinalBuffer()) {
        forcedCommitEngine.setRecoveryInProgress(false, null);
        syncForcedFinalBuffer();
      }
    }
  }
}

export default RecoveryStreamEngine;

