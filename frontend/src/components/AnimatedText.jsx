import React, { useEffect, useRef, useState, useMemo } from 'react'

/**
 * AnimatedText - Displays text with word-by-word fade-in animation
 * Only animates new words as they appear, ensuring smooth streaming without lag
 */
function AnimatedText({ text, className = '', renderCursor = false, cursorColor = 'emerald-300' }) {
  const [words, setWords] = useState([])
  const previousTextRef = useRef('')

  // Split text into words efficiently - use memoization
  const wordTokens = useMemo(() => {
    if (!text) return []
    // Split on word boundaries but preserve spaces and punctuation
    // This handles multi-byte characters and various languages
    const tokens = []
    let currentToken = ''
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      // Check if character is whitespace (including tabs, newlines, etc.)
      const isWhitespace = /\s/.test(char)
      
      if (isWhitespace) {
        if (currentToken) {
          tokens.push({ type: 'word', text: currentToken })
          currentToken = ''
        }
        // Accumulate consecutive whitespace
        let whitespace = char
        while (i + 1 < text.length && /\s/.test(text[i + 1])) {
          whitespace += text[i + 1]
          i++
        }
        tokens.push({ type: 'space', text: whitespace })
      } else {
        currentToken += char
      }
    }
    
    // Add final token if exists
    if (currentToken) {
      tokens.push({ type: 'word', text: currentToken })
    }
    
    return tokens
  }, [text])

  useEffect(() => {
    // Only process if text actually changed
    if (text === previousTextRef.current) {
      return
    }

    const previousText = previousTextRef.current
    const previousTokens = previousText ? (() => {
      const tokens = []
      let currentToken = ''
      for (let i = 0; i < previousText.length; i++) {
        const char = previousText[i]
        const isWhitespace = /\s/.test(char)
        if (isWhitespace) {
          if (currentToken) {
            tokens.push({ type: 'word', text: currentToken })
            currentToken = ''
          }
          let whitespace = char
          while (i + 1 < previousText.length && /\s/.test(previousText[i + 1])) {
            whitespace += previousText[i + 1]
            i++
          }
          tokens.push({ type: 'space', text: whitespace })
        } else {
          currentToken += char
        }
      }
      if (currentToken) {
        tokens.push({ type: 'word', text: currentToken })
      }
      return tokens
    })() : []

    // Determine which words are new
    const newWords = wordTokens.map((token, index) => {
      if (token.type === 'space') {
        // Spaces are not animated
        return {
          key: `space-${index}`,
          text: token.text,
          isNew: false,
          type: 'space'
        }
      }

      // Check if this word existed at the same position in previous text
      const isNew = index >= previousTokens.length || 
                    previousTokens[index].type !== 'word' || 
                    previousTokens[index].text !== token.text

      return {
        key: `word-${index}-${token.text.substring(0, 10)}`,
        text: token.text,
        isNew: isNew,
        type: 'word',
        index: index
      }
    })

    // Update refs
    previousTextRef.current = text
    
    // Update state
    setWords(newWords)
  }, [wordTokens, text])

  return (
    <span className={className}>
      {words.map((word) => (
        <span
          key={word.key}
          className={word.isNew && word.type === 'word' ? 'word-fade-in' : ''}
          style={{
            display: 'inline'
          }}
        >
          {word.text}
        </span>
      ))}
      {renderCursor && (
        <span 
          className="inline-block w-0.5 h-5 sm:h-6 ml-1 animate-pulse"
          style={{
            backgroundColor: cursorColor === 'white' ? 'white' : 
                           cursorColor === 'emerald-300' ? '#6ee7b7' :
                           cursorColor === 'blue-600' ? '#2563eb' : cursorColor
          }}
        ></span>
      )}
    </span>
  )
}

export default AnimatedText
