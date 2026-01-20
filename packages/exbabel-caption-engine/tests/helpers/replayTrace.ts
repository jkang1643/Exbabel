/**
 * Golden test helpers
 * 
 * Utilities for replaying WebSocket event traces and capturing state snapshots.
 */

import type { CaptionEvent, CaptionViewModel } from '../../src/types.js';
import type { CaptionClientEngine } from '../../src/CaptionClientEngine.js';

/**
 * State snapshot at a point in time
 */
export interface StateSnapshot {
    eventIndex: number;
    eventType: string;
    timestamp: number;
    state: CaptionViewModel;
}

/**
 * Replay a trace of events through an engine and capture state snapshots
 */
export function replayTrace(
    engine: CaptionClientEngine,
    events: CaptionEvent[]
): StateSnapshot[] {
    const snapshots: StateSnapshot[] = [];

    // Capture initial state
    snapshots.push({
        eventIndex: -1,
        eventType: 'initial',
        timestamp: Date.now(),
        state: structuredClone(engine.getState()),
    });

    // Process each event
    for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        engine.ingest(event);

        snapshots.push({
            eventIndex: i,
            eventType: event.type,
            timestamp: event.timestamp || Date.now(),
            state: structuredClone(engine.getState()),
        });
    }

    return snapshots;
}

/**
 * Extract only the final state from a trace replay
 */
export function replayToFinalState(
    engine: CaptionClientEngine,
    events: CaptionEvent[]
): CaptionViewModel {
    for (const event of events) {
        engine.ingest(event);
    }
    return engine.getState();
}

/**
 * Compare two view models for essential equality
 * (ignoring timestamps and debug info)
 */
export function compareViewModels(
    actual: CaptionViewModel,
    expected: Partial<CaptionViewModel>
): { equal: boolean; differences: string[] } {
    const differences: string[] = [];

    if (expected.status !== undefined && actual.status !== expected.status) {
        differences.push(`status: expected "${expected.status}", got "${actual.status}"`);
    }

    if (expected.lang !== undefined && actual.lang !== expected.lang) {
        differences.push(`lang: expected "${expected.lang}", got "${actual.lang}"`);
    }

    if (expected.seq !== undefined && actual.seq !== expected.seq) {
        differences.push(`seq: expected ${expected.seq}, got ${actual.seq}`);
    }

    if (expected.liveLine !== undefined && actual.liveLine !== expected.liveLine) {
        differences.push(`liveLine: expected "${expected.liveLine}", got "${actual.liveLine}"`);
    }

    if (expected.committedLines !== undefined) {
        if (actual.committedLines.length !== expected.committedLines.length) {
            differences.push(
                `committedLines.length: expected ${expected.committedLines.length}, got ${actual.committedLines.length}`
            );
        } else {
            for (let i = 0; i < expected.committedLines.length; i++) {
                const exp = expected.committedLines[i]!;
                const act = actual.committedLines[i]!;

                if (exp.text !== act.text) {
                    differences.push(`committedLines[${i}].text: expected "${exp.text}", got "${act.text}"`);
                }
                if (exp.seqId !== undefined && exp.seqId !== act.seqId) {
                    differences.push(`committedLines[${i}].seqId: expected ${exp.seqId}, got ${act.seqId}`);
                }
            }
        }
    }

    return {
        equal: differences.length === 0,
        differences,
    };
}

/**
 * Create a mock sentence segmenter for testing
 */
export function createMockSegmenter() {
    let flushedText = '';

    return {
        flushedText,

        processPartial(cumulativeText: string) {
            return {
                liveText: cumulativeText,
                flushedSentences: [] as string[],
            };
        },

        processFinal(finalText: string, _options?: { isForced?: boolean }) {
            // Simple dedup: if already flushed, return empty
            if (flushedText.includes(finalText)) {
                return { flushedSentences: [] };
            }
            flushedText += ' ' + finalText;
            flushedText = flushedText.trim();
            return { flushedSentences: [finalText] };
        },

        reset() {
            // Keep flushedText for dedup
        },

        softReset() {
            // Keep flushedText
        },

        hardReset() {
            flushedText = '';
        },

        getState() {
            return { liveText: '', flushedText };
        },
    };
}
