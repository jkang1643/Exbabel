/**
 * Exbabel Caption Engine - Type Definitions
 * 
 * Framework-agnostic types for caption stabilization and event handling.
 * These types match the WebSocket event format from the backend.
 */

// =============================================================================
// WebSocket Event Types (from backend)
// =============================================================================

/**
 * Base WebSocket message with common fields
 */
export interface BaseCaptionEvent {
    type: string;
    timestamp?: number;
}

/**
 * Translation message event (partial or final)
 */
export interface TranslationEvent extends BaseCaptionEvent {
    type: 'translation';

    // Sequence tracking
    seqId?: number;
    sourceSeqId?: number;

    // Partial/final status
    isPartial: boolean;
    forceFinal?: boolean;

    // Text content
    originalText?: string;
    correctedText?: string;
    translatedText?: string;

    // Language info
    sourceLang?: string;
    targetLang?: string;

    // Translation status
    hasTranslation?: boolean;
    hasCorrection?: boolean;

    // Pipeline metadata
    pipeline?: string;
    recoveryEpoch?: number;
}

/**
 * Session joined confirmation
 */
export interface SessionJoinedEvent extends BaseCaptionEvent {
    type: 'session_joined';
    sessionCode?: string;
    sessionId?: string;
}

/**
 * Session ready event (for hosts)
 */
export interface SessionReadyEvent extends BaseCaptionEvent {
    type: 'session_ready';
    sessionCode?: string;
}

/**
 * Session ended event
 */
export interface SessionEndedEvent extends BaseCaptionEvent {
    type: 'session_ended';
}

/**
 * Error event
 */
export interface ErrorEvent extends BaseCaptionEvent {
    type: 'error';
    message: string;
    code?: string;
}

/**
 * Transcript event (raw STT)
 */
export interface TranscriptEvent extends BaseCaptionEvent {
    type: 'transcript';
    text: string;
}

/**
 * Session stats event
 */
export interface SessionStatsEvent extends BaseCaptionEvent {
    type: 'session_stats';
    listenerCount?: number;
}

/**
 * TTS-related events (passed through, not processed by engine)
 */
export interface TtsEvent extends BaseCaptionEvent {
    type: 'tts/audio' | 'tts/audio_chunk' | 'tts/error' | 'tts/ack';
    [key: string]: unknown;
}

/**
 * Union of all caption event types
 */
export type CaptionEvent =
    | TranslationEvent
    | SessionJoinedEvent
    | SessionReadyEvent
    | SessionEndedEvent
    | ErrorEvent
    | TranscriptEvent
    | SessionStatsEvent
    | TtsEvent
    | BaseCaptionEvent;

// =============================================================================
// Caption View Model (output state)
// =============================================================================

/**
 * Connection status
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

/**
 * A single committed caption entry
 */
export interface CommittedEntry {
    /** Display text (translated or transcribed) */
    text: string;

    /** Original text (source language) */
    original?: string;

    /** Sequence ID from backend */
    seqId?: number;

    /** Source sequence ID for correlation */
    sourceSeqId?: number;

    /** Unix timestamp */
    timestamp: number;

    /** True if this was auto-segmented (not from backend final) */
    isSegmented?: boolean;
}

/**
 * Debug information for development/troubleshooting
 */
export interface DebugInfo {
    /** Last event type processed */
    lastEventType?: string;

    /** Count of dropped duplicate events */
    droppedDuplicates: number;

    /** Count of out-of-order partials dropped */
    outOfOrderCount: number;

    /** Last processed seqId */
    lastSeqId?: number;

    /** Fingerprints of recently seen texts (for dedup debugging) */
    recentFingerprints?: string[];
}

/**
 * The stable view model output from the engine.
 * React/Electron UIs render this directly without additional processing.
 */
export interface CaptionViewModel {
    /** Current connection status */
    status: ConnectionStatus;

    /** Current target language code */
    lang: string;

    /** Current sequence number */
    seq: number;

    /** Currently updating partial text (live line) */
    liveLine: string;

    /** Current original text (source language, live) */
    liveOriginal: string;

    /** Committed history entries */
    committedLines: CommittedEntry[];

    /** Maximum history size */
    maxHistory: number;

    /** Debug information (optional, for development) */
    debug?: DebugInfo;
}

// =============================================================================
// Engine Configuration
// =============================================================================

/**
 * Sentence segmenter interface (injected dependency)
 * Matches the API of frontend/src/utils/sentenceSegmenter.js
 */
export interface ISentenceSegmenter {
    processPartial(cumulativeText: string): { liveText: string; flushedSentences: string[] };
    processFinal(finalText: string, options?: { isForced?: boolean }): { flushedSentences: string[] };
    reset(): void;
    softReset(): void;
    hardReset(): void;
    getState(): { liveText: string; flushedText: string };

    // These may be accessed directly in some code paths
    flushedText?: string;
    detectSentences?(text: string): string[];
    isComplete?(sentence: string): boolean;
}

/**
 * Configuration options for CaptionClientEngine
 */
export interface CaptionEngineOptions {
    /** Sentence segmenter instance (required) */
    segmenter: ISentenceSegmenter;

    /** Target language code */
    lang: string;

    /** Source language code (for transcription mode detection) */
    sourceLang?: string;

    /** Maximum entries in committed history */
    maxHistory?: number;

    /** Enable debug mode (extra logging and debug state) */
    debug?: boolean;

    /** Callback for auto-flushed segments (from segmenter) */
    onFlush?: (flushedSentences: string[]) => void;
}

/**
 * Engine event types for the event emitter
 */
export interface CaptionEngineEvents {
    /** Index signature for TypedEmitter compatibility */
    [key: string]: unknown;

    /** Emitted when state changes */
    state: CaptionViewModel;

    /** Emitted for debug events */
    debug: { event: string; data: unknown };

    /** Emitted on error */
    error: Error;

    /** Emitted when TTS events are received (pass-through) */
    tts: TtsEvent;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Type guard for TranslationEvent
 */
export function isTranslationEvent(event: CaptionEvent): event is TranslationEvent {
    return event.type === 'translation';
}

/**
 * Type guard for TTS events
 */
export function isTtsEvent(event: CaptionEvent): event is TtsEvent {
    return event.type.startsWith('tts/');
}

/**
 * Type guard for error events
 */
export function isErrorEvent(event: CaptionEvent): event is ErrorEvent {
    return event.type === 'error';
}
