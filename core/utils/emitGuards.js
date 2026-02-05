/**
 * Emit Guards - Prevent duplicate flashes, fragment spam, and dropped partials
 * 
 * These utilities ensure clean transcript emission by:
 * - Skipping punctuation-only or empty partials
 * - Preventing duplicate emissions (normalized comparison)
 * - Preventing regression (shorter text) unless correction type exists
 * - Tracking last emitted text per segmentId
 */

/**
 * Normalize text for comparison (lowercase, collapse whitespace, strip punctuation)
 * @param {string} text - Text to normalize
 * @returns {string} Normalized text
 */
export function normalizeText(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"\-]/g, ' ') // Replace punctuation with spaces
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();
}

/**
 * Check if text has alphanumeric characters
 * @param {string} text - Text to check
 * @returns {boolean} True if text contains alphanumeric characters
 */
export function hasAlphaNumeric(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }
  // Check if text contains at least one alphanumeric character (Unicode aware)
  // \p{L} matches any Unicode letter, \p{N} matches any Unicode number
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Track last emitted text per segmentId
 * Using Map for efficient lookups
 */
const lastEmittedTextMap = new Map();

/**
 * Get last emitted text for a segmentId
 * @param {string|number} segmentId - Segment identifier
 * @returns {string|null} Last emitted text or null
 */
export function getLastEmittedText(segmentId) {
  return lastEmittedTextMap.get(segmentId) || null;
}

/**
 * Set last emitted text for a segmentId
 * @param {string|number} segmentId - Segment identifier
 * @param {string} text - Text that was emitted
 */
export function setLastEmittedText(segmentId, text) {
  if (segmentId !== null && segmentId !== undefined) {
    lastEmittedTextMap.set(segmentId, text);
  }
}

/**
 * Clear last emitted text for a segmentId (e.g., on new segment)
 * @param {string|number} segmentId - Segment identifier
 */
export function clearLastEmittedText(segmentId) {
  if (segmentId !== null && segmentId !== undefined) {
    lastEmittedTextMap.delete(segmentId);
  }
}

/**
 * Check if a partial should be emitted
 * @param {string|number} segmentId - Segment identifier
 * @param {string} nextText - Next text to potentially emit
 * @param {Object} options - Options
 * @param {boolean} [options.allowCorrection] - Allow regression if this is a correction
 * @param {string} [options.mode] - Mode identifier for logging (e.g., "SoloMode", "HostMode")
 * @returns {Object} Result object with shouldEmit boolean and reason string
 */
export function shouldEmitPartial(segmentId, nextText, options = {}) {
  const { allowCorrection = false, mode = 'UnknownMode' } = options;

  // Rule 1: Skip if punctuation-only or empty
  if (!hasAlphaNumeric(nextText)) {
    return {
      shouldEmit: false,
      reason: 'skip: punctuation-only',
      skipReason: 'punctuation-only'
    };
  }

  // Rule 2: Check for duplicate (normalized comparison)
  const lastEmitted = getLastEmittedText(segmentId);
  if (lastEmitted) {
    const normalizedNext = normalizeText(nextText);
    const normalizedLast = normalizeText(lastEmitted);

    if (normalizedNext === normalizedLast) {
      return {
        shouldEmit: false,
        reason: 'skip: duplicate',
        skipReason: 'duplicate'
      };
    }

    // Rule 3: Skip if regression (shorter) unless correction type exists
    if (!allowCorrection && nextText.length < lastEmitted.length) {
      // Allow if normalized text is actually longer (might be formatting change)
      if (normalizedNext.length >= normalizedLast.length) {
        // Normalized is same or longer - allow (might be formatting)
        return { shouldEmit: true, reason: 'emit: normalized same/longer' };
      }
      return {
        shouldEmit: false,
        reason: 'skip: regression',
        skipReason: 'regression'
      };
    }
  }

  return { shouldEmit: true, reason: 'emit: passed all checks' };
}

/**
 * Check if a final should be emitted
 * @param {string|number} segmentId - Segment identifier
 * @param {string} nextText - Next text to potentially emit
 * @param {Object} options - Options
 * @param {boolean} [options.allowCorrection] - Allow regression if this is a correction
 * @param {string} [options.mode] - Mode identifier for logging (e.g., "SoloMode", "HostMode")
 * @returns {Object} Result object with shouldEmit boolean and reason string
 */
export function shouldEmitFinal(segmentId, nextText, options = {}) {
  const { allowCorrection = false, mode = 'UnknownMode' } = options;

  // Rule 1: Skip if punctuation-only or empty
  if (!hasAlphaNumeric(nextText)) {
    return {
      shouldEmit: false,
      reason: 'skip: punctuation-only',
      skipReason: 'punctuation-only'
    };
  }

  // Rule 2: Check for duplicate (normalized comparison)
  const lastEmitted = getLastEmittedText(segmentId);
  if (lastEmitted) {
    const normalizedNext = normalizeText(nextText);
    const normalizedLast = normalizeText(lastEmitted);

    if (normalizedNext === normalizedLast) {
      return {
        shouldEmit: false,
        reason: 'skip: duplicate',
        skipReason: 'duplicate'
      };
    }

    // Rule 3: Skip if regression (shorter) unless correction type exists
    if (!allowCorrection && nextText.length < lastEmitted.length) {
      // Allow if normalized text is actually longer (might be formatting change)
      if (normalizedNext.length >= normalizedLast.length) {
        // Normalized is same or longer - allow (might be formatting)
        return { shouldEmit: true, reason: 'emit: normalized same/longer' };
      }
      return {
        shouldEmit: false,
        reason: 'skip: regression',
        skipReason: 'regression'
      };
    }
  }

  return { shouldEmit: true, reason: 'emit: passed all checks' };
}

/**
 * Token delta check - check if new text has new alphanumeric tokens compared to previous
 * @param {string} prevText - Previous text
 * @param {string} nextText - Next text
 * @returns {boolean} True if nextText has new alphanumeric tokens
 */
export function tokenDeltaHasNewAlpha(prevText, nextText) {
  if (!prevText || !nextText) {
    return hasAlphaNumeric(nextText);
  }

  const prevNormalized = normalizeText(prevText);
  const nextNormalized = normalizeText(nextText);

  // If next is longer, it likely has new tokens
  if (nextNormalized.length > prevNormalized.length) {
    return true;
  }

  // Extract alphanumeric tokens
  const prevTokens = prevNormalized.split(/\s+/).filter(t => t.length > 0);
  const nextTokens = nextNormalized.split(/\s+/).filter(t => t.length > 0);

  // Check if next has tokens not in prev
  const prevTokenSet = new Set(prevTokens);
  return nextTokens.some(token => !prevTokenSet.has(token));
}

export default {
  normalizeText,
  hasAlphaNumeric,
  getLastEmittedText,
  setLastEmittedText,
  clearLastEmittedText,
  shouldEmitPartial,
  shouldEmitFinal,
  tokenDeltaHasNewAlpha
};

