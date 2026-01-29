# Comprehensive Testing Strategy: Tiers, Gating & Usage

This guide outlines the scenarios and verification steps for testing the tiered plan infrastructure, including feature gating and idempotent usage metering.

## 1. Test Environments & Setup
- **Database**: Ensure Dev and Prod are aligned (completed via `surgical-sync.js`).
- **Plan Switching**: To test different tiers, update the `subscriptions` table for the test church:
    ```sql
    -- Example: Switch Church A to 'Starter'
    UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'starter') 
    WHERE church_id = 'your-church-uuid';
    ```

## 2. Tier Gating Scenarios

### Scenario A: Starter Tier (Limited)
- **STT**: Standard Google engine should be used.
- **Translate**: `gpt-4o-mini` should be resolved.
- **TTS**: Premium families (Gemini, ElevenLabs, Chirp 3 HD) should be **blocked**.
- **Log to look for**:
    ```
    [AssertEntitled] ✗ TTS tier not allowed: requested=chirp3_hd allowed=[standard, neural2, studio] plan=starter
    [SoloMode] TTS disabled - no allowed tiers for this subscription
    ```

### Scenario B: Pro Tier (Mid-Range)
- **STT**: Enhanced Google engine (v1p1beta1) should be used.
- **Translate**: `gpt-4o` should be resolved.
- **TTS**: Chirp 3 HD should be **allowed**. Gemini and ElevenLabs should be **blocked**.
- **Log to look for**:
    ```
    [AssertEntitled] ✓ TTS tier OK: requested=chirp3_hd
    [AssertEntitled] ✗ TTS tier not allowed: requested=gemini allowed=[chirp3_hd, standard, neural2, studio] plan=pro
    ```

### Scenario C: Unlimited Tier (Full Access)
- **STT**: STT 2.0 (`latest_long`) should be used.
- **Translate**: GPT Realtime should be **allowed**.
- **TTS**: All engines (Gemini, ElevenLabs) should be **allowed**.
- **Log to look for**:
    ```
    [SoloMode] RESOLVED: Use Premium Tier (gpt-realtime-mini)
    [AssertEntitled] ✓ TTS tier OK: requested=gemini
    ```

## 3. Usage Metering Verification

### Transcription (STT)
- **Metric**: `transcription_seconds`
- **Verification Query**:
    ```sql
    SELECT * FROM usage_events WHERE metric = 'transcription_seconds' ORDER BY occurred_at DESC LIMIT 5;
    SELECT * FROM usage_daily WHERE metric = 'transcription_seconds' AND church_id = '...';
    ```
- **Log to look for**:
    ```
    [GoogleSpeech] ✓ Recorded usage: 15 transcription_seconds (key: stt:...)
    ```

### Speech Synthesis (TTS)
- **Metric**: `tts_characters`
- **Verification Query**:
    ```sql
    SELECT * FROM usage_events WHERE metric = 'tts_characters' ORDER BY occurred_at DESC LIMIT 5;
    ```
- **Log to look for**:
    ```
    [TTS-Orch] ✓ Recorded usage: 120 tts_characters (key: tts:...)
    ```

### Idempotency (Deduplication)
- **Test**: Send the same transcription chunk twice or retry a network request.
- **Expected Log**:
    ```
    [Usage] ℹ️ Skipping record: Idempotency key already exists (key: ...)
    ```

## 4. Multi-Tenancy (Church Isolation)
- **Test**: Ensure Church A's usage does not affect Church B's `usage_daily`.
- **Verify**:
    ```sql
    SELECT church_id, metric, SUM(quantity) 
    FROM usage_events 
    GROUP BY church_id, metric;
    ```

## 5. Summary Checklist
- [ ] Switched church plan to Starter -> Verified premium voice block.
- [ ] Switched church plan to Unlimited -> Verified GPT Realtime activation.
- [ ] Performed 1 minute of streaming -> Verified `usage_daily` incremented by ~60 units.
- [ ] Checked logs for `[AssertEntitled] ✗` and `[AssertEntitled] ✓` patterns.
