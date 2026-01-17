import React from 'react'
import { Globe } from 'lucide-react'
import { TOP_LANGUAGES } from '../config/languages.js'

function LanguageSelector({ label, languages, selectedLanguage, onLanguageChange, compact = false }) {
  // Get top 10 languages that are in the languages list
  const topLanguagesInList = TOP_LANGUAGES.filter(topLang =>
    languages.some(lang => lang.code === topLang.code)
  );

  // Get top 10 language codes for filtering
  const topLanguageCodes = new Set(topLanguagesInList.map(lang => lang.code));

  // All languages sorted alphabetically (excluding top 10 to avoid duplicates)
  const allLanguagesAlphabetical = languages
    .filter(lang => !topLanguageCodes.has(lang.code))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (compact) {
    return (
      <div className="relative">
        <select
          value={selectedLanguage}
          onChange={(e) => onLanguageChange(e.target.value)}
          className="w-full pl-2 pr-7 py-1 border border-gray-200 rounded text-[10px] sm:text-xs font-semibold focus:ring-2 focus:ring-blue-500 focus:border-blue-500 appearance-none bg-white/80 backdrop-blur-sm truncate"
        >
          {topLanguagesInList.length > 0 && (
            <optgroup label="Popular">
              {topLanguagesInList.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="All Languages">
            {allLanguagesAlphabetical.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </optgroup>
        </select>
        <Globe className="absolute right-1.5 top-1/2 transform -translate-y-1/2 w-3 h-3 text-gray-400 pointer-events-none" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      <div className="relative">
        <select
          value={selectedLanguage}
          onChange={(e) => onLanguageChange(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 appearance-none bg-white"
        >
          {/* Popular section */}
          {topLanguagesInList.length > 0 && (
            <optgroup label="Popular">
              {topLanguagesInList.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </optgroup>
          )}

          {/* All Languages section */}
          <optgroup label="All Languages">
            {allLanguagesAlphabetical.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </optgroup>
        </select>
        <Globe className="absolute right-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
      </div>
    </div>
  )
}

export { LanguageSelector }
