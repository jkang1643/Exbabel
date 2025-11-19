# Forward-Looking Audio Recovery Fix

## The Problem

**Symptom:** Missing words between lines when Google Speech triggers forced finals (stream restarts)

**Example:**
```
Line 1: "rejects the notion that" (FINAL)
GAP: "LIFE IS" ← MISSING
Line 2: "best spent fulfilling" (FINAL)
```

## Root Cause Analysis

### Timeline of Events:
1. User says: "rejects the notion that" → Google sends FINAL
2. User continues: "**LIFE IS**" ← Audio is being captured/transmitted/buffered
3. **FORCED FINAL triggers** (60-second timeout causes stream restart)
4. System captures `getRecentAudio(1500)` for recovery
5. **BUT**: Buffer only contains audio from step 1, NOT step 2!
6. User says: "best spent fulfilling" → New segment starts

### Why the Audio is Missing:

The audio buffer is **BACKWARDS-LOOKING** - it only contains audio that has already been processed by Google Speech.

When "LIFE IS" is spoken, it's **FORWARD** in time relative to the forced final:
- Still in client's microphone buffer (not sent yet), OR
- In transit from client → backend, OR
- In the jitter buffer (not released to Google yet), OR
- Sent to Google but not processed yet

**Therefore:** Trying to recover from the audio buffer captures the WRONG segment (the previous line "rejects the notion that"), not the gap audio ("LIFE IS").

## The Solution: Forward-Looking Recovery

Instead of trying to capture audio from the PAST, we **WAIT** for audio from the FUTURE:

### Strategy:
1. When forced final triggers, **DON'T immediately commit**
2. Buffer the forced final and **wait 3 seconds**
3. **Listen for new partials** that arrive during the wait
4. These partials will contain "LIFE IS" because that audio is still incoming!
5. Use those partials to extend the forced final before committing

### Implementation Changes:

**Before (Backwards-Looking):**
```javascript
// ❌ WRONG: Capture audio from PAST buffer
const recoveryAudio = speechStream.getRecentAudio(1500);
// This contains "rejects the notion that" (wrong segment!)
```

**After (Forward-Looking):**
```javascript
// ✅ CORRECT: Wait for FORWARD partials to arrive
forcedFinalBuffer = {
  text: transcriptText,
  timeout: setTimeout(() => {
    // Check if longestPartialText extended the forced final
    // "LIFE IS" will appear HERE in partials that arrive AFTER forced final
    if (longestPartialText.startsWith(bufferedText)) {
      finalTextToCommit = longestPartialText; // Contains "rejects the notion that LIFE IS"
    }
    processFinalText(finalTextToCommit);
  }, 3000) // Wait 3 seconds for forward audio
};
```

## Key Changes Made:

1. **Increased wait time:** `FORCED_FINAL_MAX_WAIT_MS` from 2s → 3s
   - Gives more time for in-transit audio to arrive as partials

2. **Removed backwards audio recovery:**
   - Deleted entire temporary stream audio re-transcription system
   - It was capturing the wrong segment (previous line, not gap)

3. **Rely on forward partials:**
   - The code already tracked `longestPartialText`
   - Now we properly wait for it to capture gap audio
   - Partials that arrive after forced final will contain the missing words

4. **Removed debug logs:**
   - Cleaned up audio buffer test logs (no longer relevant)

## Expected Behavior After Fix:

**Timeline:**
1. User says: "rejects the notion that" → FINAL
2. Forced final triggers → **Buffer the FINAL and start 3-second wait**
3. User continues: "LIFE IS" → Partials arrive with "rejects the notion that LIFE IS"
4. **Wait timeout fires** → Check partials, find "LIFE IS", commit extended text
5. User says: "best spent fulfilling" → New FINAL

**Result:** Complete sentence captured: "rejects the notion that LIFE IS best spent fulfilling"

## Testing:

Run the same test case and check logs for:
```
[SoloMode] ✅ FORWARD RECOVERY SUCCESS: Forced final extended by partials (23 → 35 chars)
[SoloMode] 📊 Recovered from FORWARD partials: "LIFE IS"
```

## Why This Works:

The gap audio ("LIFE IS") exists in the **future** relative to the forced final trigger:
- It's still being captured/transmitted when forced final happens
- By waiting 3 seconds, we give time for that audio to:
  1. Arrive at backend
  2. Pass through jitter buffer
  3. Get sent to Google Speech
  4. Come back as partials
- Then we merge those partials with the forced final

**No audio buffer manipulation needed** - we just wait for the natural flow!
