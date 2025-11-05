with open('soloModeHandler.js', 'r') as f:
    content = f.read()

# Find and insert the check after "Final transcript from Google Speech"
marker = '// Final transcript from Google Speech - send immediately (restored simple approach)'
insertion = '''// Final transcript from Google Speech - send immediately (restored simple approach)
                  // CRITICAL: Check if partial has more text than final
                  if (latestPartialText && latestPartialText.length > transcriptText.length && (Date.now() - latestPartialTime) < 500) {
                    console.log(`[SoloMode] ⚠️ Using partial instead of final (${transcriptText.length} → ${latestPartialText.length} chars)`);
                    transcriptText = latestPartialText;
                  }
                  latestPartialText = '';'''

if marker in content:
    content = content.replace(marker, insertion)
    with open('soloModeHandler.js', 'w') as f:
        f.write(content)
    print('OK')
else:
    print('Marker not found')

