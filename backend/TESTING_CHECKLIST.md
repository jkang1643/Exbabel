# Testing Checklist - No Duplicates Verification

## Quick Start
```bash
# Terminal 1: Start backend
cd backend
npm start

# Terminal 2: Start frontend
cd frontend
npm run dev

# Browser: Open http://localhost:5173
```

## ✅ Test 1: No Duplicate Entries

### Steps:
1. Start a session (English → Spanish)
2. Say: "Hello world, this is a test"
3. Pause for 2 seconds (let final commit)
4. Check frontend history

### ✅ Expected:
- **ONE entry only** showing:
  - English (original): "hello world this is a test"
  - English (corrected): "Hello world, this is a test."
  - Spanish: "Hola mundo, esto es una prueba."

### ❌ Failure (OLD BEHAVIOR):
- Multiple identical entries (2-4 copies)
- Logs showing multiple `[SoloMode] 📤 Sending FINAL`

---

## ✅ Test 2: TextExtensionManager Recovery

### Steps:
1. Start session
2. Say rapidly: "I want to go to the store today"
3. Watch backend logs in real-time

### ✅ Expected Backend Logs:
```
[TextExtension] 📝 FINAL received, opening extension window
[TextExtension] 🔄 Partial extends pending final - merging
[TextExtension] ✅ Extension window closed, committing final
[SoloMode] 📤 Sending FINAL (coupled for history integrity)
```

### ✅ Expected Frontend:
- Single entry with complete sentence
- Possible recovered words shown in logs (if any were cut)

---

## ✅ Test 3: Multiple Sentences

### Steps:
1. Start session
2. Say: "This is sentence one."
3. Wait 1 second
4. Say: "This is sentence two."
5. Wait 1 second
6. Say: "This is sentence three."

### ✅ Expected:
- **THREE separate entries** in frontend
- Each entry appears exactly ONCE
- No duplicates

### Backend Log Pattern (per sentence):
```
[TextExtension] 📝 FINAL received, opening extension window (sentence 1)
[TextExtension] ✅ Extension window closed
[SoloMode] 📤 Sending FINAL
[TextExtension] 📝 FINAL received, opening extension window (sentence 2)
[TextExtension] ✅ Extension window closed
[SoloMode] 📤 Sending FINAL
[TextExtension] 📝 FINAL received, opening extension window (sentence 3)
[TextExtension] ✅ Extension window closed
[SoloMode] 📤 Sending FINAL
```

**Count**: Should see exactly 3 `[SoloMode] 📤 Sending FINAL` messages

---

## ✅ Test 4: Transcription Mode (No Translation)

### Steps:
1. Start session (English → English)
2. Say: "Testing transcription mode"
3. Check frontend

### ✅ Expected:
- One entry only
- Grammar correction visible (if applicable)
- No translation column (same language)

---

## ✅ Test 5: Forced Commit Scenario

### Steps:
1. Start session
2. Start saying a long sentence: "I think that we should probably consider the fact that..."
3. Click "Force Commit" button (if available) OR just pause mid-sentence

### ✅ Expected:
- TextExtensionManager opens 250ms window
- Any partials arriving within 250ms are merged
- Final committed with recovered words (if any)
- **Only ONE entry** in frontend

### Backend Logs:
```
[TextExtension] 📝 FINAL received, opening extension window
[TextExtension] 🔄 Partial extends pending final - merging (if partials arrive)
[TextExtension] ✅ Extension window closed (after 250ms)
[SoloMode] 📤 Sending FINAL
```

**NOT**: Multiple `[SoloMode] 📤 Sending FINAL` calls

---

## ✅ Test 6: Rapid Speech (Stress Test)

### Steps:
1. Start session
2. Say quickly: "one two three four five six seven eight nine ten"
3. Don't pause between numbers

### ✅ Expected:
- Single final entry with all numbers
- TextExtensionManager may merge multiple partials
- **No duplicate entries**

### Check Logs For:
```
[TextExtension] 🔄 Partial extends pending final - merging
recoveredTokens: ['five', 'six', 'seven'] (example)
```

---

## Debugging: How to Identify Issues

### Issue: Still Seeing Duplicates

**Check for**:
1. Multiple `[SoloMode] 📤 Sending FINAL` for same text
2. Verify old system is NOT running:
   ```bash
   grep -n "pendingFinalization =" soloModeHandler.js
   # Should ONLY show: "// NOTE: Old finalization state tracking removed"
   ```

**Fix**:
- Re-read `DUPLICATE_FIX_SUMMARY.md`
- Verify backups exist
- Check syntax: `node --check soloModeHandler.js`

### Issue: No Recovery Happening

**Check for**:
1. `[TextExtension]` logs appearing in backend
2. Extension windows opening/closing

**Debug**:
```bash
# Filter only TextExtension logs
npm start | grep TextExtension
```

**Expected**:
```
[TextExtension] 🎯 TextExtensionManager initialized
[TextExtension] 📝 FINAL received, opening extension window
[TextExtension] ✅ Extension window closed
```

---

## Success Criteria

### ✅ All Tests Pass When:

1. **No Duplicates**: Each spoken phrase produces exactly ONE frontend entry
2. **TextExtensionManager Active**: See `[TextExtension]` logs in backend
3. **Recovery Working**: See `recovered tokens` logs when partials extend finals
4. **Clean Logs**: Only ONE `[SoloMode] 📤 Sending FINAL` per segment
5. **Metrics Available**: See final stats on disconnect:
   ```
   [TextExtension] 📊 Final Extension Stats: {
     extensionsOpened: 15,
     extensionsClosed: 15,
     tokensRecovered: 23,
     mergesSuccessful: 8,
     successRate: '53.3%'
   }
   ```

---

## Performance Baseline

After running all tests, you should see:

- **Extension windows opened**: ~10-20 (depending on test length)
- **Extensions closed**: Should match opened (no leaks)
- **Tokens recovered**: Variable (depends on speech patterns)
- **Merge success rate**: 30-70% (industry standard)

---

## Files to Monitor

### Backend Terminal:
- `[SoloMode]` - Main processing
- `[TextExtension]` - Extension manager
- `[AUDIO_BUFFER_TEST]` - Audio buffer status

### Frontend Console:
- WebSocket messages
- Translation history updates

---

## Next Steps After Validation

Once all tests pass:
1. ✅ Mark "Test recovery and validate words appear in frontend" as complete
2. Move to Phase 2B: CommitManager implementation
3. Consider adding Jest tests for TextExtensionManager
4. Document any edge cases discovered

---

## Emergency Rollback

If testing reveals critical issues:

```bash
# Restore backup before partial cleanup
cp soloModeHandler.js.backup-before-partial-cleanup soloModeHandler.js

# Or restore backup before final cleanup
cp soloModeHandler.js.backup-before-cleanup soloModeHandler.js

# Verify syntax
node --check soloModeHandler.js
```

Then report findings for analysis.
