/**
 * Sample WebSocket event trace for golden testing
 * 
 * This fixture represents a realistic sequence of events from a translation session.
 * Used to verify the engine produces expected state transitions.
 */
export const sampleTrace = [
    // Session joined
    {
        type: 'session_joined',
        sessionCode: 'ABC123',
        timestamp: 1705000000000,
    },

    // First partial (English -> Spanish)
    {
        type: 'translation',
        seqId: 1,
        sourceSeqId: 1,
        isPartial: true,
        originalText: 'Hello',
        translatedText: 'Hola',
        sourceLang: 'en',
        targetLang: 'es',
        hasTranslation: true,
        timestamp: 1705000001000,
    },

    // Extended partial
    {
        type: 'translation',
        seqId: 2,
        sourceSeqId: 1,
        isPartial: true,
        originalText: 'Hello everyone',
        translatedText: 'Hola a todos',
        sourceLang: 'en',
        targetLang: 'es',
        hasTranslation: true,
        timestamp: 1705000002000,
    },

    // Out-of-order partial (should be dropped)
    {
        type: 'translation',
        seqId: 1, // Lower than seqId 2
        sourceSeqId: 1,
        isPartial: true,
        originalText: 'Hello',
        translatedText: 'Hola',
        sourceLang: 'en',
        targetLang: 'es',
        hasTranslation: true,
        timestamp: 1705000002500,
    },

    // Final for first segment
    {
        type: 'translation',
        seqId: 3,
        sourceSeqId: 1,
        isPartial: false,
        originalText: 'Hello everyone.',
        correctedText: 'Hello everyone.',
        translatedText: 'Hola a todos.',
        sourceLang: 'en',
        targetLang: 'es',
        hasTranslation: true,
        timestamp: 1705000003000,
    },

    // New segment partial
    {
        type: 'translation',
        seqId: 4,
        sourceSeqId: 4,
        isPartial: true,
        originalText: 'Welcome to',
        translatedText: 'Bienvenidos a',
        sourceLang: 'en',
        targetLang: 'es',
        hasTranslation: true,
        timestamp: 1705000004000,
    },

    // Extended partial
    {
        type: 'translation',
        seqId: 5,
        sourceSeqId: 4,
        isPartial: true,
        originalText: 'Welcome to the conference',
        translatedText: 'Bienvenidos a la conferencia',
        sourceLang: 'en',
        targetLang: 'es',
        hasTranslation: true,
        timestamp: 1705000005000,
    },

    // Forced final (speaker pause)
    {
        type: 'translation',
        seqId: 6,
        sourceSeqId: 4,
        isPartial: false,
        forceFinal: true,
        originalText: 'Welcome to the conference.',
        correctedText: 'Welcome to the conference.',
        translatedText: 'Bienvenidos a la conferencia.',
        sourceLang: 'en',
        targetLang: 'es',
        hasTranslation: true,
        timestamp: 1705000006000,
    },

    // Duplicate final (same seqId, should be dropped)
    {
        type: 'translation',
        seqId: 6,
        sourceSeqId: 4,
        isPartial: false,
        originalText: 'Welcome to the conference.',
        translatedText: 'Bienvenidos a la conferencia.',
        sourceLang: 'en',
        targetLang: 'es',
        hasTranslation: true,
        timestamp: 1705000006500,
    },

    // Grammar correction example
    {
        type: 'translation',
        seqId: 7,
        sourceSeqId: 7,
        isPartial: true,
        originalText: 'We gonna start',
        correctedText: "We're going to start",
        translatedText: 'Vamos a comenzar',
        sourceLang: 'en',
        targetLang: 'es',
        hasTranslation: true,
        hasCorrection: true,
        timestamp: 1705000007000,
    },

    // Final with correction
    {
        type: 'translation',
        seqId: 8,
        sourceSeqId: 7,
        isPartial: false,
        originalText: 'We gonna start now.',
        correctedText: "We're going to start now.",
        translatedText: 'Vamos a comenzar ahora.',
        sourceLang: 'en',
        targetLang: 'es',
        hasTranslation: true,
        hasCorrection: true,
        timestamp: 1705000008000,
    },

    // Session stats (should be ignored)
    {
        type: 'session_stats',
        listenerCount: 5,
        timestamp: 1705000009000,
    },

    // TTS event (should be passed through)
    {
        type: 'tts/audio',
        segmentId: 'seg_1',
        audioData: 'base64...',
        timestamp: 1705000010000,
    },
];

/**
 * Expected state after processing all events
 */
export const expectedFinalState = {
    status: 'disconnected', // Engine doesn't auto-connect in test
    lang: 'es',
    seq: 8,
    liveLine: '',
    liveOriginal: '',
    committedLines: [
        {
            text: 'Hola a todos.',
            original: 'Hello everyone.',
            seqId: 3,
            sourceSeqId: 1,
        },
        {
            text: 'Bienvenidos a la conferencia.',
            original: 'Welcome to the conference.',
            seqId: 6,
            sourceSeqId: 4,
        },
        {
            text: 'Vamos a comenzar ahora.',
            original: "We're going to start now.",
            seqId: 8,
            sourceSeqId: 7,
        },
    ],
};
