/**
 * Golden Run Tests
 * 
 * Replays recorded WebSocket event traces and verifies engine state.
 * Uses snapshots for deterministic regression testing.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { CaptionClientEngine } from '../src/CaptionClientEngine.js';
import { sampleTrace, expectedFinalState } from './fixtures/sample-trace.js';
import {
    replayTrace,
    replayToFinalState,
    compareViewModels,
    createMockSegmenter
} from './helpers/replayTrace.js';
import type { CaptionEvent, CaptionViewModel } from '../src/types.js';

describe('CaptionClientEngine', () => {
    let engine: CaptionClientEngine;
    let segmenter: ReturnType<typeof createMockSegmenter>;

    beforeEach(() => {
        segmenter = createMockSegmenter();
        engine = new CaptionClientEngine({
            segmenter,
            lang: 'es',
            sourceLang: 'en',
            debug: true,
        });
    });

    describe('Golden Run: Sample Trace', () => {
        test('processes sample trace and produces expected final state', () => {
            const finalState = replayToFinalState(engine, sampleTrace as CaptionEvent[]);

            // Check essential properties
            expect(finalState.lang).toBe('es');
            expect(finalState.seq).toBe(expectedFinalState.seq);
            expect(finalState.liveLine).toBe('');
            expect(finalState.committedLines.length).toBe(expectedFinalState.committedLines.length);

            // Check committed lines content
            for (let i = 0; i < expectedFinalState.committedLines.length; i++) {
                const expected = expectedFinalState.committedLines[i]!;
                const actual = finalState.committedLines[i]!;
                expect(actual.text).toBe(expected.text);
                expect(actual.seqId).toBe(expected.seqId);
            }
        });

        test('drops out-of-order partials', () => {
            const events: CaptionEvent[] = [
                {
                    type: 'translation',
                    seqId: 2,
                    sourceSeqId: 1,
                    isPartial: true,
                    originalText: 'Hello world',
                    translatedText: 'Hola mundo',
                    sourceLang: 'en',
                    targetLang: 'es',
                    hasTranslation: true,
                },
                {
                    type: 'translation',
                    seqId: 1, // Out of order!
                    sourceSeqId: 1,
                    isPartial: true,
                    originalText: 'Hello',
                    translatedText: 'Hola',
                    sourceLang: 'en',
                    targetLang: 'es',
                    hasTranslation: true,
                },
            ];

            engine.ingest(events[0]!);
            const stateAfterFirst = engine.getState();
            expect(stateAfterFirst.liveLine).toBe('Hola mundo');

            engine.ingest(events[1]!);
            const stateAfterSecond = engine.getState();
            // Should still be "Hola mundo" - out-of-order partial was dropped
            expect(stateAfterSecond.liveLine).toBe('Hola mundo');
            expect(stateAfterSecond.debug?.outOfOrderCount).toBe(1);
        });

        test('drops duplicate finals', () => {
            const final: CaptionEvent = {
                type: 'translation',
                seqId: 5,
                sourceSeqId: 5,
                isPartial: false,
                originalText: 'Hello.',
                translatedText: 'Hola.',
                sourceLang: 'en',
                targetLang: 'es',
                hasTranslation: true,
            };

            engine.ingest(final);
            const stateAfterFirst = engine.getState();
            expect(stateAfterFirst.committedLines.length).toBe(1);

            engine.ingest(final); // Same seqId
            const stateAfterSecond = engine.getState();
            // Should still be 1 - duplicate was dropped
            expect(stateAfterSecond.committedLines.length).toBe(1);
            expect(stateAfterSecond.debug?.droppedDuplicates).toBeGreaterThan(0);
        });

        test('ignores translations for other languages', () => {
            const frenchTranslation: CaptionEvent = {
                type: 'translation',
                seqId: 1,
                sourceSeqId: 1,
                isPartial: true,
                originalText: 'Hello',
                translatedText: 'Bonjour', // French
                sourceLang: 'en',
                targetLang: 'fr', // Not Spanish!
                hasTranslation: true,
            };

            engine.ingest(frenchTranslation);
            const state = engine.getState();
            // Should be empty - not for our language
            expect(state.liveLine).toBe('');
        });

        test('handles transcription mode (same source and target language)', () => {
            // Create engine with same source and target
            const transcriptionEngine = new CaptionClientEngine({
                segmenter: createMockSegmenter(),
                lang: 'en',
                sourceLang: 'en',
            });

            const transcription: CaptionEvent = {
                type: 'translation',
                seqId: 1,
                sourceSeqId: 1,
                isPartial: true,
                originalText: 'Hello world',
                correctedText: 'Hello, world',
                sourceLang: 'en',
                targetLang: 'en',
                hasTranslation: false, // No translation needed
            };

            transcriptionEngine.ingest(transcription);
            const state = transcriptionEngine.getState();
            // Should use correctedText in transcription mode
            expect(state.liveLine).toBe('Hello, world');
        });
    });

    describe('State Management', () => {
        test('reset() clears all state', () => {
            // Add some state
            engine.ingest({
                type: 'translation',
                seqId: 1,
                sourceSeqId: 1,
                isPartial: false,
                originalText: 'Hello.',
                translatedText: 'Hola.',
                sourceLang: 'en',
                targetLang: 'es',
                hasTranslation: true,
            });

            expect(engine.getState().committedLines.length).toBe(1);

            engine.reset();

            const state = engine.getState();
            expect(state.liveLine).toBe('');
            expect(state.committedLines.length).toBe(0);
            expect(state.seq).toBe(0);
        });

        test('setLang() changes language and resets state', () => {
            engine.ingest({
                type: 'translation',
                seqId: 1,
                sourceSeqId: 1,
                isPartial: true,
                originalText: 'Hello',
                translatedText: 'Hola',
                sourceLang: 'en',
                targetLang: 'es',
                hasTranslation: true,
            });

            expect(engine.getState().liveLine).toBe('Hola');

            engine.setLang('fr');

            const state = engine.getState();
            expect(state.lang).toBe('fr');
            expect(state.liveLine).toBe('');
        });
    });

    describe('Event Emission', () => {
        test('emits state on every significant change', () => {
            const stateChanges: CaptionViewModel[] = [];
            engine.on('state', (state) => stateChanges.push(state));

            engine.ingest({
                type: 'translation',
                seqId: 1,
                sourceSeqId: 1,
                isPartial: true,
                originalText: 'Hello',
                translatedText: 'Hola',
                sourceLang: 'en',
                targetLang: 'es',
                hasTranslation: true,
            });

            expect(stateChanges.length).toBeGreaterThan(0);
            expect(stateChanges[stateChanges.length - 1]!.liveLine).toBe('Hola');
        });

        test('emits TTS events as pass-through', () => {
            const ttsEvents: unknown[] = [];
            engine.on('tts', (event) => ttsEvents.push(event));

            engine.ingest({
                type: 'tts/audio',
                segmentId: 'test',
                audioData: 'base64...',
            });

            expect(ttsEvents.length).toBe(1);
            expect(ttsEvents[0]).toHaveProperty('type', 'tts/audio');
        });
    });

    describe('Snapshot Tests', () => {
        test('full trace produces expected snapshots', () => {
            const snapshots = replayTrace(engine, sampleTrace as CaptionEvent[]);

            // Verify snapshot structure
            expect(snapshots.length).toBe(sampleTrace.length + 1); // +1 for initial state

            // Each snapshot should have required fields
            for (const snapshot of snapshots) {
                expect(snapshot).toHaveProperty('eventIndex');
                expect(snapshot).toHaveProperty('eventType');
                expect(snapshot).toHaveProperty('state');
                expect(snapshot.state).toHaveProperty('liveLine');
                expect(snapshot.state).toHaveProperty('committedLines');
            }
        });
    });
});
