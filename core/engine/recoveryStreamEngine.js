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
import { CandidateSource } from './finalityGate.js';

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
    finalityGate,
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
    recoveryAudio: providedRecoveryAudio,
    segmentId = null
  }) {
    // Get recovery audio if not provided
    const captureWindowMs = forcedCommitEngine.CAPTURE_WINDOW_MS || 2200;
    const recoveryAudio = providedRecoveryAudio || speechStream.getRecentAudio(captureWindowMs);

    console.log(`[${mode}] 🎵 Starting decoder gap recovery with PRE+POST-final audio: ${recoveryAudio.length} bytes`);

    // CRITICAL: Mark recovery as pending in FinalityGate BEFORE starting recovery
    // This blocks lower-priority candidates (grammar/forced) from finalizing while recovery is in progress
    if (finalityGate) {
      finalityGate.markRecoveryPending(segmentId);
      console.log(`[${mode}] 🔴 FinalityGate: Marked recovery as pending for segment ${segmentId || 'default'}`);
    }

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
            console.log(`[${mode}] 📊 RECOVERY COMMIT - Committing recovery update:`);
            console.log(`[${mode}]   Merged text: "${finalTextToCommit.substring(0, 80)}..."`);
            console.log(`[${mode}]   Original buffered: "${originalBufferedText.substring(0, 80)}..."`);
            console.log(`[${mode}]   Additional words: "${additionalWords}"`);
            
            // Mark as committed by recovery BEFORE clearing buffer
            syncForcedFinalBuffer();
            const forcedFinalBuffer = forcedCommitEngine.getForcedFinalBuffer();
            
            // CRITICAL: Capture lastSentOriginalTextBeforeBuffer (preferred) or lastSentFinalTextBeforeBuffer BEFORE clearing buffer
            // This is the previous final that was sent BEFORE this forced final was buffered
            // We need to pass this to processFinalText so it can use it for deduplication
            // Prefer lastSentOriginalTextBeforeBuffer (full original text) over lastSentFinalTextBeforeBuffer (grammar-corrected shortened version)
            const lastSentOriginalTextBeforeBuffer = forcedFinalBuffer?.lastSentOriginalTextBeforeBuffer || null;
            const lastSentFinalTextBeforeBuffer = forcedFinalBuffer?.lastSentFinalTextBeforeBuffer || null;
            const lastSentFinalTimeBeforeBuffer = forcedFinalBuffer?.lastSentFinalTimeBeforeBuffer || null;
            
            // CRITICAL FIX: If buffer values are empty, we can't deduplicate the recovery commit itself,
            // but processFinalText will handle it using lastSentFinalText. However, we should ensure
            // that the recovery commit text (finalTextToCommit) will be used as the basis for NEXT final deduplication.
            // Prefer original text for deduplication (full text vs shortened grammar-corrected version)
            let previousFinalTextForDeduplication = lastSentOriginalTextBeforeBuffer || lastSentFinalTextBeforeBuffer;
            
            // If both are empty, we can't provide previous text for deduplication of THIS recovery commit
            // But processFinalText will use lastSentFinalText for deduplication, and after this commit,
            // lastSentFinalText will be set to finalTextToCommit, which will be used for NEXT final deduplication
            if (!previousFinalTextForDeduplication) {
              console.log(`[${mode}] ⚠️ WARNING: Both lastSentOriginalTextBeforeBuffer and lastSentFinalTextBeforeBuffer are empty`);
              console.log(`[${mode}] ⚠️ Recovery commit will use lastSentFinalText for deduplication (from processFinalText closure)`);
              console.log(`[${mode}] ⚠️ After recovery commit, lastSentFinalText will be set to recovery commit text for NEXT final deduplication`);
            }
            
            console.log(`[${mode}] 🔍 RECOVERY COMMIT - Previous final text for deduplication:`);
            console.log(`[${mode}]   lastSentOriginalTextBeforeBuffer: "${lastSentOriginalTextBeforeBuffer ? lastSentOriginalTextBeforeBuffer.substring(Math.max(0, lastSentOriginalTextBeforeBuffer.length - 80)) : '(empty)'}"`);
            console.log(`[${mode}]   lastSentFinalTextBeforeBuffer: "${lastSentFinalTextBeforeBuffer ? lastSentFinalTextBeforeBuffer.substring(Math.max(0, lastSentFinalTextBeforeBuffer.length - 80)) : '(empty)'}" (fallback)`);
            console.log(`[${mode}]   Using for deduplication: "${previousFinalTextForDeduplication ? previousFinalTextForDeduplication.substring(Math.max(0, previousFinalTextForDeduplication.length - 80)) : '(none - will use lastSentFinalText from closure)'}"`);
            console.log(`[${mode}]   lastSentFinalTimeBeforeBuffer: ${lastSentFinalTimeBeforeBuffer || '(not set)'}`);
            console.log(`[${mode}]   This is the final that was sent BEFORE the forced final was buffered`);
            console.log(`[${mode}]   Will be used for deduplication to ensure correct previous segment comparison`);
            
            if (forcedFinalBuffer) {
              forcedFinalBuffer.committedByRecovery = true;
            }
            
            // Commit the full recovered text (forced final + recovery words)
            // CRITICAL: Use FinalityGate to enforce dominance rules
            // Recovery candidates always win over grammar/forced candidates
            console.log(`[${mode}] 📤 Calling processFinalText with recovery context:`);
            console.log(`[${mode}]   Text to commit: "${finalTextToCommit.substring(0, 80)}..."`);
            console.log(`[${mode}]   Previous final for deduplication: "${previousFinalTextForDeduplication ? previousFinalTextForDeduplication.substring(Math.max(0, previousFinalTextForDeduplication.length - 80)) : '(none)'}"`);
            
            // CRITICAL: Submit recovery candidate to FinalityGate (DO NOT finalize here)
            // processFinalText is the single authority for finalization
            if (finalityGate) {
              const candidate = {
                text: finalTextToCommit,
                source: CandidateSource.Recovery,
                segmentId: segmentId,
                timestamp: Date.now(),
                options: {
                  previousFinalTextForDeduplication: previousFinalTextForDeduplication,
                  previousFinalTimeForDeduplication: lastSentFinalTimeBeforeBuffer
                }
              };
              // Submit candidate (updates best candidate if better)
              finalityGate.submitCandidate(candidate);
              // Mark recovery complete - allows finalization to proceed
              finalityGate.markRecoveryComplete(segmentId);
            }
            
            // Call processFinalText - it will check FinalityGate and finalize if allowed
            // Recovery candidates always win through FinalityGate dominance rules
            processFinalText(finalTextToCommit, { 
              forceFinal: true,
              candidateSource: CandidateSource.Recovery, // Tell processFinalText this is a recovery candidate
              previousFinalTextForDeduplication: previousFinalTextForDeduplication,
              previousFinalTimeForDeduplication: lastSentFinalTimeBeforeBuffer
            });
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
            // CRITICAL FIX: Buffer was cleared but recovery found words - still commit the merged text
            // This prevents word loss when buffer is cleared by new segment but recovery found missing words
            console.log(`[${mode}] ⚠️ Buffer already cleared but recovery found words - committing merged text anyway to prevent word loss`);
            console.log(`[${mode}] 📤 Committing recovery update (buffer was cleared): "${finalTextToCommit.substring(0, 80)}..."`);

            // CRITICAL: Submit recovery candidate to FinalityGate (DO NOT finalize here)
            // processFinalText is the single authority for finalization
            if (finalityGate) {
              const candidate = {
                text: finalTextToCommit,
                source: CandidateSource.Recovery,
                segmentId: segmentId,
                timestamp: Date.now(),
                options: {
                  previousFinalTextForDeduplication: null,
                  previousFinalTimeForDeduplication: null
                }
              };
              // Submit candidate (updates best candidate if better)
              finalityGate.submitCandidate(candidate);
              // Mark recovery complete - allows finalization to proceed
              finalityGate.markRecoveryComplete(segmentId);
            }
            
            // Call processFinalText - it will check FinalityGate and finalize if allowed
            // Recovery candidates always win through FinalityGate dominance rules
            processFinalText(finalTextToCommit, { 
              forceFinal: true,
              candidateSource: CandidateSource.Recovery, // Tell processFinalText this is a recovery candidate
              previousFinalTextForDeduplication: null,
              previousFinalTimeForDeduplication: null
            });

            console.log(`[${mode}] ✅ Recovery commit completed (buffer was cleared) - timeout callback will skip`);
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
            console.log(`[${mode}] 📊 RECOVERY COMMIT (no new words) - Committing forced final:`);
            console.log(`[${mode}]   Forced final text: "${forcedFinalText.substring(0, 80)}..."`);
            
            // Mark as committed by recovery BEFORE clearing buffer
            // CRITICAL: Capture lastSentOriginalTextBeforeBuffer (preferred) or lastSentFinalTextBeforeBuffer BEFORE clearing buffer
            const lastSentOriginalTextBeforeBuffer = forcedFinalBuffer?.lastSentOriginalTextBeforeBuffer || null;
            const lastSentFinalTextBeforeBuffer = forcedFinalBuffer?.lastSentFinalTextBeforeBuffer || null;
            const lastSentFinalTimeBeforeBuffer = forcedFinalBuffer?.lastSentFinalTimeBeforeBuffer || null;
            
            // CRITICAL FIX: If buffer values are empty, we can't deduplicate the recovery commit itself,
            // but processFinalText will handle it using lastSentFinalText. However, we should ensure
            // that the recovery commit text will be used as the basis for NEXT final deduplication.
            // Prefer original text for deduplication (full text vs shortened grammar-corrected version)
            let previousFinalTextForDeduplication = lastSentOriginalTextBeforeBuffer || lastSentFinalTextBeforeBuffer;
            
            // If both are empty, we can't provide previous text for deduplication of THIS recovery commit
            // But processFinalText will use lastSentFinalText for deduplication, and after this commit,
            // lastSentFinalText will be set to forcedFinalText, which will be used for NEXT final deduplication
            if (!previousFinalTextForDeduplication) {
              console.log(`[${mode}] ⚠️ WARNING: Both lastSentOriginalTextBeforeBuffer and lastSentFinalTextBeforeBuffer are empty`);
              console.log(`[${mode}] ⚠️ Recovery commit will use lastSentFinalText for deduplication (from processFinalText closure)`);
              console.log(`[${mode}] ⚠️ After recovery commit, lastSentFinalText will be set to forced final text for NEXT final deduplication`);
            }
            
            console.log(`[${mode}] 🔍 RECOVERY COMMIT - Previous final text for deduplication:`);
            console.log(`[${mode}]   lastSentOriginalTextBeforeBuffer: "${lastSentOriginalTextBeforeBuffer ? lastSentOriginalTextBeforeBuffer.substring(Math.max(0, lastSentOriginalTextBeforeBuffer.length - 80)) : '(empty)'}"`);
            console.log(`[${mode}]   lastSentFinalTextBeforeBuffer: "${lastSentFinalTextBeforeBuffer ? lastSentFinalTextBeforeBuffer.substring(Math.max(0, lastSentFinalTextBeforeBuffer.length - 80)) : '(empty)'}" (fallback)`);
            console.log(`[${mode}]   Using for deduplication: "${previousFinalTextForDeduplication ? previousFinalTextForDeduplication.substring(Math.max(0, previousFinalTextForDeduplication.length - 80)) : '(none - will use lastSentFinalText from closure)'}"`);
            console.log(`[${mode}]   lastSentFinalTimeBeforeBuffer: ${lastSentFinalTimeBeforeBuffer || '(not set)'}`);
            console.log(`[${mode}]   This is the final that was sent BEFORE the forced final was buffered`);
            console.log(`[${mode}]   Will be used for deduplication to ensure correct previous segment comparison`);
            
            if (forcedFinalBuffer) {
              forcedFinalBuffer.committedByRecovery = true;
            }
            
            // Commit the forced final (with grammar correction via processFinalText)
            // Pass the captured previous final text so deduplication uses the correct previous segment
            // Prefer lastSentOriginalTextBeforeBuffer (full original text) over lastSentFinalTextBeforeBuffer
            console.log(`[${mode}] 📤 Calling processFinalText with recovery context:`);
            console.log(`[${mode}]   Text to commit: "${forcedFinalText.substring(0, 80)}..."`);
            console.log(`[${mode}]   Previous final for deduplication: "${previousFinalTextForDeduplication ? previousFinalTextForDeduplication.substring(Math.max(0, previousFinalTextForDeduplication.length - 80)) : '(none)'}"`);
            
            processFinalText(forcedFinalText, { 
              forceFinal: true,
              previousFinalTextForDeduplication: previousFinalTextForDeduplication,
              previousFinalTimeForDeduplication: lastSentFinalTimeBeforeBuffer
            });
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
          
          console.log(`[${mode}] 📊 RECOVERY COMMIT (no recovery text) - Committing forced final:`);
          console.log(`[${mode}]   Forced final text: "${forcedFinalText.substring(0, 80)}..."`);
          
          // Mark as committed by recovery BEFORE clearing buffer
          // CRITICAL: Capture lastSentOriginalTextBeforeBuffer (preferred) or lastSentFinalTextBeforeBuffer BEFORE clearing buffer
          const lastSentOriginalTextBeforeBuffer = forcedFinalBuffer?.lastSentOriginalTextBeforeBuffer || null;
          const lastSentFinalTextBeforeBuffer = forcedFinalBuffer?.lastSentFinalTextBeforeBuffer || null;
          const lastSentFinalTimeBeforeBuffer = forcedFinalBuffer?.lastSentFinalTimeBeforeBuffer || null;
          
          // CRITICAL FIX: If buffer values are empty, we can't deduplicate the recovery commit itself,
          // but processFinalText will handle it using lastSentFinalText. However, we should ensure
          // that the recovery commit text will be used as the basis for NEXT final deduplication.
          // Prefer original text for deduplication (full text vs shortened grammar-corrected version)
          let previousFinalTextForDeduplication = lastSentOriginalTextBeforeBuffer || lastSentFinalTextBeforeBuffer;
          
          // If both are empty, we can't provide previous text for deduplication of THIS recovery commit
          // But processFinalText will use lastSentFinalText for deduplication, and after this commit,
          // lastSentFinalText will be set to forcedFinalText, which will be used for NEXT final deduplication
          if (!previousFinalTextForDeduplication) {
            console.log(`[${mode}] ⚠️ WARNING: Both lastSentOriginalTextBeforeBuffer and lastSentFinalTextBeforeBuffer are empty`);
            console.log(`[${mode}] ⚠️ Recovery commit will use lastSentFinalText for deduplication (from processFinalText closure)`);
            console.log(`[${mode}] ⚠️ After recovery commit, lastSentFinalText will be set to forced final text for NEXT final deduplication`);
          }
          
          console.log(`[${mode}] 🔍 RECOVERY COMMIT - Previous final text for deduplication:`);
          console.log(`[${mode}]   lastSentOriginalTextBeforeBuffer: "${lastSentOriginalTextBeforeBuffer ? lastSentOriginalTextBeforeBuffer.substring(Math.max(0, lastSentOriginalTextBeforeBuffer.length - 80)) : '(empty)'}"`);
          console.log(`[${mode}]   lastSentFinalTextBeforeBuffer: "${lastSentFinalTextBeforeBuffer ? lastSentFinalTextBeforeBuffer.substring(Math.max(0, lastSentFinalTextBeforeBuffer.length - 80)) : '(empty)'}" (fallback)`);
          console.log(`[${mode}]   Using for deduplication: "${previousFinalTextForDeduplication ? previousFinalTextForDeduplication.substring(Math.max(0, previousFinalTextForDeduplication.length - 80)) : '(none - will use lastSentFinalText from closure)'}"`);
          console.log(`[${mode}]   lastSentFinalTimeBeforeBuffer: ${lastSentFinalTimeBeforeBuffer || '(not set)'}`);
          console.log(`[${mode}]   This is the final that was sent BEFORE the forced final was buffered`);
          console.log(`[${mode}]   Will be used for deduplication to ensure correct previous segment comparison`);
          
          if (forcedFinalBuffer) {
            forcedFinalBuffer.committedByRecovery = true;
          }
          
          // Commit the forced final (with grammar correction via processFinalText)
          // NOTE: This case is when recovery didn't find additional words, so this is a Forced candidate, not Recovery
          // Submit the forced candidate and mark recovery complete so it can proceed
          if (finalityGate) {
            const candidate = {
              text: forcedFinalText,
              source: CandidateSource.Forced,
              segmentId: segmentId,
              timestamp: Date.now(),
              options: {
                previousFinalTextForDeduplication: previousFinalTextForDeduplication,
                previousFinalTimeForDeduplication: lastSentFinalTimeBeforeBuffer
              }
            };
            // Submit candidate (updates best candidate if better)
            finalityGate.submitCandidate(candidate);
            // Mark recovery complete - returns candidate if segment needs finalization
            const candidateToFinalize = finalityGate.markRecoveryComplete(segmentId);
            
            // CRITICAL FIX: If markRecoveryComplete returns a candidate, it means recovery completed
            // but segment hasn't been finalized. We should finalize the best candidate (may be this forced one or better)
            if (candidateToFinalize && !finalityGate.isFinalized(segmentId)) {
              console.log(`[${mode}] 🔑 FinalityGate: Recovery completed, best candidate ready for finalization`);
              // Finalize the best candidate via processFinalText to ensure liveness
              // processFinalText will finalize through FinalityGate (recovery is no longer pending)
              const finalizeOptions = candidateToFinalize.options || {};
              finalizeOptions.candidateSource = candidateToFinalize.source;
              finalizeOptions.forceFinal = candidateToFinalize.source === CandidateSource.Forced || candidateToFinalize.source === CandidateSource.Recovery;
              finalizeOptions.previousFinalTextForDeduplication = previousFinalTextForDeduplication;
              finalizeOptions.previousFinalTimeForDeduplication = lastSentFinalTimeBeforeBuffer;
              
              console.log(`[${mode}] ✅ Finalizing best candidate via processFinalText: "${candidateToFinalize.text.substring(0, 60)}..."`);
              processFinalText(candidateToFinalize.text, finalizeOptions);
              
              // Clear buffer and return early since we've finalized
              forcedCommitEngine.clearForcedFinalBuffer();
              syncForcedFinalBuffer();
              
              // Reset recovery tracking
              if (recoveryStartTime && typeof recoveryStartTime === 'object' && 'value' in recoveryStartTime) {
                recoveryStartTime.value = 0;
              }
              if (nextFinalRef && typeof nextFinalRef === 'object' && 'value' in nextFinalRef) {
                nextFinalRef.value = null;
              }
              
              console.log(`[${mode}] ✅ Best candidate finalized - timeout callback will skip`);
              return; // Exit early - we've finalized the best candidate
            }
          }
          
          // Pass the captured previous final text so deduplication uses the correct previous segment
          // Prefer lastSentOriginalTextBeforeBuffer (full original text) over lastSentFinalTextBeforeBuffer
          console.log(`[${mode}] 📤 Calling processFinalText with recovery context:`);
          console.log(`[${mode}]   Text to commit: "${forcedFinalText.substring(0, 80)}..."`);
          console.log(`[${mode}]   Previous final for deduplication: "${previousFinalTextForDeduplication ? previousFinalTextForDeduplication.substring(Math.max(0, previousFinalTextForDeduplication.length - 80)) : '(none - will use lastSentFinalText from closure)'}"`);
          
          // Call processFinalText - it will check FinalityGate and finalize if allowed
          // This is a Forced candidate (not Recovery), so it goes through normal dominance rules
          processFinalText(forcedFinalText, { 
            forceFinal: true,
            candidateSource: CandidateSource.Forced, // Tell processFinalText this is a forced candidate
            previousFinalTextForDeduplication: previousFinalTextForDeduplication,
            previousFinalTimeForDeduplication: lastSentFinalTimeBeforeBuffer
          });
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

      // CRITICAL: Mark recovery as complete in FinalityGate (if not already done above)
      // This is a fallback for cases where recovery completes but no candidate was submitted
      // If a candidate is returned, we MUST finalize it to ensure liveness
      if (finalityGate && !finalityGate.isRecoveryResolved(segmentId)) {
        const candidateToFinalize = finalityGate.markRecoveryComplete(segmentId);
        if (candidateToFinalize && !finalityGate.isFinalized(segmentId)) {
          console.log(`[${mode}] 🔑 FinalityGate: Recovery completed, best candidate available but not yet finalized: "${candidateToFinalize.text.substring(0, 60)}..."`);
          console.log(`[${mode}] ⚠️ CRITICAL: Finalizing candidate to ensure liveness (segment would be dropped otherwise)`);
          
          // CRITICAL FIX: Finalize the candidate via processFinalText to ensure eventual finalization
          // This guarantees that every segment reaches a final state exactly once
          // We call processFinalText with the candidate text, and it will finalize through FinalityGate
          // (recovery is no longer pending, so canCommit will return true)
          if (processFinalText) {
            const finalizeOptions = candidateToFinalize.options || {};
            finalizeOptions.candidateSource = candidateToFinalize.source;
            finalizeOptions.forceFinal = candidateToFinalize.source === CandidateSource.Forced || candidateToFinalize.source === CandidateSource.Recovery;
            const candidateSource = candidateToFinalize.source === CandidateSource.Recovery ? 'Recovery' : 
                                   candidateToFinalize.source === CandidateSource.Forced ? 'Forced' : 'Grammar';
            
            console.log(`[${mode}] ✅ Finalizing ${candidateSource} candidate via processFinalText: "${candidateToFinalize.text.substring(0, 60)}..."`);
            processFinalText(candidateToFinalize.text, finalizeOptions);
          } else {
            console.log(`[${mode}] ⚠️ WARNING: Could not finalize candidate - processFinalText not available`);
          }
        } else {
          console.log(`[${mode}] 🔴 FinalityGate: Marked recovery as complete for segment ${segmentId || 'default'}`);
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
      
      // CRITICAL: Mark recovery as complete even on error, and finalize any pending candidate
      // This ensures liveness even when recovery fails
      if (finalityGate && !finalityGate.isRecoveryResolved(segmentId)) {
        const candidateToFinalize = finalityGate.markRecoveryComplete(segmentId);
        if (candidateToFinalize && !finalityGate.isFinalized(segmentId)) {
          console.log(`[${mode}] 🔑 FinalityGate: Recovery failed, but best candidate exists - finalizing to ensure liveness`);
          if (processFinalText) {
            const finalizeOptions = candidateToFinalize.options || {};
            finalizeOptions.candidateSource = candidateToFinalize.source;
            finalizeOptions.forceFinal = candidateToFinalize.source === CandidateSource.Forced || candidateToFinalize.source === CandidateSource.Recovery;
            console.log(`[${mode}] ✅ Finalizing best candidate after recovery error via processFinalText: "${candidateToFinalize.text.substring(0, 60)}..."`);
            processFinalText(candidateToFinalize.text, finalizeOptions);
          }
        }
      }
      
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

