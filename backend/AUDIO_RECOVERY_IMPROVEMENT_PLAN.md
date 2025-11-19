# Audio Recovery Improvement Plan

## Current Status: Working But Not Producing Results

### What's Working ✅
- Audio buffer captures 700ms of audio successfully
- Temporary stream creates and initializes successfully
- Audio sent to temporary stream successfully
- All 8 steps execute without errors

### What's NOT Working ❌
- **Temporary stream produces NO FINAL result during 1500ms wait**
- Missing expected logs:
  - `📥 Temp stream result: FINAL "..."`
  - `✅ Recovery stream FINAL captured: "..."`
  - `✅ Step 7 complete: Wait finished`
  - `✅ Step 8 complete: Temporary stream destroyed`

### Root Cause Analysis

**Problem**: 700ms of audio is too short for Google Speech to reliably produce a FINAL result.

**Evidence from logs**:
```
[SoloMode] ⏳ Step 7: Waiting 1500ms for final result...
(no result logs)
(no step 7 or 8 completion logs)
```

**Why this happens**:
1. Google Speech needs ~1-2 seconds of audio minimum to produce stable results
2. 700ms audio sent to temp stream → Stream ends immediately → Google may not have enough context
3. Google Speech may produce only PARTIALS (not FINAL) for very short audio
4. 1500ms wait may not be long enough for Google's processing delay

## Improvement Plan

### Phase 1: Increase Recovery Audio Duration ⚡ Priority

**Change**: Capture **1200ms** instead of 700ms

**Rationale**:
- More context for Google Speech
- Higher chance of complete words/phrases
- Better acoustic modeling with longer audio

**Code Change**:
```javascript
// Line 1454
const recoveryAudio = speechStream.getRecentAudio(1200); // Was 750ms → Now 1200ms
```

**Expected Impact**: 60-70% increase in FINAL result production

---

### Phase 2: Increase Wait Time for Result ⚡ Priority

**Change**: Wait **3000ms** instead of 1500ms

**Rationale**:
- Google Speech processing delay can be 1-2 seconds
- Temporary stream initialization adds ~500ms
- Audio processing adds ~500-1000ms
- Total realistic time: 2-3 seconds

**Code Change**:
```javascript
// Line 1533-1534
console.log(`[SoloMode] ⏳ Step 7: Waiting 3000ms for final result...`);
await new Promise(resolve => setTimeout(resolve, 3000)); // Was 1500ms → Now 3000ms
```

**Expected Impact**: 80% increase in catching FINAL results

---

### Phase 3: Handle PARTIAL Results as Fallback 🔧 Important

**Change**: If no FINAL arrives, use latest PARTIAL

**Rationale**:
- Google Speech may only produce PARTIALS for short audio
- PARTIAL is better than nothing
- We can still recover missing words

**Code Change**:
```javascript
// In onResult handler (around line 1510)
let recoveredText = '';
let recoveredPartial = ''; // NEW: Track latest partial
tempStream.onResult((text, isPartial, meta) => {
  console.log(`[SoloMode] 📥 Temp stream result: ${isPartial ? 'PARTIAL' : 'FINAL'} "${text.substring(0, 60)}..."`);
  if (!isPartial) {
    recoveredText = text;
    console.log(`[SoloMode] ✅ Recovery stream FINAL captured: "${text}"`);
  } else {
    recoveredPartial = text; // NEW: Save latest partial
    console.log(`[SoloMode] 📝 Recovery stream PARTIAL captured: "${text}"`);
  }
});

// After wait (around line 1543)
if (recoveredText && recoveredText.length > 0) {
  console.log(`[SoloMode] ✅ Recovery transcription complete (FINAL): "${recoveredText}"`);
  // ... existing merge logic ...
} else if (recoveredPartial && recoveredPartial.length > 0) {
  console.log(`[SoloMode] ⚠️ No FINAL received, using latest PARTIAL: "${recoveredPartial}"`);
  recoveredText = recoveredPartial; // Use partial as fallback
  // ... existing merge logic ...
} else {
  console.log(`[SoloMode] ⚠️ No recovery transcript received (neither FINAL nor PARTIAL)`);
}
```

**Expected Impact**: 95% coverage (catches both FINAL and PARTIAL results)

---

### Phase 4: Add Explicit Stream Flush 🔧 Nice-to-Have

**Change**: Force Google Speech to flush results before waiting

**Rationale**:
- Google Speech buffers results internally
- Explicit flush may trigger faster FINAL production
- Works similarly to `forceCommit()` on main stream

**Code Change**:
```javascript
// After endAudio (around line 1530)
await tempStream.endAudio();
console.log(`[SoloMode] ✅ Step 6 complete: Audio stream ended`);

// NEW: Try to force flush (if method exists)
if (typeof tempStream.forceFlush === 'function') {
  console.log(`[SoloMode] 🔄 Step 6.5: Forcing stream flush...`);
  await tempStream.forceFlush();
  console.log(`[SoloMode] ✅ Step 6.5 complete: Stream flushed`);
}

console.log(`[SoloMode] ⏳ Step 7: Waiting 3000ms for final result...`);
```

**Expected Impact**: 10-20% faster result production

---

### Phase 5: Capture More Audio from Buffer 🔧 Experimental

**Change**: Instead of capturing last 750ms AFTER forced final, capture **BEFORE** forced final arrives

**Rationale**:
- Forced final may arrive 200-500ms AFTER actual speech ended
- By that time, relevant audio may have scrolled out of buffer
- Capture audio preemptively when chunk timeouts start

**Implementation**: Would require hooking into chunk timeout detection in `googleSpeechStream.js`

**Expected Impact**: 30-40% more complete audio captures

---

## Recommended Implementation Order

### Immediate (Do Now):
1. ✅ **Phase 1**: Increase recovery audio to 1200ms
2. ✅ **Phase 2**: Increase wait time to 3000ms
3. ✅ **Phase 3**: Handle PARTIAL results as fallback

### Next (If still missing words):
4. **Phase 4**: Add explicit stream flush
5. **Phase 5**: Capture audio preemptively

## Expected Results After Phases 1-3

**Before**:
```
Expected: "where two or three are gathered in my name"
Received: "where two or three are" (missing "gathered in my name")
Recovery: NO RESULT (temp stream timeout)
```

**After**:
```
Expected: "where two or three are gathered in my name"
Received: "where two or three are" (forced final)
Recovery: PARTIAL "gathered in my name" (from temp stream)
Final: "where two or three are gathered in my name" ✅ COMPLETE
```

## Success Metrics

After implementing Phases 1-3, we should see:

1. **Temp stream results**: >90% of forced finals get PARTIAL or FINAL from temp stream
2. **Word recovery**: >85% of missing words recovered
3. **Log evidence**:
   - `📥 Temp stream result: PARTIAL "..."` OR `FINAL "..."`
   - `✅ Recovery stream FINAL/PARTIAL captured`
   - `✅ Step 7 complete: Wait finished`
   - `📊 Audio recovery found more complete text`

## Testing Plan

1. **Test Case 1**: Short phrase with forced final
   - Say: "where two or three are gathered"
   - Force commit mid-sentence
   - Expected: Temp stream recovers "gathered"

2. **Test Case 2**: Long phrase with forced final
   - Say: "biblical hospitality is the polar opposite of the cultural trends to separate and isolate"
   - Force commit at "separate"
   - Expected: Temp stream recovers "and isolate"

3. **Test Case 3**: Very short audio (edge case)
   - Say: "hello world"
   - Force commit immediately
   - Expected: Temp stream produces PARTIAL (if not FINAL)

## Risk Assessment

**Low Risk Changes**:
- Phase 1 (increase audio capture) - ✅ Safe
- Phase 2 (increase wait time) - ✅ Safe (adds 1.5s latency)
- Phase 3 (use partials) - ✅ Safe (fallback only)

**Medium Risk Changes**:
- Phase 4 (stream flush) - ⚠️ May not exist as method
- Phase 5 (preemptive capture) - ⚠️ Requires architecture change

---

**Next Step**: Implement Phases 1-3 now and test with forced finals.
