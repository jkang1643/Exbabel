const DEFAULT_AUTO_PUNCTUATION = process.env.GOOGLE_ENABLE_AUTO_PUNCTUATION !== 'false';

let autoPunctuationEnabled = DEFAULT_AUTO_PUNCTUATION;

export function isGoogleAutoPunctuationEnabled() {
  return autoPunctuationEnabled;
}

export function setGoogleAutoPunctuationEnabled(enabled) {
  const normalized = !!enabled;
  if (autoPunctuationEnabled !== normalized) {
    autoPunctuationEnabled = normalized;
    console.log(`[GooglePunctuationSettings] Google STT auto punctuation ${normalized ? 'enabled' : 'disabled'}`);
  }
}
