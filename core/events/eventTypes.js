/**
 * Event Type Definitions for Exbabel Core Engine
 * 
 * This file defines the event contract that the core engine emits.
 * All events follow this structure to ensure consistency between
 * solo mode and host mode.
 * 
 * PHASE 1: Foundation - No behavior changes, just type definitions
 */

/**
 * @typedef {Object} PartialEvent
 * @property {string} type - Always "partial"
 * @property {string} text - Partial transcript text
 * @property {number} offset - Character offset in timeline
 * @property {number} seqId - Sequence ID for ordering
 * @property {number} timestamp - Event timestamp (ms since epoch)
 */

/**
 * @typedef {Object} FinalEvent
 * @property {string} type - Always "final"
 * @property {string} text - Final transcript text
 * @property {number} offset - Character offset in timeline
 * @property {number} seqId - Sequence ID for ordering
 * @property {number} timestamp - Event timestamp (ms since epoch)
 */

/**
 * @typedef {Object} CommitEvent
 * @property {string} type - Always "commit"
 * @property {string} id - Unique commit identifier
 * @property {string} text - Committed text
 * @property {boolean} isForced - Whether this was a forced commit
 * @property {number} timestamp - Event timestamp (ms since epoch)
 */

/**
 * @typedef {Object} LLMEvent
 * @property {string} type - Always "llm"
 * @property {string} html - LLM output (HTML formatted)
 * @property {number} seqId - Sequence ID for ordering
 * @property {number} timestamp - Event timestamp (ms since epoch)
 */

/**
 * @typedef {Object} LatencyReportEvent
 * @property {string} type - Always "latencyReport"
 * @property {number} value - Latency value in milliseconds
 * @property {number} timestamp - Event timestamp (ms since epoch)
 */

/**
 * @typedef {Object} GrammarUpdateEvent
 * @property {string} type - Always "grammarUpdate"
 * @property {string} originalText - Original text before correction
 * @property {string} correctedText - Grammar-corrected text
 * @property {number} seqId - Sequence ID for ordering
 * @property {number} timestamp - Event timestamp (ms since epoch)
 */

/**
 * @typedef {Object} TranslationEvent
 * @property {string} type - Always "translation"
 * @property {string} originalText - Original transcript text
 * @property {string} translatedText - Translated text
 * @property {boolean} isPartial - Whether this is a partial or final translation
 * @property {number} seqId - Sequence ID for ordering
 * @property {number} timestamp - Event timestamp (ms since epoch)
 */

/**
 * @typedef {Object} ScriptureDetectedEvent
 * @property {string} type - Always "scriptureDetected"
 * @property {Object} reference - Bible reference object
 * @property {string} reference.book - Book name (e.g., "Acts")
 * @property {number} reference.chapter - Chapter number
 * @property {number} [reference.verse] - Verse number (optional)
 * @property {string} displayText - Display text (e.g., "Acts 2:38")
 * @property {number} confidence - Confidence score (0.0-1.0)
 * @property {string} method - Detection method ("regex", "keywords", "keywords+ai")
 * @property {number} seqId - Sequence ID for ordering
 * @property {number} timestamp - Event timestamp (ms since epoch)
 */

/**
 * Union type of all possible Exbabel events
 * @typedef {PartialEvent | FinalEvent | CommitEvent | LLMEvent | LatencyReportEvent | GrammarUpdateEvent | TranslationEvent | ScriptureDetectedEvent} ExbabelEvent
 */

/**
 * Event type constants for type checking
 */
export const EVENT_TYPES = {
  PARTIAL: 'partial',
  FINAL: 'final',
  COMMIT: 'commit',
  LLM: 'llm',
  LATENCY_REPORT: 'latencyReport',
  GRAMMAR_UPDATE: 'grammarUpdate',
  TRANSLATION: 'translation',
  SCRIPTURE_DETECTED: 'scriptureDetected'
};

/**
 * Type guard to check if an object is an ExbabelEvent
 * @param {any} event - Object to check
 * @returns {boolean} True if object is a valid ExbabelEvent
 */
export function isExbabelEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (!event.type || typeof event.type !== 'string') return false;
  if (!event.timestamp || typeof event.timestamp !== 'number') return false;
  return Object.values(EVENT_TYPES).includes(event.type);
}

/**
 * Validate an event structure
 * @param {ExbabelEvent} event - Event to validate
 * @returns {boolean} True if event is valid
 */
export function validateEvent(event) {
  if (!isExbabelEvent(event)) return false;
  
  // Type-specific validation
  switch (event.type) {
    case EVENT_TYPES.PARTIAL:
    case EVENT_TYPES.FINAL:
    case EVENT_TYPES.TRANSLATION:
      return typeof event.text === 'string' && 
             typeof event.seqId === 'number';
    
    case EVENT_TYPES.COMMIT:
      return typeof event.id === 'string' && 
             typeof event.text === 'string' && 
             typeof event.isForced === 'boolean';
    
    case EVENT_TYPES.LLM:
      return typeof event.html === 'string' && 
             typeof event.seqId === 'number';
    
    case EVENT_TYPES.LATENCY_REPORT:
      return typeof event.value === 'number';
    
    case EVENT_TYPES.GRAMMAR_UPDATE:
      return typeof event.originalText === 'string' && 
             typeof event.correctedText === 'string' && 
             typeof event.seqId === 'number';
    
    case EVENT_TYPES.SCRIPTURE_DETECTED:
      return typeof event.reference === 'object' &&
             typeof event.reference.book === 'string' &&
             typeof event.reference.chapter === 'number' &&
             typeof event.displayText === 'string' &&
             typeof event.confidence === 'number' &&
             typeof event.method === 'string' &&
             typeof event.seqId === 'number';
    
    default:
      return false;
  }
}

export default {
  EVENT_TYPES,
  isExbabelEvent,
  validateEvent
};

