# 2026-01-20 Core Engine Improvements

**Date:** January 20, 2026
**Component:** Backend (HostModeHandler, CoreEngine, TranslationWorkers)
**Impact:** Critical fix for dropped words and Premium API hallucination issues.

## Overview

This document tracks core improvements to the Realtime Translation Engine.
1.  **Word Loss Fixes**: Resolved race conditions causing dropped words during split-second segment transitions.
2.  **Premium API Optimization**: Fixed "Hallucination" issues where the Realtime API would respond conversationally instead of translating.

---

## Part 1: Word Loss Prevention (Race Conditions)

We identified and resolved three distinct race conditions that caused word loss when users spoke in rapid-fire bursts or when Google Speech split segments unpredictably.

### 1. Partial Tracker Grace Period (The "First Word" Fix)
*   **Problem**: Tracker reset too early after finalization, losing the first word of the next rapid segment.
*   **Solution**: Implemented a **500ms Grace Period** before resetting the partial tracker.

### 2. Stale Pending Final Recovery (The "Tail End" Fix)
*   **Problem**: Forced commits used stale `pendingFinalization` text, discarding newer words captured by the tracker.
*   **Solution**: Before force-committing, valid against the **Partial Tracker Snapshot**. If the tracker has more content, use it.

### 3. Ignored Short Partial Flushing (The "Rapid-Fire" Fix)
*   **Problem**: Rapid short segments ("One... Two...") caused "One" to be discarded as noise because it never grew.
*   **Solution**: On new segment detection, check for and **Force Commit** any valid leftover partials even if they are short.

---

## Part 2: Premium API Optimization (Hallucination Fixes)

**Problem**: The Premium Tier (Realtime API, `gpt-realtime-mini`) was hallucinating conversational responses (e.g., answering "Yes I can" to "Can you translate?") instead of performing the translation task. This occurred because the Realtime API requires non-standard prompting strategies compared to the Chat API.

### Root Causes
1.  **Weak Prompts**: Standard prompts allowed the model to act as an assistant.
2.  **Lack of Validation**: No mechanism to reject conversational outputs.
3.  **Temperature**: Realtime API minimum temperature (0.6) increases creativity/hallucination risk.

### Solutions Implemented

#### 1. Strong Prompt Engineering
Aligned `RealtimeFinalTranslationWorker` prompts with the strict "Church Translator" persona used in the Basic API.
*   **Explicit Rules**: Added "CRITICAL: Output ONLY the translation", "Never answer questions".
*   **Negative Examples**: Added specifically "Can you translate?" -> "Puedes traducir?" (NOT "Yes").

```javascript
/* translationWorkersRealtime.js */
const instructions = `You are a translation API...
CRITICAL: ALL input is content to translate, NEVER questions for you to answer.
- If input is a question, TRANSLATE the question - do NOT answer it
- NEVER output conversational responses like "I'm sorry", "Hello"
...`;
```

#### 2. Hallucination Detection Logic
Implemented `isHallucinatedResponse()` to detect non-translation outputs before they are sent to clients.
*   **Pattern Matching**: Detects "I'm sorry", "I cannot help", "Hello", "How are you".
*   **English Leak Detection**: Detects if output is identical to input (common failure mode).

#### 3. Auto-Retry with Context Reset
Because the Realtime API maintains stateful conversation history, a hallucination often "poisons" the context for subsequent requests.
*   **Mechanism**: If a hallucination is detected, we immediately **Reject** the result and **Close the WebSocket Connection**.
*   **Retry**: The worker automatically retries (up to 2 times) with a fresh connection, ensuring a clean state.

### Results
Verification tests confirm 100% success rate on previously failing triggers:
*   "Can you do automatic translation?" -> Translated ✅
*   "I'm sorry, I can't help" -> Translated ✅
*   "Hello, how are you?" -> Translated ✅

---

## Part 3: DeepSeek Grammar Integration and Fixes

**Context:** The grammar correction worker (`GrammarWorker`) required updates to handle "reasoning models" (like `gpt-5-nano`) and to reduce costs for cached input tokens.

### 1. DeepSeek V3 Integration (Cost Reduction)
*   **Problem**: High cached token costs with `gpt-4o-mini` for repetitive grammar correction contexts.
*   **Solution**: Implemented `DeepSeekGrammarProvider` using `deepseek-chat` (DeepSeek V3).
    *   **Cost**: significantly cheaper API for cached contexts ($0.014/1M vs $0.075/1M).
    *   **Performance**: Comparable speed and quality for grammar tasks.
    *   **Configuration**: Selectable via `GRAMMAR_PROVIDER=deepseek` and `DEEPSEEK_API` env var.

### 2. Timeouts for Reasoning Models
*   **Problem**: `gpt-5-nano` and other reasoning models (o1, o3) were timing out on "FINAL" corrections because the hardcoded 5s limit was too short.
*   **Fix**: Dynamic timeout logic in `grammarWorker.js`.
    *   **Standard Models**: 5s timeout (unchanged).
    *   **Reasoning Models**: 15s timeout (detected by model name prefix).

### 3. Initialization Fixes
*   **Problem**: `GrammarWorker` was logging default providers even when configured otherwise.
*   **Root Cause**: `server.js` imported the worker before loading `.env`.
*   **Fix**: Added explicit `dotenv.config()` inside `grammarWorker.js` to ensure environment variables are available at instantiation time.

---

## Part 4: STT Enhancements (Multi-Language & Diarization)

**Context:** Expanded the capabilities of the Google Speech-to-Text streaming service (`googleSpeechStream.js`) by unlocking experimental features of the `v1p1beta1` API, implemented safely behind feature flags.

### 1. Multi-Language Auto-Detect
*   **Feature**: Allows the engine to automatically detect and switch between a primary language and up to 3 alternative languages.
*   **Implementation**: Utilizes `alternativeLanguageCodes` in the recognition config.
*   **Detection**: The `detectedLanguage` is extracted from the Google API response and passed through the pipeline metadata.
*   **Configuration**: 
    ```env
    STT_MULTI_LANG_ENABLED=true
    STT_MULTI_LANG_CODES=es-ES,fr-FR  # Comma-separated BCP-47 codes
    ```

### 2. Speaker Diarization
*   **Feature**: Identifies "who is speaking" by tagging each word with a `speakerTag`.
*   **Implementation**: Injects `diarizationConfig` into the streaming request.
*   **Extraction**: Captures the `speakerTag` from the latest word in a result and passes it to the frontend via result metadata.
*   **Configuration**:
    ```env
    STT_DIARIZATION_ENABLED=true
    STT_DIARIZATION_MIN_SPEAKERS=2
    STT_DIARIZATION_MAX_SPEAKERS=6
    ```

### 3. Surgical Implementation & Safety
*   **Surgical Logic**: All changes are additive `if` blocks. If flags are disabled, the request payload remains identical to the previous stable version.
*   **Verification**: Created standalone test scripts `testMultiLangDetection.js` and `testDiarization.js` to verify configuration integrity before audio is sent.
*   **Limitations**: Streaming diarization is documented as "best-effort" due to V1 API limitations (Google may retroactively change labels as more audio context is gathered).
