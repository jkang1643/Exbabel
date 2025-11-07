const DEFAULT_ENABLED = process.env.DEFAULT_PUNCTUATION_ENABLED !== 'false';

let punctuationEnabled = DEFAULT_ENABLED;

export function isPunctuationEnabled() {
  return punctuationEnabled;
}

export function setPunctuationEnabled(enabled) {
  const normalized = !!enabled;
  if (punctuationEnabled !== normalized) {
    punctuationEnabled = normalized;
    console.log(`[PunctuationSettings] Punctuation restorer ${normalized ? 'enabled' : 'disabled'}`);
  }
}
