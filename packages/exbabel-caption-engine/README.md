# @exbabel/caption-engine

Framework-agnostic caption client engine for real-time translation apps. Extracted from the Exbabel web app for reuse in web and Electron applications.

## Install

### From GitHub Packages (recommended for production)

```bash
# Add .npmrc to your project root:
echo "@exbabel:registry=https://npm.pkg.github.com" >> .npmrc

# Install
npm install @exbabel/caption-engine
```

### From Git (development)

```bash
npm install git+https://github.com/your-org/exbabel-caption-engine.git
```

### Local Development

```bash
npm install ../packages/exbabel-caption-engine
```

## Portability

This package is designed to work in:
- **Browser** (web apps)
- **Electron renderer** process
- **Electron main** process (with WebSocket injection)
- **Node.js** (with WebSocket injection)

The engine core has **no DOM dependencies** and is transport-agnostic.

## Transport Patterns

The engine supports three usage patterns depending on your environment:

### Pattern 1: Auto-Connect (Browser/Electron Renderer)

Use `connect(url)` for automatic WebSocket management:

```typescript
import { CaptionClientEngine } from '@exbabel/caption-engine';
import { SentenceSegmenter } from './utils/sentenceSegmenter';

const engine = new CaptionClientEngine({
  segmenter: new SentenceSegmenter(),
  lang: 'es',
  debug: true,
});

// Subscribe to state changes
engine.on('state', (viewModel) => {
  renderLiveLine(viewModel.liveLine);
  renderHistory(viewModel.committedLines);
});

// Auto-connect (creates WebSocket internally)
engine.connect('wss://api.exbabel.com/translate?role=listener&sessionId=...');
```

### Pattern 2: WebSocket Injection (Node.js/Electron Main)

Use `connectWithWebSocket(ws)` to inject a custom WebSocket implementation:

```typescript
import { CaptionClientEngine } from '@exbabel/caption-engine';
import WebSocket from 'ws'; // npm install ws

const engine = new CaptionClientEngine({
  segmenter: new SentenceSegmenter(),
  lang: 'fr',
});

engine.on('state', (viewModel) => {
  console.log('Caption update:', viewModel);
});

// Inject WebSocket instance
const ws = new WebSocket('wss://api.exbabel.com/translate');
engine.connectWithWebSocket(ws);
```

### Pattern 3: Manual Ingestion (Full Control)

Manage the WebSocket yourself and call `ingest()` for each event:

```typescript
import { CaptionClientEngine } from '@exbabel/caption-engine';

const engine = new CaptionClientEngine({ segmenter, lang: 'es' });

// Manage WebSocket yourself
const ws = new WebSocket(wsUrl);
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  engine.ingest(message); // Feed events manually
};

engine.on('state', (viewModel) => render(viewModel));
```

## Event Format

The engine expects WebSocket events matching this format:

```typescript
interface TranslationEvent {
  type: 'translation';
  seqId?: number;
  sourceSeqId?: number;
  isPartial: boolean;
  forceFinal?: boolean;
  originalText?: string;
  correctedText?: string;
  translatedText?: string;
  sourceLang?: string;
  targetLang?: string;
  hasTranslation?: boolean;
}
```

## State Output (View Model)

```typescript
interface CaptionViewModel {
  status: 'disconnected' | 'connecting' | 'connected';
  lang: string;
  seq: number;
  liveLine: string;          // Currently updating partial
  liveOriginal: string;      // Source language live text
  committedLines: Array<{    // History
    text: string;
    original?: string;
    seqId?: number;
    timestamp: number;
  }>;
}
```

## Golden Test Usage

Run golden tests to verify engine behavior:

```bash
# Record new golden baseline
GOLDEN_RECORD=1 npm test

# Verify against baseline
npm test
```

## API Reference

### `CaptionClientEngine`

| Method | Description |
|--------|-------------|
| `connect(wsUrl)` | Connect to WebSocket URL (browser only) |
| `connectWithWebSocket(ws)` | Connect with injected WebSocket instance |
| `disconnect()` | Disconnect from WebSocket |
| `ingest(event)` | Process a raw event |
| `getState()` | Get current view model |
| `setLang(lang)` | Change target language |
| `reset()` | Clear all caption state |

### Events

| Event | Data | Description |
|-------|------|-------------|
| `state` | `CaptionViewModel` | Emitted on state change |
| `debug` | `{ event, data }` | Debug events (if enabled) |
| `error` | `Error` | Emitted on error |
| `tts` | `TtsEvent` | Pass-through TTS events |

## Development

```bash
cd packages/exbabel-caption-engine

# Install dependencies
npm install

# Build
npm run build

# Test
npm test

# Watch mode
npm run test:watch
```

## License

MIT
