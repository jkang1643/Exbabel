/**
 * Exbabel Caption Engine
 * 
 * Framework-agnostic caption client engine for real-time translation apps.
 * 
 * @example Browser usage with auto-connect
 * ```typescript
 * import { CaptionClientEngine } from '@exbabel/caption-engine';
 * 
 * const engine = new CaptionClientEngine({
 *   segmenter: new SentenceSegmenter(),
 *   lang: 'es',
 * });
 * 
 * engine.on('state', (viewModel) => render(viewModel));
 * engine.connect(wsUrl);
 * ```
 * 
 * @example Manual WebSocket usage (Node.js/Electron main)
 * ```typescript
 * import { CaptionClientEngine } from '@exbabel/caption-engine';
 * import WebSocket from 'ws';
 * 
 * const engine = new CaptionClientEngine({ segmenter, lang: 'es' });
 * const ws = new WebSocket(wsUrl);
 * 
 * ws.on('message', (data) => {
 *   const event = JSON.parse(data.toString());
 *   engine.ingest(event);
 * });
 * 
 * engine.on('state', (viewModel) => render(viewModel));
 * ```
 */

// Core engine
export { CaptionClientEngine } from './CaptionClientEngine.js';

// Types
export type {
    // Event types
    CaptionEvent,
    TranslationEvent,
    SessionJoinedEvent,
    SessionReadyEvent,
    SessionEndedEvent,
    ErrorEvent,
    TranscriptEvent,
    SessionStatsEvent,
    TtsEvent,
    BaseCaptionEvent,

    // View model types
    CaptionViewModel,
    CommittedEntry,
    DebugInfo,
    ConnectionStatus,

    // Configuration types
    CaptionEngineOptions,
    CaptionEngineEvents,
    ISentenceSegmenter,
} from './types.js';

// Type guards
export {
    isTranslationEvent,
    isTtsEvent,
    isErrorEvent,
} from './types.js';

// Utilities
export { TypedEmitter } from './utils/emitter.js';
