---
name: Dialect Expansion Implementation (Updated)
overview: Expand translation languages to include regional dialects. When users select a base language (e.g., "es"), use generic translation. When they select a dialect (e.g., "es-MX"), use region-specific vocabulary and idioms via targetLocale parameter.
todos: []
---

# Di

alect Expansion Implementation Plan (Updated)

## Overview

Add regional dialect support to the translation system, expanding from ~130 languages to 200+ languages and dialects. The implementation distinguishes between base language selection (generic translation) and dialect selection (region-specific translation).

## Key Behavior

### Translation Logic

- **Base Language Selected** (e.g., `es`):
- Use generic translation guidance
- Pass only `targetLanguage: "es"`
- System prompt: "Translate to Spanish"
- **Dialect Selected** (e.g., `es-MX`):
- Use region-specific translation guidance
- Extract base: `targetLanguage: "es"`
- Pass locale: `targetLocale: "es-MX"`
- System prompt: "Translate to Spanish (Mexico). Use region-specific vocabulary, idioms, and grammar. Do not normalize to generic Spanish."

## Architecture Changes

### Data Structure

- Languages organized hierarchically: base language → dialects
- Each dialect has:
- Base language code (e.g., `es`)
- Full BCP-47 locale code (e.g., `es-MX`)
- Display name with region (e.g., "Spanish (Mexico)")

### Translation Flow

**Scenario 1: Base Language Selected**

```javascript
User selects "Spanish" (es)
  ↓
Frontend sends: { targetLanguage: "es" }
  ↓
Backend detects: base language (no locale)
  ↓
OpenAI API receives: generic Spanish guidance
  ↓
Translation uses standard Spanish
```

**Scenario 2: Dialect Selected**

```javascript
User selects "Spanish (Mexico)" (es-MX)
  ↓
Frontend sends: { targetLanguage: "es-MX" }
  ↓
Backend extracts: base="es", locale="es-MX"
  ↓
OpenAI API receives: 
    - targetLanguage: "es"
    - targetLocale: "es-MX"
    - Regional guidance in system prompt
  ↓
Translation uses Mexican Spanish vocabulary/idioms
```



## Implementation Steps

### 1. Update Backend Language Configuration

**File**: `backend/languageConfig.js`

- Add all regional dialects from the provided list
- Maintain backward compatibility with existing language codes
- Add helper functions:
- `getBaseLanguage(localeCode)` - extracts base language from BCP-47 (e.g., `es-MX` → `es`)
- `getLocaleCode(langCode)` - gets full BCP-47 code if it's a dialect, otherwise returns base
- `isDialect(localeCode)` - checks if a code is a dialect variant (contains `-`)
- `isBaseLanguage(langCode)` - checks if code is base language (no `-`)

**Key additions**:

- Spanish: 12 regional variants (es-ES, es-MX, es-US, etc.)
- Portuguese: 4 variants (pt-PT, pt-BR, pt-AO, pt-MZ)
- French: 5 variants (fr-FR, fr-CA, fr-BE, fr-CH, fr-CI)
- English: 10 variants (en-US, en-GB, en-CA, en-AU, etc.)
- Chinese: 6 variants (zh-CN, zh-SG, zh-TW, zh-HK, zh-Hans, zh-Hant)
- Arabic: 9 variants (ar-SA, ar-EG, ar-AE, etc.)
- Plus all other dialects from the provided list

### 2. Update Frontend Language Configuration

**File**: `frontend/src/config/languages.js`

- Mirror the backend structure
- Organize languages hierarchically for UI grouping
- Create `LANGUAGE_GROUPS` structure that groups dialects under base languages
- Maintain `TRANSLATION_LANGUAGES` array with all options (flat list for compatibility)

**Structure**:

```javascript
export const LANGUAGE_GROUPS = {
  'es': {
    base: { code: 'es', name: 'Spanish' },
    dialects: [
      { code: 'es-ES', name: 'Spanish (Spain)' },
      { code: 'es-MX', name: 'Spanish (Mexico)' },
      // ... etc
    ]
  },
  // ... other groups
}
```



### 3. Enhance LanguageSelector Component

**File**: `frontend/src/components/LanguageSelector.jsx`

- Update to support grouped display using `<optgroup>`
- Show base languages as group headers
- List dialects as options within each group
- Maintain "Popular" section at top
- Ensure selected value works with both base codes and locale codes

**UI Structure**:

```javascript
<select>
  <optgroup label="Popular">
    <!-- Top 10 languages -->
  </optgroup>
  <optgroup label="Spanish">
    <option value="es">Spanish</option>
    <option value="es-ES">Spanish (Spain)</option>
    <option value="es-MX">Spanish (Mexico)</option>
    <!-- etc -->
  </optgroup>
  <!-- Other language groups -->
</select>
```



### 4. Update Translation Workers

**Files**:

- `backend/translationWorkers.js`
- `backend/translationWorkersRealtime.js` (if exists)
- `backend/translationManager.js`

**Key Changes**:**Function: `translateFinal()` and `translatePartialStream()`**

- Detect if `targetLang` is a dialect (contains `-`)
- If base language (e.g., `es`):
- Use generic system prompt: "Translate to Spanish"
- No `targetLocale` parameter
- If dialect (e.g., `es-MX`):
- Extract base: `const baseLang = getBaseLanguage(targetLang)` → `"es"`
- Use regional system prompt: "Translate to Spanish (Mexico). Use region-specific vocabulary, idioms, and grammar for Mexico. Do not normalize to generic Spanish."
- Pass both `targetLanguage: baseLang` and `targetLocale: targetLang` in API call context (or just in prompt)

**System Prompt Logic**:

```javascript
const isDialect = targetLang.includes('-');
const baseLang = isDialect ? getBaseLanguage(targetLang) : targetLang;
const langName = getLanguageName(baseLang);
const localeName = isDialect ? getLanguageName(targetLang) : null;

const systemPrompt = isDialect
  ? `You are a world-class church translator. Translate text from ${sourceLangName} to ${localeName} (${targetLang}). Use region-specific vocabulary, idioms, and grammar for ${targetLang}. Do not normalize to generic ${langName}.`
  : `You are a world-class church translator. Translate text from ${sourceLangName} to ${langName}.`;
```

**Function: `translateToMultipleLanguages()`**

- Handle both base codes and locale codes in target list
- Apply same logic per language

### 5. Update Language Selection Handlers

**Files**:

- `frontend/src/components/TranslationInterface.jsx`
- `frontend/src/components/HostPage.jsx`
- `frontend/src/components/ListenerPage.jsx`
- Ensure locale codes (e.g., `es-MX`) are properly passed to backend
- Backend should handle both old format (base codes) and new format (locale codes)
- No changes needed to message format - just pass the selected code as-is

### 6. Backend API Compatibility

**Files**: All WebSocket handlers and API endpoints

- Ensure backward compatibility: old clients sending `es` still work (generic translation)
- New clients can send `es-MX` for dialect-specific translation
- Session storage should handle both formats
- Language validation should accept both base codes and locale codes

## Testing Considerations

1. **Base Language Selection**: Verify selecting `es` produces generic Spanish translation
2. **Dialect Selection**: Verify selecting `es-MX` produces Mexican Spanish with regional vocabulary
3. **Backward Compatibility**: Existing sessions with base language codes should continue working
4. **UI Clarity**: Ensure dropdown is not cluttered and dialects are easy to find
5. **Performance**: Adding 90+ dialects shouldn't significantly impact dropdown rendering
6. **Mixed Sessions**: Test sessions with both base and dialect selections

## Migration Notes