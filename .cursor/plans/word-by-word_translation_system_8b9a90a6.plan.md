---
name: Word-by-Word Translation System
overview: Implement a flickerless word-by-word translation system using delta-based translation with three-buffer architecture (final/partial/display) for both transcript and translation states. The system will be built in the core engine to work seamlessly in both solo and host modes.
todos:
  - id: create-translation-buffer-engine
    content: Create core/engine/translationBufferEngine.js with three-buffer architecture (final/partial/display) for both transcripts and translations
    status: completed
  - id: integrate-core-engine
    content: Integrate translationBufferEngine into coreEngine.js, expose methods and emit events
    status: completed
  - id: create-delta-api
    content: Create backend/api/translate-delta/route.js HTTP POST endpoint that returns only new translation tokens as JSON array
    status: completed
  - id: update-solo-mode
    content: Update backend/soloModeHandler.js to use translation buffers, call delta API, and send token arrays in WebSocket messages
    status: completed
  - id: update-host-mode
    content: Update backend/host/adapter.js with same translation buffer integration as solo mode
    status: completed
  - id: create-frontend-buffer
    content: Create frontend/src/components/TranslationBuffer.jsx with ref-based token management to prevent flicker
    status: completed
  - id: update-translation-interface
    content: Update frontend/src/components/TranslationInterface.jsx to handle token-based WebSocket messages and use TranslationBuffer
    status: completed
  - id: update-translation-display
    content: Update frontend/src/components/TranslationDisplay.jsx to render word-by-word tokens smoothly
    status: completed
---

# Word-by-Word Translation System Implementation Plan

## Architecture Overview

The system implements a three-buffer architecture for both transcripts and translations:

### Transcript Buffers

- **`finalTranscript`**: Immutable finalized transcripts from Google STT (`isFinal = true`)
- **`partialTranscript`**: Continuously updated from STT partials (can be overwritten)
- **`displayTranscript`**: Computed as `finalTranscript + partialTranscript` for UI

### Translation Buffers

- **`finalTranslationTokens: string[]`**: Immutable tokenized translations from finalized transcripts
- **`partialTranslationTokens: string[]`**: Temporary tokens from partial transcript translation
- **`displayTranslation`**: Computed as `finalTranslationTokens.join(' ') + ' ' + partialTranslationTokens.join(' ')`

## Core Components

### 1. Translation Buffer Engine (`core/engine/translationBufferEngine.js`)

**Purpose**: Manages the three-buffer system for both transcripts and translations.

**Key Methods**:

- `updatePartialTranscript(text)`: Update partial transcript buffer
- `finalizeTranscript(text)`: Move transcript to final buffer, clear partial
- `updatePartialTranslation(tokens: string[])`: Update partial translation tokens
- `finalizeTranslation(tokens: string[])`: Append tokens to final buffer, clear partial
- `getDisplayTranscript()`: Return `finalTranscript + partialTranscript`
- `getDisplayTranslation()`: Return concatenated final + partial tokens
- `reset()`: Clear all buffers

**State**:

```javascript
{
  finalTranscript: string,
  partialTranscript: string,
  finalTranslationTokens: string[],
  partialTranslationTokens: string[]
}
```

### 2. Delta Translation API (`backend/api/translate-delta/route.js`)

**Purpose**: HTTP POST endpoint that translates only the new segment (delta) after previous translation.

**Request Format**:

```json
{
  "previousTranslation": "Quiero la ventana abierta",
  "newTranscript": "I want the window open please",
  "sourceLang": "en",
  "targetLang": "es"
}
```

**Response Format**:

```json
{
  "delta": ["quiero", "la", "ventana", "abierta", "por", "favor"]
}
```

**Implementation**:

- Use OpenAI `gpt-4o-mini` with specialized prompt
- Prompt instructs LLM to return ONLY new tokens after previous translation
- Return JSON array of tokens (not full sentence)
- Handle edge cases (empty previous, full replacement, etc.)

**Prompt Template**:

```
Previous finalized translation: "{previousTranslation}"

New speech transcript: "{newTranscript}"

Return ONLY the newly translated words AFTER the previous translation.
Return as a JSON array of tokens: ["token1", "token2", ...]
If the new transcript completely replaces the previous, return the full translation as tokens.
```

### 3. Core Engine Integration

**File**: `core/engine/coreEngine.js`

**Changes**:

- Add `translationBufferEngine` property
- Expose buffer management methods
- Emit events for buffer state changes:
  - `partialTranscriptUpdated`
  - `transcriptFinalized`
  - `partialTranslationUpdated`
  - `translationFinalized`

**New Methods**:

- `updatePartialTranscript(text)`: Delegate to buffer engine
- `finalizeTranscript(text)`: Delegate to buffer engine
- `updatePartialTranslation(tokens)`: Delegate to buffer engine
- `finalizeTranslation(tokens)`: Delegate to buffer engine
- `getDisplayState()`: Return current display-ready state

### 4. Solo Mode Integration (`backend/soloModeHandler.js`)

**Changes in `speechStream.onResult()` handler**:

**On Partial (`isPartial = true`)**:

1. Call `coreEngine.updatePartialTranscript(transcriptText)`
2. Fetch delta translation via HTTP POST to `/api/translate-delta`
3. Call `coreEngine.updatePartialTranslation(deltaTokens)`
4. Get display state: `const display = coreEngine.getDisplayState()`
5. Send WebSocket message with `translatedTokens: display.translationTokens` (array)

**On Final (`isPartial = false`)**:

1. Call `coreEngine.finalizeTranscript(transcriptText)`
2. Fetch delta translation for full finalized chunk
3. Call `coreEngine.finalizeTranslation(deltaTokens)`
4. Get display state
5. Send WebSocket message with `translatedTokens: display.translationTokens` (array) and `isFinal: true`
6. Clear partial buffers via `coreEngine.resetPartialBuffers()`

**WebSocket Message Format**:

```javascript
{
  type: 'translation',
  originalText: string,
  translatedTokens: string[],  // NEW: Array of tokens
  isPartial: boolean,
  timestamp: number
}
```

### 5. Host Mode Integration (`backend/host/adapter.js`)

**Same changes as solo mode**, but:

- Use `broadcastWithSequence()` instead of `sendWithSequence()`
- Broadcast to all listeners in session via `sessionStore`

### 6. Frontend: Translation Buffer Component (`frontend/src/components/TranslationBuffer.jsx`)

**Purpose**: React component that manages token display without flicker.

**State Management**:

- `finalTokensRef: useRef<string[]>([])`: Immutable finalized tokens
- `partialTokensRef: useRef<string[]>([])`: Temporary partial tokens
- `displayText: useState<string>('')`: Computed display string

**Methods**:

- `updatePartial(tokens: string[])`: Update partial tokens ref, recompute display
- `finalize(tokens: string[])`: Append to final tokens ref, clear partial, recompute display
- `reset()`: Clear all refs and state

**Display Logic**:

```javascript
const displayText = useMemo(() => {
  const final = finalTokensRef.current.join(' ');
  const partial = partialTokensRef.current.join(' ');
  return final + (partial ? ' ' + partial : '');
}, [/* dependencies managed via ref updates */]);
```

**Rendering**:

- Use `useRef` for token buffers (no re-renders on updates)
- Only call `setState` for display text
- Use `flushSync` for immediate UI updates

### 7. Frontend: TranslationInterface Updates (`frontend/src/components/TranslationInterface.jsx`)

**Changes**:

- Import and use `TranslationBuffer` component
- Handle new WebSocket message format with `translatedTokens` array
- On partial: `translationBuffer.updatePartial(message.translatedTokens)`
- On final: `translationBuffer.finalize(message.translatedTokens)`
- Pass display text to `TranslationDisplay` component

**WebSocket Handler Update**:

```javascript
case 'translation':
  if (message.translatedTokens) {
    // New token-based format
    if (message.isPartial) {
      translationBufferRef.current.updatePartial(message.translatedTokens);
    } else {
      translationBufferRef.current.finalize(message.translatedTokens);
    }
  } else {
    // Fallback to old string format (backward compatibility)
    // ... existing logic
  }
```

### 8. Frontend: TranslationDisplay Updates (`frontend/src/components/TranslationDisplay.jsx`)

**Changes**:

- Accept `translatedTokens?: string[]` prop (optional for backward compatibility)
- If tokens provided, render word-by-word with smooth animation
- Each token appears incrementally without overwriting previous
- Use CSS transitions for smooth appearance

## Implementation Order

1. **Create Translation Buffer Engine** (`core/engine/translationBufferEngine.js`)

   - Implement three-buffer state management
   - Add reset and getter methods

2. **Integrate into Core Engine** (`core/engine/coreEngine.js`)

   - Add translationBufferEngine instance
   - Expose methods and emit events

3. **Create Delta Translation API** (`backend/api/translate-delta/route.js`)

   - Implement HTTP POST endpoint
   - Add OpenAI integration with delta prompt
   - Return JSON array of tokens

4. **Update Solo Mode** (`backend/soloModeHandler.js`)

   - Integrate buffer engine in `onResult` handler
   - Call delta translation API
   - Send token arrays in WebSocket messages

5. **Update Host Mode** (`backend/host/adapter.js`)

   - Same changes as solo mode
   - Use broadcast instead of send

6. **Create Frontend Translation Buffer** (`frontend/src/components/TranslationBuffer.jsx`)

   - Implement ref-based token management
   - Compute display text without flicker

7. **Update Frontend Components** (`frontend/src/components/TranslationInterface.jsx`, `TranslationDisplay.jsx`)

   - Integrate TranslationBuffer
   - Handle token-based messages
   - Render word-by-word display

## Critical Constraints

1. **DO NOT translate individual words in isolation** - Always translate full context
2. **DO NOT re-render entire translation on partial** - Only append new tokens
3. **DO NOT commit partial translations** - Only finalize on `isFinal = true`
4. **Delta translation must include context** - Previous translation + new transcript
5. **Frontend must use refs for buffers** - Prevent unnecessary re-renders
6. **Translation correctness > visual smoothness** - Prioritize accuracy

## Testing Strategy

1. **Unit Tests**: Translation buffer engine state management
2. **Integration Tests**: Delta translation API with various scenarios
3. **E2E Tests**: Full flow from STT partial → translation → display
4. **Visual Tests**: Verify no flickering during rapid partial updates

## Files to Create/Modify

**New Files**:

- `core/engine/translationBufferEngine.js`
- `backend/api/translate-delta/route.js`
- `frontend/src/components/TranslationBuffer.jsx`

**Modified Files**:

- `core/engine/coreEngine.js`
- `backend/soloModeHandler.js`
- `backend/host/adapter.js`
- `frontend/src/components/TranslationInterface.jsx`
- `frontend/src/components/TranslationDisplay.jsx`