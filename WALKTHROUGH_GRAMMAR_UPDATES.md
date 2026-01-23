# Walkthrough: Grammar Engine Updates (DeepSeek & Critical Fixes)

**Date**: January 23, 2026
**Focus**: Cost Optimization, Stability (GPT-5 Nano), and Debugging

## 1. Overview
This update introduces a modular **Grammar Provider** architecture, adds **DeepSeek V3** as a cost-effective alternative to GPT-4o-mini, and fixes critical stability issues with "reasoning models" (like GPT-5 Nano) that require longer processing times.

## 2. DeepSeek V3 Integration
We have integrated **DeepSeek V3** (`deepseek-chat`) to significantly reduce the cost of cached input tokens, which is the primary cost driver for real-time grammar correction.

*   **Provider**: `DeepSeekGrammarProvider.js`
*   **Model**: `deepseek-chat`
*   **Cost Efficiency**: ~$0.014 per 1M cached input tokens (vs ~$0.075 for GPT-4o-mini).
*   **Performance**: Comparable latency for grammar tasks.

### usage
To use DeepSeek, restart the server with:
```bash
GRAMMAR_PROVIDER=deepseek GRAMMAR_MODEL=deepseek-chat npm run dev
```

Ensure your `.env` has:
```env
DEEPSEEK_API=sk-your-key-here
```

## 3. Critical Fixes

### A. Reasoning Model Timeouts (`gpt-5-nano`)
*   **Issue**: "Reasoning models" (like `o1`, `o3`, `gpt-5-nano`) take longer to "think" before outputting tokens. The previous hardcoded 5-second timeout caused these requests to abort and fail silently.
*   **Fix**: `GrammarWorker` now detects reasoning models (by name) and dynamically extends the timeout:
    *   **Standard Models**: 5s (unchanged)
    *   **Reasoning Models**: 15s

### B. Initialization Race Condition
*   **Issue**: The `GrammarWorker` was initializing *before* environment variables were fully loaded, causing it to default to `openai` even when `GRAMMAR_PROVIDER=deepseek` was set.
*   **Fix**: Added explicit `dotenv.config()` within `grammarWorker.js` to ensure configuration is ready at instantiation.

### C. ReferenceError Fix
*   **Issue**: `ReferenceError: startTime is not defined` in `OpenAIGrammarProvider`.
*   **Fix**: Correctly defined `startTime` variable for latency logging.

## 4. How to Verify

### 1. Verify DeepSeek
Run the server with DeepSeek:
```bash
GRAMMAR_PROVIDER=deepseek GRAMMAR_MODEL=deepseek-chat npm run dev
```
**Expected Output**:
```
[GrammarWorker] ===== GRAMMAR CORRECTION SERVICE =====
[GrammarWorker] Provider Name: deepseek
[GrammarWorker] Class Instance: DeepSeekGrammarProvider
```

### 2. Verify GPT-5 Nano (Reasoning Model)
Run the server with OpenAI Reasoning model:
```bash
GRAMMAR_PROVIDER=openai GRAMMAR_MODEL=gpt-5-nano npm run dev
```
**Expected Output**:
trigger a grammar correction and ensure it does not log "timeout after 5000ms". You should see "Request complete in X ms" where X might be > 5000.

## 5. Files Changed
*   `backend/grammarWorker.js`: Timeout logic, init fixes.
*   `backend/providers/grammar/DeepSeekGrammarProvider.js`: New provider.
*   `backend/providers/grammar/OpenAIGrammarProvider.js`: Bug fix.
*   `backend/providers/grammar/GrammarProviderFactory.js`: Registered DeepSeek.
