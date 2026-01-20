/**
 * Caption Client Engine
 * 
 * Framework-agnostic caption stabilization engine extracted from
 * ListenerPage.jsx and HostPage.jsx for reuse in web and Electron apps.
 * 
 * Responsibilities:
 * - WebSocket event handling (ingest)
 * - Out-of-order partial detection and dropping
 * - Partial/final processing with deduplication
 * - State management (liveLine, committedLines)
 * - Event emission for UI updates
 */

import { TypedEmitter } from './utils/emitter.js';
import type {
    CaptionEvent,
    CaptionViewModel,
    CaptionEngineOptions,
    CaptionEngineEvents,
    CommittedEntry,
    DebugInfo,
    ConnectionStatus,
    TranslationEvent,
    ISentenceSegmenter,
} from './types.js';
import { isTranslationEvent, isTtsEvent, isErrorEvent } from './types.js';

/**
 * Fingerprint helper for debugging ghost sentences
 * Creates a short hash for text comparison
 */
function fingerprint(s: string): string {
    if (!s) return '(empty)';
    const trimmed = s.trim().toLowerCase();
    const prefix = trimmed.slice(0, 30);
    const suffix = trimmed.length > 30 ? '...' + trimmed.slice(-10) : '';
    return `${prefix}${suffix}[${trimmed.length}]`;
}

/**
 * Normalize text for comparison (deduplication)
 */
function normalizeText(text: string): string {
    return text.toLowerCase().replace(/[.,!?;:'\"]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Caption Client Engine
 * 
 * Manages caption state and emits updates for dumb UIs to render.
 */
export class CaptionClientEngine extends TypedEmitter<CaptionEngineEvents> {
    // Configuration
    private readonly segmenter: ISentenceSegmenter;
    private readonly maxHistory: number;
    private readonly debugMode: boolean;
    private readonly onFlushCallback?: (flushedSentences: string[]) => void;

    // Language settings
    private lang: string;
    private sourceLang: string;

    // Connection state
    private status: ConnectionStatus = 'disconnected';
    private ws: WebSocket | null = null;

    // Caption state
    private liveLine = '';
    private liveOriginal = '';
    private committedLines: CommittedEntry[] = [];
    private seq = 0;

    // Out-of-order detection
    private lastPartialSeqBySource = new Map<number, number>();

    // Deduplication
    private seenFingerprints = new Set<string>();
    private processedSeqIds = new Set<number>();
    private originalBySeqId = new Map<number, string>();
    private lastNonEmptyOriginal = '';

    // Grammar correction tracking (from HostPage)
    private longestCorrectedText = '';
    private longestCorrectedOriginal = '';

    // Throttling (for high-frequency partials)
    private lastRenderTime = 0;
    private lastTextLength = 0;

    // Debug counters
    private debug: DebugInfo = {
        droppedDuplicates: 0,
        outOfOrderCount: 0,
    };

    constructor(options: CaptionEngineOptions) {
        super();

        this.segmenter = options.segmenter;
        this.lang = options.lang;
        this.sourceLang = options.sourceLang || 'en';
        this.maxHistory = options.maxHistory || 50;
        this.debugMode = options.debug || false;
        this.onFlushCallback = options.onFlush;
    }

    // ===========================================================================
    // Public API
    // ===========================================================================

    /**
     * Connect to a WebSocket URL (browser/Electron renderer only)
     * 
     * This is a convenience method that creates a WebSocket instance internally.
     * For Node.js or Electron main process, use connectWithWebSocket() or manual ingestion.
     * 
     * @param wsUrl - WebSocket URL to connect to
     */
    connect(wsUrl: string): void {
        if (this.ws) {
            this.disconnect();
        }

        this.status = 'connecting';
        this.emitState();

        try {
            const ws = new WebSocket(wsUrl);
            this.connectWithWebSocket(ws);
        } catch (err) {
            this.status = 'disconnected';
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
    }

    /**
     * Connect with an existing WebSocket instance
     * 
     * Use this method when you need to inject a WebSocket implementation
     * (e.g., 'ws' package in Node.js or Electron main process).
     * 
     * @param ws - WebSocket instance to attach to
     * 
     * @example
     * ```typescript
     * import WebSocket from 'ws';
     * const ws = new WebSocket(url);
     * engine.connectWithWebSocket(ws);
     * ```
     */
    connectWithWebSocket(ws: WebSocket): void {
        if (this.ws) {
            this.disconnect();
        }

        this.ws = ws;
        this.status = 'connecting';
        this.emitState();

        this.ws.onopen = () => {
            this.status = 'connected';
            this.emitState();
            this.emitDebug('connected', {});
        };

        this.ws.onclose = () => {
            this.status = 'disconnected';
            this.ws = null;
            this.emitState();
            this.emitDebug('disconnected', {});
        };

        this.ws.onerror = (error) => {
            this.emit('error', new Error(`WebSocket error: ${error}`));
        };

        this.ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
                try {
                    const message = JSON.parse(event.data) as CaptionEvent;
                    this.ingest(message);
                } catch {
                    // Ignore parse errors
                }
            }
        };

        // If already open, emit connected immediately
        if (ws.readyState === WebSocket.OPEN) {
            this.status = 'connected';
            this.emitState();
        }
    }

    /**
     * Disconnect from WebSocket
     */
    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.status = 'disconnected';
        this.emitState();
    }

    /**
     * Ingest a raw WebSocket event
     * This is the main entry point for processing events.
     */
    ingest(event: CaptionEvent): void {
        this.debug.lastEventType = event.type;

        // Track fingerprints for dedup debugging
        if (isTranslationEvent(event)) {
            if (event.translatedText) {
                this.seenFingerprints.add(fingerprint(event.translatedText));
            }
            if (event.originalText) {
                this.seenFingerprints.add(fingerprint(event.originalText));
            }
        }

        // Route by event type
        switch (event.type) {
            case 'translation':
                this.handleTranslation(event as TranslationEvent);
                break;

            case 'session_joined':
            case 'session_ready':
                this.emitDebug('session', event);
                break;

            case 'session_ended':
                this.reset();
                this.emitState();
                break;

            case 'error':
                if (isErrorEvent(event)) {
                    this.emit('error', new Error(event.message));
                }
                break;

            case 'session_stats':
                // Ignore stats messages
                break;

            default:
                // Pass through TTS events
                if (isTtsEvent(event)) {
                    this.emit('tts', event);
                } else {
                    this.emitDebug('unknown', event);
                }
        }
    }

    /**
     * Get the current state as a view model
     */
    getState(): CaptionViewModel {
        return {
            status: this.status,
            lang: this.lang,
            seq: this.seq,
            liveLine: this.liveLine,
            liveOriginal: this.liveOriginal,
            committedLines: [...this.committedLines],
            maxHistory: this.maxHistory,
            debug: this.debugMode ? { ...this.debug } : undefined,
        };
    }

    /**
     * Update target language
     */
    setLang(lang: string): void {
        this.lang = lang;
        this.reset();
        this.emitState();
    }

    /**
     * Reset all caption state (but keep connection)
     */
    reset(): void {
        this.liveLine = '';
        this.liveOriginal = '';
        this.committedLines = [];
        this.seq = 0;
        this.lastPartialSeqBySource.clear();
        this.processedSeqIds.clear();
        this.originalBySeqId.clear();
        this.longestCorrectedText = '';
        this.longestCorrectedOriginal = '';
        this.lastRenderTime = 0;
        this.lastTextLength = 0;
        this.segmenter.reset();
    }

    // ===========================================================================
    // Translation Handling (extracted from ListenerPage/HostPage)
    // ===========================================================================

    private handleTranslation(message: TranslationEvent): void {
        // Out-of-order partial detection
        if (message.isPartial && message.sourceSeqId != null && message.seqId != null) {
            const last = this.lastPartialSeqBySource.get(message.sourceSeqId) || 0;
            if (message.seqId <= last) {
                this.debug.outOfOrderCount++;
                this.emitDebug('drop_ooo_partial', {
                    sourceSeqId: message.sourceSeqId,
                    seqId: message.seqId,
                    last,
                });
                return;
            }
            this.lastPartialSeqBySource.set(message.sourceSeqId, message.seqId);
        }

        if (message.isPartial) {
            this.handlePartial(message);
        } else {
            this.handleFinal(message);
        }
    }

    private handlePartial(message: TranslationEvent): void {
        const correctedText = message.correctedText;
        const originalText = message.originalText || '';
        const textToDisplay = correctedText?.trim() ? correctedText : originalText;

        // Cache original text
        if (textToDisplay) {
            this.cacheOriginal(textToDisplay, message.sourceSeqId ?? message.seqId);
        }

        // Check if this message is for our target language
        const hasTranslatedText = typeof message.translatedText === 'string' && message.translatedText.trim().length > 0;
        const hasTranslationFlag = message.hasTranslation === true || hasTranslatedText;
        const isForMyLanguage = hasTranslationFlag && message.targetLang === this.lang;
        const isTranscriptionMode = this.lang === this.sourceLang;

        if (!isForMyLanguage && !isTranscriptionMode) {
            return;
        }

        // Determine text to display
        let displayText = isTranscriptionMode
            ? (correctedText?.trim() ? correctedText : originalText)
            : message.translatedText;

        if (!displayText) {
            return;
        }

        // Process through segmenter
        const { liveText, flushedSentences } = this.segmenter.processPartial(displayText);

        // Handle auto-flushed sentences
        if (flushedSentences.length > 0 && this.onFlushCallback) {
            this.onFlushCallback(flushedSentences);
            this.commitFlushedSentences(flushedSentences);
        }

        // Throttling: limit render frequency
        const THROTTLE_MS = 66; // ~15 fps
        const MIN_CHAR_DELTA = 3;
        const now = Date.now();
        const timeSinceLastRender = now - this.lastRenderTime;
        const charDelta = liveText.length - this.lastTextLength;
        const isFirstAfterReset = this.lastRenderTime === 0;

        const shouldRender =
            isFirstAfterReset ||
            charDelta >= MIN_CHAR_DELTA ||
            timeSinceLastRender >= THROTTLE_MS;

        if (shouldRender) {
            this.lastRenderTime = now;
            this.lastTextLength = liveText.length;

            // Filter suspicious/refusal content
            if (!this.isSuspiciousContent(message, liveText, displayText, isTranscriptionMode)) {
                this.liveLine = liveText;
                this.liveOriginal = textToDisplay;
                this.emitState();
            }
        }
    }

    private handleFinal(message: TranslationEvent): void {
        // Lock finals to prevent partial overwrites
        if (message.sourceSeqId != null && message.seqId != null) {
            this.lastPartialSeqBySource.set(message.sourceSeqId, Number.MAX_SAFE_INTEGER);
        }

        const finalText = message.correctedText || message.translatedText || message.originalText;
        const finalSeqId = message.seqId;
        const isForcedFinal = message.forceFinal === true;

        // Prevent duplicate processing
        if (finalSeqId !== undefined && finalSeqId !== null) {
            if (this.processedSeqIds.has(finalSeqId)) {
                this.debug.droppedDuplicates++;
                return;
            }
            this.processedSeqIds.add(finalSeqId);

            // Cleanup old seqIds
            if (this.processedSeqIds.size > 100) {
                const seqIdsArray = Array.from(this.processedSeqIds).sort((a, b) => a - b);
                const toRemove = seqIdsArray.slice(0, seqIdsArray.length - 100);
                toRemove.forEach(id => this.processedSeqIds.delete(id));
            }
        }

        if (!finalText?.trim()) {
            return;
        }

        // Check language
        const isForMyLanguage = message.hasTranslation && message.targetLang === this.lang;
        const isTranscriptionMode = this.lang === this.sourceLang;

        if (!isForMyLanguage && !isTranscriptionMode) {
            return;
        }

        const textToDisplay = isForMyLanguage
            ? message.translatedText
            : (message.correctedText || message.originalText);

        if (!textToDisplay?.trim()) {
            return;
        }

        // Reset correction tracking
        this.longestCorrectedText = '';
        this.longestCorrectedOriginal = '';

        // Process through segmenter for deduplication
        // CRITICAL: Use textToDisplay (the correct text for target language) not finalText
        const { flushedSentences } = this.segmenter.processFinal(textToDisplay.trim(), { isForced: isForcedFinal });

        if (flushedSentences.length > 0) {
            const joinedText = flushedSentences.join(' ').trim();
            if (joinedText) {
                this.addToHistory(joinedText, message, finalSeqId);
            }
        } else {
            // Fallback: segmenter deduplicated everything, but still add if substantial
            if (textToDisplay.trim().length > 10 && !this.isInHistory(textToDisplay.trim())) {
                this.addToHistory(textToDisplay.trim(), message, finalSeqId);
            }
        }

        // Clear live displays
        this.liveLine = '';
        this.liveOriginal = '';
        this.segmenter.reset();
        this.lastRenderTime = 0;
        this.lastTextLength = 0;

        // Update sequence
        if (finalSeqId !== undefined) {
            this.seq = Math.max(this.seq, finalSeqId);
            this.debug.lastSeqId = finalSeqId;
        }

        this.emitState();
    }

    // ===========================================================================
    // Helper Methods
    // ===========================================================================

    private cacheOriginal(text: string, seqId?: number): void {
        const trimmed = text.trim();
        if (!trimmed) return;

        this.lastNonEmptyOriginal = trimmed;

        if (seqId !== undefined && seqId !== null && seqId !== -1) {
            this.originalBySeqId.set(seqId, trimmed);
        }
    }

    private commitFlushedSentences(sentences: string[]): void {
        const joinedText = sentences.join(' ').trim();
        if (!joinedText) return;

        const newEntry: CommittedEntry = {
            text: joinedText,
            timestamp: Date.now(),
            seqId: -1, // Auto-segmented
            isSegmented: true,
        };

        this.committedLines = [...this.committedLines, newEntry].slice(-this.maxHistory);
        this.emitState();
    }

    private addToHistory(text: string, message: TranslationEvent, seqId?: number): void {
        const stableKey = message.sourceSeqId ?? message.seqId;
        const cachedOriginal = stableKey !== undefined ? this.originalBySeqId.get(stableKey) : undefined;
        const fallbackOriginal = cachedOriginal || this.lastNonEmptyOriginal || '';
        const safeOriginal = message.originalText?.trim() || message.correctedText?.trim() || fallbackOriginal;

        // Remove auto-segmented entries that are contained in this final
        const textNormalized = normalizeText(text);
        this.committedLines = this.committedLines.filter(entry => {
            if (entry.isSegmented) {
                const entryNormalized = normalizeText(entry.text);
                if (textNormalized.includes(entryNormalized) && entryNormalized.length > 10) {
                    return false; // Remove
                }
            }
            return true;
        });

        // Check for duplicates
        const isDuplicate = this.committedLines.some(entry => {
            if (entry.seqId === seqId) return true;
            const entryNormalized = normalizeText(entry.text);
            return entryNormalized === textNormalized;
        });

        if (isDuplicate) {
            this.debug.droppedDuplicates++;
            return;
        }

        const newEntry: CommittedEntry = {
            text,
            original: safeOriginal,
            seqId: seqId,
            sourceSeqId: message.sourceSeqId,
            timestamp: message.timestamp || Date.now(),
        };

        // Insert in order by seqId
        this.committedLines = [...this.committedLines, newEntry]
            .sort((a, b) => {
                if (a.seqId !== undefined && b.seqId !== undefined && a.seqId !== -1 && b.seqId !== -1) {
                    return a.seqId - b.seqId;
                }
                return (a.timestamp || 0) - (b.timestamp || 0);
            })
            .slice(-this.maxHistory);
    }

    private isInHistory(text: string): boolean {
        const normalized = normalizeText(text);
        return this.committedLines.some(entry => {
            const entryNormalized = normalizeText(entry.text);
            return entryNormalized === normalized ||
                (entryNormalized.length > 10 && normalized.includes(entryNormalized)) ||
                (normalized.length > 10 && entryNormalized.includes(normalized));
        });
    }

    private isSuspiciousContent(
        message: TranslationEvent,
        liveText: string,
        translatedText: string | undefined,
        isTranscriptionMode: boolean
    ): boolean {
        // Skip if translation is suspiciously similar to original (API misfire)
        if (!isTranscriptionMode && message.originalText && translatedText) {
            if (translatedText.toLowerCase().trim() === message.originalText.toLowerCase().trim()) {
                return true;
            }
        }

        // Skip AI refusal messages
        const lowerText = (translatedText || liveText || '').toLowerCase();
        const refusalPhrases = [
            'sorry', 'lo siento', 'désolé', 'desculpe',
            "i can't", 'i cannot', 'no puedo', 'je ne peux',
            'unfortunately', 'lamentablemente'
        ];

        return refusalPhrases.some(phrase => lowerText.includes(phrase));
    }

    // ===========================================================================
    // Event Emission
    // ===========================================================================

    private emitState(): void {
        this.emit('state', this.getState());
    }

    private emitDebug(event: string, data: unknown): void {
        if (this.debugMode) {
            this.emit('debug', { event, data });
        }
    }

    /**
     * Grammar merge helper (from HostPage)
     * Merges new raw text with existing corrections
     */
    mergeTextWithCorrection(newRawText: string, correctedOverride: string | null = null): string {
        const trimmedRaw = (newRawText || '').trim();
        if (!trimmedRaw) {
            return '';
        }

        if (correctedOverride?.trim()) {
            this.longestCorrectedText = correctedOverride;
            this.longestCorrectedOriginal = trimmedRaw;
            return correctedOverride;
        }

        const existingCorrected = this.longestCorrectedText;
        const existingOriginal = this.longestCorrectedOriginal;

        if (existingCorrected && existingOriginal) {
            if (trimmedRaw.startsWith(existingOriginal)) {
                const extension = trimmedRaw.substring(existingOriginal.length);
                const merged = existingCorrected + extension;
                this.longestCorrectedText = merged;
                this.longestCorrectedOriginal = trimmedRaw;
                return merged;
            }
        }

        this.longestCorrectedText = trimmedRaw;
        this.longestCorrectedOriginal = trimmedRaw;
        return trimmedRaw;
    }
}
